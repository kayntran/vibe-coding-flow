// node --test hooks/lib/agy-guard.test.mjs — chuẩn hoá đường dẫn, đích thật (realpath) và nhận ra việc ghi/xoá vào cấu hình gác chính bộ chặn (hooks/lib/agy-guard.mjs).
// Phần ghép vào hook (deny/ask theo từng tool) nằm ở hooks/agy-hook.test.mjs; ở đây chỉ kiểm các hàm thuần.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canon, checkForms, configHit, homesOf, physicalPath, realTarget, shellProtectedWrite } from './agy-guard.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guard-')))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(path.join(HOME, '.gemini', 'config', 'agents'), { recursive: true })
fs.mkdirSync(path.join(HOME, '.claude', 'hooks'), { recursive: true })
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
const H = HOME.replaceAll('\\', '/')
const ctx = (cwd = TMP) => ({ cwd, home: HOME })
const hit = (cmd, cwd) => shellProtectedWrite(cmd, ctx(cwd))

test('canon: mở ~ / $HOME / %USERPROFILE%, bỏ .. và . ở mọi kiểu đường dẫn (ổ đĩa, UNC, /, tương đối)', () => {
  assert.equal(canon('~/a/../b', TMP, HOME).abs, path.win32.isAbsolute(HOME) && /^[a-zA-Z]:/.test(HOME) ? path.win32.normalize(`${HOME}/b`) : path.posix.normalize(`${HOME}/b`))
  assert.equal(canon('C:\\Windows\\Temp\\..\\System32\\x.dll', TMP, HOME).abs, 'C:\\Windows\\System32\\x.dll')
  assert.equal(canon('C:/Windows/Temp/../System32', TMP, HOME).abs, 'C:\\Windows\\System32')
  assert.equal(canon('/tmp/../etc/passwd', TMP, HOME).abs, '/etc/passwd')
  assert.equal(canon('\\\\srv\\share\\a\\..\\b', TMP, HOME).abs, '\\\\srv\\share\\b')
  assert.equal(canon('x/./y/../z', TMP, HOME).abs, path.resolve(TMP, 'x', 'z'))
  assert.equal(canon('$HOME/.x', TMP, HOME).abs, canon('~/.x', TMP, HOME).abs)
  assert.equal(canon('${HOME}/.x', TMP, HOME).abs, canon('~/.x', TMP, HOME).abs)
  assert.equal(canon('$env:USERPROFILE\\.x', TMP, HOME).abs, canon('~/.x', TMP, HOME).abs)
  assert.equal(canon('%USERPROFILE%\\.x', TMP, HOME).abs, canon('~/.x', TMP, HOME).abs)
  assert.equal(canon('file:///C:/a/../b', TMP, HOME).abs, 'C:\\b')
})

test('canon: biến chưa rõ ⇒ unresolved; ký tự đại diện ⇒ glob + thư mục đứng trước; rỗng / không phải chuỗi ⇒ null', () => {
  assert.deepEqual(canon('$X/y', TMP, HOME), { abs: null, unresolved: true, glob: false })
  assert.deepEqual(canon('%FOO%\\y', TMP, HOME), { abs: null, unresolved: true, glob: false })
  const g = canon(`${H}/.gemini/config/*`, TMP, HOME)
  assert.equal(g.glob, true)
  assert.equal(g.unresolved, false)
  assert.equal(lowerSlash(g.abs), lowerSlash(path.join(HOME, '.gemini', 'config')))
  assert.equal(canon('', TMP, HOME), null)
  assert.equal(canon('   ', TMP, HOME), null)
  assert.equal(canon(5, TMP, HOME), null)
})
const lowerSlash = (p) => p.replaceAll('\\', '/').toLowerCase()

test('realTarget / checkForms: theo liên kết tới đích thật, kể cả phần đường dẫn chưa tồn tại; không phân giải được ⇒ chính nó', (t) => {
  const target = path.join(TMP, 'that')
  fs.mkdirSync(target)
  const link = path.join(TMP, 'lk')
  try { fs.symlinkSync(target, link, 'junction') } catch (e) { return t.skip(e.code) }
  assert.equal(realTarget(path.join(link, 'a', 'b.txt')), path.join(target, 'a', 'b.txt'))
  assert.deepEqual(checkForms(path.join(link, 'x')).map(lowerSlash), [lowerSlash(path.join(link, 'x')), lowerSlash(path.join(target, 'x'))])
  assert.deepEqual(checkForms(path.join(target, 'x')), [path.join(target, 'x')])
  assert.equal(realTarget('Z:\\khong\\ton\\tai'), process.platform === 'win32' ? realTarget('Z:\\khong\\ton\\tai') : 'Z:\\khong\\ton\\tai')
})

test('POSIX: physicalPath / checkForms — ".." tính từ đích THẬT của liên kết đứng trước nó (kernel mở alias rồi mới lùi một cấp), thêm dạng chữ để chặn cả hai', { skip: process.platform === 'win32' ? 'chỉ posix' : false }, () => {
  const proj = path.join(TMP, 'phys')
  fs.mkdirSync(proj)
  fs.symlinkSync(path.join(HOME, '.gemini', 'config', 'agents'), path.join(proj, 'alias'))
  const c = canon('alias/../hooks.json', proj, HOME)
  assert.equal(c.abs, path.join(proj, 'hooks.json'), 'dạng chữ: .. rút theo chữ')
  assert.equal(c.rawAbs, `${proj}/alias/../hooks.json`)
  assert.equal(physicalPath(c.rawAbs), path.join(fs.realpathSync(HOME), '.gemini', 'config', 'hooks.json'), 'dạng thật: alias → agents, .. → config')
  const forms = checkForms(c.abs, c.rawAbs)
  assert.ok(forms.length >= 2)
  assert.equal(configHit(forms, homesOf(HOME)), '.gemini/config/hooks.json')
  assert.equal(configHit(checkForms(canon('plain/../hooks.json', proj, HOME).abs, `${proj}/plain/../hooks.json`), homesOf(HOME)), null, 'không có liên kết thì chỉ còn dạng chữ, ở ngoài vùng')
  assert.equal(physicalPath('/khong/ton/tai/../x'), '/khong/ton/x', 'thành phần chưa tồn tại: lùi theo chữ')
})

test('configHit: file / thư mục / thư mục cha (chỉ khi xoá-di chuyển hoặc glob); không nhầm file cùng tên ở chỗ khác', () => {
  const homes = homesOf(HOME)
  const p = (...s) => [path.join(HOME, ...s)]
  assert.equal(configHit(p('.gemini', 'config', 'hooks.json'), homes), '.gemini/config/hooks.json')
  assert.equal(configHit(p('.GEMINI', 'Config', 'MCP_CONFIG.JSON'), homes), '.gemini/config/mcp_config.json')
  assert.equal(configHit(p('.gemini', 'AGENTS.md'), homes), '.gemini/AGENTS.md')
  assert.equal(configHit(p('.claude', 'hooks', 'lib', 'x.mjs'), homes), '.claude/hooks')
  assert.equal(configHit(p('.claude', 'kit'), homes), '.claude/kit')
  assert.equal(configHit(p('.gemini', 'config'), homes), null, 'cha: chỉ chặn khi xoá/di chuyển')
  assert.equal(configHit(p('.gemini', 'config'), homes, { destructive: true }), '.gemini/config')
  assert.equal(configHit(p('.gemini'), homes, { destructive: true }), '.gemini')
  assert.equal(configHit(p('.claude'), homes, { destructive: true }), '.claude')
  assert.equal(configHit(p('.gemini', 'config'), homes, { glob: true }), '.gemini/config/hooks.json')
  for (const ok of [p('.gemini', 'config', 'skills', 'a.md'), p('.gemini', 'GEMINI.md'), p('.claude', 'CLAUDE.md'), p('.claude', '.claude', 'worktrees', 'w', 'hooks', 'a.mjs'), p('docs', 'hooks.json'), [path.join(TMP, 'hooks.json')]]) {
    assert.equal(configHit(ok, homes, { destructive: true }), null, ok[0])
  }
})

test('shellProtectedWrite: kiểu viết ít gặp — glob, &>, -t, -OutFile, curl -o, dd of=, sudo/env/time, PowerShell -EncodedCommand, wsl, eval', () => {
  const hooks = `${H}/.gemini/config/hooks.json`
  const enc = (s) => Buffer.from(s, 'utf16le').toString('base64')
  for (const c of [
    `rm ${H}/.gemini/config/*`, `rm -rf "${H}/.claude/hooks/*"`, `echo x &> ${hooks}`, `echo x &>> ${hooks}`, `echo x >| ${hooks}`, `cp -t ${H}/.claude/hooks evil.mjs`, `cp --target-directory ${H}/.claude/kit x`,
    `Invoke-WebRequest http://x -OutFile ${hooks}`, `iwr http://x -OutFile "${path.join(HOME, '.claude', 'settings.json')}"`, `curl -o ${hooks} http://x`, `wget -O ${hooks} http://x`, `dd if=x of=${hooks}`,
    `sudo tee ${hooks}`, `env X=1 cp a ${hooks}`, `time rm ${hooks}`, `nohup mv a ${H}/.claude/hooks/a.mjs &`, `powershell -EncodedCommand ${enc(`Set-Content ${H}/.gemini/config/hooks.json x`)}`,
    `powershell -NoProfile -enc ${enc(`'x' | Out-File ${hooks}`)}`, `wsl bash -c "echo x > ${hooks}"`, `eval "echo x > ${hooks}"`, `iex "Set-Content ${hooks} x"`,
    `[System.IO.File]::WriteAllText('${H}\\.gemini\\config\\hooks.json','{}')`, `bash -c "bash -c 'echo x > ${hooks}'"`,
  ]) assert.ok(hit(c), `đáng lẽ phát hiện: ${c}`)
  for (const c of [
    `rm ${H}/.gemini/config/skills/*`, `cp ${hooks} ${H}/backup/hooks.json`, `curl -o ${H}/tai-ve.txt http://x`, `dd if=${hooks} of=${H}/b.bin`, `Invoke-WebRequest http://x -OutFile ${H}/x.zip`,
    `node ${H}/.claude/hooks/x.mjs -e foo`, `node script.mjs -p ${hooks}`, `echo x > ${H}/.gemini/config/skills/a.md`, `cat ${hooks} | head`, `bash -c "cat ${hooks}"`, `powershell -Command "Get-Content ${hooks}"`,
    `a && b; c | d`, '', '   ', 'echo "unbalanced', `echo 2>&1 ${hooks}`,
  ]) assert.equal(hit(c), null, `không được chặn: ${c} ⇒ ${JSON.stringify(hit(c))}`)
})

test('shellProtectedWrite: lồng quá sâu thì bỏ qua (không treo / không đệ quy vô hạn); đầu vào không phải chuỗi ⇒ null; cd tới nơi khác thì thôi theo dõi', () => {
  let cmd = `echo x > ${H}/.gemini/config/hooks.json`
  for (let i = 0; i < 10; i++) cmd = `bash -c "${cmd.replaceAll('"', '\\"')}"`
  assert.ok(cmd.length > 0)
  hit(cmd) // không ném, không treo
  assert.equal(shellProtectedWrite(null, ctx()), null)
  assert.equal(shellProtectedWrite(undefined, ctx()), null)
  fs.mkdirSync(path.join(HOME, '.gemini', 'config', 'skills'), { recursive: true })
  assert.equal(hit(`cd ${H}/.gemini/config && cd skills && echo x > hooks.json`), null, 'đã sang config/skills: hooks.json ở đó là file khác')
  assert.ok(hit(`cd ${H}/.gemini/config/skills && cd .. && echo x > hooks.json`), 'cd .. quay lại config')
  assert.ok(hit(`cd ${H}/.gemini/config/skills; cd ..; echo x > hooks.json`))
})

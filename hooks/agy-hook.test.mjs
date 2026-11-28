// Test cho agy-hook.mjs (adapter hook Antigravity ⇄ cổng của kit) và phần nhận diện agy trong lib/host.mjs:
//   node --test ~/.claude/hooks/agy-hook.test.mjs
// Phủ AC-03 (chặn lệnh nguy hiểm, fail-closed), AC-07 (nạp sổ tiến độ lúc mở phiên). Mọi repo/HOME đều là thư mục tạm; không đụng ~/.gemini hay ~/.claude thật.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGY_BASH_TOOLS, agyPreToolMatcher, agyToolKind, normalize } from './lib/host.mjs'

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HOOKS_DIR, 'agy-hook.mjs')
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-')))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
// Đặt TRƯỚC khi flow-gate.mjs được import (nó đọc FLOW_GATE_LOG lúc nạp): log của cổng và của adapter nằm trong thư mục tạm.
process.env.FLOW_GATE_LOG = path.join(TMP, 'flow-gate.log')
process.env.AGY_HOOK_LOG = path.join(TMP, 'agy-hook.log')
const { buildSessionStart, decidePreTool, decideStop, preToolOuter } = await import('./agy-hook.mjs')

// Tắt bảo trì tự động của git (xem flow-gate.test.mjs): tránh ENOTEMPTY lúc dọn thư mục tạm trên Mac.
const NO_MAINT = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), ...NO_MAINT }

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------- helpers ----------

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')} lỗi: ${r.stderr}`)
  return r.stdout
}

let seq = 0
// Repo chính (nhánh main, một commit) + worktree `wt` trên nhánh feat.
function repoFixture() {
  const root = path.join(TMP, `fx${++seq}`)
  const main = path.join(root, 'main')
  fs.mkdirSync(main, { recursive: true })
  git(main, 'init', '-b', 'main')
  fs.writeFileSync(path.join(main, 'a.txt'), 'line1\nline2\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-m', 'init')
  const wt = path.join(root, 'wt')
  git(main, 'worktree', 'add', '-b', 'feat', wt)
  return { root, main, wt }
}

const pre = (name, args, cwd = TMP) => ({ hookEventName: 'PreToolUse', cwd, conversationId: 'c1', workspacePaths: [cwd], stepIdx: 3, toolCall: { id: 'toolu_01', name, args } })
const bash = (command, cwd = TMP, extra = {}) => pre('run_command', { CommandLine: command, ...extra }, cwd)
const decide = (raw, deps = { home: HOME }) => decidePreTool(raw, deps)
const GHP = 'ghp_' + 'a'.repeat(36) // dựng lúc chạy: file test không chứa khoá nguyên vẹn

async function assertDeny(raw, match, deps) {
  const r = await decide(raw, deps)
  assert.equal(r.decision, 'deny', `đáng lẽ chặn: ${JSON.stringify(r)}`)
  if (match) assert.match(r.reason, match)
  return r
}
async function assertAllow(raw, deps) {
  const r = await decide(raw, deps)
  assert.equal(r.decision, 'allow', `đáng lẽ cho qua: ${JSON.stringify(r)}`)
  return r
}

function runHook(mode, input, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: TMP,
    env: { ...ENV, AGY_HOOK_LOG: process.env.AGY_HOOK_LOG, FLOW_GATE_LOG: process.env.FLOW_GATE_LOG, ...env },
  })
  assert.equal(r.error, undefined)
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function script(name, body) {
  const f = path.join(TMP, name)
  fs.writeFileSync(f, body)
  return f
}

// ---------- lib/host.mjs: nhận diện payload agy ----------

describe('host.normalize: payload agy', () => {
  test('run_command → bash + command (args.CommandLine), event/cwd từ camelCase', () => {
    assert.deepEqual(
      normalize({ hookEventName: 'PreToolUse', cwd: '/proj', conversationId: 'c', toolCall: { id: 't', name: 'run_command', args: { CommandLine: 'npm test' } } }),
      { host: 'agy', event: 'PreToolUse', tool: 'bash', command: 'npm test', cwd: '/proj' },
    )
  })

  test('tool ghi/sửa file (tên docs, changelog, step type) → edit; đọc/liệt kê/tìm → other; subagent → agent', () => {
    const kind = (name) => normalize({ hookEventName: 'PreToolUse', cwd: '/p', toolCall: { name, args: {} } }).tool
    for (const n of ['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'code_action', 'file_change', 'propose_code', 'edit_notebook', 'write_blob', 'delete_directory', 'move', 'Write_To_File']) {
      assert.equal(kind(n), 'edit', n)
    }
    for (const n of ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'read_url_content', 'search_web', 'command_status', 'mcp_tool', 'task_boundary']) assert.equal(kind(n), 'other', n)
    for (const n of ['invoke_subagent', 'define_subagent', 'browser_subagent']) assert.equal(kind(n), 'agent', n)
    assert.equal(agyToolKind(undefined), 'other')
    assert.equal(agyToolKind('shell_exec'), 'bash')
  })

  test('SessionStart/Stop không có toolCall vẫn là agy; workspacePaths làm cwd khi thiếu cwd', () => {
    assert.deepEqual(normalize({ hookEventName: 'SessionStart', cwd: '/proj', conversationId: 'c' }), { host: 'agy', event: 'SessionStart', tool: 'other', cwd: '/proj' })
    assert.equal(normalize({ hookEventName: 'Stop', workspacePaths: ['/w'], terminationReason: 'NO_TOOL_CALL' }).cwd, '/w')
  })

  test('không lẫn: payload Claude (snake_case) vẫn claude, Codex có turn_id vẫn codex, thiếu CommandLine ⇒ không có command', () => {
    assert.equal(normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/p' }).host, 'claude')
    assert.equal(normalize({ hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/p' }).host, 'codex')
    assert.equal('command' in normalize({ hookEventName: 'PreToolUse', cwd: '/p', toolCall: { name: 'run_command', args: {} } }), false)
  })

  test('agyPreToolMatcher: khớp lệnh + ghi file, không khớp tool đọc; dùng được làm regex JS', () => {
    const re = new RegExp(agyPreToolMatcher())
    for (const n of [...AGY_BASH_TOOLS, 'write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'code_action', 'delete_directory', 'move_file', 'rename_file', 'create_file']) assert.match(n, re, n)
    for (const n of ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'read_url_content', 'command_status', 'search_web', 'invoke_subagent', 'xrun_command']) assert.doesNotMatch(n, re, n)
    assert.doesNotMatch(agyPreToolMatcher(), /\\|\(\?[<=!]|\(\?i/, 'chỉ dùng cú pháp chung của JS và RE2 (không lookaround, không cờ nội tuyến)')
  })
})

// ---------- PreToolUse: lệnh shell (cùng luật chặn như Claude) ----------

describe('pre-tool: run_command', () => {
  test('lệnh xoá thư mục hệ thống giả bị chặn; lời chặn là tiếng Việt đời thường', async () => {
    const r = await assertDeny(bash('rm -rf C:\\Windows\\khong-ton-tai'), /thư mục hệ thống/)
    assert.match(r.reason, /FLOW_OK=1/)
    await assertDeny(bash('rm -rf /usr/khong-ton-tai-vibe-test'))
    await assertDeny(bash('Remove-Item -Recurse -Force "C:\\Program Files\\khong-ton-tai"'))
    await assertDeny(bash('rmdir /s /q C:\\Windows\\khong-ton-tai'))
  })

  test('xoá thư mục tạm / lệnh vô hại ⇒ cho qua', async () => {
    const tmpTarget = path.join(TMP, 'xoa-duoc').replaceAll('\\', '/')
    await assertAllow(bash(`rm -rf ${tmpTarget}`))
    await assertAllow(bash('echo hello'))
    await assertAllow(bash('git status'))
    await assertAllow(bash('npm test'))
  })

  test('xoá database (DROP TABLE/DATABASE, supabase db reset) bị chặn; cùng câu SQL không qua client DB thì không', async () => {
    await assertDeny(bash('psql "$DATABASE_URL" -c "DROP TABLE users"'), /xoá/)
    await assertDeny(bash('mysql -e "DROP DATABASE app"'))
    await assertDeny(bash('supabase db reset'))
    await assertAllow(bash('echo "DROP TABLE users"'))
  })

  test('git push ép / xoá nhánh chính / reset --hard ở thư mục chính bị chặn; push ép nhánh khác thì qua', async () => {
    const fx = repoFixture()
    await assertDeny(bash('git push --force origin main', fx.main), /nhánh chính/)
    await assertDeny(bash('git push origin main --force-with-lease', fx.main))
    await assertDeny(bash('git push origin --delete main', fx.main))
    await assertDeny(bash('git reset --hard', fx.main))
    await assertDeny(bash('git branch -D main', fx.main))
    await assertAllow(bash('git push --force origin feat', fx.main))
    await assertAllow(bash('git push --force', fx.wt)) // HEAD = feat
  })

  test('đối số Cwd của run_command (tuyệt đối hoặc tương đối) quyết định repo được kiểm', async () => {
    const fx = repoFixture()
    await assertDeny(bash('git push --force origin main', TMP, { Cwd: fx.main }))
    await assertDeny(bash('git push --force origin main', fx.root, { Cwd: 'main' }))
    await assertAllow(bash('git push --force origin main', TMP)) // TMP không phải repo
  })

  test('git commit có secret trong phần đã stage ⇒ chặn, lý do nêu loại + 4 ký tự đầu, không lộ cả khoá', async () => {
    const fx = repoFixture()
    fs.writeFileSync(path.join(fx.main, 'cfg.js'), `export const k = '${GHP}'\n`)
    git(fx.main, 'add', 'cfg.js')
    const r = await assertDeny(bash('git commit -m them-cau-hinh', fx.main), /github/)
    assert.ok(!r.reason.includes(GHP) && !r.reason.includes(GHP.slice(0, 20)), 'lý do không được chứa giá trị khoá')
    assert.match(r.reason, /ghp_…/)
  })

  test('FLOW_OK= trong lệnh KHÔNG tự cho qua ở agy: trả ask (để user duyệt trong agy), kèm lý do cổng sẽ chặn; không còn bỏ qua mọi kiểm tra', async () => {
    for (const c of [
      'FLOW_OK=1 rm -rf C:\\Windows\\khong-ton-tai', '$env:FLOW_OK=1; rm -rf C:\\Windows\\khong-ton-tai', 'echo FLOW_OK=1 && rm -rf C:\\Windows\\khong-ton-tai',
      'rm -rf C:\\Windows\\khong-ton-tai # FLOW_OK=1', 'set FLOW_OK=1 && rmdir /s /q C:\\Windows\\khong-ton-tai',
    ]) {
      const r = await decide(bash(c))
      assert.equal(r.decision, 'ask', `${c}: ${JSON.stringify(r)}`)
      assert.match(r.reason, /duyệt/)
      assert.match(r.reason, /thư mục hệ thống/, 'nêu việc cổng sẽ chặn để user biết đang duyệt gì')
    }
    const fx = repoFixture()
    assert.equal((await decide(bash('FLOW_OK=1 git push --force origin main', fx.main))).decision, 'ask')
    assert.equal((await decide(bash('FLOW_OK=1 npm test'))).decision, 'ask', 'có FLOW_OK là phải hỏi, kể cả khi lệnh vô hại')
  })

  test('FLOW_OK không vượt được rào bảo vệ cấu hình của chính bộ chặn (vẫn deny, không phải ask)', async () => {
    const r = await decide(bash(`FLOW_OK=1 echo {} > ${HOME.replaceAll('\\', '/')}/.gemini/config/hooks.json`))
    assert.equal(r.decision, 'deny', JSON.stringify(r))
  })

  test('lệnh chỉ cần nhắc (grep -r) ⇒ cho qua kèm lời nhắc ở reason', async () => {
    const r = await assertAllow(bash('grep -rn foo .'))
    assert.match(r.reason ?? '', /Grep|rg/)
  })

  test('chạy qua tiến trình thật: stdout là JSON {"decision":...} đúng hợp đồng agy, exit 0', () => {
    const deny = runHook('pre-tool', bash('rm -rf C:\\Windows\\khong-ton-tai'))
    assert.equal(deny.status, 0)
    assert.equal(deny.json.decision, 'deny')
    assert.equal(typeof deny.json.reason, 'string')
    const ok = runHook('pre-tool', bash('echo hello'))
    assert.equal(ok.status, 0)
    assert.deepEqual(ok.json, { decision: 'allow' })
  })

  test('hồi quy Claude: hookBash strict và không-strict cho cùng kết quả khi cổng không lỗi', async () => {
    const fx = repoFixture()
    const gate = await import('./flow-gate.mjs')
    for (const [cmd, cwd] of [
      ['git push --force origin main', fx.main], ['git push --force origin feat', fx.main], ['rm -rf C:\\Windows\\x', TMP], ['echo hi', TMP],
      ['git reset --hard', fx.main], ['grep -rn a .', TMP], ['psql -c "DROP TABLE t"', TMP],
    ]) {
      const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd }
      assert.deepEqual(await gate.hookBash(input, { strict: true }), await gate.hookBash(input), cmd)
    }
  })

  test('import flow-gate.mjs không có tác dụng phụ (không đọc stdin, không in, không đặt exit code)', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(HOOKS_DIR, 'flow-gate.mjs')).href)}); console.log('ok')`],
      { input: '', encoding: 'utf8', timeout: 20000, env: { ...ENV, FLOW_GATE_LOG: process.env.FLOW_GATE_LOG } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'ok')
    assert.equal(r.stderr, '')
  })
})

// ---------- PreToolUse: ghi/sửa/xoá file ----------

describe('pre-tool: tool ghi file', () => {
  test('ghi vào thư mục hệ thống / cá nhân / .git bị chặn, với nhiều tên tool và nhiều tên khoá', async () => {
    const fx = repoFixture()
    await assertDeny(pre('write_to_file', { TargetFile: 'C:\\Windows\\System32\\evil.txt', CodeContent: 'x' }), /thư mục hệ thống/)
    await assertDeny(pre('write_file', { file_path: '/etc/passwd', content: 'x' }))
    await assertDeny(pre('edit_file', { path: `${HOME}/.ssh/authorized_keys`, new_string: 'x' }))
    await assertDeny(pre('write_file', { path: '~/.aws/credentials', content: 'x' }))
    await assertDeny(pre('replace_file_content', { TargetFile: 'C:\\Program Files\\App\\a.dll', TargetContent: 'a', ReplacementContent: 'b' }))
    await assertDeny(pre('write_file', { path: '.git/config', content: 'x' }, fx.main), /\.git/)
    await assertDeny(pre('code_action', { AbsolutePath: path.join(fx.main, '.git', 'hooks', 'pre-commit') }, fx.main))
    await assertDeny(pre('delete_directory', { DirectoryPath: 'C:\\Windows\\System32' }))
    await assertDeny(pre('move', { SourcePath: path.join(TMP, 'a'), DestinationPath: 'C:\\Program Files\\x' }))
  })

  test('ghi trong dự án / thư mục tạm, kể cả .github và .gitignore, ⇒ cho qua', async () => {
    const fx = repoFixture()
    await assertAllow(pre('write_to_file', { TargetFile: path.join(fx.main, 'src', 'a.ts'), CodeContent: 'export const a = 1\n' }, fx.main))
    await assertAllow(pre('write_file', { path: 'src/b.ts', content: 'x' }, fx.main))
    await assertAllow(pre('replace_file_content', { TargetFile: path.join(os.tmpdir(), 'agy-ok.txt'), TargetContent: 'a', ReplacementContent: 'b' }))
    await assertAllow(pre('write_file', { path: '.github/workflows/ci.yml', content: 'on: push' }, fx.main))
    await assertAllow(pre('write_file', { path: '.gitignore', content: 'node_modules' }, fx.main))
    await assertAllow(pre('delete_file', { path: path.join(TMP, 'x.txt') }))
    await assertAllow(pre('code_action', { foo: 'bar' })) // tên khoá lạ, không có đường dẫn, không có secret
  })

  test('khoá chứa nội dung (TargetContent, CodeContent, old_string) không bị coi là đường dẫn: sửa chữ ".git" / "C:\\Windows" trong file thường được', async () => {
    const fx = repoFixture()
    await assertAllow(pre('replace_file_content', { TargetFile: path.join(fx.main, '.gitignore'), TargetContent: '.git', ReplacementContent: '.git/\n.env' }, fx.main))
    await assertAllow(pre('multi_replace_file_content', { TargetFile: path.join(fx.main, 'README.md'), ReplacementChunks: [{ TargetContent: 'C:\\Windows', ReplacementContent: 'D:\\Win' }] }, fx.main))
    await assertAllow(pre('write_file', { path: path.join(fx.main, 'doc.md'), content: 'C:\\Windows\\System32', description: '.git' }, fx.main))
    await assertDeny(pre('replace_file_content', { TargetFile: 'C:\\Windows\\win.ini', TargetContent: 'a', ReplacementContent: 'b' }, fx.main)) // đường dẫn thật vẫn bị chặn
  })

  test('nội dung có secret bị chặn (kể cả lồng trong mảng chunk); lý do không lộ cả khoá', async () => {
    const r = await assertDeny(pre('write_to_file', { TargetFile: path.join(TMP, 'cfg.js'), CodeContent: `const k = '${GHP}'\n` }), /github/)
    assert.ok(!r.reason.includes(GHP))
    await assertDeny(pre('multi_replace_file_content', { TargetFile: path.join(TMP, 'a.ts'), ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: `k="AKIA${'Q3EGRDLMZ7XK2PWN'}"` }] }), /aws/)
    await assertDeny(pre('edit_file', { path: path.join(TMP, 'a.env.example'), new_string: `K=${GHP}` })) // .env.example không phải chỗ để khoá thật
  })

  test('file .env / khoá (chỗ để khoá) cho ghi khoá; dòng có dấu allow-secret và giá trị giữ chỗ cho qua', async () => {
    await assertAllow(pre('write_file', { path: path.join(TMP, '.env'), content: `GITHUB_TOKEN=${GHP}\n` }))
    await assertAllow(pre('write_file', { path: path.join(TMP, '.env.local'), content: `GITHUB_TOKEN=${GHP}\n` }))
    await assertAllow(pre('write_file', { path: path.join(TMP, 'a.txt'), content: `token = '${GHP}' // flow-gate: allow-secret\n` }))
    await assertAllow(pre('write_file', { path: path.join(TMP, 'a.txt'), content: 'OPENAI_API_KEY=sk-xxxx\n' }))
  })

  test('tool đọc (view_file) trên đường dẫn hệ thống không bị chặn: kit chỉ gác việc ghi/xoá', async () => {
    await assertAllow(pre('view_file', { AbsolutePath: 'C:\\Windows\\win.ini' }))
    await assertAllow(pre('list_dir', { DirectoryPath: 'C:\\Windows' }))
  })
})

// ---------- PreToolUse: khoá đường dẫn (chuẩn hoá .., khoá path rõ ràng, đích thật, cấu hình tự bảo vệ) ----------

const H = HOME.replaceAll('\\', '/') // HOME giả viết kiểu gạch xuôi (dùng trong lệnh shell)
const inHome = (...s) => path.join(HOME, ...s)
function linkDir(t, target, at) {
  try { fs.symlinkSync(target, at, 'junction'); return true } catch (e) { t.skip(`không tạo được liên kết thư mục: ${e.code}`); return false }
}

describe('pre-tool: chuẩn hoá .. và chỉ tin khoá đường dẫn rõ ràng', () => {
  test('đường dẫn có .. đi vòng qua thư mục tạm vào thư mục hệ thống/cá nhân vẫn bị chặn (ổ đĩa, /, ~)', async () => {
    for (const p of ['C:\\Windows\\Temp\\..\\System32\\x.dll', 'C:/Windows/Temp/../System32/x.dll', '/tmp/../etc/passwd', '~/tmp/../.ssh/authorized_keys', `${H}/tmp/../.ssh/authorized_keys`, 'C:\\Users\\..\\Windows\\x', '/usr/local/../bin/x']) {
      await assertDeny(pre('write_to_file', { TargetFile: p, CodeContent: 'x' }), /thư mục hệ thống/, { home: HOME })
    }
    await assertAllow(pre('write_to_file', { TargetFile: path.join(TMP, 'a', '..', 'b.txt'), CodeContent: 'x' }), { home: HOME }) // .. vẫn trong thư mục tạm
  })

  test('edit_file thật của agy {Path, Target, Replacement}: Target/Replacement là chữ cần thay, KHÔNG phải đường dẫn', async () => {
    const fx = repoFixture()
    const opt = { home: HOME }
    await assertAllow(pre('edit_file', { Path: '.env', Target: 'TOKEN=old', Replacement: `TOKEN=${GHP}` }, fx.main), opt) // file khoá: được ghi khoá
    await assertAllow(pre('edit_file', { Path: '.gitignore', Target: '.git', Replacement: '.git/' }, fx.main), opt)
    await assertAllow(pre('edit_file', { Path: 'README.md', Target: 'C:\\Windows\\System32', Replacement: 'D:\\Win' }, fx.main), opt)
    await assertAllow(pre('edit_file', { Path: 'README.md', Target: '/etc/passwd', Replacement: '~/.ssh/id_rsa' }, fx.main), opt)
    await assertDeny(pre('edit_file', { Path: 'C:\\Windows\\win.ini', Target: 'a', Replacement: 'b' }, fx.main), /thư mục hệ thống/, opt)
    await assertDeny(pre('edit_file', { Path: 'src/a.ts', Target: 'x', Replacement: `k = '${GHP}'` }, fx.main), /github/, opt) // nội dung mới vẫn bị quét khoá
  })

  test('chỉ các khoá đường dẫn rõ ràng được tin: Path, AbsolutePath, TargetFile, FilePath, path, file_path, DirectoryPath…; khoá lạ thì không', async () => {
    const opt = { home: HOME }
    for (const key of ['Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'path', 'file_path', 'DirectoryPath', 'directory_path', 'target_file', 'absolute_path', 'SourcePath', 'DestinationPath']) {
      await assertDeny(pre('write_file', { [key]: 'C:\\Windows\\System32\\x.dll', content: 'x' }), /thư mục hệ thống/, opt)
    }
    for (const key of ['Target', 'TargetContent', 'Replacement', 'ReplacementContent', 'Source', 'Query', 'Description', 'Instruction']) {
      await assertAllow(pre('edit_file', { Path: path.join(TMP, 'ok.txt'), [key]: 'C:\\Windows\\System32\\x.dll' }), opt)
    }
  })
})

describe('pre-tool: đường dẫn dài KHÔNG được bỏ qua', () => {
  const opt = { home: HOME }

  test('đường dẫn thô > 2048 ký tự (chèn ./ thừa) vẫn được chuẩn hoá rồi kiểm: .git / thư mục hệ thống / cấu hình tự bảo vệ ⇒ chặn; chuẩn hoá ngắn và vô hại ⇒ qua', async () => {
    const fx = repoFixture()
    const pad = './'.repeat(1500)
    assert.ok(`${pad}.git/config`.length > 2048)
    await assertDeny(pre('edit_file', { Path: `${pad}.git/config`, Target: 'a', Replacement: 'b' }, fx.main), /\.git/, opt)
    await assertDeny(pre('write_file', { path: `${pad}.git/hooks/pre-commit`, content: 'x' }, fx.main), /\.git/, opt)
    await assertDeny(pre('write_file', { path: `C:\\Windows\\${'.\\'.repeat(1500)}System32\\x.dll`, content: 'x' }, fx.main), /thư mục hệ thống/, opt)
    await assertDeny(pre('write_file', { path: `${H}/${'./'.repeat(1500)}.gemini/config/hooks.json`, content: 'x' }, fx.main), /cấu hình/, opt)
    await assertDeny(pre('write_file', { path: `${'//'.repeat(1200)}etc/passwd`, content: 'x' }, fx.main), /thư mục hệ thống/, opt)
    await assertAllow(pre('write_file', { path: `${pad}src/ok.ts`, content: 'x' }, fx.main), opt)
  })

  test('chuẩn hoá xong vẫn quá giới hạn kiểm (4096) ⇒ deny, không cho qua lặng lẽ; mọi tên công cụ ghi', async () => {
    const fx = repoFixture()
    for (const [tool, key] of [['write_file', 'path'], ['edit_file', 'Path'], ['write_to_file', 'TargetFile'], ['delete_file', 'AbsolutePath']]) {
      const r = await decide(pre(tool, { [key]: `${'a/'.repeat(3000)}x.txt`, content: 'x' }, fx.main), opt)
      assert.equal(r.decision, 'deny', `${tool}: ${JSON.stringify(r).slice(0, 200)}`)
      assert.match(r.reason, /quá dài/)
    }
    assert.equal((await decide(pre('write_file', { path: 'x'.repeat(100000), content: 'x' }, fx.main), opt)).decision, 'deny')
    await assertAllow(pre('write_file', { path: `${'a/'.repeat(1000)}x.txt`, content: 'x' }, fx.main), opt) // dài nhưng dưới giới hạn ⇒ vẫn kiểm bình thường
  })
})

describe('pre-tool: ghi theo ĐÍCH THẬT (realpath của file hoặc thư mục cha gần nhất đang tồn tại)', () => {
  test('liên kết (junction/symlink) trong dự án trỏ tới .git ⇒ chặn, kể cả file chưa tồn tại dưới thư mục liên kết', async (t) => {
    const fx = repoFixture()
    const link = path.join(fx.main, 'lk')
    if (!linkDir(t, path.join(fx.main, '.git'), link)) return
    await assertDeny(pre('write_file', { path: path.join(link, 'config'), content: 'x' }, fx.main), /\.git/, { home: HOME })
    await assertDeny(pre('write_file', { path: 'lk/hooks/pre-commit', content: 'x' }, fx.main), /\.git/, { home: HOME })
    await assertDeny(pre('write_file', { path: path.join(link, 'moi', 'sau', 'x.txt'), content: 'x' }, fx.main), /\.git/, { home: HOME })
  })

  test('liên kết trỏ tới thư mục hệ thống / thư mục cấu hình tự bảo vệ ⇒ chặn; liên kết tới thư mục thường ⇒ qua', async (t) => {
    const fx = repoFixture()
    fs.mkdirSync(inHome('.gemini', 'config'), { recursive: true })
    const lkCfg = path.join(fx.main, 'cau-hinh')
    if (!linkDir(t, inHome('.gemini', 'config'), lkCfg)) return
    await assertDeny(pre('edit_file', { Path: path.join(lkCfg, 'hooks.json'), Target: 'a', Replacement: 'b' }, fx.main), /cấu hình/, { home: HOME })
    await assertDeny(pre('write_file', { path: 'cau-hinh/mcp_config.json', content: '{}' }, fx.main), /cấu hình/, { home: HOME })
    const sys = path.join(fx.main, 'he-thong')
    const sysTarget = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc'
    if (linkDir(t, sysTarget, sys)) await assertDeny(pre('write_file', { path: path.join(sys, 'khong-ton-tai-vibe.txt'), content: 'x' }, fx.main), /thư mục hệ thống/, { home: HOME })
    const okDir = path.join(fx.main, 'src')
    fs.mkdirSync(okDir)
    const okLink = path.join(fx.main, 'ln-ok')
    if (linkDir(t, okDir, okLink)) await assertAllow(pre('write_file', { path: path.join(okLink, 'a.ts'), content: 'x' }, fx.main), { home: HOME })
  })
})

describe('pre-tool: bảo vệ cấu hình gác chính nó (hooks, quyền, MCP, agent, mã bộ chặn)', () => {
  const PROTECTED = [
    ['.gemini', 'config', 'hooks.json'], ['.gemini', 'config', 'mcp_config.json'], ['.gemini', 'antigravity-cli', 'settings.json'], ['.gemini', 'settings.json'],
    ['.gemini', 'config', 'agents', 'coder.md'], ['.gemini', 'config', 'agents', 'moi', 'agent.md'], ['.gemini', 'AGENTS.md'],
    ['.claude', 'hooks', 'agy-hook.mjs'], ['.claude', 'hooks', 'lib', 'secrets.mjs'], ['.claude', 'settings.json'], ['.claude', 'kit', 'roles.json'],
  ]
  const opt = { home: HOME }

  test('công cụ ghi/sửa/xoá vào các file đó bị chặn (đủ tên tool, tên khoá, kiểu viết đường dẫn)', async () => {
    for (const rel of PROTECTED) {
      for (const [tool, key] of [['write_to_file', 'TargetFile'], ['edit_file', 'Path'], ['write_file', 'AbsolutePath'], ['replace_file_content', 'TargetFile'], ['delete_file', 'path']]) {
        await assertDeny(pre(tool, { [key]: inHome(...rel), Replacement: 'x' }), /cấu hình/, opt)
      }
    }
    await assertDeny(pre('write_file', { Path: '~/.gemini/config/hooks.json', content: '{}' }), /cấu hình/, opt)
    await assertDeny(pre('write_file', { Path: '~/x/../.gemini/config/hooks.json', content: '{}' }), /cấu hình/, opt)
    await assertDeny(pre('write_file', { Path: `${H}/.GEMINI/Config/HOOKS.JSON`, content: '{}' }), /cấu hình/, opt)
    if (process.platform === 'win32') await assertDeny(pre('write_file', { Path: inHome('.gemini', 'config', 'hooks.json').replaceAll('/', '\\'), content: '{}' }), /cấu hình/, opt)
  })

  test('xoá/di chuyển CẢ thư mục chứa cấu hình (cha của file được bảo vệ) cũng bị chặn; tạo file mới trong thư mục agent/hooks/kit cũng chặn', async () => {
    for (const dir of [['.gemini'], ['.gemini', 'config'], ['.gemini', 'antigravity-cli'], ['.claude', 'hooks'], ['.claude', 'kit'], ['.gemini', 'config', 'agents']]) {
      await assertDeny(pre('delete_directory', { DirectoryPath: inHome(...dir) }), /cấu hình/, opt)
      await assertDeny(pre('move', { SourcePath: inHome(...dir), DestinationPath: path.join(TMP, 'dich') }), /cấu hình/, opt)
    }
    await assertDeny(pre('write_file', { path: inHome('.claude', 'hooks', 'moi.mjs'), content: 'x' }), /cấu hình/, opt)
  })

  test('file lân cận KHÔNG bị chặn: skill, GEMINI.md, dự án khác, .claude/settings.json của dự án, .agents/hooks.json của dự án, worktree của kit', async () => {
    const fx = repoFixture()
    for (const [p, cwd] of [
      [inHome('.gemini', 'config', 'skills', 'flow-x', 'SKILL.md'), TMP], [inHome('.gemini', 'GEMINI.md'), TMP], [inHome('.gemini', 'config', 'plugins', 'p', 'a.md'), TMP],
      [inHome('.claude', 'projects', 'x', 'm.md'), TMP], [inHome('.claude', '.claude', 'worktrees', 'w', 'hooks', 'agy-hook.mjs'), TMP], [inHome('.claude', 'CLAUDE.md'), TMP],
      [path.join(fx.main, '.claude', 'settings.json'), fx.main], ['.agents/hooks.json', fx.main], ['.claude/hooks/x.mjs', fx.main], [path.join(fx.main, 'kit', 'roles.json'), fx.main],
      [inHome('Documents', 'hooks.json'), TMP],
    ]) await assertAllow(pre('write_file', { path: p, content: 'x' }, cwd), opt)
  })

  test('lệnh shell ghi vào các file đó bị chặn: redirect, cp/mv, tee, sed -i, Set-Content, Out-File, rm, bash/powershell/cmd -c, node/python -e, cd rồi ghi file tương đối', async () => {
    const hooks = `${H}/.gemini/config/hooks.json`
    for (const c of [
      `echo {} > ${hooks}`, `echo {}>${hooks}`, `echo {} >> "${hooks}"`, `echo {} > "${inHome('.gemini', 'config', 'hooks.json')}"`, `1> ${hooks} echo x`, `cat evil.json > ${H}/.gemini/config/mcp_config.json`,
      `echo x > ~/.gemini/config/hooks.json`, `echo x > $HOME/.gemini/config/hooks.json`, `echo x > \${HOME}/.gemini/config/hooks.json`, `echo x > $env:USERPROFILE\\.gemini\\config\\hooks.json`, `echo x > %USERPROFILE%\\.gemini\\config\\hooks.json`,
      `cp evil.json ${hooks}`, `copy evil.json "${H}/.gemini/config/mcp_config.json"`, `mv evil.mjs ${H}/.claude/hooks/agy-hook.mjs`, `move x ${H}/.claude/settings.json`, `install -m 644 evil ${H}/.claude/kit/roles.json`,
      `cp -r evil ${H}/.claude/hooks/`, `mv ${H}/.claude/hooks /tmp/hooks-cu`, `ln -sf /tmp/evil ${H}/.gemini/config/hooks.json`,
      `echo x | tee ${H}/.gemini/AGENTS.md`, `echo x | tee -a ${H}/.gemini/settings.json`, `sed -i s/a/b/ ${H}/.claude/kit/roles.json`, `perl -pi -e 's/a/b/' ${H}/.claude/settings.json`,
      `rm ${hooks}`, `rm -rf ${H}/.gemini/config`, `rm -rf ${H}/.gemini`, `del ${inHome('.gemini', 'antigravity-cli', 'settings.json')}`, `Remove-Item -Force ${hooks}`, `rd /s /q ${inHome('.claude', 'hooks')}`, `truncate -s 0 ${hooks}`,
      `Set-Content -Path "${inHome('.gemini', 'antigravity-cli', 'settings.json')}" -Value '{}'`, `Set-Content ${hooks} '{}'`, `'x' | Out-File ${inHome('.claude', 'settings.json')}`, `Add-Content -Path ${hooks} -Value x`, `New-Item -Path ${hooks} -Force`,
      `Copy-Item evil.json -Destination ${hooks}`, `Move-Item x ${H}/.gemini/config/agents/coder.md`, `Rename-Item ${hooks} hooks.bak`, `Clear-Content ${hooks}`,
      `bash -c "echo x > ${hooks}"`, `sh -c 'cp evil ${hooks}'`, `powershell -Command "Set-Content ${inHome('.gemini', 'config', 'hooks.json')} x"`, `pwsh -c "'x' | Out-File ${hooks}"`, `cmd /c "echo x> ${inHome('.gemini', 'config', 'hooks.json')}"`,
      `node -e "require('fs').writeFileSync('${hooks}','{}')"`, `python -c "open('${hooks}','w').write('x')"`, `node -e "fs.writeFileSync(os.homedir()+'/.gemini/config/hooks.json','{}')"`,
      `cd ${H}/.gemini/config && echo {} > hooks.json`, `pushd ${H}/.claude/hooks; echo x > agy-hook.mjs`, `cd ${H}/.gemini && echo x > AGENTS.md`, `Set-Location ${inHome('.gemini', 'config')}; Set-Content hooks.json x`,
      `ls; echo x > ${hooks}; ls`, `echo x > $UNKNOWN/.gemini/config/hooks.json`, `echo x > $SOME\\hooks.json`,
    ]) {
      const r = await decide(bash(c, TMP), opt)
      assert.equal(r.decision, 'deny', `đáng lẽ chặn: ${c} ⇒ ${JSON.stringify(r)}`)
      assert.match(r.reason, /cấu hình/, c)
    }
  })

  test('đứng sẵn trong thư mục cấu hình: ghi file tương đối vào đó cũng bị chặn', async () => {
    fs.mkdirSync(inHome('.gemini', 'config'), { recursive: true })
    for (const c of ['echo {} > hooks.json', 'cp evil.json mcp_config.json', 'Set-Content hooks.json x', 'rm hooks.json', 'echo x > agents/coder.md']) {
      await assertDeny(bash(c, inHome('.gemini', 'config')), /cấu hình/, opt)
    }
    await assertAllow(bash('echo x > skills/new.md', inHome('.gemini', 'config')), opt)
    await assertAllow(bash('cat hooks.json', inHome('.gemini', 'config')), opt)
  })

  test('sao chép/di chuyển VÀO thư mục được bảo vệ hoặc thư mục chứa file được bảo vệ ⇒ chặn (tên đích = tên nguồn); tên khác / chỗ khác thì qua', async () => {
    for (const d of [['.gemini', 'config', 'agents'], ['.gemini', 'config', 'skills'], ['.gemini', 'antigravity-cli'], ['.claude', 'hooks'], ['.claude', 'kit']]) fs.mkdirSync(inHome(...d), { recursive: true })
    const cfg = `${H}/.gemini/config`
    for (const c of [
      `cp ./hooks.json ${cfg}/`, `cp hooks.json ${cfg}`, `cp evil/hooks.json ${cfg}/`, `cp ./mcp_config.json ${cfg}/`, `cp -f ./hooks.json "${cfg}/"`, `cp ./settings.json ${H}/.gemini/antigravity-cli/`,
      `cp ./settings.json ${H}/.gemini/`, `cp AGENTS.md ${H}/.gemini/`, `cp settings.json ${H}/.claude/`, `cp -r hooks ${H}/.claude/`, `cp -r kit ${H}/.claude`, `cp roles.json ${H}/.claude/kit/`, `cp coder.md ${cfg}/agents/`,
      `copy hooks.json ${cfg}/`, `copy /y hooks.json ${cfg}`, `xcopy hooks.json ${cfg}/`, `Copy-Item ./hooks.json -Destination ${cfg}`, `Copy-Item hooks.json ${cfg}/`, `Copy-Item -Path ./hooks.json -Destination "${cfg}"`,
      `cp -t ${cfg} hooks.json`, `cp --target-directory ${cfg} ./x/hooks.json`, `install -m 644 hooks.json ${cfg}/`,
      `cp -r ./dir/. ${cfg}/`, `cp ./*.json ${cfg}/`, `cp $F ${cfg}/`, `cp "$SRC" ${cfg}/`, `cp -r .. ${cfg}`, `cp a b hooks.json ${cfg}/`,
      `robocopy ./evil ${cfg}`, `robocopy ./evil "${cfg}" hooks.json`, `rsync -a ./evil/ ${cfg}/`, `scp user@host:hooks.json ${cfg}/`,
      `mv ./hooks.json ${cfg}/`, `mv hooks.json ${cfg}`, `mv -t ${cfg} hooks.json`, `Move-Item ./hooks.json -Destination ${cfg}`, `move hooks.json ${cfg}/`,
    ]) {
      const r = await decide(bash(c, TMP), opt)
      assert.equal(r.decision, 'deny', `đáng lẽ chặn: ${c} ⇒ ${JSON.stringify(r)}`)
      assert.match(r.reason, /cấu hình/, c)
    }
    for (const c of [
      `cp notes.txt ${cfg}/`, `cp x.md ${cfg}/skills/`, `cp hooks.json ${cfg}/skills/`, `cp hooks.json ${cfg}/skills`, `cp ./hooks.json ${TMP.replaceAll('\\', '/')}/`, `cp a.txt ${H}/`, `cp -r evil ${H}/.claude/`, `cp x ${H}/.gemini/GEMINI.md`,
      `cp -r skill-moi ${cfg}/skills/`, `cp settings.json ${H}/.gemini/config/skills/s/`, `cp hooks.json ${H}/.claude/projects/`, `cp ${cfg}/hooks.json ${TMP.replaceAll('\\', '/')}/hooks.bak`,
      `cp -r src ${cfg}/`, `cp coder.md ${H}/.claude/agents/`, `mv notes.txt ${H}/ghi-chu/`,
    ]) {
      const r = await decide(bash(c, TMP), opt)
      assert.notEqual(r.decision, 'deny', `đáng lẽ không chặn: ${c} ⇒ ${JSON.stringify(r)}`)
    }
  })

  test('POSIX: alias/../hooks.json — liên kết đứng trước ".." thì ".." tính từ đích THẬT của liên kết (bộ chặn không được rút ".." theo chữ rồi mới phân giải)', { skip: process.platform === 'win32' ? 'chỉ posix: Windows rút ".." theo chữ trước khi mở file' : false }, async () => {
    fs.mkdirSync(inHome('.gemini', 'config', 'agents'), { recursive: true })
    const proj = path.join(TMP, `alias-proj-${++seq}`)
    fs.mkdirSync(proj)
    fs.symlinkSync(inHome('.gemini', 'config', 'agents'), path.join(proj, 'alias'))
    for (const c of ['echo x > alias/../hooks.json', 'echo x > alias/../mcp_config.json', 'cp evil.json alias/../hooks.json', 'rm alias/../hooks.json', `echo x > ${proj}/alias/../hooks.json`, 'echo x > ./alias/./../hooks.json', 'Set-Content alias/../hooks.json x']) {
      await assertDeny(bash(c, proj), /cấu hình/, opt)
    }
    for (const p of ['alias/../hooks.json', `${proj}/alias/../mcp_config.json`, 'alias/../../config/hooks.json']) {
      await assertDeny(pre('write_file', { path: p, content: 'x' }, proj), /cấu hình/, opt)
      await assertDeny(pre('edit_file', { Path: p, Target: 'a', Replacement: 'b' }, proj), /cấu hình/, opt)
    }
    await assertAllow(pre('write_file', { path: 'alias/../ghi-chu.txt', content: 'x' }, proj), opt) // .. từ đích thật vẫn trong ~/.gemini/config nhưng file không được bảo vệ
    await assertAllow(bash('echo x > alias/../ghi-chu.txt', proj), opt)
  })

  test('lệnh chỉ ĐỌC hoặc chạy script của kit KHÔNG bị chặn (cat, ls, cp từ hooks ra ngoài, node ~/.claude/hooks/x.mjs, git -C hooks log, 2>&1)', async () => {
    const hooks = `${H}/.gemini/config/hooks.json`
    for (const c of [
      `cat ${hooks}`, `cat ${hooks} 2>&1`, `type "${H.replaceAll('/', '\\')}\\.gemini\\config\\hooks.json"`, `Get-Content ${hooks}`, `ls ${H}/.gemini/config`, `ls ${H}/.claude/hooks | head`, `rg foo ${H}/.claude/kit`, `head -5 ${H}/.claude/settings.json`,
      `node ${H}/.claude/hooks/lib/so-chot.mjs tim ${TMP.replaceAll('\\', '/')} '{"query":"x"}'`, `node ${H}/.claude/hooks/models.mjs list > ${TMP.replaceAll('\\', '/')}/models.txt`, `node ${H}/.claude/hooks/cli-check.mjs codex 2>/dev/null`,
      `cp ${H}/.claude/hooks/a.mjs ${TMP.replaceAll('\\', '/')}/a.mjs`, `cp ${hooks} ${TMP.replaceAll('\\', '/')}/hooks.bak`, `git -C ${H}/.claude/hooks log --oneline`, `diff ${hooks} other.json`,
      `echo hi > ${H}/ghi-chu.txt`, `echo x > ${H}/.gemini/config/skills/s/SKILL.md`, `cp x ${H}/.gemini/GEMINI.md`, `echo x > notes.md`, `cd ${H}/.gemini/config/skills && echo x > a.md`,
      `echo "hooks.json la file cau hinh"`, `grep -n "hooks.json" README.md`, `node -e "console.log(1)"`, `python -c "print(1)"`, `echo x > ${path.join(TMP, 'hooks.json').replaceAll('\\', '/')}`,
    ]) {
      const r = await decide(bash(c, TMP), opt)
      assert.notEqual(r.decision, 'deny', `đáng lẽ không chặn: ${c} ⇒ ${JSON.stringify(r)}`)
    }
  })
})

// ---------- PreToolUse: fail-closed ----------

describe('pre-tool: fail-closed (mọi lỗi ⇒ deny)', () => {
  test('payload không đúng dạng ⇒ deny: thiếu toolCall, thiếu name, payload kiểu Claude, null, mảng', async () => {
    for (const raw of [
      { hookEventName: 'PreToolUse', cwd: TMP }, { hookEventName: 'PreToolUse', toolCall: {} }, { hookEventName: 'PreToolUse', toolCall: { name: '', args: {} } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, null, [], 'run_command', 7,
    ]) await assertDeny(raw, /fail-closed/)
  })

  test('run_command không có CommandLine ⇒ deny (không kiểm được thì không cho chạy)', async () => {
    await assertDeny(pre('run_command', {}), /fail-closed/)
    await assertDeny(pre('run_command', { CommandLine: 42 }), /fail-closed/)
  })

  test('lỗi BÊN TRONG phép kiểm (cổng ném lỗi / trả kết quả lạ / import hỏng) ⇒ deny, log chỉ ghi loại lỗi', async () => {
    const boom = { hookBash: async () => { throw new Error(`SECRET-IN-ERROR ${GHP}`) }, systemTarget: () => null, normPath: (p) => p }
    await assertDeny(bash('echo hi'), /fail-closed/, { home: HOME, gate: boom })
    await assertDeny(pre('write_file', { path: 'a.txt', content: 'x' }), /fail-closed/, { home: HOME, gate: { ...boom, systemTarget: () => { throw new TypeError('hỏng') } } })
    await assertDeny(bash('echo hi'), /fail-closed/, { home: HOME, gate: { ...boom, hookBash: async () => ({ lạ: true }) } })
    await assertDeny(bash('echo hi'), /fail-closed/, { home: HOME, gate: { ...boom, hookBash: async () => ({ hookSpecificOutput: { permissionDecision: 'cho-qua-di' } }) } })
    const log = fs.readFileSync(process.env.AGY_HOOK_LOG, 'utf8')
    assert.match(log, /lỗi nội bộ tool=run_command: Error/)
    assert.ok(!log.includes('SECRET-IN-ERROR') && !log.includes(GHP), 'log không được chứa nội dung lỗi/khoá')
  })

  test('cổng ném lỗi: deny; cổng báo deny: giữ nguyên lý do; cổng báo ask: chuyển ask', async () => {
    const gate = (out) => ({ hookBash: async () => out, systemTarget: () => null, normPath: (p) => p })
    const d = await decide(bash('x'), { home: HOME, gate: gate({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'vì A' } }) })
    assert.deepEqual(d, { decision: 'deny', reason: 'vì A' })
    const a = await decide(bash('x'), { home: HOME, gate: gate({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'hỏi' } }) })
    assert.deepEqual(a, { decision: 'ask', reason: 'hỏi' })
    assert.deepEqual(await decide(bash('x'), { home: HOME, gate: gate(null) }), { decision: 'allow' })
  })

  test('tiến trình thật: stdin hỏng / rỗng / toàn khoảng trắng ⇒ deny, exit 0, stdout là JSON hợp lệ', () => {
    for (const input of ['không phải json', '{', '', '   \n', '[]', 'null']) {
      const r = runHook('pre-tool', input)
      assert.equal(r.status, 0, `input ${JSON.stringify(input)}`)
      assert.equal(r.json?.decision, 'deny', `input ${JSON.stringify(input)}: ${r.stdout}`)
      assert.match(r.json.reason, /fail-closed/)
    }
  })

  test('tiến trình thật: tiến trình con chết / treo quá giờ / in rác / thoát khác 0 / không tồn tại ⇒ deny', () => {
    const input = bash('echo hi')
    const cases = {
      'thoát mã 1': script('inner-exit1.mjs', 'process.exit(1)\n'),
      'ném lỗi': script('inner-throw.mjs', 'throw new Error("hỏng")\n'),
      'in rác': script('inner-garbage.mjs', 'process.stdout.write("xin chào")\n'),
      'JSON không có decision': script('inner-nodec.mjs', 'process.stdout.write("{}")\n'),
      'decision lạ': script('inner-baddec.mjs', 'process.stdout.write(JSON.stringify({ decision: "yes" }))\n'),
      'reason không phải chuỗi': script('inner-badreason.mjs', 'process.stdout.write(JSON.stringify({ decision: "allow", reason: 5 }))\n'),
      'im lặng exit 0': script('inner-silent.mjs', '\n'),
      'treo': script('inner-hang.mjs', 'setInterval(() => {}, 1000)\n'),
      'file không tồn tại': path.join(TMP, 'khong-co-file-nay.mjs'),
    }
    for (const [name, file] of Object.entries(cases)) {
      const t0 = Date.now()
      const r = runHook('pre-tool', input, { AGY_HOOK_INNER_SCRIPT: file, AGY_HOOK_TIMEOUT_MS: '1500' })
      assert.equal(r.json?.decision, 'deny', `${name}: ${r.stdout}`)
      assert.ok(Date.now() - t0 < 10000, `${name}: không được chờ quá hạn`)
    }
  })

  test('tiến trình con trả quyết định hợp lệ thì tiến trình ngoài chuyển nguyên (allow/ask/deny)', () => {
    for (const out of [{ decision: 'allow' }, { decision: 'ask', reason: 'hỏi nhé' }, { decision: 'deny', reason: 'không' }]) {
      const file = script('inner-ok.mjs', `process.stdout.write(${JSON.stringify(JSON.stringify(out))})\n`)
      assert.deepEqual(runHook('pre-tool', bash('x'), { AGY_HOOK_INNER_SCRIPT: file }).json, out)
    }
  })

  test('preToolOuter gọi trực tiếp: timeout nhỏ ⇒ deny nêu "quá giờ"', () => {
    const r = preToolOuter(JSON.stringify(bash('x')), { script: script('inner-hang2.mjs', 'setInterval(() => {}, 1000)\n'), timeoutMs: 600 })
    assert.equal(r.decision, 'deny')
    assert.match(r.reason, /quá giờ/)
  })

  test('log không ghi lệnh hay nội dung đã bị chặn', async () => {
    await decide(bash(`echo ${GHP} && rm -rf C:\\Windows\\log-check`))
    const log = fs.readFileSync(process.env.AGY_HOOK_LOG, 'utf8')
    assert.match(log, /deny tool=run_command kind=bash/)
    assert.ok(!log.includes(GHP) && !log.includes('log-check'))
  })

  test('AGY_HOOK_TRACE=1 ghi cả lần cho qua (để xem tên tool thật của agy)', async () => {
    process.env.AGY_HOOK_TRACE = '1'
    try { await decide(pre('tool_la_hoac_moi', {})) } finally { delete process.env.AGY_HOOK_TRACE }
    assert.match(fs.readFileSync(process.env.AGY_HOOK_LOG, 'utf8'), /allow tool=tool_la_hoac_moi kind=other/)
  })
})

// ---------- Stop ----------

describe('stop', () => {
  const gate = (out) => ({ hookStop: async (i) => (typeof out === 'function' ? out(i) : out) })

  test('hookStop báo block ⇒ {"decision":"continue","reason"}; còn lại ⇒ {"decision":"stop"}', async () => {
    assert.deepEqual(await decideStop({ cwd: TMP, terminationReason: 'NO_TOOL_CALL' }, { gate: gate({ decision: 'block', reason: 'thiếu review' }) }), { decision: 'continue', reason: 'thiếu review' })
    assert.deepEqual(await decideStop({ cwd: TMP }, { gate: gate(null) }), { decision: 'stop' })
  })

  test('chỉ nhắc khi agent kết thúc bình thường; lỗi/huỷ/hết lượt ⇒ cho dừng; continuationActive truyền thành stop_hook_active', async () => {
    const block = gate({ decision: 'block', reason: 'x' })
    for (const why of ['ERROR', 'USER_CANCELED', 'MAX_INVOCATIONS']) assert.deepEqual(await decideStop({ cwd: TMP, terminationReason: why }, { gate: block }), { decision: 'stop' })
    let seen
    await decideStop({ cwd: TMP, continuationActive: true }, { gate: gate((i) => { seen = i; return null }) })
    assert.equal(seen.stop_hook_active, true)
    assert.equal(seen.cwd, TMP)
  })

  test('cwd rỗng / khoảng trắng / không phải chuỗi ⇒ dùng workspacePaths[0], không rơi về thư mục của tiến trình hook', async () => {
    for (const cwd of ['', '   ', null, 5]) {
      let seen
      await decideStop({ cwd, workspacePaths: ['/du-an-cua-phien'], terminationReason: 'NO_TOOL_CALL' }, { gate: gate((i) => { seen = i; return null }) })
      assert.equal(seen.cwd, '/du-an-cua-phien', JSON.stringify(cwd))
    }
    let seen
    await decideStop({ workspacePaths: ['', '/ws2'] }, { gate: gate((i) => { seen = i; return null }) })
    assert.equal(seen.cwd, '/ws2', 'bỏ qua phần tử rỗng đầu danh sách')
  })

  test('cổng lỗi hoặc payload lạ ⇒ cho dừng (không giữ phiên lại vì lỗi của hook)', async () => {
    assert.deepEqual(await decideStop({ cwd: TMP }, { gate: { hookStop: async () => { throw new Error('x') } } }), { decision: 'stop' })
    assert.deepEqual(await decideStop(null), { decision: 'stop' })
  })

  // Chạy qua tiến trình con có cwd = thư mục tạm (như flow-gate.test.mjs): kết quả của hookStop phụ thuộc thư mục làm việc của TIẾN TRÌNH (đo trên WSL: chạy từ một worktree git
  // thì flow-gate.mjs stop chạy trực tiếp cũng im lặng, từ chỗ khác thì chặn) — tiến trình con có cwd sạch giúp test không phụ thuộc nơi chạy.
  test('hookStop thật: nhánh feat đã commit mà thiếu dấu review/qa/test ⇒ continue một lần rồi stop', () => {
    const fx = repoFixture()
    fs.writeFileSync(path.join(fx.wt, 'feat.go'), 'package feat\n')
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'feat')
    const stop = () => runHook('stop', { hookEventName: 'Stop', cwd: fx.wt, terminationReason: 'NO_TOOL_CALL' })
    const first = stop()
    assert.equal(first.json?.decision, 'continue', first.stdout)
    assert.match(first.json.reason, /thiếu: review, qa, test/)
    assert.deepEqual(stop().json, { decision: 'stop' })
    assert.deepEqual(runHook('stop', { hookEventName: 'Stop', cwd: TMP, terminationReason: 'NO_TOOL_CALL' }).json, { decision: 'stop' })
  })
})

// ---------- SessionStart ----------

describe('session-start', () => {
  test('đổi additionalContext của session-start.mjs thành injectSteps của agy; truyền cwd + source', () => {
    const fake = script('ss-fake.mjs', `let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => { const p = JSON.parse(s); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'cwd=' + p.cwd + ';src=' + p.source + ';ev=' + p.hook_event_name } })) })\n`)
    assert.deepEqual(buildSessionStart({ hookEventName: 'SessionStart', cwd: '/du-an' }, { script: fake }), {
      injectSteps: [{ systemMessage: { systemMessage: 'cwd=/du-an;src=startup;ev=SessionStart' } }],
    })
    assert.match(buildSessionStart({ workspacePaths: ['/ws'] }, { script: fake }).injectSteps[0].systemMessage.systemMessage, /cwd=\/ws;/)
  })

  test('cwd rỗng ⇒ nạp theo workspacePaths[0] (không rơi về thư mục của tiến trình hook)', () => {
    const fake = script('ss-fake-cwd.mjs', `let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'cwd=' + JSON.parse(s).cwd } })) })\n`)
    for (const cwd of ['', '  ', null]) {
      assert.equal(buildSessionStart({ cwd, workspacePaths: ['/du-an-phien'] }, { script: fake }).injectSteps[0].systemMessage.systemMessage, 'cwd=/du-an-phien', JSON.stringify(cwd))
    }
  })

  test('không có gì để nạp, script lỗi/treo/in rác ⇒ {} (không chặn phiên)', () => {
    for (const body of ['', 'process.exit(3)\n', 'process.stdout.write("rác")\n', 'process.stdout.write("{}")\n', 'throw new Error("x")\n']) {
      assert.deepEqual(buildSessionStart({ cwd: TMP }, { script: script('ss-bad.mjs', body) }), {}, body)
    }
    assert.deepEqual(buildSessionStart({ cwd: TMP }, { script: script('ss-hang.mjs', 'setInterval(() => {}, 1000)\n'), timeoutMs: 600 }), {})
    assert.deepEqual(buildSessionStart(null, { script: path.join(TMP, 'khong-co.mjs') }), {})
  })

  test('session-start.mjs thật: phiên mới thấy sổ tiến độ đang dở của dự án (AC-07)', () => {
    const repo = path.join(TMP, 'proj-ss')
    fs.mkdirSync(path.join(repo, 'docs', 'specs', 'viec-dang-do'), { recursive: true })
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'viec-dang-do', 'progress.md'), '# viec-dang-do\nTrạng thái: đang làm\n\n## Bước tiếp theo\nviết test cho cổng chặn agy\n')
    const env = { ...ENV, HOME, USERPROFILE: HOME, FLOW_UPDATES: 'off', FLOW_MODELS: 'off', MCP_USAGE_LOG: path.join(TMP, 'usage.jsonl'), GIT_CEILING_DIRECTORIES: TMP }
    delete env.PASEO_AGENT_ID
    delete env.DEVIN_PROJECT_DIR
    const out = buildSessionStart({ hookEventName: 'SessionStart', cwd: repo, conversationId: 'c1' }, { env })
    const ctx = out.injectSteps?.[0]?.systemMessage?.systemMessage
    assert.ok(typeof ctx === 'string', JSON.stringify(out))
    assert.match(ctx, /Sổ tiến độ đang dở/)
    assert.match(ctx, /docs\/specs\/viec-dang-do\/progress\.md/)
    assert.match(ctx, /viết test cho cổng chặn agy/)
    // chạy qua tiến trình thật của adapter
    const r = spawnSync(process.execPath, [SCRIPT, 'session-start'], { input: JSON.stringify({ hookEventName: 'SessionStart', cwd: repo }), encoding: 'utf8', env: { ...env, AGY_HOOK_LOG: process.env.AGY_HOOK_LOG } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage, /viết test cho cổng chặn agy/)
  })

  test('thư mục không có sổ nào ⇒ {}', () => {
    const plain = path.join(TMP, 'plain-ss')
    fs.mkdirSync(plain)
    const env = { ...ENV, HOME, USERPROFILE: HOME, FLOW_UPDATES: 'off', FLOW_MODELS: 'off', MCP_USAGE_LOG: path.join(TMP, 'usage.jsonl'), GIT_CEILING_DIRECTORIES: TMP }
    delete env.PASEO_AGENT_ID
    delete env.DEVIN_PROJECT_DIR
    assert.deepEqual(buildSessionStart({ cwd: plain }, { env }), {})
  })
})

// ---------- CLI ----------

describe('cli', () => {
  test('deny-rules: in mảng JSON luật lớp 2 (cùng nguồn với hostgen.agyLayer2Deny) để dán vào permissions.deny của agy', async () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'deny-rules'], { encoding: 'utf8', env: ENV })
    assert.equal(r.status, 0, r.stderr)
    const { agyLayer2Deny } = await import('./lib/hostgen.mjs')
    assert.deepEqual(JSON.parse(r.stdout), agyLayer2Deny())
    assert.ok(JSON.parse(r.stdout).every((x) => x.startsWith('command(regex:')))
  })

  test('chế độ lạ ⇒ in cách dùng, exit 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'khong-co'], { encoding: 'utf8', env: ENV })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Dùng: agy-hook\.mjs/)
  })
})

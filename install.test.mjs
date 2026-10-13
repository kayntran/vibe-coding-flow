// node --test install.test.mjs — AC-39: cài/cập nhật bằng một lệnh. Mọi thứ chạy trên HOME giả (HOME + USERPROFILE + CODEX_HOME giả),
// git repo tạm làm origin; KHÔNG bao giờ đụng HOME thật của máy. Hai tầng:
//   (1) trong tiến trình: install({ home, kitDir, env, ... }) với kit mini + danh sách model giả;
//   (2) tiến trình thật: install.sh (sh/Git Bash) và install.ps1 (Windows PowerShell 5.1, cả -File lẫn `irm | iex`) chạy với origin tạm.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { install, SECRET_DENY, hookKey, spliceAgents, mergeCodexHooks } from './install.mjs'
import { claudeHooks, codexHooksJson } from './hooks/lib/hostgen.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIN32 = process.platform === 'win32'
const posix = (p) => p.replaceAll('\\', '/')
// Tắt bảo trì tự động của git (Mac: commit/pull tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem hooks/flow-dispatch.test.mjs.
// process.env cho git của test; e2eEnv thêm riêng cho install.sh/install.ps1 (git pull).
const NO_GIT_MAINT = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
Object.assign(process.env, NO_GIT_MAINT)

// ---------- tiện ích ----------

const dirs = []
const tmp = (prefix = 'vf-install-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows còn giữ khoá: để hệ điều hành dọn */ } }
})

const rd = (...p) => fs.readFileSync(path.join(...p), 'utf8')
const wr = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const json = (...p) => JSON.parse(rd(...p))
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])

// Ảnh chụp cây thư mục (đường dẫn → băm nội dung) để so "chạy 2 lần y kết quả". Cache của kit chứa thời điểm nên bỏ qua.
function tree(dir, skip = () => false) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = posix(path.relative(dir, p))
      if (skip(rel)) continue
      if (e.isDirectory()) walk(p)
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}
const skipCache = (rel) => rel.startsWith('.claude/cache/') || rel.endsWith('.tmp')

// ---------- kit mini + danh sách model giả ----------

function miniKit() {
  const d = tmp('vf-kit-')
  fs.copyFileSync(path.join(HERE, 'CLAUDE.md'), path.join(d, 'CLAUDE.md'))
  wr(path.join(d, 'kit', 'roles.json'), rd(HERE, 'kit', 'roles.json'))
  for (const a of ['coder', 'recon']) wr(path.join(d, 'agents', `${a}.md`), rd(HERE, 'agents', `${a}.md`))
  for (const s of ['flow-spec', 'flow-qa']) fs.cpSync(path.join(HERE, 'skills', s), path.join(d, 'skills', s), { recursive: true })
  return d
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const cm = (slug, priority) => ({
  slug, display_name: slug, visibility: 'list', priority, default_reasoning_level: 'medium',
  supported_reasoning_levels: LEVELS.map((effort) => ({ effort, description: 'x' })), upgrade: null,
})
const WIN_CATALOG = { fetched_at: '2026-10-11T11:00:00Z', models: [cm('gpt-6.1-sol', 1), cm('gpt-6-astra', 2), cm('gpt-6-sol', 3), cm('gpt-6-luna', 4)] }
const MAC_CATALOG = { models: [cm('gpt-5.6-sol', 5), cm('gpt-5.6-terra', 8), cm('gpt-5.6-luna', 9)] }

const STAMP = '20261011120000'
const emptyBin = tmp('vf-emptybin-')

// Chạy install() trong tiến trình trên HOME giả. PATH trống ⇒ không có `codex` trên PATH trừ khi test chủ ý thêm.
// VIBE_FLOW_PATH_ONLY: findExe bỏ các thư mục quen (/opt/homebrew/bin…) — máy thật có codex ở Homebrew không được lọt vào "máy trống".
async function run(home, kitDir, o = {}) {
  const lines = []
  const r = await install({
    home,
    kitDir,
    env: { PATH: emptyBin, VIBE_FLOW_PATH_ONLY: '1', ...(o.env ?? {}) },
    log: (l) => lines.push(l),
    stamp: o.stamp ?? STAMP,
    models: { catalog: { codex: WIN_CATALOG }, ...(o.models ?? {}) },
    checkAll: o.checkAll === undefined ? async () => ({}) : o.checkAll,
    hasRg: o.hasRg ?? true, // máy test coi như đã có rg; ca thiếu rg kiểm riêng
  })
  return { ...r, out: lines.join('\n') }
}

const rootOf = (home) => posix(path.join(home, '.claude'))
const flat = (settings) => Object.entries(settings.hooks ?? {}).flatMap(([ev, list]) => list.flatMap((e) => (e.hooks ?? []).map((h) => [ev, e.matcher, h.command])))
const expectedClaude = (home) => claudeHooks(rootOf(home)).map(([ev, m, h]) => [ev, m, h.command])
const key = (t) => JSON.stringify(t)

const HIDDEN = { zeroWidth: String.fromCodePoint(0x200B), tag: String.fromCodePoint(0xE0041), bidi: String.fromCodePoint(0x202E) }

// ---------- (1) Claude Code ----------

test('Claude: máy trống ⇒ settings.json có đủ hook của kit + chặn đọc file bí mật; không đụng Codex; không sao lưu (chưa có gì để lưu)', async () => {
  const home = tmp(); const kit = miniKit()
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const s = json(home, '.claude', 'settings.json')
  assert.deepEqual(flat(s).map(key).sort(), expectedClaude(home).map(key).sort())
  for (const rule of ['Read(.env)', 'Read(.env.*)', 'Read(*.pem)', 'Read(*.key)']) assert.ok(s.permissions.deny.includes(rule), rule)
  assert.deepEqual(s.permissions.deny, SECRET_DENY)
  assert.equal(fs.existsSync(path.join(home, '.codex')), false)
  assert.equal(fs.existsSync(path.join(home, '.agents')), false)
  assert.deepEqual(ls(path.join(home, '.claude')).filter((f) => f.includes('before-kit')), [])
  assert.ok(r.changed.includes('settings.json'))
})

test('Claude: hook kèm bí danh tên công cụ Devin (ADR-0004) và nháy kép quanh đường dẫn', async () => {
  const home = tmp()
  await run(home, miniKit())
  const cmds = flat(json(home, '.claude', 'settings.json'))
  const edit = cmds.find(([, , c]) => c.includes('flow-gate.mjs') && c.endsWith(' edit'))
  const bash = cmds.find(([, , c]) => c.includes('flow-gate.mjs') && c.endsWith(' bash'))
  assert.match(edit[1], /apply_patch/)
  assert.match(edit[1], /\bedit\b/)
  assert.match(bash[1], /\bexec\b/)
  assert.ok(edit[2].startsWith(`node "${rootOf(home)}/hooks/`), edit[2])
})

test('Claude: ghép vào settings.json sẵn có — giữ khoá/hook/quyền của user, thay hook kit cũ (đường dẫn máy khác), sao lưu bản gốc', async () => {
  const home = tmp(); const kit = miniKit()
  const original = {
    model: 'opus',
    env: { FOO: 'bar' },
    permissions: { allow: ['Bash(npm test)'], deny: ['Read(./secrets/**)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Edit|Write|NotebookEdit', hooks: [
          { type: 'command', command: 'node C:/Old/Machine/.claude/hooks/flow-gate.mjs edit', timeout: 15 },
          { type: 'command', command: 'node /my/own/hook.mjs' },
        ] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /my/other.py' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node C:/Old/Machine/.claude/hooks/flow-gate.mjs stop' }] }],
    },
  }
  const file = path.join(home, '.claude', 'settings.json')
  wr(file, `${JSON.stringify(original, null, 4)}\n`)
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const s = json(file)
  assert.equal(s.model, 'opus')
  assert.deepEqual(s.env, { FOO: 'bar' })
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)'])
  assert.deepEqual(s.permissions.deny, ['Read(./secrets/**)', ...SECRET_DENY])
  const cmds = flat(s).map(([, , c]) => c)
  assert.ok(cmds.includes('node /my/own/hook.mjs'))
  assert.ok(cmds.includes('python3 /my/other.py'))
  assert.equal(cmds.filter((c) => c.includes('C:/Old/Machine')).length, 0, 'hook kit cũ phải được thay')
  assert.equal(cmds.filter((c) => /flow-gate\.mjs"? edit$/.test(c)).length, 1)
  assert.equal(cmds.filter((c) => /flow-gate\.mjs"? stop$/.test(c)).length, 1)
  for (const e of expectedClaude(home)) assert.ok(flat(s).some((t) => key(t) === key(e)), key(e))
  assert.deepEqual(ls(path.join(home, '.claude')).filter((f) => f.includes('before-kit')), [`settings.json.before-kit-${STAMP}`])
  assert.deepEqual(json(home, '.claude', `settings.json.before-kit-${STAMP}`), original)
})

test('Claude: chạy 2 lần y kết quả — file không đổi, không sinh bản sao lưu mới, changed rỗng', async () => {
  const home = tmp(); const kit = miniKit()
  wr(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { A: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/mine.mjs' }] }] } }))
  const r1 = await run(home, kit, { stamp: '20261011120000' })
  const snap1 = tree(home, skipCache)
  const text1 = rd(home, '.claude', 'settings.json')
  const r2 = await run(home, kit, { stamp: '20261011130000' })
  assert.equal(r1.code, 0, r1.out); assert.equal(r2.code, 0, r2.out)
  assert.equal(rd(home, '.claude', 'settings.json'), text1)
  assert.deepEqual(tree(home, skipCache), snap1)
  assert.deepEqual(r2.changed, [])
  const s = json(home, '.claude', 'settings.json')
  assert.equal(new Set(s.permissions.deny).size, s.permissions.deny.length, 'deny không bị thêm trùng')
})

test('Claude: settings.json hỏng ⇒ không ghi đè, không sao lưu, báo rõ, exit 1', async () => {
  const home = tmp(); const kit = miniKit()
  const file = path.join(home, '.claude', 'settings.json')
  wr(file, '{ "hooks": ')
  const r = await run(home, kit)
  assert.equal(r.code, 1)
  assert.equal(rd(file), '{ "hooks": ')
  assert.deepEqual(ls(path.join(home, '.claude')).filter((f) => f.includes('before-kit')), [])
  assert.match(r.out, /settings\.json/)
})

test('Claude: settings.json có BOM vẫn đọc được', async () => {
  const home = tmp()
  wr(path.join(home, '.claude', 'settings.json'), `\uFEFF${JSON.stringify({ model: 'sonnet' })}`)
  const r = await run(home, miniKit())
  assert.equal(r.code, 0, r.out)
  assert.equal(json(home, '.claude', 'settings.json').model, 'sonnet')
})

// ---------- ký tự ẩn trong file luật của kit (AC-28) ----------

for (const [label, file, ch] of [
  ['CLAUDE.md', 'CLAUDE.md', HIDDEN.zeroWidth],
  ['skill', path.join('skills', 'flow-spec', 'SKILL.md'), HIDDEN.tag],
  ['agent', path.join('agents', 'coder.md'), HIDDEN.bidi],
]) {
  test(`ký tự ẩn trong ${label} của kit ⇒ dừng cài, không ghi gì, thông báo tên file + dòng nhưng không in lại ký tự ẩn`, async () => {
    const home = tmp(); const kit = miniKit()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    const p = path.join(kit, file)
    const lines = rd(p).split('\n')
    lines[2] = `${lines[2]}${ch}`
    fs.writeFileSync(p, lines.join('\n'))
    const r = await run(home, kit)
    assert.equal(r.code, 1)
    assert.ok(r.out.includes(posix(file)), r.out)
    assert.match(r.out, /\b3\b/, 'phải nêu số dòng')
    assert.equal(r.out.includes(ch), false, 'không in lại ký tự ẩn')
    assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false)
    assert.deepEqual(ls(path.join(home, '.codex')), [])
    assert.equal(fs.existsSync(path.join(home, '.agents')), false)
  })
}

// ---------- (2) Codex ----------

const withCodex = (home) => fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

test('Codex có mặt (~/.codex) ⇒ khối AGENTS.md, skill sang ~/.agents/skills, TOML vai, hooks.json', async () => {
  const home = tmp(); const kit = miniKit()
  withCodex(home)
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const agents = rd(home, '.codex', 'AGENTS.md')
  assert.ok(agents.startsWith('<!-- VIBE-FLOW:START -->'))
  assert.ok(agents.trimEnd().endsWith('<!-- VIBE-FLOW:END -->'))
  assert.ok(agents.includes('Từ điển công cụ Claude → Codex'))
  for (const s of ['flow-spec', 'flow-qa']) {
    assert.equal(rd(home, '.agents', 'skills', s, 'SKILL.md'), rd(kit, 'skills', s, 'SKILL.md'))
  }
  const coder = rd(home, '.codex', 'agents', 'coder.toml')
  assert.match(coder, /^name = "coder"$/m)
  assert.match(coder, /^model = "gpt-6\.1-sol"$/m)
  assert.match(coder, /^model_reasoning_effort = "high"$/m)
  assert.doesNotMatch(coder, /sandbox_mode/)
  const recon = rd(home, '.codex', 'agents', 'recon.toml')
  assert.match(recon, /^sandbox_mode = "read-only"$/m)
  assert.deepEqual(json(home, '.codex', 'hooks.json'), codexHooksJson(rootOf(home)))
  assert.deepEqual(ls(path.join(home, '.codex')).filter((f) => f.startsWith('backup-vibe-flow')), [])
  assert.match(r.out, /\/hooks/, 'phải hướng dẫn trust hook trong Codex')
})

test('Codex: vai không có model trong danh sách ⇒ TOML bỏ khoá model (CLI tự dùng mặc định), vẫn có effort, có ghi chú', async () => {
  const home = tmp(); withCodex(home)
  const r = await run(home, miniKit(), { models: { catalog: { codex: null }, exec: () => ({ ok: false, stdout: '', error: 'không có codex' }) } })
  assert.equal(r.code, 0, r.out)
  const coder = rd(home, '.codex', 'agents', 'coder.toml')
  assert.doesNotMatch(coder, /^model = /m)
  assert.match(coder, /^model_reasoning_effort = "high"$/m)
})

test('Codex: chạy 2 lần y kết quả — không file nào đổi, không có thư mục sao lưu', async () => {
  const home = tmp(); const kit = miniKit()
  withCodex(home)
  await run(home, kit, { stamp: '20261011120000' })
  const snap = tree(home, skipCache)
  const r2 = await run(home, kit, { stamp: '20261011130000' })
  assert.equal(r2.code, 0, r2.out)
  assert.deepEqual(tree(home, skipCache), snap)
  assert.deepEqual(r2.changed, [])
  assert.deepEqual(ls(path.join(home, '.codex')).filter((f) => f.startsWith('backup-vibe-flow')), [])
  assert.doesNotMatch(r2.out, /\/hooks/, 'hook không đổi ⇒ không bắt user bấm tin lại')
  assert.match(r2.out, /không còn việc gì/i)
})

test('Codex: đổi model hoặc nguồn rồi cài lại ⇒ bản sinh ra được cập nhật tại chỗ, KHÔNG sao lưu (đó là bản của kit)', async () => {
  const home = tmp(); const kit = miniKit()
  withCodex(home)
  await run(home, kit, { stamp: '20261011120000' })
  fs.appendFileSync(path.join(kit, 'CLAUDE.md'), '\nDòng mới của luật chung.\n')
  fs.appendFileSync(path.join(kit, 'skills', 'flow-spec', 'SKILL.md'), '\nDòng mới của skill.\n')
  const r2 = await run(home, kit, { stamp: '20261011130000', models: { catalog: { codex: MAC_CATALOG } } })
  assert.equal(r2.code, 0, r2.out)
  assert.match(rd(home, '.codex', 'AGENTS.md'), /Dòng mới của luật chung\./)
  assert.match(rd(home, '.agents', 'skills', 'flow-spec', 'SKILL.md'), /Dòng mới của skill\./)
  assert.match(rd(home, '.codex', 'agents', 'coder.toml'), /^model = "gpt-5\.6-sol"$/m)
  assert.deepEqual(ls(path.join(home, '.codex')).filter((f) => f.startsWith('backup-vibe-flow')), [])
  assert.ok(r2.changed.length >= 3)
})

test('Codex: AGENTS.md của user — giữ phần ngoài marker, thay khối VIBE-FLOW giữa marker; bộ điều phối CODEX-ORCHESTRATION cũ được cất vào backup', async () => {
  const home = tmp(); const kit = miniKit()
  const agentsFile = path.join(home, '.codex', 'AGENTS.md')
  const before = [
    'Phong cách riêng của tôi: ngắn gọn.',
    '',
    '<!-- CODEX-ORCHESTRATION:START -->',
    'Giao việc luna/sol, marker [WAIT_FOR_WORKERS] gpt-5.6-luna',
    '<!-- CODEX-ORCHESTRATION:END -->',
    '',
    'Ghi chú cuối của tôi.',
    '',
  ].join('\n')
  wr(agentsFile, before)
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const after1 = rd(agentsFile)
  assert.ok(after1.includes('Phong cách riêng của tôi: ngắn gọn.'))
  assert.ok(after1.includes('Ghi chú cuối của tôi.'))
  assert.equal(after1.includes('CODEX-ORCHESTRATION'), false)
  assert.equal(after1.includes('WAIT_FOR_WORKERS'), false)
  const iFirst = after1.indexOf('Phong cách riêng'); const iBlock = after1.indexOf('<!-- VIBE-FLOW:START -->'); const iLast = after1.indexOf('Ghi chú cuối')
  assert.ok(iFirst < iBlock && iBlock < iLast, 'khối kit nằm đúng chỗ khối điều phối cũ')
  const backup = path.join(home, '.codex', `backup-vibe-flow-${STAMP}`)
  assert.equal(rd(backup, '.codex', 'AGENTS.md'), before, 'bản gốc nguyên vẹn nằm trong backup')

  // Cập nhật lần sau: chỉ thay giữa marker, phần ngoài y nguyên, không thêm backup.
  fs.appendFileSync(path.join(kit, 'CLAUDE.md'), '\nMột dòng luật mới.\n')
  const r2 = await run(home, kit, { stamp: '20261011130000' })
  assert.equal(r2.code, 0, r2.out)
  const after2 = rd(agentsFile)
  assert.ok(after2.includes('Một dòng luật mới.'))
  assert.ok(after2.startsWith('Phong cách riêng của tôi: ngắn gọn.\n'))
  assert.ok(after2.trimEnd().endsWith('Ghi chú cuối của tôi.'))
  assert.equal(after2.match(/VIBE-FLOW:START/g).length, 1)
  assert.deepEqual(ls(path.join(home, '.codex')).filter((f) => f.startsWith('backup-vibe-flow')), [`backup-vibe-flow-${STAMP}`])
})

test('Codex: AGENTS.md có sẵn nhưng chưa có khối ⇒ nối khối vào cuối, giữ nguyên chữ của user (kể cả CRLF) và lưu bản gốc', async () => {
  const home = tmp()
  const agentsFile = path.join(home, '.codex', 'AGENTS.md')
  const before = 'Dòng một của tôi.\r\nDòng hai của tôi.\r\n'
  wr(agentsFile, before)
  const r = await run(home, miniKit())
  assert.equal(r.code, 0, r.out)
  const text = rd(agentsFile)
  assert.ok(text.startsWith(before), 'phần của user là tiền tố nguyên vẹn')
  assert.equal(text.match(/VIBE-FLOW:START/g).length, 1)
  assert.equal(rd(home, '.codex', `backup-vibe-flow-${STAMP}`, '.codex', 'AGENTS.md'), before)
  const r2 = await run(home, miniKit(), { stamp: '20261011130000' })
  assert.equal(r2.code, 0)
  assert.equal(rd(agentsFile), text, 'lần 2 y hệt')
})

test('Codex: AGENTS.md có START mà thiếu END ⇒ không sửa gì ở phía Codex, báo lỗi, exit 1 (phần Claude vẫn làm)', async () => {
  const home = tmp()
  const agentsFile = path.join(home, '.codex', 'AGENTS.md')
  wr(agentsFile, 'Của tôi\n<!-- VIBE-FLOW:START -->\ndang dở\n')
  const r = await run(home, miniKit())
  assert.equal(r.code, 1)
  assert.equal(rd(agentsFile), 'Của tôi\n<!-- VIBE-FLOW:START -->\ndang dở\n')
  assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json')), false)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')))
})

test('Codex: bộ điều phối cũ (orchestration-policy.md, worker-wait-hook*, hook trỏ tới chúng) ⇒ chuyển vào backup-vibe-flow-<stamp>, không xoá', async () => {
  const home = tmp(); const kit = miniKit()
  const c = path.join(home, '.codex')
  wr(path.join(c, 'orchestration-policy.md'), 'chính sách cũ gpt-5.6-luna\n')
  wr(path.join(c, 'worker-wait-hook', 'hook.py'), 'print("chờ worker")\n')
  wr(path.join(c, 'worker-wait-hook', 'sub', 'x.txt'), 'x\n')
  wr(path.join(c, 'worker-wait-hook.bak'), 'bản cũ hơn\n')
  wr(path.join(c, 'config.toml'), 'model = "gpt-6.1-sol"\n')
  const oldHooks = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'python.exe C:\\Users\\Admin\\.codex\\worker-wait-hook\\hook.py', timeout: 600 }] }],
      Interrupt: [{ hooks: [{ type: 'command', command: 'python.exe C:\\Users\\Admin\\.codex\\worker-wait-hook\\hook.py' }] }],
      PostToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node /mine/log.mjs' }] }],
    },
  }
  wr(path.join(c, 'hooks.json'), JSON.stringify(oldHooks, null, 2))
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const backup = path.join(c, `backup-vibe-flow-${STAMP}`)
  assert.equal(rd(backup, '.codex', 'orchestration-policy.md'), 'chính sách cũ gpt-5.6-luna\n')
  assert.equal(rd(backup, '.codex', 'worker-wait-hook', 'hook.py'), 'print("chờ worker")\n')
  assert.equal(rd(backup, '.codex', 'worker-wait-hook', 'sub', 'x.txt'), 'x\n')
  assert.equal(rd(backup, '.codex', 'worker-wait-hook.bak'), 'bản cũ hơn\n')
  assert.deepEqual(json(backup, '.codex', 'hooks.json'), oldHooks, 'hooks.json gốc nằm trong backup')
  for (const gone of ['orchestration-policy.md', 'worker-wait-hook', 'worker-wait-hook.bak']) assert.equal(fs.existsSync(path.join(c, gone)), false, gone)
  assert.equal(rd(c, 'config.toml'), 'model = "gpt-6.1-sol"\n', 'config.toml của user không bị đụng')
  const hooks = json(c, 'hooks.json')
  assert.equal(JSON.stringify(hooks).includes('worker-wait-hook'), false)
  assert.equal('Interrupt' in hooks.hooks, false, 'sự kiện chỉ còn hook cũ thì bỏ hẳn')
  assert.ok(hooks.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === 'node /mine/log.mjs')), 'hook riêng của user còn')
  const kitHooks = codexHooksJson(rootOf(home)).hooks
  for (const [ev, groups] of Object.entries(kitHooks)) for (const g of groups) assert.ok(hooks.hooks[ev].some((x) => key(x) === key(g)), `${ev} ${g.matcher ?? ''}`)

  // Lần sau không còn gì để chuyển, không đổi gì.
  const snap = tree(home, skipCache)
  const r2 = await run(home, kit, { stamp: '20261011130000' })
  assert.equal(r2.code, 0, r2.out)
  assert.deepEqual(tree(home, skipCache), snap)
})

test('Codex: hooks.json của user có hook không phải của kit ⇒ gộp, không mất; hook kit cũ (đường dẫn khác) bị thay; hỏng JSON ⇒ dừng phần Codex', async () => {
  const home = tmp(); const kit = miniKit()
  const f = path.join(home, '.codex', 'hooks.json')
  wr(f, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '^Bash$', hooks: [
        { type: 'command', command: 'node "C:/Old/.claude/hooks/flow-gate.mjs" bash', timeout: 15 },
        { type: 'command', command: 'node /mine/audit.mjs' },
      ] }],
    },
    custom: true,
  }))
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const h = json(f)
  assert.equal(h.custom, true)
  const cmds = Object.values(h.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((x) => x.command)))
  assert.ok(cmds.includes('node /mine/audit.mjs'))
  assert.equal(cmds.filter((c) => c.includes('C:/Old')).length, 0)
  assert.equal(cmds.filter((c) => /flow-gate\.mjs" bash$/.test(c)).length, 1)

  const home2 = tmp()
  const bad = path.join(home2, '.codex', 'hooks.json')
  wr(bad, '{ không phải json')
  const r2 = await run(home2, kit)
  assert.equal(r2.code, 1)
  assert.equal(rd(bad), '{ không phải json')
  assert.equal(fs.existsSync(path.join(home2, '.codex', 'AGENTS.md')), false, 'lỗi ở phần Codex ⇒ không ghi nửa chừng')
  assert.ok(fs.existsSync(path.join(home2, '.claude', 'settings.json')))
})

test('Codex: file trùng tên không phải của kit (TOML vai, thư mục skill) ⇒ sao lưu rồi thay; bản do kit sinh trước đó thì thay không sao lưu; file khác của user không đụng', async () => {
  const home = tmp(); const kit = miniKit()
  const c = path.join(home, '.codex')
  wr(path.join(c, 'agents', 'coder.toml'), 'name = "coder"\n# của tôi\n')
  wr(path.join(c, 'agents', 'custom.toml'), 'name = "custom"\n')
  wr(path.join(home, '.agents', 'skills', 'flow-spec', 'SKILL.md'), '# skill tự viết của tôi\n')
  wr(path.join(home, '.agents', 'skills', 'gemini-x', 'SKILL.md'), '# skill khác\n')
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  const backup = path.join(c, `backup-vibe-flow-${STAMP}`)
  assert.equal(rd(backup, '.codex', 'agents', 'coder.toml'), 'name = "coder"\n# của tôi\n')
  assert.equal(rd(backup, '.agents', 'skills', 'flow-spec', 'SKILL.md'), '# skill tự viết của tôi\n')
  assert.match(rd(c, 'agents', 'coder.toml'), /tự sinh bởi vibe-flow/)
  assert.equal(rd(c, 'agents', 'custom.toml'), 'name = "custom"\n')
  assert.equal(rd(home, '.agents', 'skills', 'gemini-x', 'SKILL.md'), '# skill khác\n')
  assert.equal(rd(home, '.agents', 'skills', 'flow-spec', 'SKILL.md'), rd(kit, 'skills', 'flow-spec', 'SKILL.md'))
})

test('Codex: file thừa do kit sinh trước đây (vai/skill đã bỏ khỏi kit) ⇒ chuyển vào backup, không xoá', async () => {
  const home = tmp(); const kit = miniKit()
  withCodex(home)
  wr(path.join(kit, 'skills', 'flow-spec', 'extra.md'), 'phụ\n')
  await run(home, kit, { stamp: '20261011120000' })
  assert.equal(rd(home, '.agents', 'skills', 'flow-spec', 'extra.md'), 'phụ\n')
  fs.rmSync(path.join(kit, 'skills', 'flow-spec', 'extra.md'))
  fs.rmSync(path.join(kit, 'skills', 'flow-qa'), { recursive: true })
  fs.rmSync(path.join(kit, 'agents', 'recon.md'))
  const r2 = await run(home, kit, { stamp: '20261011130000' })
  assert.equal(r2.code, 0, r2.out)
  const backup = path.join(home, '.codex', 'backup-vibe-flow-20261011130000')
  assert.equal(rd(backup, '.agents', 'skills', 'flow-spec', 'extra.md'), 'phụ\n')
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'flow-spec', 'extra.md')), false)
  assert.ok(fs.existsSync(path.join(backup, '.agents', 'skills', 'flow-qa', 'SKILL.md')))
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'flow-qa')), false)
  assert.ok(fs.existsSync(path.join(backup, '.codex', 'agents', 'recon.toml')))
  assert.equal(fs.existsSync(path.join(home, '.codex', 'agents', 'recon.toml')), false)
  assert.ok(fs.existsSync(path.join(home, '.codex', 'agents', 'coder.toml')))
})

// ---------- nhận diện Codex ----------

function fakeCodexOnPath() {
  const bin = tmp('vf-codexbin-')
  if (WIN32) fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n')
  else { fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, 'codex'), 0o755) }
  return bin
}

test('nhận diện Codex: `codex` trên PATH (chưa có ~/.codex) ⇒ vẫn cài phần Codex và tạo ~/.codex', async () => {
  const home = tmp()
  const r = await run(home, miniKit(), { env: { PATH: fakeCodexOnPath() } })
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(home, '.codex', 'AGENTS.md')))
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')))
})

test('nhận diện Codex: CODEX_HOME trỏ chỗ khác ⇒ ghi ở đó, ~/.codex không bị tạo', async () => {
  const home = tmp(); const codexHome = path.join(tmp(), 'codex-home')
  fs.mkdirSync(codexHome, { recursive: true })
  const r = await run(home, miniKit(), { env: { CODEX_HOME: codexHome } })
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(codexHome, 'AGENTS.md')))
  assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'coder.toml')))
  assert.equal(fs.existsSync(path.join(home, '.codex')), false)
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'flow-spec', 'SKILL.md')))
})

// ---------- việc user cần làm ----------

test('in cuối: chỉ nêu CLI chưa sẵn sàng theo clis.mjs (đã cài chưa đăng nhập ⇒ lệnh login; chưa cài ⇒ gom một dòng); CLI sẵn sàng không bị nhắc', async () => {
  const home = tmp(); withCodex(home)
  const res = (name, o) => ({ name, installed: true, auth: 'ok', ready: true, reason: 'ok', loginCmd: null, installHint: null, ...o })
  const checkAll = async () => ({
    claude: res('claude', {}),
    codex: res('codex', { auth: 'none', ready: false, reason: 'not-logged-in', loginCmd: 'codex login' }),
    grok: res('grok', { installed: false, auth: 'unknown', ready: false, reason: 'not-installed', installHint: 'grok install' }),
    agy: res('agy', { auth: 'none', ready: false, reason: 'quota', loginCmd: null }),
  })
  const r = await run(home, miniKit(), { checkAll })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /codex login/)
  assert.match(r.out, /grok/)
  assert.doesNotMatch(r.out, /claude auth login/)
  assert.doesNotMatch(r.out, /agy login/)
})

test('in cuối: kiểm CLI lỗi (ném lỗi) không làm hỏng việc cài', async () => {
  const home = tmp()
  const r = await run(home, miniKit(), { checkAll: async () => { throw new Error('boom') } })
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')))
})

test('không in secret: giá trị nhạy cảm trong settings.json của user không xuất hiện trong output', async () => {
  const home = tmp()
  const secret = 'gia-tri-nhay-cam-khong-duoc-in-ra-1234567890'
  wr(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { API_KEY: secret } }))
  const r = await run(home, miniKit())
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.includes(secret), false)
  assert.equal(json(home, '.claude', 'settings.json').env.API_KEY, secret)
})


// ---------- hàm thuần ----------

test('hookKey: cùng khoá cho đường dẫn máy khác, có/không nháy kép, dấu gạch ngược; hook ngoài ~/.claude/hooks thì không phải của kit', () => {
  const k = 'flow-gate.mjs edit'
  for (const c of [
    'node C:/Users/A/.claude/hooks/flow-gate.mjs edit',
    'node "C:/Users/Nguyễn Văn A/.claude/hooks/flow-gate.mjs" edit',
    'node C:\\Users\\A\\.claude\\hooks\\flow-gate.mjs edit',
    'node /Users/a/.claude/hooks/flow-gate.mjs edit',
  ]) assert.equal(hookKey(c), k, c)
  assert.equal(hookKey('node /proj/hooks/flow-gate.mjs edit'), null)
  assert.equal(hookKey('python3 /x/y.py'), null)
  assert.equal(hookKey(undefined), null)
})

test('spliceAgents: khối cũ đứng trước/sau khối VIBE-FLOW, file trống — đều ra đúng một khối, phần user giữ nguyên; marker cũ nằm trong khối kit không bị coi là khối cũ', () => {
  const block = '<!-- VIBE-FLOW:START -->\nluật\n<!-- VIBE-FLOW:END -->\n'
  const legacy = '<!-- CODEX-ORCHESTRATION:START -->\ncũ\n<!-- CODEX-ORCHESTRATION:END -->'
  const vibe = '<!-- VIBE-FLOW:START -->\nbản cũ\n<!-- VIBE-FLOW:END -->'
  for (const [name, before] of [
    ['legacy trước', `A\n\n${legacy}\n\n${vibe}\n\nB\n`],
    ['legacy sau', `A\n\n${vibe}\n\n${legacy}\n\nB\n`],
  ]) {
    const r = spliceAgents(before, block)
    assert.equal(r.text.match(/VIBE-FLOW:START/g).length, 1, name)
    assert.equal(r.text.includes('CODEX-ORCHESTRATION'), false, name)
    assert.equal(r.text.includes('bản cũ'), false, name)
    assert.ok(r.text.startsWith('A\n') && r.text.trimEnd().endsWith('B'), name)
    assert.equal(r.touchedOutside, true, name)
  }
  assert.deepEqual(spliceAgents('', block), { text: block, touchedOutside: false, legacy: false })
  const same = spliceAgents(block, block)
  assert.equal(same.text, block)
  assert.equal(same.touchedOutside, false)
  const tricky = '<!-- VIBE-FLOW:START -->\nnhắc <!-- CODEX-ORCHESTRATION:START --> x <!-- CODEX-ORCHESTRATION:END -->\n<!-- VIBE-FLOW:END -->\n'
  assert.equal(spliceAgents(tricky, block).text, block)
  assert.throws(() => spliceAgents('x <!-- VIBE-FLOW:END -->', block), /thiếu/)
  assert.throws(() => spliceAgents(`${vibe}\n${vibe}`, block), /nhiều/)
})

test('mergeCodexHooks: không có file ⇒ nguyên bản của kit; có hook riêng + hook cũ ⇒ giữ riêng, bỏ cũ, thêm kit; chạy lại không đổi', () => {
  const kit = codexHooksJson('C:/Users/A/.claude')
  assert.equal(mergeCodexHooks(null, kit).json, kit)
  const existing = { note: 1, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python worker-wait-hook/hook.py' }, { type: 'command', command: 'node /mine.mjs' }] }] } }
  const r = mergeCodexHooks(existing, kit)
  assert.equal(r.legacy, 1)
  assert.equal(r.json.note, 1)
  assert.ok(r.json.hooks.Stop[0].hooks.length === 1 && r.json.hooks.Stop[0].hooks[0].command === 'node /mine.mjs')
  assert.deepEqual(mergeCodexHooks(r.json, kit).json, r.json)
})

// ---------- (3) tiến trình thật: install.mjs, install.sh, install.ps1 ----------

const KIT_ENTRIES = ['install.mjs', 'CLAUDE.md', 'WORKERS.md', 'WORKTREE.md', 'agents', 'hooks', 'kit', 'workers', 'skills']
function copyKit(dest) {
  for (const e of KIT_ENTRIES) {
    fs.cpSync(path.join(HERE, e), path.join(dest, e), {
      recursive: true,
      filter: (src) => {
        const rel = posix(path.relative(HERE, src))
        if (rel.endsWith('.log') || rel.includes('node_modules')) return false
        if (rel.startsWith('skills/') && rel.split('/').length >= 2 && !rel.split('/')[1].startsWith('flow-')) return false
        return true
      },
    })
  }
}

const gitOpts = { encoding: 'utf8', windowsHide: true }
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], gitOpts)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
function makeOrigin() {
  const o = tmp('vf-origin-')
  copyKit(o)
  git(o, 'init', '-q')
  git(o, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(o, 'add', '-A')
  git(o, 'commit', '-q', '-m', 'kit')
  return o
}

// Tên người dùng Windows của người Việt hay có dấu cách và chữ có dấu: đường dẫn như vậy phải chạy được cả ở sh lẫn PowerShell 5.1.
const viHome = () => { const h = path.join(tmp(), 'Nguyễn Văn A'); fs.mkdirSync(h); return h }

const which = (cmd) => {
  const r = spawnSync(WIN32 ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : null
}
const nodeDir = path.dirname(process.execPath)
const gitExe = which('git')
const gitDir = gitExe ? path.dirname(gitExe) : null

function findBash() {
  if (!WIN32) return fs.existsSync('/bin/sh') ? '/bin/sh' : null
  const cands = [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean).map((p) => path.join(p, 'Git', 'bin', 'bash.exe'))
  if (gitDir) cands.push(path.join(gitDir, '..', 'bin', 'bash.exe'))
  return cands.find((c) => fs.existsSync(c)) ?? null
}
const bash = findBash()
const psExe = WIN32 && process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
const sysDirs = WIN32 ? [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')] : []

function e2eEnv(home, pathDirs, extra = {}) {
  const base = WIN32
    ? Object.fromEntries(['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']
      .filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    : { TMPDIR: os.tmpdir(), LANG: 'C.UTF-8' }
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    PATH: pathDirs.filter(Boolean).join(path.delimiter),
    VIBE_FLOW_NO_LOGIN_CHECK: '1',
    VIBE_FLOW_PATH_ONLY: '1', // máy thật có codex ở /opt/homebrew/bin không được tính là "máy có Codex"
    ...NO_GIT_MAINT,
    ...extra,
  }
}
// install.sh cần mkdir/rm/mktemp… (macOS để ở /bin, /usr/bin). PATH thật của user luôn có hai thư mục này; chỉ các test "thiếu node/git" cố ý bỏ.
const SYS_BIN = WIN32 ? [] : ['/usr/bin', '/bin']
// Chốt an toàn: tiến trình con PHẢI thấy HOME giả, nếu không thì không chạy bất cứ thứ gì có thể ghi vào HOME thật.
function assertFakeHome(env, home) {
  const r = spawnSync(process.execPath, ['-p', 'require("os").homedir()'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(path.resolve(r.stdout.trim()).toLowerCase(), path.resolve(home).toLowerCase(), 'HOME giả không có hiệu lực — dừng để không đụng HOME thật')
}

const lfScript = (name) => rd(HERE, name).replaceAll('\r\n', '\n')
function runSh(home, env, script = lfScript('install.sh')) {
  assertFakeHome(env, home)
  return spawnSync(bash, ['-s'], { input: script, env, encoding: 'utf8', timeout: 180000, windowsHide: true })
}
const outOf = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`

// PowerShell tự ghi dữ liệu khởi động vào LOCALAPPDATA giả (AppData/…); .git của kit đổi theo mỗi lệnh git: cả hai không phải kết quả của bộ cài.
const skipE2e = (rel) => skipCache(rel) || rel.startsWith('.claude/.git/') || rel.startsWith('AppData/')

const shReady = Boolean(bash && gitExe)
const skipSh = shReady ? false : 'cần sh/bash + git'

test('install.sh: cú pháp sh hợp lệ, bọc trong hàm (tải dở thì không chạy nửa chừng), không dùng tính năng riêng của bash', { skip: skipSh }, () => {
  const text = lfScript('install.sh')
  const r = spawnSync(bash, ['-n', '-s'], { input: text, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  assert.match(text, /^#!\/bin\/sh/)
  assert.match(text, /\nmain "\$@"\s*$/, 'lệnh gọi main phải là dòng CUỐI')
  assert.doesNotMatch(text, /\[\[|\bpipefail\b|\blocal\b/)
})

test('install.sh: cài lần đầu (curl | sh) — init + fetch + sao lưu file trùng tên + checkout + install.mjs; HOME giả có dấu cách và chữ có dấu', { skip: skipSh, timeout: 240000 }, () => {
  const origin = makeOrigin(); const home = viHome()
  // File sẵn có của user: một file trùng tên khác nội dung (phải được sao lưu), một file trùng tên y hệt (không cần sao lưu), settings.json riêng.
  wr(path.join(home, '.claude', 'CLAUDE.md'), 'Luật riêng của tôi\n')
  wr(path.join(home, '.claude', 'agents', 'coder.md'), rd(origin, 'agents', 'coder.md'))
  wr(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
  const env = e2eEnv(home, [nodeDir, gitDir, ...SYS_BIN], { VIBE_FLOW_REPO: origin })
  const r = runSh(home, env)
  assert.equal(r.status, 0, outOf(r))
  const c = path.join(home, '.claude')
  assert.ok(fs.existsSync(path.join(c, '.git')))
  assert.equal(git(c, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
  assert.equal(git(c, 'rev-parse', 'HEAD').trim(), git(origin, 'rev-parse', 'HEAD').trim())
  assert.equal(rd(c, 'CLAUDE.md').replaceAll('\r\n', '\n'), rd(origin, 'CLAUDE.md'))
  const backups = ls(c).filter((f) => f.includes('.before-kit-'))
  assert.ok(backups.some((f) => f.startsWith('CLAUDE.md.before-kit-')), backups.join(','))
  assert.equal(rd(c, backups.find((f) => f.startsWith('CLAUDE.md.before-kit-'))), 'Luật riêng của tôi\n')
  assert.equal(ls(path.join(c, 'agents')).filter((f) => f.includes('before-kit')).length, 0, 'file trùng y hệt không cần sao lưu')
  assert.ok(backups.some((f) => f.startsWith('settings.json.before-kit-')), 'settings.json đổi ⇒ có sao lưu')
  const s = json(c, 'settings.json')
  assert.equal(s.model, 'opus')
  assert.deepEqual(flat(s).map(key).sort(), expectedClaude(home).map(key).sort())
  assert.deepEqual(s.permissions.deny, SECRET_DENY)
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'máy không có Codex ⇒ bỏ phần Codex')
  assert.match(outOf(r), /Claude/)
})

test('install.sh: chạy lại = cập nhật (git pull --ff-only) và idempotent — kit đổi thì nhận, cài đặt không đổi thì không sao lưu thêm', { skip: skipSh, timeout: 300000 }, () => {
  const origin = makeOrigin(); const home = tmp()
  const codex = path.join(home, '.codex')
  wr(path.join(codex, 'models_cache.json'), JSON.stringify({ ...WIN_CATALOG, fetched_at: new Date().toISOString() }))
  const env = e2eEnv(home, [nodeDir, gitDir, ...SYS_BIN], { VIBE_FLOW_REPO: origin })
  let r = runSh(home, env)
  assert.equal(r.status, 0, outOf(r))
  const c = path.join(home, '.claude')
  assert.ok(fs.existsSync(path.join(codex, 'AGENTS.md')), 'có ~/.codex ⇒ cài phần Codex')
  assert.match(rd(codex, 'agents', 'coder.toml'), /^model = "gpt-6\.1-sol"$/m)
  const snap1 = tree(home, skipE2e)

  r = runSh(home, env)
  assert.equal(r.status, 0, outOf(r))
  assert.deepEqual(tree(home, skipE2e), snap1, 'chạy lần 2 y kết quả')

  fs.appendFileSync(path.join(origin, 'skills', 'flow-spec', 'SKILL.md'), '\nDÒNG MỚI TỪ ORIGIN\n')
  git(origin, 'commit', '-q', '-am', 'skill mới')
  r = runSh(home, env)
  assert.equal(r.status, 0, outOf(r))
  assert.match(rd(c, 'skills', 'flow-spec', 'SKILL.md'), /DÒNG MỚI TỪ ORIGIN/)
  assert.match(rd(home, '.agents', 'skills', 'flow-spec', 'SKILL.md'), /DÒNG MỚI TỪ ORIGIN/)
  assert.deepEqual(ls(codex).filter((f) => f.startsWith('backup-vibe-flow')), [], 'bản kit sinh ra được cập nhật tại chỗ, không sao lưu')
  assert.equal(ls(c).filter((f) => f.startsWith('settings.json.before-kit-')).length, 0, 'settings.json chưa từng có file gốc ⇒ không có gì để sao lưu')
})

test('install.sh: pull không ff được (user có commit riêng) ⇒ dừng, exit khác 0, KHÔNG ép, commit của user còn nguyên', { skip: skipSh, timeout: 240000 }, () => {
  const origin = makeOrigin(); const home = tmp()
  const env = e2eEnv(home, [nodeDir, gitDir, ...SYS_BIN], { VIBE_FLOW_REPO: origin })
  let r = runSh(home, env)
  assert.equal(r.status, 0, outOf(r))
  const c = path.join(home, '.claude')
  fs.appendFileSync(path.join(c, 'CLAUDE.md'), '\nsửa riêng của user\n')
  git(c, 'commit', '-q', '-am', 'của user')
  const mine = git(c, 'rev-parse', 'HEAD').trim()
  fs.appendFileSync(path.join(origin, 'CLAUDE.md'), '\nthay đổi từ origin\n')
  git(origin, 'commit', '-q', '-am', 'origin đổi')
  r = runSh(home, env)
  assert.notEqual(r.status, 0)
  assert.equal(git(c, 'rev-parse', 'HEAD').trim(), mine, 'không được ép/ghi đè')
  assert.doesNotMatch(rd(c, 'CLAUDE.md'), /thay đổi từ origin/)
  assert.match(outOf(r), /ff-only|không|dừng/i)
})

test('install.sh: thiếu node ⇒ in lời hướng dẫn cài một dòng rồi dừng (exit 1), chưa đụng ~/.claude', { skip: skipSh, timeout: 120000 }, () => {
  const origin = makeOrigin(); const home = tmp()
  const env = e2eEnv(home, [gitDir], { VIBE_FLOW_REPO: origin })
  const r = runSh(home, env)
  assert.equal(r.status, 1, outOf(r))
  assert.match(outOf(r), /node/i)
  assert.equal(fs.existsSync(path.join(home, '.claude')), false)
})

test('install.sh: thiếu git ⇒ in lời hướng dẫn cài một dòng rồi dừng (exit 1)', { skip: !shReady || WIN32 ? 'Git Bash luôn kèm git; mục này chạy trên macOS/Linux, thiếu git ở PowerShell được kiểm riêng' : false, timeout: 120000 }, () => {
  const home = tmp()
  const bin = tmp('vf-onlynode-')
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  const env = e2eEnv(home, [bin], { VIBE_FLOW_REPO: path.join(home, 'khong-co') })
  const r = runSh(home, env)
  assert.equal(r.status, 1, outOf(r))
  assert.match(outOf(r), /git/i)
  assert.equal(fs.existsSync(path.join(home, '.claude')), false)
})

const psReady = Boolean(WIN32 && psExe && fs.existsSync(psExe) && gitExe)
const skipPs = psReady ? false : 'cần Windows PowerShell 5.1 + git'
const SENTINEL = 'VF-SENTINEL-DONE'
function runPs(home, env, mode = 'file') {
  assertFakeHome(env, home)
  const script = path.join(tmp('vf-ps-'), 'install.ps1')
  fs.writeFileSync(script, lfScript('install.ps1'))
  const args = mode === 'file'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
    // Đúng cách user dùng: nội dung nạp thành chuỗi UTF-8 rồi iex (như `irm … | iex`); thêm mốc để biết cửa sổ KHÔNG bị đóng giữa chừng.
    : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[IO.File]::ReadAllText('${script}', [Text.Encoding]::UTF8) | Invoke-Expression; Write-Output '${SENTINEL}'`]
  return spawnSync(psExe, args, { env, encoding: 'utf8', timeout: 240000, windowsHide: true })
}

test('install.ps1: chạy được trong Windows PowerShell 5.1 — không dùng cú pháp chỉ có ở PowerShell 7 (&&, ||, ?:, ??)', { skip: skipPs }, () => {
  const text = lfScript('install.ps1')
  // PowerShell 5.1 đọc .ps1 không BOM theo ANSI (cp1252): byte UTF-8 của chữ có dấu (đ, ố, ồ…) thành dấu nháy thông minh làm vỡ chuỗi khi chạy -File.
  assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, 'install.ps1 chỉ được dùng ký tự ASCII')
  assert.doesNotMatch(text.replace(/#.*$/gm, ''), /&&|\|\||\?\?|\?\.|\s\?\s/)
  const v = spawnSync(psExe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true })
  assert.equal(v.stdout.trim(), '5', 'bài kiểm phải chạy trên Windows PowerShell 5.x')
})

test('install.ps1: cài lần đầu bằng -File — init + fetch + sao lưu + checkout + install.mjs; HOME giả có dấu cách và chữ có dấu', { skip: skipPs, timeout: 300000 }, () => {
  const origin = makeOrigin(); const home = viHome()
  wr(path.join(home, '.claude', 'CLAUDE.md'), 'Luật riêng của tôi\n')
  const env = e2eEnv(home, [...sysDirs, nodeDir, gitDir], { VIBE_FLOW_REPO: origin })
  const r = runPs(home, env)
  assert.equal(r.status, 0, outOf(r))
  const c = path.join(home, '.claude')
  assert.equal(git(c, 'rev-parse', 'HEAD').trim(), git(origin, 'rev-parse', 'HEAD').trim())
  const backup = ls(c).find((f) => f.startsWith('CLAUDE.md.before-kit-'))
  assert.ok(backup)
  assert.equal(rd(c, backup), 'Luật riêng của tôi\n')
  assert.deepEqual(flat(json(c, 'settings.json')).map(key).sort(), expectedClaude(home).map(key).sort())
  // chạy lại ⇒ cập nhật + y kết quả
  const snap = tree(home, skipE2e)
  const r2 = runPs(home, env)
  assert.equal(r2.status, 0, outOf(r2))
  assert.deepEqual(tree(home, skipE2e), snap)
})

test('install.ps1: dạng `irm | iex` — chạy xong cửa sổ PowerShell KHÔNG bị đóng (không exit), cài đủ', { skip: skipPs, timeout: 300000 }, () => {
  const origin = makeOrigin(); const home = tmp()
  const env = e2eEnv(home, [...sysDirs, nodeDir, gitDir], { VIBE_FLOW_REPO: origin })
  const r = runPs(home, env, 'iex')
  assert.equal(r.status, 0, outOf(r))
  assert.ok(r.stdout.includes(SENTINEL), 'script trong iex được phép làm cửa sổ của user thoát')
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')))
})

test('install.ps1: thiếu git hoặc node ⇒ in lời hướng dẫn cài một dòng (winget) rồi dừng; dạng iex vẫn không đóng cửa sổ', { skip: skipPs, timeout: 180000 }, () => {
  const home = tmp()
  let env = e2eEnv(home, [...sysDirs, nodeDir], { VIBE_FLOW_REPO: path.join(home, 'khong-co') })
  let r = runPs(home, env)
  assert.equal(r.status, 1, outOf(r))
  assert.match(outOf(r), /winget install[^\n]*Git/i)
  r = runPs(home, env, 'iex')
  assert.ok(r.stdout.includes(SENTINEL))
  assert.match(outOf(r), /git/i)
  env = e2eEnv(home, [...sysDirs, gitDir], { VIBE_FLOW_REPO: path.join(home, 'khong-co') })
  r = runPs(home, env)
  assert.equal(r.status, 1, outOf(r))
  assert.match(outOf(r), /winget install[^\n]*(Node|OpenJS)/i)
  assert.equal(fs.existsSync(path.join(home, '.claude')), false)
})

test('install.mjs chạy trực tiếp: phải nằm ở ~/.claude (gốc kit, ADR-0002) — chạy từ chỗ khác ⇒ dừng với lời nhắc, không ghi gì', () => {
  const home = tmp()
  const env = e2eEnv(home, [nodeDir])
  assertFakeHome(env, home)
  const r = spawnSync(process.execPath, [path.join(HERE, 'install.mjs')], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 1, outOf(r))
  assert.match(outOf(r), /\.claude/)
  assert.deepEqual(ls(home), [])
})

test('install.mjs chạy trực tiếp ở ~/.claude giả (kit thật): cài đủ cho Claude; VIBE_FLOW_NO_LOGIN_CHECK bỏ bước kiểm đăng nhập', { timeout: 120000 }, () => {
  const home = tmp()
  copyKit(path.join(home, '.claude'))
  const env = e2eEnv(home, [nodeDir])
  assertFakeHome(env, home)
  const r = spawnSync(process.execPath, [path.join(home, '.claude', 'install.mjs')], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, outOf(r))
  const s = json(home, '.claude', 'settings.json')
  assert.deepEqual(flat(s).map(key).sort(), expectedClaude(home).map(key).sort())
  assert.equal(fs.existsSync(path.join(home, '.codex')), false)
})

test('cài trên kit THẬT với Codex: đủ skill flow-* (có flow-architecture), đủ vai trong agents/, AGENTS.md ≤ 24 KB, hooks.json = hostgen', { timeout: 120000 }, async () => {
  const home = tmp(); withCodex(home)
  const r = await run(home, HERE)
  assert.equal(r.code, 0, r.out)
  const skills = ls(path.join(home, '.agents', 'skills')).filter((s) => s.startsWith('flow-'))
  assert.deepEqual(skills, ls(path.join(HERE, 'skills')).filter((s) => s.startsWith('flow-')))
  assert.ok(skills.length >= 8 && skills.includes('flow-architecture'), skills.join(', '))
  const tomls = ls(path.join(home, '.codex', 'agents')).map((f) => f.replace(/\.toml$/, ''))
  assert.deepEqual(tomls, ls(path.join(HERE, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
  assert.ok(Buffer.byteLength(rd(home, '.codex', 'AGENTS.md'), 'utf8') <= 24 * 1024 + 64)
  assert.deepEqual(json(home, '.codex', 'hooks.json'), codexHooksJson(rootOf(home)))
})

test('.gitignore (allowlist) mở đúng ba file mới của làn I', () => {
  const ig = rd(HERE, '.gitignore').split(/\r?\n/)
  for (const line of ['!/install.mjs', '!/install.ps1', '!/install.sh', '!/install.test.mjs']) assert.ok(ig.includes(line), line)
})

test('AC-42: máy chưa có rg ⇒ việc cần làm có đúng lệnh cài rg theo hệ điều hành; có rg ⇒ không nhắc', async () => {
  const r = await run(tmp(), miniKit(), { hasRg: false })
  const how = process.platform === 'win32' ? 'winget install BurntSushi.ripgrep.MSVC' : process.platform === 'darwin' ? 'brew install ripgrep' : 'sudo apt install ripgrep'
  assert.ok(r.todo.some((t) => t.includes('rg') && t.includes(how)), r.out)
  const r2 = await run(tmp(), miniKit(), { hasRg: true })
  assert.ok(!r2.todo.some((t) => t.includes('Cài rg')), r2.out)
})

// Test cho lib/clis.mjs: node --test hooks/lib/clis.test.mjs
// Không gọi CLI thật: lớp kiểm dùng runner giả (tiêm `run`), PATH giả (tiêm `exists`/`env`/`platform`); riêng runCommand/CLI
// được thử với shim giả tự tạo trong thư mục tạm (tên có dấu cách + tiếng Việt), `HOME` giả.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../cli-check.mjs'
import { CACHE_TTL_MS, CLI_NAMES, MAX_TIMEOUT_MS, cachePath, check, checkAll, classifyFailure, resolveBin, runCommand } from './clis.mjs'

const CLI_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli-check.mjs')
const IS_WIN = process.platform === 'win32'

const tmpDirs = []
function tmp(prefix = 'clis-test ') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

// --- thế giới giả -------------------------------------------------------------------------------------------------------------

const W = { platform: 'win32', env: { PATH: 'C:\\Windows\\System32;C:\\Users\\Tester\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, home: 'C:\\Users\\Tester' }
const M = { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/tester' }

// run giả: table = { 'args nối bằng dấu cách': {code, stdout, stderr, timedOut, error} }; gọi lệnh ngoài bảng ⇒ lỗi test.
function fakeRun(table) {
  const calls = []
  const run = async (file, args, o) => {
    calls.push({ file, args, o })
    const r = table[args.join(' ')]
    if (!r) throw new Error(`lệnh ngoài dự kiến: ${file} ${args.join(' ')}`)
    return { code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...r }
  }
  return { run, calls }
}

function world(base, files, table, extra = {}) {
  const set = new Set(files)
  const { run, calls } = fakeRun(table)
  return { opts: { ...base, exists: (p) => set.has(p), run, cacheFile: path.join(tmp(), 'clis.json'), ...extra }, calls }
}

const NPM = 'C:\\Users\\Tester\\AppData\\Roaming\\npm'

// --- resolveBin ----------------------------------------------------------------------------------------------------------------

test('resolveBin win32: chỉ nhận đuôi trong PATHEXT (bỏ file không đuôi), .exe trước .cmd nếu PATHEXT xếp vậy', () => {
  const files = new Set([`${NPM}\\claude`, `${NPM}\\claude.cmd`, `${NPM}\\codex.cmd`, `${NPM}\\codex.exe`])
  const ctx = { ...W, exists: (p) => files.has(p) }
  assert.equal(resolveBin('claude', ctx), `${NPM}\\claude.cmd`)
  assert.equal(resolveBin('codex', ctx), `${NPM}\\codex.exe`)
  files.delete(`${NPM}\\claude.cmd`)
  assert.equal(resolveBin('claude', ctx), null, 'file "claude" không đuôi không chạy được ⇒ không tính là đã cài')
})

test('resolveBin win32: thư mục PATH đứng trước thắng; PATHEXT thiếu ⇒ dùng mặc định; PATHEXT hoa/thường đều được; khoá env "Path" cũng được', () => {
  const files = new Set(['C:\\a\\grok.exe', 'C:\\b\\grok.exe'])
  const ctx = { platform: 'win32', env: { Path: 'C:\\a;C:\\b' }, home: W.home, exists: (p) => files.has(p) }
  assert.equal(resolveBin('grok', ctx), 'C:\\a\\grok.exe')
  const cmd = { platform: 'win32', env: { PATH: 'C:\\a', PATHEXT: '.cmd' }, home: W.home, exists: (p) => p === 'C:\\a\\codex.cmd' }
  assert.equal(resolveBin('codex', cmd), 'C:\\a\\codex.cmd')
  assert.equal(resolveBin('codex', { ...cmd, env: { PATH: 'C:\\a', PATHEXT: '.CMD' } }), 'C:\\a\\codex.cmd')
})

test('resolveBin win32: PATH thưa (app mở từ GUI) vẫn thấy bản cài ở thư mục quen: %APPDATA%\\npm, %LOCALAPPDATA%\\agy\\bin, ~\\.grok\\bin, cursor-agent', () => {
  const sparse = { ...W, env: { ...W.env, PATH: 'C:\\Windows\\System32' } }
  const at = (p) => ({ ...sparse, exists: (x) => x === p })
  assert.equal(resolveBin('codex', at(`${NPM}\\codex.cmd`)), `${NPM}\\codex.cmd`)
  assert.equal(resolveBin('agy', at('C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe')), 'C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe')
  assert.equal(resolveBin('grok', at('C:\\Users\\Tester\\.grok\\bin\\grok.exe')), 'C:\\Users\\Tester\\.grok\\bin\\grok.exe')
  assert.equal(resolveBin('cursor-agent', at('C:\\Users\\Tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd')), 'C:\\Users\\Tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd')
})

test('resolveBin: cursor-agent KHÔNG nhận nhầm tên "agent" (trên máy này trỏ sang grok)', () => {
  const dir = 'C:\\Users\\Tester\\AppData\\Local\\cursor-agent'
  const ctx = { ...W, env: { ...W.env, PATH: dir }, exists: (p) => p === `${dir}\\agent.cmd` }
  assert.equal(resolveBin('cursor-agent', ctx), null)
})

test('resolveBin macOS: PATH của ssh/GUI thưa ⇒ vẫn thấy Homebrew và ~/.local/bin', () => {
  const at = (p) => ({ ...M, exists: (x) => x === p })
  assert.equal(resolveBin('codex', at('/opt/homebrew/bin/codex')), '/opt/homebrew/bin/codex')
  assert.equal(resolveBin('claude', at('/Users/tester/.local/bin/claude')), '/Users/tester/.local/bin/claude')
  assert.equal(resolveBin('grok', at('/usr/local/bin/grok')), '/usr/local/bin/grok')
  assert.equal(resolveBin('agy', at('/nowhere/agy')), null)
})

const DEVIN_TAIL = 'resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe'

test('resolveBin devin win32: PATH → thư mục bin của Desktop trên PATH → %LOCALAPPDATA%\\Programs → Program Files → ổ đĩa khác (D:\\Program Files\\Devin)', () => {
  const only = (p, env = {}) => ({ ...W, env: { ...W.env, ...env }, exists: (x) => x === p })
  assert.equal(resolveBin('devin', only('C:\\tools\\devin.exe', { PATH: 'C:\\tools' })), 'C:\\tools\\devin.exe')
  assert.equal(resolveBin('devin', only(`D:\\Program Files\\Devin\\${DEVIN_TAIL}`, { PATH: 'C:\\Windows;D:\\Program Files\\Devin\\bin' })), `D:\\Program Files\\Devin\\${DEVIN_TAIL}`)
  const lap = `C:\\Users\\Tester\\AppData\\Local\\Programs\\Devin\\${DEVIN_TAIL}`
  assert.equal(resolveBin('devin', only(lap)), lap)
  const pf = `C:\\Program Files\\Devin\\${DEVIN_TAIL}`
  assert.equal(resolveBin('devin', only(pf)), pf)
  const d = `D:\\Program Files\\Devin\\${DEVIN_TAIL}`
  assert.equal(resolveBin('devin', only(d)), d, 'cài ở ổ D do user chọn, không có gì trên PATH')
  assert.equal(resolveBin('devin', { ...W, exists: () => false }), null)
})

test('resolveBin devin: PATH thắng bản trong thư mục Desktop; macOS tìm /Applications/Devin.app', () => {
  const both = new Set(['C:\\tools\\devin.exe', `D:\\Program Files\\Devin\\${DEVIN_TAIL}`])
  assert.equal(resolveBin('devin', { ...W, env: { ...W.env, PATH: 'C:\\tools' }, exists: (p) => both.has(p) }), 'C:\\tools\\devin.exe')
  const app = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin'
  assert.equal(resolveBin('devin', { ...M, exists: (p) => p === app }), app)
})

test('resolveBin: tên CLI lạ ⇒ ném lỗi (lỗi của người gọi, không phải trạng thái máy)', () => {
  assert.throws(() => resolveBin('gemini', { ...M, exists: () => true }), /gemini/)
})

// --- check: từng CLI -------------------------------------------------------------------------------------------------------------

test('check: chưa cài ⇒ không chạy lệnh nào, đưa lệnh cài đúng nền tảng, không đưa lệnh login', async () => {
  for (const [base, re] of [[W, /irm .*claude\.ai\/install\.ps1/], [M, /curl .*claude\.ai\/install\.sh/]]) {
    const { opts, calls } = world(base, [], {})
    const r = await check('claude', opts)
    assert.equal(r.installed, false)
    assert.equal(r.auth, 'unknown')
    assert.equal(r.reason, 'not-installed')
    assert.equal(r.ready, false)
    assert.equal(r.version, null)
    assert.equal(r.loginCmd, null)
    assert.match(r.installHint, re)
    assert.equal(calls.length, 0)
  }
})

test('check: mọi CLI chưa cài đều có installHint không rỗng cho cả hai nền tảng', async () => {
  for (const base of [W, M]) for (const name of CLI_NAMES) {
    const { opts } = world(base, [], {})
    const r = await check(name, opts)
    assert.equal(r.name, name)
    assert.ok(r.installHint && r.installHint.length > 8, `${name} ${base.platform}`)
  }
})

test('check claude: --version + auth status JSON; loggedIn:true ⇒ ok; email trong output KHÔNG lọt vào kết quả', async () => {
  const { opts, calls } = world(W, [`${NPM}\\claude.cmd`], {
    '--version': { stdout: '2.1.285 (Claude Code)\n' },
    'auth status': { stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgName":"Acme"}\n' },
  })
  const r = await check('claude', opts)
  assert.deepEqual([r.installed, r.version, r.auth, r.reason, r.ready, r.loginCmd, r.installHint], [true, '2.1.285', 'ok', 'ok', true, null, null])
  assert.equal(r.path, `${NPM}\\claude.cmd`)
  assert.ok(!JSON.stringify(r).includes('example.com') && !JSON.stringify(r).includes('Acme'))
  assert.deepEqual(calls.map((c) => c.args.join(' ')).sort(), ['--version', 'auth status'])
})

test('check claude: CLAUDECODE trong env ⇒ KHÔNG chạy `auth status` (báo sai trong phiên Claude), auth unknown nhưng gọi thử được', async () => {
  const { opts, calls } = world({ ...W, env: { ...W.env, CLAUDECODE: '1' } }, [`${NPM}\\claude.cmd`], { '--version': { stdout: '2.1.285 (Claude Code)' } })
  const r = await check('claude', opts)
  assert.deepEqual([r.installed, r.auth, r.reason, r.ready, r.loginCmd], [true, 'unknown', 'in-claude-session', true, null])
  assert.deepEqual(calls.map((c) => c.args.join(' ')), ['--version'])
})

test('check claude: gỡ riêng CLAUDECODE mà còn CLAUDE_CODE_ENTRYPOINT / SESSION_ID của host ⇒ vẫn coi là trong phiên Claude (đã kiểm: auth status vẫn báo sai)', async () => {
  for (const extra of [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CLAUDE_CODE_SESSION_ID: 'abc' }]) {
    const { opts, calls } = world({ ...W, env: { ...W.env, ...extra } }, [`${NPM}\\claude.cmd`], { '--version': { stdout: '2.1.285 (Claude Code)' } })
    const r = await check('claude', opts)
    assert.deepEqual([r.auth, r.reason, r.ready], ['unknown', 'in-claude-session', true])
    assert.equal(calls.length, 1)
  }
})

test('check claude: loggedIn:false / "Not logged in" / "Login: Expired" ⇒ none + đúng một lệnh login', async () => {
  for (const out of [{ code: 1, stdout: '{"loggedIn":false}' }, { code: 1, stderr: 'Not logged in' }, { code: 0, stdout: 'Login: Expired — log in again' }]) {
    const { opts } = world(W, [`${NPM}\\claude.cmd`], { '--version': { stdout: '2.1.285' }, 'auth status': out })
    const r = await check('claude', opts)
    assert.deepEqual([r.auth, r.reason, r.ready, r.loginCmd], ['none', 'not-logged-in', false, 'claude auth login'])
  }
})

test('check codex: "Logged in using ChatGPT" ⇒ ok; "Not logged in" exit 1 ⇒ none + `codex login`', async () => {
  const ok = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.159.3\n' }, 'login status': { stdout: 'Logged in using ChatGPT\n' } })
  const r1 = await check('codex', ok.opts)
  assert.deepEqual([r1.version, r1.auth, r1.ready], ['0.159.3', 'ok', true])
  const no = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.145.0' }, 'login status': { code: 1, stdout: 'Not logged in\n' } })
  const r2 = await check('codex', no.opts)
  assert.deepEqual([r2.auth, r2.reason, r2.loginCmd], ['none', 'not-logged-in', 'codex login'])
})

test('check cursor-agent: "✓ Logged in as <email>" ⇒ ok, email không lọt ra; phiên bản kiểu 2026.10.01-e373342', async () => {
  const p = 'C:\\Users\\Tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd'
  const { opts } = world(W, [p], { '--version': { stdout: '2026.10.01-e373342\n' }, status: { stdout: '\u2713 Logged in as me@private.example\n' } })
  const r = await check('cursor-agent', opts)
  assert.deepEqual([r.version, r.auth, r.ready], ['2026.10.01-e373342', 'ok', true])
  assert.ok(!JSON.stringify(r).includes('private.example'))
  const no = world(W, [p], { '--version': { stdout: '2026.10.01-e373342' }, status: { code: 1, stderr: 'Not logged in. Run cursor-agent login' } })
  const r2 = await check('cursor-agent', no.opts)
  assert.deepEqual([r2.auth, r2.loginCmd], ['none', 'cursor-agent login'])
})

test('check agy: không có lệnh kiểm đăng nhập ⇒ chỉ gọi --version, auth unknown (do thiết kế) nhưng gọi thử được, không bịa lệnh login', async () => {
  const p = 'C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe'
  const { opts, calls } = world(W, [p], { '--version': { stdout: '1.3.3\n' } })
  const r = await check('agy', opts)
  assert.deepEqual([r.installed, r.version, r.auth, r.reason, r.ready, r.loginCmd], [true, '1.3.3', 'unknown', 'no-status-command', true, null])
  assert.deepEqual(calls.map((c) => c.args.join(' ')), ['--version'])
})

test('check grok: "You are logged in with grok.com" ⇒ ok; phiên bản trích từ "grok 1.0.46 (…) [stable]"', async () => {
  const p = 'C:\\Users\\Tester\\.grok\\bin\\grok.exe'
  const { opts } = world(W, [p], { '--version': { stdout: 'grok 1.0.46 (2765805b9442) [stable]\n' }, models: { stdout: 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n' } })
  const r = await check('grok', opts)
  assert.deepEqual([r.version, r.auth, r.ready], ['1.0.46', 'ok', true])
})

test('check grok: lệnh trạng thái báo hết lượt ⇒ auth unknown, reason quota, KHÔNG gợi ý login', async () => {
  const p = 'C:\\Users\\Tester\\.grok\\bin\\grok.exe'
  const { opts } = world(W, [p], { '--version': { stdout: 'grok 1.0.46' }, models: { code: 1, stderr: "You've reached your free Grok Build usage limit for now. https://grok.com/supergrok" } })
  const r = await check('grok', opts)
  assert.deepEqual([r.auth, r.reason, r.loginCmd, r.ready], ['unknown', 'quota', null, false])
})

test('check devin: "Not logged in." (exit 0!) ⇒ none + `devin auth login`; đường dẫn Credentials không lọt ra; tìm bản trong thư mục Desktop', async () => {
  const exe = `D:\\Program Files\\Devin\\${DEVIN_TAIL}`
  const { opts } = world(W, [exe], {
    '--version': { stdout: 'devin 3000.10.48 (fcf7ba39)\n' },
    'auth status': { code: 0, stdout: 'Not logged in.\n  Credentials path: C:\\Users\\Tester\\AppData\\Roaming\\devin\\credentials.toml\nRun `devin.exe auth login` to authenticate.\n' },
  })
  const r = await check('devin', opts)
  assert.deepEqual([r.installed, r.path, r.version, r.auth, r.reason, r.loginCmd], [true, exe, '3000.10.48', 'none', 'not-logged-in', 'devin auth login'])
  assert.ok(!/credentials/i.test(JSON.stringify(r)))
  const yes = world(W, [exe], { '--version': { stdout: 'devin 3000.10.48 (fcf7ba39)' }, 'auth status': { stdout: 'Logged in as someone\n' } })
  assert.equal((await check('devin', yes.opts)).auth, 'ok')
})

test('check: output có mã màu ANSI / BOM / thông báo cập nhật trước dòng phiên bản vẫn đọc đúng', async () => {
  const { opts } = world(W, ['C:\\Users\\Tester\\.grok\\bin\\grok.exe'], {
    '--version': { stdout: '\u001b[2mA new version is available\u001b[0m\n\ufeffgrok \u001b[1m1.0.46\u001b[0m (2765805b9442) [stable]\n' },
    models: { stdout: '\u001b[32mYou are logged in\u001b[0m with grok.com.\n' },
  })
  const r = await check('grok', opts)
  assert.deepEqual([r.version, r.auth], ['1.0.46', 'ok'])
})

// --- check: lỗi vận hành -----------------------------------------------------------------------------------------------------------

test('check: --version quá giờ ⇒ cài rồi nhưng reason timeout, auth unknown, không sẵn sàng; không ghi cache', async () => {
  const { opts } = world(W, [`${NPM}\\codex.cmd`], { '--version': { timedOut: true, code: null }, 'login status': { stdout: 'Logged in using ChatGPT' } })
  const r = await check('codex', opts)
  assert.deepEqual([r.installed, r.reason, r.auth, r.ready], [true, 'timeout', 'unknown', false])
  assert.ok(!fs.existsSync(opts.cacheFile))
})

test('check: lệnh trạng thái quá giờ / mất mạng / thiếu quyền ⇒ auth unknown với đúng nguyên nhân, không gợi ý login', async () => {
  const cases = [
    [{ timedOut: true, code: null }, 'timeout'],
    [{ code: 1, stderr: 'stream disconnected before completion: error sending request (ENOTFOUND chatgpt.com)' }, 'network'],
    [{ code: 1, stderr: 'EACCES: permission denied, open /root/.codex/auth.json' }, 'permission'],
    [{ code: 1, stderr: 'boom' }, 'error'],
    [{ code: 0, stdout: 'hello' }, 'unrecognized'],
  ]
  for (const [res, reason] of cases) {
    const { opts } = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.159.3' }, 'login status': res })
    const r = await check('codex', opts)
    assert.deepEqual([r.installed, r.auth, r.reason, r.loginCmd, r.ready], [true, 'unknown', reason, null, false], reason)
  }
})

test('check: đường dẫn thấy trên PATH nhưng chạy không được (ENOENT) ⇒ coi như chưa cài; lỗi khác ⇒ reason error', async () => {
  const a = world(W, [`${NPM}\\codex.cmd`], { '--version': { code: null, error: { code: 'ENOENT' } }, 'login status': { code: null, error: { code: 'ENOENT' } } })
  const r1 = await check('codex', a.opts)
  assert.deepEqual([r1.installed, r1.reason], [false, 'not-installed'])
  const b = world(W, [`${NPM}\\codex.cmd`], { '--version': { code: null, error: { code: 'EACCES' } }, 'login status': { code: null, error: { code: 'EACCES' } } })
  const r2 = await check('codex', b.opts)
  assert.deepEqual([r2.installed, r2.reason, r2.ready], [true, 'error', false])
})

test('check: giờ chờ mỗi lệnh luôn ≤ 20 giây dù người gọi xin nhiều hơn; mọi tham số lệnh là mảng token an toàn (không chuỗi shell)', async () => {
  for (const name of CLI_NAMES) {
    const table = { '--version': { stdout: '1.2.3' }, 'auth status': { stdout: 'Logged in' }, 'login status': { stdout: 'Logged in' }, status: { stdout: 'Logged in' }, models: { stdout: 'logged in' } }
    const files = { claude: `${NPM}\\claude.cmd`, codex: `${NPM}\\codex.cmd`, 'cursor-agent': 'C:\\Users\\Tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd', agy: 'C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe', grok: 'C:\\Users\\Tester\\.grok\\bin\\grok.exe', devin: `D:\\Program Files\\Devin\\${DEVIN_TAIL}` }
    const { opts, calls } = world(W, [files[name]], table, { timeoutMs: 99999 })
    await check(name, opts)
    assert.ok(calls.length >= 1)
    for (const c of calls) {
      assert.ok(c.o.timeoutMs <= MAX_TIMEOUT_MS && c.o.timeoutMs > 0, `${name} ${c.o.timeoutMs}`)
      assert.ok(Array.isArray(c.args) && c.args.every((a) => /^[\w.:=/-]+$/.test(a)), `${name} ${c.args}`)
    }
  }
  const d = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: '1.2.3' }, 'login status': { stdout: 'Logged in' } })
  await check('codex', d.opts)
  assert.ok(d.calls.every((c) => c.o.timeoutMs <= MAX_TIMEOUT_MS), 'mặc định cũng ≤ 20 giây')
})

test('checkAll: 6 CLI song song, trả đủ khoá theo thứ tự; tên lạ ⇒ ném lỗi', async () => {
  const { opts } = world(M, [], {})
  const all = await checkAll(undefined, opts)
  assert.deepEqual(Object.keys(all), CLI_NAMES)
  assert.ok(Object.values(all).every((r) => r.installed === false))
  assert.deepEqual(Object.keys(await checkAll(['grok', 'agy'], opts)), ['grok', 'agy'])
  await assert.rejects(() => checkAll(['codex', 'nope'], opts), /nope/)
})

// --- cache ----------------------------------------------------------------------------------------------------------------------------

test('cachePath: ~/.claude/cache/clis.json theo HOME truyền vào', () => {
  assert.equal(cachePath('/Users/tester'), path.join('/Users/tester', '.claude', 'cache', 'clis.json'))
  assert.equal(CACHE_TTL_MS, 10 * 60 * 1000)
})

test('cache: kết quả ok nhớ 10 phút (không chạy lại lệnh), hết hạn thì kiểm lại, fresh:true bỏ qua cache', async () => {
  let t = 1_000_000
  const { opts, calls } = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.159.3' }, 'login status': { stdout: 'Logged in using ChatGPT' } }, { now: () => t })
  const r1 = await check('codex', opts)
  assert.equal(r1.cached, undefined)
  assert.equal(calls.length, 2)
  t += CACHE_TTL_MS - 1
  const r2 = await check('codex', opts)
  assert.equal(calls.length, 2, 'còn hạn ⇒ không chạy lại')
  assert.deepEqual([r2.cached, r2.auth, r2.version, r2.ready], [true, 'ok', '0.159.3', true])
  const r3 = await check('codex', { ...opts, fresh: true })
  assert.equal(calls.length, 4)
  assert.equal(r3.cached, undefined)
  t += CACHE_TTL_MS + 5
  await check('codex', opts)
  assert.equal(calls.length, 6, 'quá 10 phút ⇒ kiểm lại')
})

test('opts.now nhận cả SỐ (mili giây) lẫn hàm — như models/deps; số cố định thì cache còn hạn', async () => {
  const { opts, calls } = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.159.3' }, 'login status': { stdout: 'Logged in using ChatGPT' } }, { now: 1_000_000 })
  const r1 = await check('codex', opts)
  assert.equal(r1.ready, true)
  assert.equal(calls.length, 2)
  const r2 = await check('codex', opts)
  assert.equal(calls.length, 2, 'số cố định ⇒ cache còn hạn, không chạy lại')
  assert.equal(r2.cached, true)
})

test('cache: chỉ nhớ kết quả ok — chưa login / hết hạn mức / quá giờ kiểm lại ngay (user vừa login xong không bị kết quả cũ chặn)', async () => {
  const { opts, calls } = world(W, [`${NPM}\\codex.cmd`], { '--version': { stdout: 'codex-cli 0.159.3' }, 'login status': { code: 1, stdout: 'Not logged in' } })
  await check('codex', opts)
  await check('codex', opts)
  assert.equal(calls.length, 4)
  assert.ok(!fs.existsSync(opts.cacheFile))
})

test('cache: file hỏng / sai kiểu / bản cài đã biến mất ⇒ bỏ qua, không ném lỗi; cache:false không đụng đĩa; file cache không chứa gì ngoài trường đã biết', async () => {
  const files = [`${NPM}\\codex.cmd`]
  const table = { '--version': { stdout: 'codex-cli 0.159.3 someone@example.com' }, 'login status': { stdout: 'Logged in using ChatGPT (someone@example.com)' } }
  const a = world(W, files, table)
  fs.writeFileSync(a.opts.cacheFile, '{not json')
  assert.equal((await check('codex', a.opts)).auth, 'ok')
  const saved = JSON.parse(fs.readFileSync(a.opts.cacheFile, 'utf8'))
  assert.ok(!JSON.stringify(saved).includes('example.com'))
  assert.deepEqual(Object.keys(saved.entries.codex.result).sort(), ['auth', 'installed', 'name', 'path', 'reason', 'version'])
  fs.writeFileSync(a.opts.cacheFile, JSON.stringify({ entries: { codex: { at: 'x', result: 5 } } }))
  assert.equal((await check('codex', a.opts)).auth, 'ok')
  const b = world(W, files, table)
  await check('codex', b.opts)
  const gone = { ...b.opts, exists: () => false }
  assert.equal((await check('codex', gone)).reason, 'not-installed', 'cache nói ok nhưng file đã bị xoá ⇒ không tin cache')
  const c = world(W, files, table, { cache: false })
  await check('codex', c.opts)
  assert.ok(!fs.existsSync(c.opts.cacheFile))
})

test('cache: ghi vào <home>/.claude/cache/clis.json (HOME giả), tạo thư mục nếu thiếu, giữ mục của CLI khác', async () => {
  const home = tmp('clis-home ')
  const bin = tmp('clis-bin ')
  const nat = { platform: process.platform, env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, home }
  const file = path.join(bin, IS_WIN ? 'codex.cmd' : 'codex')
  fs.writeFileSync(file, '')
  const { run } = fakeRun({ '--version': { stdout: 'codex-cli 1.0.0' }, 'login status': { stdout: 'Logged in using ChatGPT' } })
  const exists = (p) => p === file
  await check('codex', { ...nat, run, exists })
  const f = cachePath(home)
  assert.ok(fs.existsSync(f))
  const g = path.join(bin, IS_WIN ? 'grok.exe' : 'grok')
  fs.writeFileSync(g, '')
  const run2 = fakeRun({ '--version': { stdout: 'grok 1.0.46' }, models: { stdout: 'You are logged in with grok.com.' } }).run
  await check('grok', { ...nat, run: run2, exists: (p) => p === g })
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).entries).sort(), ['codex', 'grok'])
})

// --- classifyFailure --------------------------------------------------------------------------------------------------------------------

test('classifyFailure: hết hạn mức theo chuỗi đã gặp (Grok, Codex) ⇒ quota, KHÔNG gợi ý login', () => {
  const grok = classifyFailure('grok', { code: 1, stdout: '', stderr: "You've reached your free Grok Build usage limit for now… https://grok.com/supergrok\nError: usage limit" })
  assert.deepEqual([grok.reason, grok.loginCmd], ['quota', null])
  for (const text of ['{"type":"error","message":"usage_limit_reached"}', '{"error":{"code":"rate_limit_exceeded"}}', "You've hit your usage limit. Try again at 3pm."]) {
    const r = classifyFailure('codex', { code: 1, stdout: text, stderr: '' })
    assert.deepEqual([r.reason, r.loginCmd], ['quota', null], text)
  }
  assert.equal(classifyFailure('claude', { code: 1, stdout: 'Claude AI usage limit reached|1760000000', stderr: '' }).reason, 'quota')
})

test('classifyFailure: quota thắng chuỗi "đăng nhập"; không có quota thì token hết hạn ⇒ not-logged-in + lệnh login đúng CLI', () => {
  const both = classifyFailure('codex', { code: 1, stderr: 'usage_limit_reached; please sign in again' })
  assert.deepEqual([both.reason, both.loginCmd], ['quota', null])
  const login = classifyFailure('codex', { code: 1, stderr: 'Your access token could not be refreshed. Please sign in again.' })
  assert.deepEqual([login.reason, login.loginCmd], ['not-logged-in', 'codex login'])
  assert.equal(classifyFailure('grok', { code: 1, stderr: 'Please log in' }).loginCmd, 'grok login')
  assert.equal(classifyFailure('devin', { code: 1, stderr: 'Not logged in.' }).loginCmd, 'devin auth login')
})

test('classifyFailure: mạng / thiếu quyền / quá giờ / lỗi không rõ', () => {
  for (const text of ['stream disconnected before completion', 'getaddrinfo ENOTFOUND api.x.ai', 'connect ECONNREFUSED 127.0.0.1:443', 'fetch failed', 'ETIMEDOUT', 'Could not resolve host']) {
    assert.equal(classifyFailure('grok', { code: 1, stderr: text }).reason, 'network', text)
  }
  for (const text of ['EACCES: permission denied', 'Error: EPERM: operation not permitted', '403 Forbidden']) {
    assert.equal(classifyFailure('claude', { code: 1, stderr: text }).reason, 'permission', text)
  }
  assert.equal(classifyFailure('agy', { code: null, timedOut: true }).reason, 'timeout')
  assert.equal(classifyFailure('agy', { code: 1, stderr: 'segfault' }).reason, 'error')
  assert.equal(classifyFailure('agy', { code: null, error: { code: 'ENOENT' } }).reason, 'not-installed')
  for (const reason of ['quota', 'network', 'permission', 'timeout', 'error']) assert.ok(classifyFailure('grok', reason === 'quota' ? { code: 1, stderr: 'usage limit' } : { code: 1, stderr: reason === 'network' ? 'fetch failed' : reason === 'permission' ? 'EACCES' : 'x', timedOut: reason === 'timeout' }).message.length > 5)
})

test('classifyFailure: exit 0 ⇒ ok dù câu trả lời nhắc "rate limit"; chỉ xét stderr + đuôi 2.000 ký tự của stdout khi lệnh lỗi', () => {
  assert.equal(classifyFailure('codex', { code: 0, stdout: 'Add a rate limit and handle usage_limit_reached', stderr: '' }).reason, 'ok')
  const long = 'usage limit '.repeat(5) + 'x'.repeat(5000)
  assert.equal(classifyFailure('codex', { code: 1, stdout: long, stderr: '' }).reason, 'error', 'chữ ở đầu câu trả lời dài không phải lỗi hạn mức')
  assert.equal(classifyFailure('codex', { code: 1, stdout: 'x'.repeat(5000) + ' usage_limit_reached', stderr: '' }).reason, 'quota')
})

// --- runCommand (spawn thật với shim giả) ------------------------------------------------------------------------------------------

function shim(dir, name, bodyWin, bodyPosix) {
  if (IS_WIN) {
    const f = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(f, `@echo off\r\n${bodyWin}\r\n`)
    return f
  }
  const f = path.join(dir, name)
  fs.writeFileSync(f, `#!/bin/sh\n${bodyPosix}\n`, { mode: 0o755 })
  return f
}

const SHIM_DIR_NAME = 'thư mục có dấu cách'

test('runCommand: chạy shim (Windows .cmd qua cmd.exe, POSIX script) trong đường dẫn có dấu cách + tiếng Việt; lấy stdout, stderr, mã thoát; stdin đóng', async () => {
  const dir = path.join(tmp(), SHIM_DIR_NAME)
  fs.mkdirSync(dir)
  const f = shim(dir, 'fake',
    'if "%1"=="--version" (echo fake 1.2.3) else (echo oops 1>&2 & exit /b 3)',
    'case "$1" in --version) echo "fake 1.2.3";; *) echo oops >&2; exit 3;; esac')
  const ok = await runCommand(f, ['--version'], { timeoutMs: 10000 })
  assert.deepEqual([ok.code, ok.timedOut, ok.error, ok.stdout.trim()], [0, false, null, 'fake 1.2.3'])
  const bad = await runCommand(f, ['status'], { timeoutMs: 10000 })
  assert.deepEqual([bad.code, bad.stderr.trim()], [3, 'oops'])
})

test('runCommand: không có file ⇒ error ENOENT (không ném); đối số có ký tự shell trên .cmd bị từ chối trước khi chạy', async () => {
  const r = await runCommand(path.join(tmp(), 'khong-co-file'), ['--version'], { timeoutMs: 5000 })
  assert.equal(r.error?.code, 'ENOENT')
  assert.equal(r.code, null)
  if (IS_WIN) {
    const dir = tmp()
    const f = shim(dir, 'fake', 'echo hi', '')
    const evil = await runCommand(f, ['a&calc'], { timeoutMs: 5000 })
    assert.equal(evil.error?.code, 'EUNSAFE')
    assert.equal(evil.stdout, '')
    const evil2 = await runCommand(f, ['--version'], { timeoutMs: 5000, env: { ...process.env } })
    assert.equal(evil2.error, null)
  }
})

test('runCommand: quá giờ ⇒ timedOut:true, trả về nhanh, giữ phần output đã có, diệt cả cây tiến trình (POSIX: kiểm pid con)', async () => {
  const dir = tmp()
  const pidFile = path.join(dir, 'pids')
  const f = shim(dir, 'slow',
    'if "%1"=="warm" exit /b 0\r\necho started\r\nping -n 30 127.0.0.1 >nul\r\necho late',
    `[ "$1" = warm ] && exit 0\necho started\nsleep 30 &\necho "$$ $!" > '${pidFile}'\nwait\necho late`)
  // macOS quét bảo mật file thực thi vừa ghi ở lần chạy ĐẦU (~230ms đo trên Mac mini, hơn 700ms khi nhiều test chạy song song);
  // chạy khởi động một lần cho lần quét xong, để mốc 700ms bên dưới đo đúng việc "quá giờ", không đo tốc độ quét.
  assert.equal((await runCommand(f, ['warm'], { timeoutMs: 30000 })).code, 0)
  const t0 = Date.now()
  const r = await runCommand(f, [], { timeoutMs: 700 })
  const dt = Date.now() - t0
  assert.equal(r.timedOut, true)
  assert.ok(dt < 6000, `trả về sau ${dt}ms`)
  assert.ok(!r.stdout.includes('late'))
  if (!IS_WIN) {
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    const pids = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
    for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50)) // chờ hệ điều hành dọn xác tiến trình
    for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} còn sống sau khi quá giờ`)
  }
})

test('runCommand: output quá lớn bị cắt ở trần bộ nhớ, không treo (POSIX)', { skip: IS_WIN }, async () => {
  const dir = tmp()
  const f = shim(dir, 'big', '', 'head -c 2000000 /dev/zero | tr "\\0" x')
  const r = await runCommand(f, [], { timeoutMs: 10000 })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.length > 1000 && r.stdout.length <= 512 * 1024, String(r.stdout.length))
})

// --- CLI cli-check.mjs ---------------------------------------------------------------------------------------------------------------

const READY = { name: 'codex', installed: true, path: '/x/codex', version: '0.159.3', auth: 'ok', reason: 'ok', message: 'sẵn sàng', ready: true, loginCmd: null, installHint: null }
const NO_LOGIN = { ...READY, name: 'claude', version: '2.1.285', auth: 'none', reason: 'not-logged-in', message: 'claude chưa đăng nhập', ready: false, loginCmd: 'claude auth login' }
const MISSING = { name: 'grok', installed: false, path: null, version: null, auth: 'unknown', reason: 'not-installed', message: 'grok chưa cài', ready: false, loginCmd: null, installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash' }

function cliHarness(results) {
  const seen = []
  const io = { out: '', err: '' }
  const deps = {
    checkAll: async (names, o) => { seen.push({ names, o }); return Object.fromEntries((names ?? Object.keys(results)).map((n) => [n, results[n]])) },
    stdout: { write: (s) => { io.out += s } },
    stderr: { write: (s) => { io.err += s } },
  }
  return { deps, io, seen }
}

test('cli-check main: tất cả sẵn sàng ⇒ exit 0; --json in object theo tên CLI', async () => {
  const h = cliHarness({ codex: READY })
  assert.equal(await main(['codex', '--json'], h.deps), 0)
  assert.deepEqual(JSON.parse(h.io.out).codex, READY)
  assert.deepEqual(h.seen[0].names, ['codex'])
})

test('cli-check main: có CLI chưa sẵn sàng ⇒ exit 1; bản người đọc mỗi CLI một dòng: tên, phiên bản, lý do, đúng MỘT lệnh (login hoặc cài)', async () => {
  const h = cliHarness({ codex: READY, claude: NO_LOGIN, grok: MISSING })
  assert.equal(await main(['codex', 'claude', 'grok'], h.deps), 1)
  const lines = h.io.out.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^codex\s+0\.159\.3\s+sẵn sàng$/)
  assert.match(lines[1], /^claude\s+2\.1\.285\s+claude chưa đăng nhập -> claude auth login$/)
  assert.match(lines[2], /^grok\s+-\s+grok chưa cài -> curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash$/)
})

test('cli-check main: không nêu tên ⇒ kiểm cả 6 (names undefined); --fresh, --timeout <giây> đi vào tuỳ chọn', async () => {
  const h = cliHarness({ codex: READY })
  await main(['--fresh', '--timeout', '5'], h.deps)
  assert.equal(h.seen[0].names, undefined)
  assert.equal(h.seen[0].o.fresh, true)
  assert.equal(h.seen[0].o.timeoutMs, 5000)
})

test('cli-check main: tên lạ / --timeout sai / cờ lạ ⇒ exit 2, một dòng stderr, không chạy kiểm', async () => {
  for (const argv of [['gemini'], ['codex', '--timeout', 'abc'], ['codex', '--timeout'], ['--nope']]) {
    const h = cliHarness({ codex: READY })
    assert.equal(await main(argv, h.deps), 2, argv.join(' '))
    assert.equal(h.io.out, '')
    assert.equal(h.io.err.trim().split('\n').length, 1)
    assert.equal(h.seen.length, 0)
  }
  const h = cliHarness({})
  await main(['gemini'], h.deps)
  assert.match(h.io.err, /gemini/)
})

test('cli-check (spawn thật): shim codex giả trong thư mục có dấu cách/tiếng Việt ⇒ exit 0, JSON đủ trường, cache vào HOME giả, lần hai dùng cache', () => {
  const home = tmp('clis-home ')
  const bin = path.join(tmp(), SHIM_DIR_NAME)
  fs.mkdirSync(bin)
  shim(bin, 'codex',
    'if "%1"=="--version" (echo codex-cli 9.9.9) else if "%1"=="login" (echo Logged in using ChatGPT) else (exit /b 3)',
    'case "$1" in --version) echo "codex-cli 9.9.9";; login) echo "Logged in using ChatGPT";; *) exit 3;; esac')
  const env = {
    PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD', HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, windir: process.env.windir,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const go = (...args) => spawnSync(process.execPath, [CLI_SCRIPT, ...args], { env, encoding: 'utf8', timeout: 60000 })
  const r = go('codex', '--json')
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout).codex
  assert.deepEqual([j.installed, j.version, j.auth, j.ready], [true, '9.9.9', 'ok', true])
  assert.ok(fs.existsSync(cachePath(home)), 'cache nằm trong HOME giả')
  assert.equal(JSON.parse(go('codex', '--json').stdout).codex.cached, true)
  assert.equal(JSON.parse(go('codex', '--json', '--fresh').stdout).codex.cached, undefined)
})

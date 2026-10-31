// Test cho lib/devin.mjs + devin-vm.mjs: node --test ~/.claude/hooks/devin-vm.test.mjs
// KHÔNG gọi Devin thật: REST/MCP là fetch giả, `devin ssh` là spawn giả. Phần git là git THẬT trong thư mục tạm; phần "máy ảo" của sync chạy script thật bằng bash
// (bỏ qua nếu máy không có bash). Đường dẫn dự án có dấu cách + tiếng Việt; thư mục giả lập máy ảo chỉ ASCII (MSYS bash).
import { EventEmitter } from 'node:events'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as D from './lib/devin.mjs'
import { main, parseArgs } from './devin-vm.mjs'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
let seq = 0
const fresh = (name = 'd') => {
  const p = path.join(ROOT, `${name}${++seq}`)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }
// Windows: dùng bash của Git (ngoài PATH có thể là bash của WSL, chạy khác hẳn); nơi khác: bash trên PATH.
function findBash() {
  if (process.platform === 'win32') {
    const ep = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim()
    const cand = ep && path.join(ep, '..', '..', '..', 'bin', 'bash.exe')
    if (cand && fs.existsSync(cand)) return cand
  }
  return 'bash'
}
const BASH = findBash()
const HAS_BASH = spawnSync(BASH, ['--version'], { encoding: 'utf8' }).status === 0

// ---------- git thật ----------
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false']
const g = (cwd, ...args) => {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function mkRepo(files = { 'a.txt': 'a\n' }, { origin, dir } = {}) {
  const d = dir ?? path.join(fresh('p'), 'Dự án', 'ứng dụng demo')
  fs.mkdirSync(d, { recursive: true })
  g(d, 'init', '-q', '-b', 'main')
  for (const [f, c] of Object.entries(files)) write(path.join(d, f), c)
  g(d, 'add', '-A')
  g(d, 'commit', '-q', '-m', 'c1')
  if (origin) g(d, 'remote', 'add', 'origin', origin)
  return d
}
const lsTree = (cwd, ref) => g(cwd, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort()

// ---------- Devin giả ----------
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
function fakeApi() {
  const sessions = new Map()
  const calls = []
  const attachments = new Map()
  let n = 0
  const api = {
    sessions, calls, attachments, fail: null, stuck: false,
    // GetUserStatus (số hạn mức của Devin CLI /usage): mặc định còn 80% ngày. Test đổi `plan` (thiếu trường = 0 theo proto3) hoặc đặt `quotaReply(rec)` để trả tuỳ ý.
    plan: { dailyQuotaRemainingPercent: 80, weeklyQuotaRemainingPercent: 47, dailyQuotaResetAtUnix: '1793520000', weeklyQuotaResetAtUnix: '1793520000', overageBalanceMicros: -14108 },
    quotaReply: null,
    quotaCalls: () => calls.filter((c) => c.path.endsWith('/GetUserStatus')),
    seed(status = 'suspended', detail = 'inactivity') {
      const id = `devin-seed${++n}abcdef`
      sessions.set(id, { status, detail, polls: 0 })
      return id
    },
    posts: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/sessions')),
    mcpCalls: () => calls.filter((c) => c.host === 'mcp.devin.ai').map((c) => JSON.parse(c.body)).filter((b) => b.method === 'tools/call'),
    sleeps: () => api.mcpCalls().filter((b) => b.params.arguments.action === 'sleep'),
    pings: () => api.mcpCalls().filter((b) => b.params.arguments.action === 'message'),
    async fetch(url, init = {}) {
      const u = new URL(url)
      const method = init.method ?? 'GET'
      const rec = { method, host: u.host, path: u.pathname, protocol: u.protocol, url: String(url), headers: init.headers ?? {}, body: init.body, manual: init.redirect === 'manual', signal: Boolean(init.signal) }
      calls.push(rec)
      if (api.fail) {
        const r = api.fail(rec)
        if (r) return r instanceof Error ? Promise.reject(r) : r
      }
      if (u.pathname.endsWith('/GetUserStatus')) {
        if (api.quotaReply) {
          const r = api.quotaReply(rec)
          return r instanceof Error ? Promise.reject(r) : r
        }
        return json(200, { userStatus: { planStatus: api.plan } })
      }
      if (u.host === 'mcp.devin.ai') {
        const b = JSON.parse(init.body)
        if (b.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }), { status: 200, headers: { 'mcp-session-id': 'mcp-1' } })
        if (b.method.startsWith('notifications/')) return new Response(null, { status: 202 })
        const s = sessions.get(b.params.arguments.session_id)
        if (s && b.params.arguments.action === 'sleep' && !api.stuck) s.sleepIn = 2 // "message" (ping giữ thức) không làm máy ngủ
        if (s && b.params.arguments.action === 'terminate' && s.status !== 'suspended') s.status = 'exit'
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`, { status: 200 })
      }
      const m = /^\/v3\/organizations\/[^/]+(\/.*)$/.exec(u.pathname)
      if (!m) return json(404, {})
      const rest = m[1]
      if (method === 'POST' && rest === '/sessions') {
        const body = JSON.parse(init.body)
        const id = `devin-new${++n}abcdef`
        sessions.set(id, { status: 'new', detail: null, polls: 0, body })
        return json(200, { session_id: id.replace(/^devin-/, ''), status: 'new' })
      }
      const sm = /^\/sessions\/([^/]+)$/.exec(rest)
      if (sm) {
        const s = sessions.get(sm[1])
        if (!s) return json(404, { detail: 'not found' })
        if (method === 'DELETE') {
          // Devin thật (đo 31/10): DELETE lên máy đang ngủ trả 200 nhưng KHÔNG xoá — máy vẫn đánh thức được
          if (s.status === 'suspended') return json(200, { session_id: sm[1], status: s.status })
          // máy Windows: DELETE chỉ để lại running/finished, phải MCP terminate mới exit
          if (api.deleteFinishes) { s.detail = 'finished'; return json(200, { session_id: sm[1], status: s.status }) }
          sessions.delete(sm[1])
          return json(200, {})
        }
        s.polls++
        if (s.status === 'new' && s.polls >= 2) s.status = 'running'
        if (s.sleepIn && --s.sleepIn === 0) Object.assign(s, { status: 'suspended', detail: 'user_request' })
        return json(200, { session_id: sm[1], status: s.status, status_detail: s.detail })
      }
      if (method === 'POST' && rest === '/attachments') {
        const f = init.body.get('file')
        const id = `att${++n}abcdef`
        attachments.set(id, { name: f.name, bytes: Buffer.from(await f.arrayBuffer()) })
        return json(200, { attachment_id: id, name: f.name })
      }
      const am = /^\/attachments\/([^/]+)\/(.+)$/.exec(rest)
      if (am && method === 'GET') return new Response(null, { status: 307, headers: { location: `https://s3.example.test/signed/${am[1]}?X-Amz-Signature=SIGSECRET${am[1]}` } })
      return json(404, {})
    },
  }
  return api
}

// Hạn mức giả: đo thật 31/10 planStatus KHÔNG có dailyQuotaRemainingPercent khi bằng 0 (proto3 bỏ số 0). daily === undefined ⇒ bỏ trường.
const QUOTA_RESET = 1793520000
const quotaPlan = (daily, extra = {}) => ({
  ...(daily === undefined ? {} : { dailyQuotaRemainingPercent: daily }),
  weeklyQuotaRemainingPercent: 47, dailyQuotaResetAtUnix: String(QUOTA_RESET), weeklyQuotaResetAtUnix: String(QUOTA_RESET), overageBalanceMicros: -14108, ...extra,
})
const quotaReplies = (...dailies) => { let n = 0; return () => json(200, { userStatus: { planStatus: quotaPlan(dailies[Math.min(n++, dailies.length - 1)]) } }) }

const decodeCommand = (command) => {
  const ps = /-EncodedCommand (\S+)/.exec(command)
  if (ps) return Buffer.from(ps[1], 'base64').toString('utf16le')
  const b = /printf %s '([A-Za-z0-9+/=]*)'/.exec(command)
  return b ? Buffer.from(b[1], 'base64').toString('utf8') : command
}
// `devin ssh` giả: ghi lại lệnh, đánh thức máy ngủ ở lần đầu, trả kết quả theo handler (mặc định: probe/node/âm thanh đều ổn).
function fakeSsh(api, handler) {
  const calls = []
  const git = []
  const spawn = async (cmd, args, o = {}) => {
    if (cmd === 'git') {
      git.push(args)
      return D.runProc(cmd, args, o)
    }
    assert.equal(cmd, 'DEVIN')
    assert.equal(args[0], 'ssh')
    assert.equal(o.input, undefined, 'không bao giờ gửi qua stdin của devin ssh (bị treo)')
    const [, id, command] = args
    const s = api.sessions.get(id)
    if (s?.status === 'suspended') s.status = 'running'
    const rec = { id, command, script: decodeCommand(command) }
    calls.push(rec)
    const base = { code: 0, stdout: '', stderr: '', timedOut: false, error: null }
    const h = await handler?.(rec)
    if (h) return { ...base, ...h }
    if (/devinvm-ready/.test(command)) return { ...base, stdout: 'devinvm-ready\n' }
    if (rec.script.includes('SHASUMS256')) return { ...base, stdout: '@@DEVINVM@@ node v24.9.0\n' }
    if (rec.script.includes('Audiosrv')) return { ...base, stdout: '@@DEVINVM@@ audio Running\n' }
    return base
  }
  return { spawn, calls, git }
}

function mkCtx({ api = fakeApi(), handler, env = {}, server = 'https://server.codeium.com', ...over } = {}) {
  const dir = fresh('ctx')
  write(path.join(dir, 'devin', 'credentials.toml'), `windsurf_api_key = "devin-session-token$KEYSECRET123456"\n${server ? `api_server_url = "${server}"\n` : ''}`)
  const warns = [] // dòng cảnh báo stderr của công cụ (ctx.warn) — gom lại để test kiểm, không in ra
  write(path.join(dir, 'devin', 'config.json'), JSON.stringify({ version: 1, devin: { org_id: 'org-abcdef123456' } }))
  const ssh = fakeSsh(api, handler)
  let t = 1_000_000
  // hẹn giờ giả: không chạy thật, test gọi fire() để "đến giờ" (hàm ping trả promise nên chờ được)
  const timers = []
  // môi trường sạch: giữ PATH/Windows cần cho git, bỏ mọi khoá thật và biến DEVIN_* của máy đang chạy test
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|^DEVIN|^FLOW_STATE_DIR$/i.test(k)))
  const ctx = D.makeCtx({
    env: { ...clean, DEVIN_CREDENTIALS: path.join(dir, 'devin', 'credentials.toml'), ...env },
    home: dir,
    stateDir: path.join(dir, 'state'),
    logFile: path.join(dir, 'devin-vm.log'),
    devinBin: 'DEVIN',
    fetch: (u, i) => api.fetch(u, i),
    spawn: ssh.spawn,
    sleep: async (ms) => { t += ms },
    now: () => (t += 1000),
    setInterval: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h },
    clearInterval: (h) => { if (h) h.on = false },
    warn: (s) => warns.push(String(s)),
    ...over,
  })
  return { ctx, api, ssh, dir, timers, warns, fire: async () => { for (const h of timers.filter((x) => x.on)) await h.fn() } }
}
const sink = () => { const b = []; return { write: (s) => b.push(s), text: () => b.join('') } }
// Mục sổ có sẵn cho (dự án, os) với một máy giả ở trạng thái `status`.
async function seedVm(ctx, api, repo, osName, status = 'running') {
  const info = await D.projectInfo(ctx, repo)
  const id = api.seed(status)
  await D.updateRegistry(ctx, (reg) => { reg[D.projectKey(ctx, info.root, osName)] = { id, os: osName, name: info.name, root: info.root, created: 'x', lastUp: 'x', prep: { node: true, audio: true } } })
  return id
}

// ---------- chuỗi, đăng nhập ----------
describe('chuỗi', () => {
  test('stripAnsi: bỏ mã màu/OSC/CR, giữ chữ; scrub: che link và giá trị bí mật', () => {
    assert.equal(D.stripAnsi('\u001b[31mđỏ\u001b[0m xong\r\n\u001b]0;tiêu đề\u0007dòng 2\r'), 'đỏ xong\ndòng 2\n')
    assert.equal(D.scrub('lỗi tại https://s3.x/y?sig=ABC rồi', []), 'lỗi tại <link> rồi')
    assert.equal(D.scrub('khoá hunter2xyz ở đây', ['hunter2xyz']), 'khoá *** ở đây')
  })
  test('wrapRemote: một dòng chỉ có ký tự an toàn (không nháy kép/xuống dòng — qua devin.exe→ssh.exe không bị vỡ), giải mã ra đúng script; bash -n ổn', () => {
    const script = 'echo "xin chào" && cat <<EOF\n$HOME\nEOF\n'
    const cmd = D.wrapRemote(script)
    assert.ok(!/["\n\r]/.test(cmd))
    assert.equal(decodeCommand(cmd), script)
    if (HAS_BASH) assert.equal(spawnSync(BASH, ['-n'], { input: cmd, encoding: 'utf8' }).status, 0)
  })
  test('psCommand: -EncodedCommand UTF-16LE base64', () => {
    const c = D.psCommand('Write-Output "ê"')
    assert.match(c, /^powershell -NoProfile -NonInteractive .* -EncodedCommand [A-Za-z0-9+/=]+$/)
    assert.equal(decodeCommand(c), 'Write-Output "ê"')
  })
  test('isSecretPath: .env*, .mcp.json, khoá riêng, Note/ là bí mật; .env.example thì không', () => {
    for (const p of ['.env', 'app/.env.local', '.env.production', '.dev.vars', '.mcp.json', 'k/id_rsa', 'a/b.pem', 'x/server.key', 'Note/x.md']) assert.ok(D.isSecretPath(p), p)
    for (const p of ['.env.example', 'src/env.ts', 'README.md', 'keyboard.js', 'a/monkey.txt']) assert.ok(!D.isSecretPath(p), p)
  })
})

describe('đăng nhập Devin', () => {
  test('parse credentials/org: đọc được cả org lồng trong devin.org_id; thiếu ⇒ null', () => {
    assert.equal(D.parseCredentials('windsurf_api_key = "abc$def-123"\n'), 'abc$def-123')
    assert.equal(D.parseCredentials('x = 1'), null)
    assert.equal(D.parseOrgId('{"devin":{"org_id":"org-1234"}}'), 'org-1234')
    assert.equal(D.parseOrgId('{"org_id":"org-9999"}'), 'org-9999')
    assert.equal(D.parseOrgId('org_id = "org-5555"'), 'org-5555')
    assert.equal(D.parseOrgId('{}'), null)
  })
  test('có đăng nhập: khoá không liệt kê được (JSON/console không lộ)', async () => {
    const { ctx } = mkCtx()
    const login = await D.loadLogin(ctx)
    assert.equal(login.org, 'org-abcdef123456')
    assert.ok(login.key.startsWith('devin-session-token'))
    assert.ok(!JSON.stringify(login).includes('KEYSECRET') && !Object.keys(login).includes('key'))
  })
  test('thiếu file / hỏng / thiếu org ⇒ DevinUnavailable(not-logged-in) kèm devin auth login', async () => {
    const { ctx: a } = mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co', 'credentials.toml') } })
    await assert.rejects(D.loadLogin(a), (e) => e instanceof D.DevinUnavailable && e.kind === 'not-logged-in' && e.loginCmd === 'devin auth login')
    const { ctx: b, dir } = mkCtx()
    write(path.join(dir, 'devin', 'credentials.toml'), 'rác')
    await assert.rejects(D.loadLogin(b), D.DevinUnavailable)
    const { ctx: c, dir: d2 } = mkCtx()
    write(path.join(d2, 'devin', 'config.json'), '{"devin":{}}')
    await assert.rejects(D.loadLogin(c), D.DevinUnavailable)
  })
})

// ---------- chọn nơi chạy ----------
describe('createBody / detectOs / devin.json', () => {
  test('createBody: SWE-2, không giao việc, đúng platform; repos chỉ khi kho kayntran', () => {
    const b = D.createBody({ os: 'windows', name: 'demo', slug: { owner: 'kayntran', repo: 'demo' } })
    assert.deepEqual([b.platform, b.devin_mode, b.repos], ['windows', 'swe-2-medium', ['kayntran/demo']])
    assert.match(b.prompt, /Do not run any tools/)
    assert.ok(!('repos' in D.createBody({ os: 'linux', name: 'x', slug: null })))
  })
  test('parseSlug: https/ssh/có token; projectInfo chỉ nhận kayntran', async () => {
    assert.deepEqual(D.parseSlug('https://github.com/kayntran/Foo.git'), { owner: 'kayntran', repo: 'Foo' })
    assert.deepEqual(D.parseSlug('git@github.com:kayntran/foo'), { owner: 'kayntran', repo: 'foo' })
    assert.equal(D.parseSlug('https://tok:en@github.com/kayntran/foo.git/').repo, 'foo')
    assert.equal(D.parseSlug('https://gitlab.com/a/b'), null)
    const { ctx } = mkCtx()
    assert.equal((await D.projectInfo(ctx, mkRepo({ 'a': '1' }, { origin: 'https://tok:en@github.com/kayntran/demo-app.git' }))).slug.repo, 'demo-app')
    const other = await D.projectInfo(ctx, mkRepo({ 'a': '1' }, { origin: 'https://github.com/namtran020322/x.git' }))
    assert.equal(other.slug, null)
    assert.equal(other.kayntran, false)
  })
  test('detectOs: electron/wails/.NET/tauri ⇒ windows; xcodeproj/Package.swift ⇒ macos; webapp/trống ⇒ linux; windows thắng khi lẫn; node_modules bị bỏ qua', () => {
    const t = (files) => { const d = fresh('app'); for (const [f, c] of Object.entries(files)) write(path.join(d, f), c); return D.detectOs(d).os }
    assert.equal(t({ 'package.json': '{"devDependencies":{"electron":"^30"}}' }), 'windows')
    assert.equal(t({ 'apps/desktop/package.json': '{"dependencies":{"electron-vite":"1"}}' }), 'windows')
    assert.equal(t({ 'wails.json': '{}' }), 'windows')
    assert.equal(t({ 'src/App/App.csproj': '<Project/>' }), 'windows')
    assert.equal(t({ 'src-tauri/tauri.conf.json': '{}' }), 'windows')
    assert.equal(t({ 'Package.swift': '//' }), 'macos')
    assert.equal(t({ 'App.xcodeproj/project.pbxproj': '' }), 'macos')
    assert.equal(t({ 'package.json': '{"dependencies":{"vite":"5","react":"19"}}' }), 'linux')
    assert.equal(t({ 'README.md': 'x' }), 'linux')
    assert.equal(t({ 'package.json': '{"dependencies":{"electron":"1"}}', 'Package.swift': '//' }), 'windows')
    assert.equal(t({ 'node_modules/electron-thing/package.json': '{"dependencies":{"electron":"1"}}' }), 'linux')
    assert.equal(t({ 'package.json': '{hỏng' }), 'linux')
  })
  test('readProjectConfig: nhận trường đúng, bỏ trường sai kiểu và ghi vào problems; JSON hỏng không ném', () => {
    const d = fresh('cfg')
    write(path.join(d, '.claude', 'devin.json'), JSON.stringify({ os: 'windows', local: ['GPU', ' mic '], setup: 'npm ci', env: ['OPENROUTER_API_KEY'], audio: true }))
    assert.deepEqual(D.readProjectConfig([d]).config, { os: 'windows', local: ['gpu', 'mic'], setup: 'npm ci', env: ['OPENROUTER_API_KEY'], audio: true })
    write(path.join(d, '.claude', 'devin.json'), JSON.stringify({ os: 'beos', local: 'gpu', env: ['bad name'], off: 'yes' }))
    const r = D.readProjectConfig([d])
    assert.deepEqual(r.config, {})
    assert.equal(r.problems.length, 4)
    write(path.join(d, '.claude', 'devin.json'), '{hỏng')
    assert.deepEqual(D.readProjectConfig([d]).config, {})
    assert.deepEqual(D.readProjectConfig([fresh('none')]), { config: {}, problems: [], file: null })
  })
})

describe('where (AC-01..04, 11, 16)', () => {
  const cfg = (repo, o) => write(path.join(repo, '.claude', 'devin.json'), JSON.stringify(o))
  test('webapp ⇒ Ubuntu · electron ⇒ Windows · Package.swift ⇒ macOS (có lý do)', async () => {
    const { ctx } = mkCtx()
    const web = await D.where(ctx, { dir: mkRepo({ 'package.json': '{"dependencies":{"vite":"5"}}' }) })
    assert.deepEqual([web.runner, web.os], ['devin', 'linux'])
    assert.match(web.reason, /Ubuntu/)
    assert.equal((await D.where(ctx, { dir: mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' }) })).os, 'windows')
    assert.equal((await D.where(ctx, { dir: mkRepo({ 'Package.swift': '//' }) })).os, 'macos')
  })
  test('devin.json.os thắng việc dò; --os (internal) và DEVIN_VM_OS thắng devin.json', async () => {
    const { ctx } = mkCtx()
    const repo = mkRepo({ 'package.json': '{"dependencies":{"electron":"1"}}' })
    cfg(repo, { os: 'linux' })
    assert.equal((await D.where(ctx, { dir: repo })).os, 'linux')
    assert.equal((await D.where(ctx, { dir: repo, os: 'macos' })).os, 'macos')
    const { ctx: c2 } = mkCtx({ env: { DEVIN_VM_OS: 'windows' } })
    assert.equal((await D.where(c2, { dir: repo })).os, 'windows')
  })
  test('--need trùng nhãn "local" của dự án ⇒ máy bạn + lý do; không trùng ⇒ vẫn máy ảo (AC-04)', async () => {
    const { ctx } = mkCtx()
    const repo = mkRepo()
    cfg(repo, { local: ['gpu', 'mic'] })
    const w = await D.where(ctx, { dir: repo, need: 'GPU,speed' })
    assert.deepEqual([w.runner, w.reason], ['local', 'cần máy thật: gpu'])
    assert.equal((await D.where(ctx, { dir: repo, need: ['speed'] })).runner, 'devin')
    assert.equal((await D.where(ctx, { dir: repo })).runner, 'devin')
  })
  test('tắt: DEVIN_VM=off hoặc devin.json off ⇒ luôn máy bạn', async () => {
    const repo = mkRepo()
    assert.equal((await D.where(mkCtx({ env: { DEVIN_VM: 'off' } }).ctx, { dir: repo })).runner, 'local')
    cfg(repo, { off: true })
    const w = await D.where(mkCtx().ctx, { dir: repo })
    assert.equal(w.runner, 'local')
    assert.match(w.reason, /tắt/)
  })
  test('chưa đăng nhập ⇒ máy bạn + lệnh devin auth login; CLI chưa cài ⇒ máy bạn; không phải kho git ⇒ máy bạn (AC-11)', async () => {
    const repo = mkRepo()
    const w = await D.where(mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co.toml') } }).ctx, { dir: repo })
    assert.deepEqual([w.runner, w.login], ['local', 'devin auth login'])
    const n = await D.where(mkCtx({ devinBin: null }).ctx, { dir: repo })
    assert.deepEqual([n.runner, /chưa cài/.test(n.reason)], ['local', true])
    const ng = await D.where(mkCtx().ctx, { dir: fresh('khong-git') })
    assert.equal(ng.runner, 'local')
    assert.match(ng.reason, /kho git/)
  })
})

// ---------- sổ máy ảo ----------
describe('sổ máy ảo', () => {
  test('chưa có ⇒ {}; ghi nguyên tử (không để file tạm); khoá chuẩn hoá đường dẫn', async () => {
    const { ctx } = mkCtx()
    assert.deepEqual(D.readRegistry(ctx), {})
    await D.updateRegistry(ctx, (r) => { r.a = { id: 'devin-x' } })
    assert.deepEqual(D.readRegistry(ctx), { a: { id: 'devin-x' } })
    assert.deepEqual(fs.readdirSync(ctx.stateDir).filter((f) => /tmp$|lock/.test(f)), [])
    if (process.platform === 'win32') assert.equal(D.projectKey({ ...ctx, platform: 'win32' }, 'D:\\Work\\RuntoEnglish\\', 'windows'), 'd:/work/runtoenglish|windows')
    assert.equal(D.projectKey({ ...ctx, platform: 'linux' }, '/srv/A b', 'linux').endsWith('|linux'), true)
  })
  test('sổ hỏng ⇒ coi như trống (mất sổ ⇒ tạo máy mới), file hỏng được để sang bên', async () => {
    const { ctx } = mkCtx()
    write(D.registryFile(ctx), '{hỏng')
    assert.deepEqual(D.readRegistry(ctx), {})
    assert.ok(fs.readdirSync(ctx.stateDir).some((f) => f.startsWith('devin-vm.json.bad-')))
  })
  test('nhiều tiến trình/phiên cùng ghi: khoá làm mọi cập nhật đều vào, không mất cái nào', async () => {
    const { ctx } = mkCtx()
    await Promise.all(Array.from({ length: 12 }, (_, i) => D.updateRegistry(ctx, async (r) => { const n = r.count ?? 0; await new Promise((x) => setTimeout(x, 5)); r.count = n + 1; r[`k${i}`] = i })))
    const reg = D.readRegistry(ctx)
    assert.equal(reg.count, 12)
    assert.equal(Object.keys(reg).length, 13)
  })
  test('khoá còn sót của tiến trình đã chết (cũ > 60 s) bị phá; khoá mới thì chờ rồi báo lỗi rõ', async () => {
    const { ctx } = mkCtx()
    fs.mkdirSync(ctx.stateDir, { recursive: true })
    const lock = path.join(ctx.stateDir, 'devin-vm.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: 2147483000, token: 'x' }))
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lock, old, old)
    await D.updateRegistry(ctx, (r) => { r.ok = 1 })
    assert.equal(D.readRegistry(ctx).ok, 1)
  })
})

// ---------- bật / đánh thức / ngủ / xoá ----------
describe('up (AC-05, 06, 14)', () => {
  test('chưa có máy ⇒ tạo bằng SWE-2 (không giao việc), chờ running, ssh thử, cài Node, ghi sổ; lần sau dùng lại, không tạo mới', async () => {
    const { ctx, api, ssh } = mkCtx()
    const repo = mkRepo({ 'package.json': '{"dependencies":{"vite":"5"}}' }, { origin: 'https://github.com/kayntran/demo-app.git' })
    const r = await D.up(ctx, { dir: repo })
    assert.deepEqual([r.os, r.created, r.woke], ['linux', true, false])
    assert.equal(api.posts().length, 1)
    const body = JSON.parse(api.posts()[0].body)
    assert.deepEqual([body.platform, body.devin_mode, body.repos, body.title], ['linux', 'swe-2-medium', ['kayntran/demo-app'], 'devin-vm demo-app linux'])
    assert.ok(ssh.calls.some((c) => c.script.includes('SHASUMS256')), 'cài Node lần đầu')
    const reg = D.readRegistry(ctx)
    const e = Object.values(reg)[0]
    assert.deepEqual([e.id, e.os, e.name, e.prep], [r.id, 'linux', 'demo-app', { node: '24' }])
    // lần 2
    const nSsh = ssh.calls.filter((c) => c.script.includes('SHASUMS256')).length
    const r2 = await D.up(ctx, { dir: repo })
    assert.deepEqual([r2.id, r2.created], [r.id, false])
    assert.equal(api.posts().length, 1, 'không tạo máy mới')
    assert.equal(ssh.calls.filter((c) => c.script.includes('SHASUMS256')).length, nSsh, 'không cài Node lại')
  })
  test('kho không phải kayntran ⇒ không có repos; noRepos cũng bỏ repos', async () => {
    const { ctx, api } = mkCtx()
    await D.up(ctx, { dir: mkRepo({ a: '1' }, { origin: 'https://github.com/namtran020322/x.git' }) })
    assert.ok(!('repos' in JSON.parse(api.posts()[0].body)))
    await D.up(ctx, { dir: mkRepo({ a: '1' }, { origin: 'https://github.com/kayntran/y.git' }), noRepos: true })
    assert.ok(!('repos' in JSON.parse(api.posts()[1].body)))
  })
  test('máy đang ngủ ⇒ đánh thức bằng ssh, không tạo máy mới; trạng thái quota ⇒ DevinUnavailable', async () => {
    const { ctx, api, ssh } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux', 'suspended')
    const r = await D.up(ctx, { dir: repo })
    assert.deepEqual([r.id, r.created, r.woke], [id, false, true])
    assert.equal(api.posts().length, 0)
    assert.ok(ssh.calls.length >= 1)
    api.sessions.get(id).status = 'suspended'
    api.sessions.get(id).detail = 'out_of_quota'
    await assert.rejects(D.up(ctx, { dir: repo }), (e) => e instanceof D.DevinUnavailable && e.kind === 'quota')
    assert.equal(api.posts().length, 0)
  })
  test('máy trong sổ đã bị xoá (404) hoặc đã chết ⇒ tạo máy mới và ghi đè sổ (AC-06)', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const old = await seedVm(ctx, api, repo, 'linux', 'suspended')
    api.sessions.delete(old)
    const r = await D.up(ctx, { dir: repo })
    assert.equal(r.created, true)
    assert.notEqual(r.id, old)
    assert.equal(Object.values(D.readRegistry(ctx))[0].id, r.id)
    api.sessions.get(r.id).status = 'exit'
    const r2 = await D.up(ctx, { dir: repo })
    assert.deepEqual([r2.created, r2.id === r.id], [true, false])
  })
  test('máy cũ không đánh thức được (ssh hỏng 3 lần) ⇒ tạo máy mới; máy mới cũng không nối được ⇒ DevinUnavailable', async () => {
    let bad = null
    const { ctx, api } = mkCtx({ handler: (rec) => (rec.id === bad && /devinvm-ready/.test(rec.command) ? { code: 255, stderr: 'timeout' } : null) })
    const repo = mkRepo()
    bad = await seedVm(ctx, api, repo, 'linux', 'suspended')
    const r = await D.up(ctx, { dir: repo })
    assert.deepEqual([r.created, r.id === bad], [true, false])
    const { ctx: c2 } = mkCtx({ handler: (rec) => (/devinvm-ready/.test(rec.command) ? { code: 255 } : null) })
    await assert.rejects(D.up(c2, { dir: mkRepo() }), D.DevinUnavailable)
  })
  test('lỗi Devin: 401/403 ⇒ not-logged-in (kèm lệnh) · 402/429 ⇒ quota · 5xx ⇒ service · mạng đứt ⇒ network', async () => {
    const cases = [[401, 'not-logged-in'], [403, 'not-logged-in'], [402, 'quota'], [429, 'quota'], [503, 'service']]
    for (const [status, kind] of cases) {
      const { ctx, api } = mkCtx()
      api.fail = (r) => (r.method === 'POST' && r.path.endsWith('/sessions') ? new Response('{"detail":"x https://leak.example/?sig=ZZZ"}', { status }) : null)
      await assert.rejects(D.up(ctx, { dir: mkRepo() }), (e) => e instanceof D.DevinUnavailable && e.kind === kind && (kind !== 'not-logged-in' || e.loginCmd === 'devin auth login'), String(status))
    }
    const { ctx, api } = mkCtx()
    api.fail = () => new TypeError('fetch failed')
    await assert.rejects(D.up(ctx, { dir: mkRepo() }), (e) => e instanceof D.DevinUnavailable && e.kind === 'network')
  })
  test('403 "billing error: out_of_quota" (thân lỗi thật của Devin, đo 31/10) ⇒ quota, KHÔNG bảo đăng nhập lại', async () => {
    const { ctx, api } = mkCtx()
    const body = '{"title":"Forbidden","status":403,"detail":"Your organization has a billing error. Error: out_of_quota","error_code":"billing_restricted"}'
    api.fail = (r) => (r.method === 'POST' && r.path.endsWith('/sessions') ? new Response(body, { status: 403 }) : null)
    await assert.rejects(D.up(ctx, { dir: mkRepo() }), (e) => e instanceof D.DevinUnavailable && e.kind === 'quota' && !e.loginCmd && /hạn mức/.test(e.message))
  })
  test('lỗi 400 khác (vd sai nền tảng) là lỗi thật của công cụ, không giả làm "Devin không dùng được"; link trong thân lỗi bị che', async () => {
    const { ctx, api } = mkCtx()
    api.fail = (r) => (r.method === 'POST' && r.path.endsWith('/sessions') ? new Response('bad platform https://leak.example/?sig=ZZZ', { status: 400 }) : null)
    await assert.rejects(D.up(ctx, { dir: mkRepo() }), (e) => e instanceof D.ToolError && !/leak\.example|ZZZ/.test(e.message))
  })
  test('Windows: chỉ bật âm thanh khi devin.json audio / --audio, đúng một lần (AC-14); Windows không cài Node', async () => {
    const { ctx, ssh } = mkCtx()
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await D.up(ctx, { dir: repo })
    assert.ok(!ssh.calls.some((c) => /Audiosrv/.test(c.script)) && !ssh.calls.some((c) => c.script.includes('SHASUMS256')))
    await D.up(ctx, { dir: repo, audio: true })
    const audio = ssh.calls.filter((c) => /Audiosrv/.test(c.script))
    assert.equal(audio.length, 1)
    assert.match(audio[0].script, /Set-Service Audiosrv -StartupType Automatic[\s\S]*Start-Service AudioEndpointBuilder, Audiosrv/)
    assert.equal(Object.values(D.readRegistry(ctx))[0].prep.audio, true)
    await D.up(ctx, { dir: repo, audio: true })
    assert.equal(ssh.calls.filter((c) => /Audiosrv/.test(c.script)).length, 1)
  })
  test('hai phiên cùng up một dự án một lúc ⇒ chỉ tạo MỘT máy (khoá sổ)', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const [a, b] = await Promise.all([D.up(ctx, { dir: repo }), D.up(ctx, { dir: repo })])
    assert.equal(api.posts().length, 1)
    assert.equal(a.id, b.id)
  })
  test('cài Node lỗi ⇒ ToolError nêu lý do, sổ chưa đánh dấu (lần sau thử lại)', async () => {
    const { ctx } = mkCtx({ handler: (rec) => (rec.script.includes('SHASUMS256') ? { code: 93 } : null) })
    await assert.rejects(D.up(ctx, { dir: mkRepo() }), /sai mã kiểm/)
    assert.deepEqual(Object.values(D.readRegistry(ctx))[0].prep, {})
  })
})

// ---------- Node theo devin.json ----------
describe('devin.json node (cài đúng major)', () => {
  const PS_OK = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' }).status === 0
  const setNode = (repo, node) => write(path.join(repo, '.claude', 'devin.json'), JSON.stringify(node === undefined ? {} : { node }))
  // máy ảo giả báo đúng major vừa cài (script tải sẽ chứa latest-v<major>.x hoặc $major = '<major>')
  const installer = (rec) => {
    const m = /latest-v(\d+)\.x/.exec(rec.script) ?? /\$major = '(\d+)'/.exec(rec.script)
    return m ? { code: 0, stdout: `@@DEVINVM@@ node v${m[1]}.1.0\n` } : null
  }
  const installs = (ssh) => ssh.calls.filter((c) => /latest-v(\d+)\.x|\$major = '/.test(c.script))

  test('readProjectConfig: node nhận "25" hoặc 25 (về chuỗi); "abc", 0, 100, true bị bỏ và ghi vào problems', () => {
    const d = fresh('cfg')
    const read = (node) => { write(path.join(d, '.claude', 'devin.json'), JSON.stringify({ node })); return D.readProjectConfig([d]) }
    assert.equal(read('25').config.node, '25')
    assert.equal(read(24).config.node, '24')
    for (const bad of ['abc', 0, 100, true, '', '2.5', '0', null]) {
      const r = read(bad)
      assert.deepEqual([r.config.node, r.problems.length], [undefined, 1], JSON.stringify(bad))
    }
  })
  test('pathPrefix: linux/mac luôn ~/.local/bin; Windows chỉ thêm C:\\devinvm\\node-v<major> khi có node', () => {
    assert.match(D.pathPrefix('linux'), /^export PATH="\$HOME\/\.local\/bin:/)
    assert.equal(D.pathPrefix('windows'), '')
    assert.equal(D.pathPrefix('windows', '25'), 'export PATH="/c/devinvm/node-v25:$PATH"\n')
  })
  test('nodePrepScript: exact đòi đúng major (case v<major>.*), không exact giữ node có sẵn; tải đúng latest-v<major>.x; gỡ npm/corepack cũ trước khi giải đè; major lạ ⇒ lỗi; bash -n ổn', () => {
    const ex = D.nodePrepScript({ major: '25', exact: true })
    const loose = D.nodePrepScript({ major: '24' })
    assert.ok(ex.includes('case "$cur" in v25.*) echo "@@DEVINVM@@ node $cur"; exit 0 ;; esac') && ex.includes('base=https://nodejs.org/dist/latest-v25.x'))
    assert.ok(loose.includes('[ -z "$cur" ] || { echo "@@DEVINVM@@ node $cur"; exit 0; }') && loose.includes('latest-v24.x'))
    assert.match(ex, /rm -rf -- "\$HOME\/\.local\/lib\/node_modules\/npm" "\$HOME\/\.local\/lib\/node_modules\/corepack"\ntar -xzf/)
    assert.ok(D.nodePrepScript().includes('latest-v24.x'), 'mặc định LTS 24')
    for (const bad of ['x', '0', '100', '25; ls', null]) assert.throws(() => D.nodePrepScript({ major: bad }), undefined, String(bad))
    if (HAS_BASH) for (const s of [ex, loose]) assert.equal(spawnSync(BASH, ['-n'], { input: s, encoding: 'utf8' }).status, 0)
  })
  test('nodePrepScript chạy thật với node giả trong ~/.local/bin: exact + đúng major ⇒ thoát 0 ngay, không tải; không exact + có node ⇒ thoát 0', (t) => {
    if (!HAS_BASH) return t.skip('không có bash')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dvmvm-'))
    for (const n of ['node', 'npm']) {
      write(path.join(home, '.local', 'bin', n), n === 'node' ? '#!/bin/sh\necho v25.1.0\n' : '#!/bin/sh\necho 10.0.0\n')
      fs.chmodSync(path.join(home, '.local', 'bin', n), 0o755)
    }
    const run = (script) => spawnSync(BASH, ['-s'], { input: script, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000 })
    if (!/v25\.1\.0/.test(run('export PATH="$HOME/.local/bin:$PATH"; node -v\n').stdout)) return t.skip('bash này không chạy được script giả')
    for (const s of [D.nodePrepScript({ major: '25', exact: true }), D.nodePrepScript({ major: '24' })]) {
      const r = run(s)
      assert.deepEqual([r.status, r.stdout.trim()], [0, '@@DEVINVM@@ node v25.1.0'], r.stderr)
    }
  })
  test('nodeWinScript: zip win-x64 nodejs.org → C:\\devinvm\\node-v<major>, kiểm sha256, bỏ qua khi đã có đúng major; PowerShell phân tích không lỗi cú pháp', (t) => {
    const s = D.nodeWinScript({ major: '25' })
    assert.ok(s.includes("$major = '25'") && s.includes('latest-v$major.x') && s.includes('C:\\devinvm\\node-v$major') && s.includes('win-x64\\.zip') && s.includes('Get-FileHash') && s.includes('exit 93'))
    assert.throws(() => D.nodeWinScript({ major: "25'; calc" }))
    if (!PS_OK) return t.skip('không có PowerShell')
    const wrapper = '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}else{"ok"}'
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', wrapper], { input: s, encoding: 'utf8' })
    assert.deepEqual([r.status, r.stdout.trim()], [0, 'ok'], r.stdout)
  })

  test('linux: node "25" ⇒ cài đúng major (không exact → exact), sổ ghi prep.node="25"; lần sau không cài lại; đổi sang "26" ⇒ cài lại', async () => {
    const { ctx, ssh } = mkCtx({ handler: installer })
    const repo = mkRepo()
    setNode(repo, '25')
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 1)
    assert.ok(installs(ssh)[0].script.includes('case "$cur" in v25.*)'))
    const entry = () => Object.values(D.readRegistry(ctx))[0]
    assert.equal(entry().prep.node, '25')
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 1, 'đã đúng major ⇒ không cài lại')
    setNode(repo, '26')
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 2)
    assert.ok(installs(ssh)[1].script.includes('latest-v26.x'))
    assert.equal(entry().prep.node, '26')
  })
  test('không có node trong devin.json ⇒ linux/mac như cũ (LTS 24, chỉ cài khi thiếu) và sổ ghi major thật; sổ cũ prep.node=true không bị cài lại, nhưng có node trong devin.json thì cài', async () => {
    const { ctx, ssh } = mkCtx({ handler: installer })
    const repo = mkRepo()
    await D.up(ctx, { dir: repo, os: 'macos' })
    assert.ok(installs(ssh)[0].script.includes('latest-v24.x') && installs(ssh)[0].script.includes('[ -z "$cur" ]'))
    assert.equal(Object.values(D.readRegistry(ctx))[0].prep.node, '24')
    const { ctx: c2, api: a2, ssh: s2 } = mkCtx({ handler: installer })
    const repo2 = mkRepo()
    await seedVm(c2, a2, repo2, 'linux') // prep.node: true (sổ bản đầu)
    await D.up(c2, { dir: repo2 })
    assert.equal(installs(s2).length, 0)
    setNode(repo2, '25')
    await D.up(c2, { dir: repo2 })
    assert.equal(installs(s2).length, 1)
    assert.equal(Object.values(D.readRegistry(c2))[0].prep.node, '25')
  })
  test('Windows: có node "25" ⇒ cài zip bằng PowerShell, ghi prep.node, mọi `run` có PATH tới C:/devinvm/node-v25; không có node ⇒ không cài, không đổi PATH (dùng Node có sẵn của máy)', async () => {
    const { ctx, ssh } = mkCtx({ handler: installer })
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 0)
    assert.equal(Object.values(D.readRegistry(ctx))[0].prep.node, undefined)
    await D.runProject(ctx, { dir: repo, command: 'node -v' })
    assert.ok(!ssh.calls.at(-1).script.includes('devinvm'), 'không đổi PATH khi không khai node')

    setNode(repo, '25')
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 1)
    assert.match(installs(ssh)[0].command, /^powershell .* -EncodedCommand /)
    assert.equal(Object.values(D.readRegistry(ctx))[0].prep.node, '25')
    await D.up(ctx, { dir: repo })
    assert.equal(installs(ssh).length, 1, 'đã có ⇒ không cài lại')
    await D.runProject(ctx, { dir: repo, command: 'node -v' })
    assert.match(ssh.calls.at(-1).script, /^export PATH="\/c\/devinvm\/node-v25:\$PATH"\ncd /)
  })
  test('cài Node lỗi (93 sai mã kiểm / 91 / 92) ⇒ ToolError nêu lý do, sổ chưa ghi prep.node (lần sau thử lại)', async () => {
    for (const [os_, repoFiles, code, re] of [['windows', { 'package.json': '{"devDependencies":{"electron":"1"}}' }, 93, /sai mã kiểm/], ['linux', { a: '1' }, 91, /danh sách bản Node/]]) {
      const { ctx } = mkCtx({ handler: (rec) => (installs({ calls: [rec] }).length ? { code, stderr: 'lỗi tải' } : null) })
      const repo = mkRepo(repoFiles)
      setNode(repo, '25')
      await assert.rejects(D.up(ctx, { dir: repo }), re, os_)
      assert.equal(Object.values(D.readRegistry(ctx))[0].prep.node, undefined, os_)
    }
  })
})

describe('sleep / rm / status (AC-07, 13)', () => {
  test('sleep: gọi MCP devin_session_interact action sleep rồi CHỜ tới suspended; khoá chỉ ở header', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux', 'running')
    const r = await D.sleepProject(ctx, { dir: repo })
    assert.deepEqual([r.ok, r.status, r.id], [true, 'suspended', id])
    const [c] = api.mcpCalls()
    assert.deepEqual([c.params.name, c.params.arguments], ['devin_session_interact', { action: 'sleep', session_id: id }])
    const mcp = api.calls.filter((x) => x.host === 'mcp.devin.ai')
    assert.ok(mcp.every((x) => x.headers['X-Org-Id'] === 'org-abcdef123456' && x.headers.Authorization.startsWith('Bearer ')))
    assert.equal(api.sessions.get(id).status, 'suspended')
  })
  test('đã ngủ ⇒ không gọi MCP; không có máy ⇒ ok/none; máy biến mất ⇒ ok/gone; không ngủ kịp ⇒ ok:false kèm trạng thái', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    assert.equal((await D.sleepProject(ctx, { dir: repo })).status, 'none')
    const id = await seedVm(ctx, api, repo, 'linux', 'suspended')
    assert.equal((await D.sleepProject(ctx, { dir: repo })).status, 'suspended')
    assert.equal(api.mcpCalls().length, 0)
    api.sessions.get(id).status = 'running'
    api.stuck = true
    const r = await D.sleepVm(ctx, id, { waitMs: 20_000 })
    assert.deepEqual([r.ok, r.status], [false, 'running'])
    api.sessions.delete(id)
    assert.equal((await D.sleepVm(ctx, id)).status, 'gone')
  })
  test('rm: DELETE rồi xác nhận GET 404, gỡ mục khỏi sổ; không có máy ⇒ ok', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    const r = await D.removeVm(ctx, { dir: repo })
    assert.deepEqual([r.ok, r.removed], [true, id])
    assert.ok(api.calls.some((c) => c.method === 'DELETE'))
    assert.equal(api.sessions.has(id), false)
    assert.deepEqual(D.readRegistry(ctx), {})
    assert.equal((await D.removeVm(ctx, { dir: repo })).removed, null)
  })
  test('rm máy đang ngủ: đánh thức bằng ssh trước rồi mới DELETE (DELETE lên máy ngủ không có tác dụng)', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux', 'suspended')
    const r = await D.removeVm(ctx, { dir: repo })
    assert.deepEqual([r.ok, r.removed], [true, id])
    assert.equal(api.sessions.has(id), false)
    assert.deepEqual(D.readRegistry(ctx), {})
  })
  test('rm máy Windows: DELETE chỉ ra running/finished ⇒ sau 20 s gọi MCP terminate tới khi exit', async () => {
    const { ctx, api } = mkCtx()
    api.deleteFinishes = true
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'windows')
    const r = await D.removeVm(ctx, { dir: repo, os: 'windows' })
    assert.deepEqual([r.ok, r.removed], [true, id])
    assert.equal(api.sessions.get(id).status, 'exit')
    assert.deepEqual(api.mcpCalls().map((c) => c.params.arguments.action), ['terminate'])
    assert.deepEqual(D.readRegistry(ctx), {})
  })
  test('rm: máy không đánh thức được ⇒ báo lỗi, giữ mục trong sổ', async () => {
    const { ctx, api } = mkCtx({ handler: (rec) => (/devinvm-ready/.test(rec.command) ? { code: 255, stderr: 'down' } : null) })
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux', 'suspended')
    await assert.rejects(D.removeVm(ctx, { dir: repo }), /chưa xoá|không đánh thức/)
    assert.equal(api.sessions.has(id), true)
    assert.ok(Object.values(D.readRegistry(ctx)).some((e) => e.id === id))
  })
  test('status: liệt kê máy của dự án với trạng thái thật; --all liệt kê mọi máy trong sổ; không đăng nhập vẫn liệt kê (unknown)', async () => {
    const { ctx, api } = mkCtx()
    const a = mkRepo()
    const b = mkRepo()
    const ia = await seedVm(ctx, api, a, 'linux', 'running')
    const ib = await seedVm(ctx, api, b, 'windows', 'suspended')
    const s = await D.statusOf(ctx, { dir: a })
    assert.deepEqual(s.vms.map((v) => [v.id, v.status, v.awake]), [[ia, 'running', true]])
    const all = await D.statusOf(ctx, { all: true })
    assert.deepEqual(all.vms.map((v) => [v.id, v.awake]).sort(), [[ia, true], [ib, false]].sort())
    const off = mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co.toml') }, stateDir: ctx.stateDir }).ctx
    assert.ok((await D.statusOf(off, { all: true })).vms.every((v) => v.status === 'unknown'))
  })
})

// ---------- chép code ----------
describe('snapshot / bundle (AC-08, 09)', () => {
  function dirtyRepo() {
    const repo = mkRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/x.js': 'x\n', '.gitignore': 'ignored.log\nnode_modules/\n' })
    write(path.join(repo, 'a.txt'), 'a sửa\n')
    fs.rmSync(path.join(repo, 'b.txt'))
    write(path.join(repo, 'new.txt'), 'mới\n')
    write(path.join(repo, 'ignored.log'), 'log\n')
    write(path.join(repo, 'node_modules', 'm', 'i.js'), '1\n')
    write(path.join(repo, '.env'), 'OPENROUTER_API_KEY=thatbi\n')
    write(path.join(repo, '.env.example'), 'OPENROUTER_API_KEY=\n')
    write(path.join(repo, '.mcp.json'), '{}')
    return repo
  }
  test('snapshot: cây = HEAD + thay đổi + file mới − file xoá; ignore và file bí mật chưa commit KHÔNG vào; ref/index/cây làm việc thật không đổi', async () => {
    const { ctx } = mkCtx()
    const repo = dirtyRepo()
    const before = { head: g(repo, 'rev-parse', 'HEAD'), status: g(repo, 'status', '--porcelain'), refs: g(repo, 'for-each-ref'), a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') }
    const s = await D.snapshot(ctx, repo)
    assert.deepEqual(lsTree(repo, s.sha), ['.env.example', '.gitignore', 'a.txt', 'new.txt', 'src/x.js'])
    assert.deepEqual(s.skipped.sort(), ['.env', '.mcp.json'])
    assert.equal(g(repo, 'show', `${s.sha}:a.txt`), 'a sửa')
    assert.equal(g(repo, 'rev-parse', `${s.sha}^{tree}`), s.tree)
    assert.equal(g(repo, 'rev-parse', `${s.sha}^`), before.head, 'cha = HEAD')
    assert.deepEqual({ head: g(repo, 'rev-parse', 'HEAD'), status: g(repo, 'status', '--porcelain'), refs: g(repo, 'for-each-ref'), a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') }, before)
  })
  test('file bí mật đã `git add` (chưa commit) cũng KHÔNG vào bản chụp; bí mật đã nằm trong HEAD thì giữ nguyên; index thật không đổi', async () => {
    const { ctx } = mkCtx()
    const repo = mkRepo({ 'a.txt': 'a\n', '.env.production': 'TRONG_HEAD=1\n' })
    write(path.join(repo, '.env'), 'OPENROUTER_API_KEY=thatbi\n')
    write(path.join(repo, 'cfg', 'server.pem'), 'PEM\n')
    write(path.join(repo, 'Note', 'n.md'), 'ghi chú riêng\n')
    write(path.join(repo, 'ok.txt'), 'ok\n')
    write(path.join(repo, '.mcp.json'), '{}') // chưa add
    write(path.join(repo, '.env.production'), 'TRONG_HEAD=2\n') // bí mật đã commit, sửa tiếp: không phải việc của lọc "chưa commit"
    g(repo, 'add', '.env', 'cfg/server.pem', 'Note/n.md', 'ok.txt')
    const staged = g(repo, 'diff', '--cached', '--name-only')
    const s = await D.snapshot(ctx, repo)
    assert.deepEqual(lsTree(repo, s.sha), ['.env.production', 'a.txt', 'ok.txt'])
    assert.deepEqual(s.skipped.sort(), ['.env', '.mcp.json', 'Note/n.md', 'cfg/server.pem'])
    assert.equal(g(repo, 'diff', '--cached', '--name-only'), staged, 'index thật còn nguyên (file vẫn đang add, chỉ không lên máy ảo)')
    assert.ok(fs.existsSync(path.join(repo, '.env')), 'cây làm việc không đổi')
  })
  test('kho chưa có commit nào vẫn chụp được (commit không cha); file bí mật đã add cũng bị bỏ', async () => {
    const { ctx } = mkCtx()
    const d = fresh('trong2')
    g(d, 'init', '-q', '-b', 'main')
    write(path.join(d, 'f.txt'), 'f\n')
    write(path.join(d, '.env'), 'K=1\n')
    g(d, 'add', '.env')
    const s = await D.snapshot(ctx, d)
    assert.deepEqual(lsTree(d, s.sha), ['f.txt'])
    assert.deepEqual(s.skipped, ['.env'])
  })
  test('kho chưa có commit nào vẫn chụp được (commit không cha)', async () => {
    const { ctx } = mkCtx()
    const d = fresh('trong')
    g(d, 'init', '-q', '-b', 'main')
    write(path.join(d, 'f.txt'), 'f\n')
    const s = await D.snapshot(ctx, d)
    assert.equal(s.head, null)
    assert.deepEqual(lsTree(d, s.sha), ['f.txt'])
  })
  test('buildBundle: ref tạm được xoá sau khi đóng gói; full không cha (máy ảo không cần lịch sử); delta chỉ mang phần chưa có ở origin; không bao giờ git push', async () => {
    const { ctx, ssh } = mkCtx()
    const repo = dirtyRepo()
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const out = fresh('bundle')
    const full = await D.buildBundle(ctx, { top: repo, mode: 'full', file: path.join(out, 'full.bundle') })
    assert.equal(spawnSync('git', ['rev-parse', `${full.sha}^`], { cwd: repo }).status !== 0, true, 'full: commit không cha')
    const delta = await D.buildBundle(ctx, { top: repo, mode: 'delta', file: path.join(out, 'delta.bundle') })
    assert.equal(g(repo, 'for-each-ref', 'refs/devin-vm'), '', 'ref tạm đã xoá')
    assert.equal(spawnSync('git', ['bundle', 'verify', path.join(out, 'delta.bundle')], { cwd: repo }).status, 0, 'gói delta hợp lệ (commit nền có ở origin)')
    assert.ok(!ssh.git.some((a) => a[0] === 'push'))
    assert.equal(delta.tree, full.tree, 'cùng cây làm việc')
  })
})

// "Máy ảo" thật bằng bash: chạy đúng script do công cụ dựng, thay đúng một dòng curl (không có mạng) bằng cp từ tệp đính kèm đã tải lên.
function vmSim(api, home, { onScript } = {}) {
  return (rec) => {
    if (!rec.script.includes('devinvm.bundle')) return null
    onScript?.(rec.script)
    const url = /curl -fsSL --retry 3 -o \.git\/devinvm\.bundle '(https:\/\/s3\.example\.test\/signed\/([^?']+)\?[^']*)'/.exec(rec.script)
    assert.ok(url, 'script có dòng curl tới link ký sẵn')
    const att = api.attachments.get(url[2])
    const bundle = path.join(home, `${url[2]}.bundle`).replace(/\\/g, '/')
    fs.writeFileSync(bundle, att.bytes)
    const script = rec.script.replace(url[0], `cp '${bundle}' .git/devinvm.bundle`)
    // máy ảo Linux không có autocrlf của Git for Windows: bỏ cấu hình hệ thống/người dùng của máy test
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig') }
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
    const r = spawnSync(BASH, ['-s'], { input: script, env, encoding: 'utf8' })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }
}
const vmGit = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

describe('syncScript + syncProject trên "máy ảo" bash thật', { skip: !HAS_BASH && 'không có bash' }, () => {
  const asciiHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvmvm-'))
  test('syncScript: từ chối tên/sha/ref/link lạ; bash -n ổn; link nằm trong nháy đơn', () => {
    const ok = { name: 'demo', url: 'https://s3.example.test/x?a=1&b=2', ref: 'refs/devin-vm/snap-0a1b2c3d', sha: 'a'.repeat(40), delta: true }
    const s = D.syncScript(ok)
    assert.ok(s.includes("'https://s3.example.test/x?a=1&b=2'"))
    assert.equal(spawnSync(BASH, ['-n'], { input: s, encoding: 'utf8' }).status, 0)
    for (const bad of [{ name: '..' }, { name: 'a b' }, { name: 'a;rm' }, { sha: 'HEAD' }, { ref: 'refs/heads/main' }, { url: 'file:///etc/passwd' }]) assert.throws(() => D.syncScript({ ...ok, ...bad }), undefined, JSON.stringify(bad))
    assert.equal(spawnSync(BASH, ['-n'], { input: D.nodePrepScript(), encoding: 'utf8' }).status, 0)
  })
  test('full: máy ảo trống ⇒ git init + lấy gói + checkout đúng W + dọn file thừa; cây khớp máy bạn; chạy lại sau khi sửa/xoá file thì máy ảo theo kịp (clean -fd)', async () => {
    const home = asciiHome()
    const api = fakeApi()
    const { ctx, ssh } = mkCtx({ api, handler: (rec) => vmSim(api, home)(rec) })
    const repo = mkRepo({ 'a.txt': 'a\n', 'old.txt': 'old\n' })
    await seedVm(ctx, api, repo, 'linux')
    write(path.join(repo, 'a.txt'), 'a sửa\n')
    write(path.join(repo, 'moi.txt'), 'mới\n')
    write(path.join(repo, '.env'), 'SECRET=thatbi\n')
    const r1 = await D.syncProject(ctx, { dir: repo })
    assert.deepEqual([r1.ok, r1.mode], [true, 'full'])
    const vm = path.join(home, 'repos', fs.readdirSync(path.join(home, 'repos'))[0])
    assert.equal(fs.readFileSync(path.join(vm, 'a.txt'), 'utf8'), 'a sửa\n')
    assert.ok(fs.existsSync(path.join(vm, 'moi.txt')) && !fs.existsSync(path.join(vm, '.env')), 'file bí mật chưa commit không lên máy ảo')
    assert.equal(vmGit(vm, 'rev-parse', 'HEAD'), r1.head)
    assert.equal(vmGit(vm, 'rev-parse', 'HEAD^{tree}'), r1.tree)
    // thay đổi tiếp: xoá moi.txt, thêm file khác; máy ảo có file rác chưa theo dõi
    fs.rmSync(path.join(repo, 'moi.txt'))
    write(path.join(repo, 'khac.txt'), 'k\n')
    write(path.join(vm, 'rac.txt'), 'rác trên máy ảo\n')
    const r2 = await D.syncProject(ctx, { dir: repo })
    assert.equal(r2.tree, g(vm, 'rev-parse', 'HEAD^{tree}'))
    assert.deepEqual(fs.readdirSync(vm).filter((f) => f !== '.git').sort(), ['a.txt', 'khac.txt', 'old.txt'])
    assert.ok(ssh.git.every((a) => a[0] !== 'push'))
    // bản chụp lên qua tệp đính kèm Devin, không phải stdin
    assert.equal(api.attachments.size, 2)
  })
  test('delta (kho kayntran): máy ảo đã có commit nền ⇒ gói chỉ mang phần chưa đẩy; commit chưa đẩy + thay đổi chưa commit đều lên đúng', async () => {
    const home = asciiHome()
    const repo = mkRepo({ 'a.txt': 'a\n', 'lib/l.js': 'l\n' }, { origin: 'https://github.com/kayntran/demo-app.git' })
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    // "máy ảo" = bản clone ở thời điểm đã đẩy; origin của nó không với tới được (giống proxy chưa có commit mới)
    const vm = path.join(home, 'repos', 'demo-app')
    fs.mkdirSync(path.dirname(vm), { recursive: true })
    g(home, 'clone', '-q', repo, vm)
    g(vm, 'remote', 'set-url', 'origin', 'file:///khong/co/gi')
    write(path.join(repo, 'unpushed.txt'), 'u\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'chua day')
    write(path.join(repo, 'a.txt'), 'a dở dang\n')
    let seen = ''
    const api = fakeApi()
    const { ctx } = mkCtx({ api, handler: (rec) => vmSim(api, home, { onScript: (s) => { seen = s } })(rec) })
    await seedVm(ctx, api, repo, 'linux')
    const r = await D.syncProject(ctx, { dir: repo })
    assert.equal(r.mode, 'delta')
    assert.match(seen, /git fetch -q origin <\/dev\/null \|\| true/)
    assert.equal(r.tree, g(vm, 'rev-parse', 'HEAD^{tree}'))
    assert.equal(fs.readFileSync(path.join(vm, 'a.txt'), 'utf8'), 'a dở dang\n')
    assert.ok(fs.existsSync(path.join(vm, 'unpushed.txt')))
    const bundle = [...api.attachments.values()][0].bytes
    assert.ok(bundle.length < 4000, `gói chênh nhỏ (${bundle.length} B)`)
  })
  test('delta nhưng máy ảo thiếu commit nền (exit 90) ⇒ tự chép cả bản', async () => {
    const home = asciiHome()
    const repo = mkRepo({ 'a.txt': 'a\n' }, { origin: 'https://github.com/kayntran/demo-app.git' })
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    write(path.join(repo, 'b.txt'), 'b\n')
    const api = fakeApi()
    const said = []
    const { ctx } = mkCtx({ api, handler: (rec) => vmSim(api, home)(rec) })
    await seedVm(ctx, api, repo, 'linux')
    const r = await D.syncProject(ctx, { dir: repo, say: (s) => said.push(s) })
    assert.equal(r.mode, 'full')
    assert.ok(said.some((s) => /thiếu commit nền/.test(s)))
    assert.equal(api.attachments.size, 2)
    const vm = path.join(home, 'repos', 'demo-app')
    assert.equal(g(vm, 'rev-parse', 'HEAD^{tree}'), r.tree)
  })
  test('--full bỏ qua delta; máy ảo báo cây/commit khác ⇒ KHÔNG chạy tiếp (ToolError); link ký sẵn không lọt ra thông báo', async () => {
    const repo = mkRepo({ 'a.txt': 'a\n' }, { origin: 'https://github.com/kayntran/demo-app.git' })
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const home = asciiHome()
    const api = fakeApi()
    const { ctx } = mkCtx({ api, handler: (rec) => vmSim(api, home)(rec) })
    await seedVm(ctx, api, repo, 'linux')
    assert.equal((await D.syncProject(ctx, { dir: repo, full: true })).mode, 'full')
    assert.equal(api.attachments.size, 1, 'chỉ một gói (không thử delta)')
    const { ctx: c3, api: a3 } = mkCtx({ handler: () => ({ code: 0, stdout: `@@DEVINVM@@ head ${'0'.repeat(40)}\n@@DEVINVM@@ tree ${'1'.repeat(40)}\n` }) })
    await seedVm(c3, a3, repo, 'linux')
    await assert.rejects(D.syncProject(c3, { dir: repo }), (e) => e instanceof D.ToolError && /không khớp/.test(e.message) && !/SIGSECRET|s3\.example/.test(e.message))
  })
  test('thiếu máy trong sổ ⇒ lỗi chỉ cách chạy up; script lỗi ⇒ nêu lý do bằng lời, không lộ link', async () => {
    const { ctx, api } = mkCtx({ handler: () => ({ code: 91, stderr: 'curl: (22) https://s3.example.test/signed/x?X-Amz-Signature=SIGSECRET' }) })
    const repo = mkRepo()
    await assert.rejects(D.syncProject(ctx, { dir: repo }), /chạy trước: node hooks\/devin-vm\.mjs up --os linux/)
    await seedVm(ctx, api, repo, 'linux')
    await assert.rejects(D.syncProject(ctx, { dir: repo }), (e) => /không tải được gói code/.test(e.message) && !/SIGSECRET|s3\.example/.test(e.message))
  })
  test('devin.json setup: chạy một lần sau sync đầu (và khi đổi lệnh / --setup), lỗi setup ⇒ ToolError', async () => {
    const home = asciiHome()
    const api = fakeApi()
    const setups = []
    const { ctx } = mkCtx({ api, handler: (rec) => (rec.script.includes('devinvm.bundle') ? vmSim(api, home)(rec) : (rec.script.includes('npm ci') ? (setups.push(rec.script), { code: 0 }) : null)) })
    const repo = mkRepo()
    write(path.join(repo, '.claude', 'devin.json'), JSON.stringify({ setup: 'npm ci' }))
    await seedVm(ctx, api, repo, 'linux')
    assert.equal((await D.syncProject(ctx, { dir: repo })).setup, 'ran')
    assert.equal((await D.syncProject(ctx, { dir: repo })).setup, undefined)
    assert.equal((await D.syncProject(ctx, { dir: repo, setup: true })).setup, 'ran')
    assert.equal(setups.length, 2)
    assert.match(setups[0], /cd "\$HOME\/repos\/[^"]+"/)
    const { ctx: bad, api: a2 } = mkCtx({ handler: (rec) => (rec.script.includes('npm ci') ? { code: 7, stderr: 'ERESOLVE' } : vmSim(a2, home)(rec)) })
    await seedVm(bad, a2, repo, 'linux')
    await assert.rejects(D.syncProject(bad, { dir: repo }), /setup của dự án lỗi \(mã 7\): ERESOLVE/)
  })
})

// ---------- run / khoá (AC-10) ----------
describe('run --env (AC-10)', () => {
  const KEY = 'sk-or-v1-GIATRIBIMAT-0123456789'
  test('khoá đi base64 trong script của đúng lần chạy; stdout/stderr/log không có giá trị; giá trị bị echo ngược lại bị che', async () => {
    const { ctx, api, ssh } = mkCtx({
      env: { OPENROUTER_API_KEY: KEY },
      handler: (rec) => (/printenv|echo/.test(rec.script) ? { code: 0, stdout: `độ dài 32\nkhoá là ${KEY}\n`, stderr: `lỗi ${Buffer.from(KEY).toString('base64')}` } : null),
    })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    const o = sink()
    const e = sink()
    const code = await main(['run', '--dir', repo, '--env', 'OPENROUTER_API_KEY', '--', 'echo $OPENROUTER_API_KEY | wc -c'], { ctx, stdout: o, stderr: e })
    assert.equal(code, 0)
    assert.ok(!o.text().includes(KEY) && !e.text().includes(KEY) && !e.text().includes(Buffer.from(KEY).toString('base64')))
    assert.match(o.text(), /khoá là \*\*\*/)
    assert.match(e.text(), /OPENROUTER_API_KEY/, 'báo TÊN khoá đã dùng')
    const sent = ssh.calls.at(-1)
    assert.ok(sent.script.includes(`export OPENROUTER_API_KEY="$(printf %s '${Buffer.from(KEY).toString('base64')}' | base64 --decode)"`))
    assert.ok(!sent.command.includes(KEY), 'giá trị thô không nằm trong dòng lệnh')
    const log = fs.readFileSync(ctx.logFile, 'utf8')
    assert.ok(!log.includes(KEY) && !log.includes('wc -c'))
    assert.ok(!fs.existsSync(path.join(repo, '.env')), 'không ghi file vào kho')
  })
  test('giá trị lấy từ .env của dự án khi môi trường không có; thiếu ⇒ ToolError chỉ nêu TÊN; tên sai ⇒ lỗi dùng', async () => {
    const calls = []
    const { ctx, api } = mkCtx({ handler: (rec) => { calls.push(rec); return null } })
    const repo = mkRepo()
    write(path.join(repo, '.env'), '# ghi chú\nexport OPENAI_API_KEY="gia-tri-trong-env-1234"\nA=1\n')
    await seedVm(ctx, api, repo, 'linux')
    await D.runProject(ctx, { dir: repo, command: 'true', env: ['OPENAI_API_KEY'] })
    assert.match(calls.at(-1).script, new RegExp(`'${Buffer.from('gia-tri-trong-env-1234').toString('base64')}'`))
    await assert.rejects(D.runProject(ctx, { dir: repo, command: 'true', env: ['KHONG_CO_BIEN_NAY'] }), (e) => e instanceof D.ToolError && /KHONG_CO_BIEN_NAY/.test(e.message))
    await assert.rejects(D.runProject(ctx, { dir: repo, command: 'true', env: ['bad name'] }), D.UsageError)
  })
  test('@config lấy danh sách tên từ devin.json; script cd vào thư mục code rồi chạy lệnh; mã thoát của máy ảo được trả nguyên', async () => {
    const calls = []
    const { ctx, api } = mkCtx({ env: { K1: 'giatri-k1-abcd' }, handler: (rec) => { calls.push(rec); return { code: 3, stdout: 'ra\n' } } })
    const repo = mkRepo()
    write(path.join(repo, '.claude', 'devin.json'), JSON.stringify({ env: ['K1'] }))
    await seedVm(ctx, api, repo, 'linux')
    const r = await D.runProject(ctx, { dir: repo, command: 'npm test -- --grep "a b"', env: ['@config'] })
    assert.deepEqual([r.code, r.stdout, r.envNames], [3, 'ra\n', ['K1']])
    const s = calls.at(-1).script
    assert.match(s, /^export PATH=.*\nexport K1=.*\ncd "\$HOME\/repos\/[^"]+" \|\| \{ echo .*exit 125; \}\nnpm test -- --grep "a b"\n$/)
  })
  test('"Could not verify the code" ⇒ tự thử lại (tối đa 3 lần); đầu ra lọc ANSI', async () => {
    let n = 0
    const { ctx, api } = mkCtx({ handler: (rec) => (rec.script.includes('hello') ? (++n < 3 ? { code: 1, stderr: 'Could not verify the code' } : { code: 0, stdout: '\u001b[32mxanh\u001b[0m\r\n' }) : null) })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    const r = await D.runProject(ctx, { dir: repo, command: 'echo hello' })
    assert.deepEqual([n, r.code, r.stdout], [3, 0, 'xanh\n'])
  })
})

// ---------- put / get / forward / gui ----------
describe('put / get', () => {
  test('put: tệp đính kèm Devin + curl link ký sẵn trong script; kết quả không có link; đích ~/ mở rộng thành $HOME', async () => {
    const { ctx, api } = mkCtx({ handler: () => ({ code: 0, stdout: '@@DEVINVM@@ size 11\n' }) })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    const f = path.join(fresh('up'), 'tệp thử.txt')
    write(f, 'xin chào ạ\n')
    const o = sink()
    const code = await main(['put', '--dir', repo, f, '~/ảnh/x y.txt'], { ctx, stdout: o, stderr: sink() })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(o.text()), { ok: true, bytes: 11 })
    assert.ok(!/SIGSECRET|s3\.example/.test(o.text()))
    const [a] = [...api.attachments.values()]
    assert.equal(a.bytes.toString('utf8'), 'xin chào ạ\n')
    assert.match(a.name, /^put-[0-9a-f]{8}-/)
    assert.ok(api.calls.some((c) => c.manual), 'link tải lấy bằng redirect: manual (không theo 307 ở máy bạn)')
  })
  test('put ping giữ máy thức suốt lúc chép (chép lâu thì hẹn giờ 4 phút ping tiếp) và dừng hẹn giờ khi xong — kể cả khi hỏng', async () => {
    let mk = null
    mk = mkCtx({ handler: async () => { await mk.ctx.sleep(250_000); await mk.fire(); return { code: 0, stdout: '@@DEVINVM@@ size 3\n' } } })
    const repo = mkRepo()
    await seedVm(mk.ctx, mk.api, repo, 'linux')
    const f = path.join(fresh('up'), 'a.txt')
    write(f, 'abc')
    await D.putFile(mk.ctx, { dir: repo, local: f, remote: '~/a.txt' })
    assert.equal(mk.api.pings().length, 2, 'một ping lúc bắt đầu + một ping của hẹn giờ')
    assert.deepEqual(mk.timers.map((h) => [h.ms, h.on]), [[4 * 60_000, false]])
    const bad = mkCtx({ handler: () => ({ code: 91 }) })
    await seedVm(bad.ctx, bad.api, repo, 'linux')
    await assert.rejects(D.putFile(bad.ctx, { dir: repo, local: f, remote: 'x' }), /Chép file lên máy ảo lỗi/)
    assert.equal(bad.api.pings().length, 1)
    assert.ok(bad.timers.length === 1 && bad.timers.every((h) => !h.on))
  })
})

// ConPTY của Windows bẻ dòng dài + chèn mã ESC GIỮA chuỗi ⇒ khoá bị cắt đôi, so khớp chuỗi nguyên không bắt được.
describe('che khoá trong đầu ra bị ConPTY bẻ dòng', () => {
  const KEY = 'sk-or-v1.GIA+TRI/BIMAT$(0123456789)abcXYZ'
  const run = async (stdout, stderr = '') => {
    const { ctx, api } = mkCtx({ handler: () => ({ code: 0, stdout, stderr }) })
    return D.sshRun(ctx, api.seed('running'), 'echo', { secrets: [KEY] })
  }
  // chèn `ins` vào giữa chuỗi sau `at` ký tự
  const cut = (s, at, ins) => s.slice(0, at) + ins + s.slice(at)
  const SPLITS = {
    'xuống dòng CRLF': '\r\n',
    'CR rồi LF rời nhau': '\r\x1b[0m\n',
    'mã màu CSI': '\x1b[0m',
    'dời con trỏ CSI': '\x1b[10;5H',
    'ẩn/hiện con trỏ CSI': '\x1b[?25l\x1b[?25h',
    'tiêu đề cửa sổ OSC': '\x1b]0;devin\x07',
    'trộn nhiều thứ': '\r\n\x1b[K\x1b[2;1H\r\n',
  }
  test('khoá nguyên vẹn, và khoá bị chèn xuống dòng / mã ESC ở BẤT KỲ vị trí nào đều bị che (cả stdout lẫn stderr)', async () => {
    assert.equal((await run(`trước ${KEY} sau`)).stdout, 'trước *** sau')
    for (const [name, ins] of Object.entries(SPLITS)) {
      for (const at of [1, 7, 20, KEY.length - 1]) {
        const r = await run(`trước ${cut(KEY, at, ins)} sau\n`, `lỗi ${cut(KEY, at, ins)}`)
        assert.equal(r.stdout, 'trước *** sau\n', `${name} @${at}`)
        assert.equal(r.stderr, 'lỗi ***', `${name} @${at}`)
      }
    }
  })
  test('bẻ dòng nhiều chỗ cùng lúc (mỗi ~12 ký tự, như cột của ConPTY) vẫn che hết', async () => {
    const wrapped = KEY.replace(/(.{12})/g, '$1\r\n\x1b[0m')
    assert.ok(wrapped.includes('\r\n'))
    assert.equal((await run(`a ${wrapped} b`)).stdout, 'a *** b')
  })
  test('dạng base64 của khoá (lệnh in lại phần mã hoá) cũng bị che dù bị bẻ giữa chừng', async () => {
    const b = Buffer.from(KEY, 'utf8').toString('base64')
    assert.equal((await run(`x ${b} y`)).stdout, 'x *** y')
    assert.equal((await run(`x ${cut(b, 9, '\r\n')} y`)).stdout, 'x *** y')
    assert.equal((await run(`x ${cut(cut(b, 5, '\x1b[0m'), 30, '\r\n')} y`)).stdout, 'x *** y')
  })
  test('không che nhầm: đầu ra khác giữ nguyên; ký tự đặc biệt của regex trong khoá không làm vỡ; khoá ngắn (< 4) bỏ qua', async () => {
    assert.equal((await run('không có gì ở đây\nsk-or-v1 chưa đủ\n')).stdout, 'không có gì ở đây\nsk-or-v1 chưa đủ\n')
    const { ctx, api } = mkCtx({ handler: () => ({ code: 0, stdout: 'abc xyz' }) })
    assert.equal((await D.sshRun(ctx, api.seed('running'), 'echo', { secrets: ['abc', '', null] })).stdout, 'abc xyz')
  })
})

// `get` KHÔNG đi qua stdout (ConPTY của Windows bẻ dòng dài + chèn ESC ⇒ file hỏng): server tĩnh tạm trên máy ảo + devin forward + HTTP + sha256.
describe('get qua cổng chuyển', () => {
  // đủ 256 giá trị byte, lặp nhiều lần: có CR (13), LF (10), ESC (27), NUL — đúng loại byte mà ConPTY làm hỏng
  const PAYLOAD = Buffer.from(Array.from({ length: 12000 }, (_, i) => i % 256))
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  const START_OK = `@@DEVINVM@@ port 45555\n@@DEVINVM@@ sha ${sha(PAYLOAD)}\n@@DEVINVM@@ size ${PAYLOAD.length}\n`
  // Máy ảo, cổng chuyển, tải HTTP đều giả; timeline ghi thứ tự để kiểm "mở → nối → tải → đóng → dọn".
  function getCtx({ startOut, cleanOut, payload = PAYLOAD, startBackground, ...over } = {}) {
    const timeline = []
    const api = fakeApi()
    const fetched = []
    const killed = []
    const started = []
    const scripts = { start: [], clean: [] }
    let open = false // cổng máy bạn chỉ "mở" sau khi devin forward được sinh ra (trước đó mà đã mở = có tiến trình khác giữ)
    const mk = mkCtx({
      api,
      handler: (rec) => {
        if (rec.script.includes('http.server')) { timeline.push('start'); scripts.start.push(rec.script); return startOut ?? { code: 0, stdout: START_OK } }
        if (rec.script.includes('not-cleaned')) { timeline.push('clean'); scripts.clean.push(rec.script); return cleanOut ?? { code: 0, stdout: '@@DEVINVM@@ cleaned\n' } }
        return null
      },
      fetch: async (u, i) => {
        if (!String(u).startsWith('http://127.0.0.1:')) return api.fetch(u, i)
        timeline.push('fetch')
        fetched.push({ url: String(u), headers: i?.headers })
        return new Response(payload)
      },
      startBackground: (...a) => {
        open = true
        return (startBackground ?? ((bin, args) => { timeline.push('forward'); started.push([bin, ...args]); return { pid: 5151, exited: () => false } }))(...a)
      },
      probePort: async () => open,
      freePort: async () => 54321,
      kill: (pid) => { timeline.push('kill'); killed.push(pid) },
      ...over,
    })
    return { ...mk, api, timeline, fetched, killed, started, scripts }
  }

  test('get: đúng thứ tự mở server → nối cổng → tải → đóng cổng → dọn; HTTP trần (không gửi khoá Devin); nhị phân về NGUYÊN VẸN; không để file .part', async () => {
    const g_ = getCtx()
    const repo = mkRepo()
    const id = await seedVm(g_.ctx, g_.api, repo, 'windows')
    const dest = path.join(fresh('get'), 'sâu', 'x.bin')
    const r = await D.getFile(g_.ctx, { dir: repo, os: 'windows', remote: 'out/x.bin', local: dest })
    assert.deepEqual(r, { ok: true, bytes: PAYLOAD.length, sha256: sha(PAYLOAD), cleaned: true })
    assert.deepEqual(g_.timeline, ['start', 'forward', 'fetch', 'kill', 'clean'])
    assert.deepEqual(g_.started, [['DEVIN', 'forward', id, '54321:45555']])
    assert.deepEqual(g_.fetched.map((f) => f.url), ['http://127.0.0.1:54321/payload'])
    assert.equal(g_.fetched[0].headers?.Authorization, undefined, 'không gửi khoá Devin tới server trên máy ảo')
    assert.ok(fs.readFileSync(dest).equals(PAYLOAD))
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['x.bin'])
    assert.deepEqual(g_.killed, [5151])
    const info = await D.projectInfo(g_.ctx, repo)
    assert.deepEqual(D.readRegistry(g_.ctx)[D.projectKey(g_.ctx, info.root, 'windows')].fwd, [], 'cổng đã gỡ khỏi sổ')
  })
  test('get ping giữ máy thức suốt lúc mở server + tải (tải lâu thì hẹn giờ 4 phút ping tiếp), dừng hẹn giờ khi xong — kể cả khi lỗi', async () => {
    const g_ = getCtx()
    const base = g_.ctx.fetch
    g_.ctx.fetch = async (u, i) => {
      if (String(u).startsWith('http://127.0.0.1:')) { await g_.ctx.sleep(250_000); await g_.fire() }
      return base(u, i)
    }
    const repo = mkRepo()
    await seedVm(g_.ctx, g_.api, repo, 'linux')
    const dest = path.join(fresh('get'), 'p.bin')
    await D.getFile(g_.ctx, { dir: repo, remote: 'out/x.bin', local: dest })
    assert.equal(g_.api.pings().length, 2)
    assert.deepEqual(g_.timers.map((h) => [h.ms, h.on]), [[4 * 60_000, false]])
    const bad = getCtx({ startOut: { code: 94 } })
    await seedVm(bad.ctx, bad.api, repo, 'linux')
    await assert.rejects(D.getFile(bad.ctx, { dir: repo, remote: 'khong-co', local: dest }), /Không thấy file/)
    assert.equal(bad.api.pings().length, 1)
    assert.ok(bad.timers.length === 1 && bad.timers.every((h) => !h.on))
  })
  test('qua CLI: JSON một dòng {ok, bytes, sha256, cleaned}; tiến trình ra stderr', async () => {
    const g_ = getCtx()
    const repo = mkRepo()
    await seedVm(g_.ctx, g_.api, repo, 'linux')
    const dest = path.join(fresh('get'), 'a.bin')
    const o = sink()
    const e = sink()
    assert.equal(await main(['get', '--dir', repo, 'out/a.bin', dest], { ctx: g_.ctx, stdout: o, stderr: e }), 0)
    assert.equal(JSON.parse(o.text()).bytes, PAYLOAD.length)
    assert.match(e.text(), /Mở server tạm[\s\S]*Tải file qua cổng chuyển/)
  })
  test('máy ảo báo lỗi (94 không có file · 95 quá lớn · 96 thiếu Python · 97 không mở cổng · thiếu dòng đánh dấu) ⇒ lỗi rõ, KHÔNG mở cổng chuyển, VẪN chạy script dọn', async () => {
    const cases = [
      [{ code: 94 }, /Không thấy file/], [{ code: 95 }, /quá lớn/], [{ code: 96 }, /không có Python/], [{ code: 97 }, /không mở được cổng/],
      [{ code: 0, stdout: '@@DEVINVM@@ port 45555\n' }, /Lấy file từ máy ảo lỗi/],
    ]
    for (const [startOut, re] of cases) {
      const g_ = getCtx({ startOut })
      const repo = mkRepo()
      await seedVm(g_.ctx, g_.api, repo, 'linux')
      const dest = path.join(fresh('get'), 'x.bin')
      await assert.rejects(D.getFile(g_.ctx, { dir: repo, remote: 'x', local: dest }), re, JSON.stringify(startOut))
      assert.deepEqual(g_.timeline, ['start', 'clean'], JSON.stringify(startOut))
      assert.ok(!fs.existsSync(dest))
    }
  })
  test('tải về sai nội dung (cổng chuyển làm hỏng) ⇒ thử 3 lần rồi báo "không khớp"; file đích CŨ giữ nguyên, không có .part; vẫn đóng cổng + dọn server', async () => {
    const bad = Buffer.from(PAYLOAD)
    bad[100] ^= 0xff
    const g_ = getCtx({ payload: bad })
    const repo = mkRepo()
    await seedVm(g_.ctx, g_.api, repo, 'linux')
    const dest = path.join(fresh('get'), 'x.bin')
    write(dest, 'bản cũ')
    await assert.rejects(D.getFile(g_.ctx, { dir: repo, remote: 'x', local: dest }), /không khớp máy ảo/)
    assert.equal(g_.fetched.length, 3)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'bản cũ')
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['x.bin'])
    assert.deepEqual(g_.timeline.filter((x) => x !== 'fetch'), ['start', 'forward', 'kill', 'clean'])
    // thiếu byte (bị bẻ/cắt) cũng bị bắt
    const g2 = getCtx({ payload: PAYLOAD.subarray(0, 5000) })
    const repo2 = mkRepo()
    await seedVm(g2.ctx, g2.api, repo2, 'linux')
    await assert.rejects(D.getFile(g2.ctx, { dir: repo2, remote: 'x', local: dest }), /5000\/12000 byte/)
  })
  test('cổng chuyển thoát ngay ⇒ lỗi, vẫn dọn server; server tạm trả mã lỗi ⇒ báo mã', async () => {
    const g_ = getCtx({ startBackground: () => ({ pid: 1, exited: () => true }) })
    const repo = mkRepo()
    await seedVm(g_.ctx, g_.api, repo, 'linux')
    await assert.rejects(D.getFile(g_.ctx, { dir: repo, remote: 'x', local: path.join(fresh('get'), 'x') }), /thoát ngay/)
    assert.deepEqual(g_.timeline, ['start', 'clean'])
    const g2 = getCtx({ fetch: async (u) => (String(u).startsWith('http://127.0.0.1:') ? new Response('no', { status: 404 }) : fakeApi().fetch(u)) })
    const repo2 = mkRepo()
    await seedVm(g2.ctx, g2.api, repo2, 'linux')
    await assert.rejects(D.getFile(g2.ctx, { dir: repo2, remote: 'x', local: path.join(fresh('get'), 'x') }), /mã 404/)
    assert.ok(g2.timeline.includes('kill') && g2.timeline.includes('clean'))
  })
  test('Devin không dùng được lúc mở server (CLI chưa cài) ⇒ DevinUnavailable, không cố dọn từ xa; dọn thất bại sau khi tải xong ⇒ vẫn thành công nhưng cleaned:false + cảnh báo', async () => {
    const down = getCtx({ devinBin: null })
    const repo = mkRepo()
    await seedVm(down.ctx, down.api, repo, 'linux')
    await assert.rejects(D.getFile(down.ctx, { dir: repo, remote: 'x', local: path.join(fresh('get'), 'x') }), D.DevinUnavailable)
    assert.deepEqual(down.scripts.clean, [])
    const g_ = getCtx({ cleanOut: { code: 255, stderr: 'mất kết nối' } })
    await seedVm(g_.ctx, g_.api, repo, 'linux')
    const said = []
    const r = await D.getFile(g_.ctx, { dir: repo, remote: 'x', local: path.join(fresh('get'), 'x'), say: (s) => said.push(s) })
    assert.deepEqual([r.ok, r.cleaned], [true, false])
    assert.ok(said.some((s) => /CẢNH BÁO.*server tạm/.test(s)))
  })

  test('getStartScript: server chỉ 127.0.0.1, cổng 0, tách nền với MỌI fd chuyển hướng, chỉ phục vụ bản sao trong thư mục riêng, không còn base64 qua stdout; python ưu tiên theo hệ; bash -n ổn', () => {
    const args = { os: 'linux', name: 'demo-app', remote: '~/ảnh/x y.png', gid: 'a1b2c3d4' }
    const s = D.getStartScript(args)
    assert.match(s, /for c in python3 python; do "\$c" -c 'import http\.server'/)
    assert.match(D.getStartScript({ ...args, os: 'windows' }), /for c in python python3; do/)
    assert.ok(s.includes('nohup "$PY" -u -m http.server 0 --bind 127.0.0.1 >"$W/log" 2>&1 </dev/null &'))
    assert.ok(s.includes('W="$HOME/.devinvm-get-a1b2c3d4"') && s.includes('cp "$src" "$W/serve/payload"') && s.includes('cd "$W/serve"'))
    assert.ok(s.includes('echo $! > "$W/pid"'))
    assert.match(s, /sha256sum[\s\S]*shasum -a 256/)
    assert.match(s, /@@DEVINVM@@ port \$port[\s\S]*@@DEVINVM@@ sha \$h[\s\S]*@@DEVINVM@@ size \$n/)
    assert.ok(s.includes(`src="$HOME"/'ảnh/x y.png'`))
    assert.ok(!/base64/.test(s))
    assert.match(D.getStartScript({ ...args, os: 'windows', node: '25' }), /^export PATH="\/c\/devinvm\/node-v25:\$PATH"\n/)
    if (HAS_BASH) assert.equal(spawnSync(BASH, ['-n'], { input: s, encoding: 'utf8' }).status, 0)
    for (const bad of [{ gid: 'xyz' }, { gid: 'A1B2C3D4' }, { gid: 'a1b2c3d4; ls' }, { name: '..' }, { name: 'a b' }]) assert.throws(() => D.getStartScript({ ...args, ...bad }), undefined, JSON.stringify(bad))
  })
  test('getCleanScript: dừng server theo pid (có đường Git Bash taskkill), chỉ xoá đúng thư mục riêng của lần này (rào case), báo cleaned/not-cleaned; chạy được khi chưa có gì (gọi lại được)', (t) => {
    const s = D.getCleanScript({ gid: 'a1b2c3d4' })
    assert.ok(s.includes('W="$HOME/.devinvm-get-a1b2c3d4"') && s.includes('taskkill //PID "$wp" //F'))
    assert.match(s, /case "\$W" in "\$HOME"\/\.devinvm-get-\*\) rm -rf -- "\$W" ;; esac/)
    assert.equal((s.match(/rm -rf/g) ?? []).length, 1, 'chỉ một chỗ xoá, nằm trong rào case')
    assert.throws(() => D.getCleanScript({ gid: '../x' }))
    if (!HAS_BASH) return t.skip('không có bash')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dvmvm-'))
    const run = () => spawnSync(BASH, ['-s'], { input: s, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000 })
    assert.match(run().stdout, /@@DEVINVM@@ cleaned/)
    fs.mkdirSync(path.join(home, '.devinvm-get-a1b2c3d4', 'serve'), { recursive: true })
    fs.mkdirSync(path.join(home, '.devinvm-get-deadbeef'), { recursive: true })
    assert.match(run().stdout, /@@DEVINVM@@ cleaned/)
    assert.deepEqual(fs.readdirSync(home), ['.devinvm-get-deadbeef'], 'thư mục của lần khác không bị đụng')
  })

  const PY = ['python', 'python3'].find((c) => spawnSync(c, ['-c', 'import http.server'], { encoding: 'utf8' }).status === 0)
  test('THẬT (bash + python): server tạm chạy nền thật, tải qua HTTP, byte về nguyên vẹn, rồi server chết + thư mục sạch', { skip: (!HAS_BASH || !PY) && 'cần bash và python' }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dvmvm-'))
    let realPort = null
    let forwarded = false
    const runBash =(script) => spawnSync(BASH, ['-s'], { input: script, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 90_000 })
    const api = fakeApi()
    // "máy ảo" = bash thật: chạy mọi script có `.devinvm-get-`; cổng chuyển giả = đổi cổng 54321 của máy bạn thành cổng thật mà python vừa mở
    const { ctx } = mkCtx({
      api,
      handler: (rec) => {
        if (!rec.script.includes('.devinvm-get-')) return null
        const r = runBash(rec.script)
        const p = /@@DEVINVM@@ port (\d+)/.exec(r.stdout)
        if (p) realPort = Number(p[1])
        return { code: r.status, stdout: r.stdout, stderr: r.stderr }
      },
      fetch: async (u, i) => (String(u).startsWith('http://127.0.0.1:54321/') ? fetch(String(u).replace(':54321', `:${realPort}`)) : api.fetch(u, i)),
      startBackground: () => { forwarded = true; return { pid: 4242, exited: () => false } },
      probePort: async () => forwarded,
      freePort: async () => 54321,
      kill: () => {},
    })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    const info = await D.projectInfo(ctx, repo)
    write(path.join(home, 'repos', info.name, 'out', 'big.bin'), PAYLOAD)
    const dest = path.join(fresh('get'), 'big.bin')
    try {
      const r = await D.getFile(ctx, { dir: repo, remote: 'out/big.bin', local: dest })
      assert.deepEqual([r.ok, r.bytes, r.sha256, r.cleaned], [true, PAYLOAD.length, sha(PAYLOAD), true])
      assert.ok(fs.readFileSync(dest).equals(PAYLOAD))
      assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('.devinvm-get-')), [], 'thư mục tạm trên "máy ảo" đã dọn')
      let alive = true
      for (let i = 0; i < 25 && alive; i++) {
        alive = await fetch(`http://127.0.0.1:${realPort}/payload`).then(() => true, () => false)
        if (alive) await new Promise((x) => setTimeout(x, 200))
      }
      assert.equal(alive, false, 'server tạm đã bị dừng')
    } finally {
      for (const d of fs.readdirSync(home).filter((f) => f.startsWith('.devinvm-get-'))) runBash(D.getCleanScript({ gid: d.slice('.devinvm-get-'.length) }))
    }
  })
})

describe('forward / gui', () => {
  test('parsePorts: <cổng> hoặc L:R; ngoài 1–65535 hoặc rác ⇒ lỗi dùng', () => {
    assert.deepEqual(D.parsePorts('9333'), { local: 9333, remote: 9333 })
    assert.deepEqual(D.parsePorts('8080:3000'), { local: 8080, remote: 3000 })
    for (const bad of ['0', '70000', 'a:b', '1:2:3', '', '80;ls']) assert.throws(() => D.parsePorts(bad), D.UsageError, bad)
  })
  // Máy bạn giả cho forward: cổng chỉ "mở" sau khi devin forward sinh ra và "đóng" khi nó bị diệt; mọi tiến trình nền có pid riêng (forward 4242, 4252…; keepalive 4343, 4353…).
  function fwdCtx({ busy = [], ...over } = {}) {
    const st = { started: [], killed: [], cmdlines: {}, ports: {}, open: new Set(busy), fwdPids: 4242, kaPids: 4343, deadAfter: null }
    const portOf = (args) => Number(args[2].split(':')[0])
    const mk = mkCtx({
      startBackground: (bin, args) => {
        st.started.push([bin, args])
        if (bin === 'DEVIN') {
          const pid = st.fwdPids
          st.fwdPids += 10
          st.open.add(portOf(args))
          st.cmdlines[pid] = `devin.exe ${args.join(' ')}`
          st.ports[pid] = portOf(args)
          let calls = 0
          return { pid, exited: () => st.deadAfter !== null && ++calls >= st.deadAfter }
        }
        const pid = st.kaPids
        st.kaPids += 10
        st.cmdlines[pid] = `node.exe ${args.join(' ')}`
        return { pid, exited: () => false }
      },
      probePort: async (p) => st.open.has(p),
      kill: (pid) => { st.killed.push(pid); if (st.ports[pid]) st.open.delete(st.ports[pid]) },
      cmdline: async (pid) => st.cmdlines[pid] ?? null,
      ...over,
    })
    return { ...mk, st }
  }
  test('forward: chạy nền devin forward <id> L:R, chờ cổng mở, ghi pid vào sổ; --stop chỉ diệt pid còn đúng là devin forward của máy này', async () => {
    const { ctx, api, st } = fwdCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'windows')
    const r = await D.startForward(ctx, { dir: repo, os: 'windows', spec: '9444:9333' })
    assert.deepEqual(st.started[0], ['DEVIN', ['forward', id, '9444:9333']])
    assert.deepEqual([r.pid, r.local, r.remote, r.keepalive], [4242, 9444, 9333, 4343])
    const info = await D.projectInfo(ctx, repo)
    const key = D.projectKey(ctx, info.root, 'windows')
    assert.equal(D.readRegistry(ctx)[key].fwd[0].pid, 4242)
    st.cmdlines[4242] = 'chrome.exe --some-other-process' // pid đã bị tiến trình khác mượn
    assert.deepEqual(await D.stopForward(ctx, { dir: repo, os: 'windows' }), { ok: true, stopped: 0, stale: 1, keepalive: 1 })
    assert.deepEqual(st.killed, [4343], 'chỉ diệt keepalive (pid còn đúng); forward bị mượn pid thì không đụng')
    await D.startForward(ctx, { dir: repo, os: 'windows', spec: '9333' })
    assert.deepEqual(await D.stopForward(ctx, { dir: repo, os: 'windows' }), { ok: true, stopped: 1, stale: 0, keepalive: 1 })
    assert.deepEqual(st.killed, [4343, 4252, 4353])
    assert.deepEqual([D.readRegistry(ctx)[key].fwd, D.readRegistry(ctx)[key].keepalive], [[], undefined])
  })
  test('forward: cổng máy bạn đã có tiến trình KHÁC nghe ⇒ lỗi rõ, không sinh devin forward, không ghi sổ, không bật keepalive', async () => {
    const { ctx, api, st } = fwdCtx({ busy: [9444] })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'windows')
    await assert.rejects(D.startForward(ctx, { dir: repo, os: 'windows', spec: '9444:9333' }), (e) => e instanceof D.ToolError && /Cổng 9444.*tiến trình khác nghe/.test(e.message))
    assert.deepEqual(st.started, [])
    const info = await D.projectInfo(ctx, repo)
    const e = D.readRegistry(ctx)[D.projectKey(ctx, info.root, 'windows')]
    assert.deepEqual([e.fwd ?? [], e.keepalive], [[], undefined])
    // qua CLI: không phải ok
    const err = sink()
    assert.equal(await main(['forward', '--dir', repo, '--os', 'windows', '9444:9333'], { ctx, stdout: sink(), stderr: err }), 1)
    assert.match(err.text(), /tiến trình khác nghe/)
  })
  test('forward lại ĐÚNG cổng do chính mình giữ ⇒ diệt cái cũ rồi mở lại, không báo bận; keepalive đang chạy thì giữ, không sinh thêm', async () => {
    const { ctx, api, st } = fwdCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    await D.startForward(ctx, { dir: repo, spec: '5173' })
    const r = await D.startForward(ctx, { dir: repo, spec: '5173' })
    assert.deepEqual(st.killed, [4242], 'forward cũ của cổng 5173 bị diệt')
    assert.deepEqual([r.pid, r.keepalive], [4252, 4343], 'forward mới; keepalive cũ vẫn là cái đang chạy')
    assert.equal(st.started.filter(([b]) => b !== 'DEVIN').length, 1, 'chỉ một tiến trình keepalive được sinh')
    assert.deepEqual(st.started.filter(([b]) => b === 'DEVIN').map(([, a]) => a), [['forward', id, '5173:5173'], ['forward', id, '5173:5173']])
  })
  test('forward: cổng "mở" nhưng devin forward chết ngay sau đó (cổng là của kẻ khác) ⇒ lỗi, không ghi sổ, không bật keepalive', async () => {
    const { ctx, api, st } = fwdCtx()
    st.deadAfter = 2 // lần exited() thứ nhất (trong vòng chờ) còn sống; lần thứ hai (kiểm sau khi cổng mở) đã chết
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    await assert.rejects(D.startForward(ctx, { dir: repo, spec: '5173' }), /thoát sau khi cổng 5173 đã mở/)
    assert.equal(st.started.length, 1)
    const info = await D.projectInfo(ctx, repo)
    assert.deepEqual(D.readRegistry(ctx)[D.projectKey(ctx, info.root, 'linux')].fwd ?? [], [])
  })
  test('forward: tiến trình thoát ngay ⇒ lỗi; cổng không mở trong 30 s ⇒ diệt và báo; chưa có máy ⇒ lỗi chỉ cách up', async () => {
    const repo = mkRepo()
    const a = mkCtx({ startBackground: () => ({ pid: 1, exited: () => true }), probePort: async () => false })
    await seedVm(a.ctx, a.api, repo, 'linux')
    await assert.rejects(D.startForward(a.ctx, { dir: repo, spec: '5173' }), /thoát ngay/)
    const killed = []
    const b = mkCtx({ startBackground: () => ({ pid: 77, exited: () => false }), probePort: async () => false, kill: (p) => killed.push(p) })
    await seedVm(b.ctx, b.api, repo, 'linux')
    await assert.rejects(D.startForward(b.ctx, { dir: repo, spec: '5173' }), /chưa mở/)
    assert.deepEqual(killed, [77])
    await assert.rejects(D.startForward(mkCtx().ctx, { dir: repo, spec: '5173' }), /up --os linux/)
  })
  test('gui: Windows mới được; script PowerShell đăng ký tác vụ Interactive, thoát nháy đơn, chạy qua -EncodedCommand', async () => {
    const calls = []
    const { ctx, api } = mkCtx({ handler: (rec) => { calls.push(rec); return { code: 0, stdout: '@@DEVINVM@@ gui Running\n' } } })
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await seedVm(ctx, api, repo, 'windows')
    const r = await D.guiLaunch(ctx, { dir: repo, exe: "C:\\Users\\Administrator\\App's\\RuntoTalk.exe", args: '--remote-debugging-port=9333', cwd: 'C:\\x' })
    assert.deepEqual(r, { ok: true, state: 'Running' })
    const ps = calls[0].script
    assert.match(calls[0].command, /^powershell .* -EncodedCommand /)
    assert.ok(ps.includes("$exe = 'C:\\Users\\Administrator\\App''s\\RuntoTalk.exe'") && ps.includes("$arg = '--remote-debugging-port=9333'"))
    assert.match(ps, /New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive[\s\S]*Register-ScheduledTask[\s\S]*Start-ScheduledTask/)
    assert.ok(ps.includes("$wd = 'C:\\x'"), '--cwd rõ ràng thì giữ nguyên')
    const lin = mkRepo({ 'package.json': '{}' })
    await seedVm(ctx, api, lin, 'linux')
    await assert.rejects(D.guiLaunch(ctx, { dir: lin, os: 'linux', exe: 'x' }), /chỉ dùng cho máy Windows/)
  })
  test('gui --cmd: node tự dựng exe=cmd.exe + args="/c <dòng lệnh>" (Git Bash không kịp đổi /c thành C:/); thiếu --cwd ⇒ thư mục kho trên máy ảo, không System32', async () => {
    const calls = []
    const { ctx, api } = mkCtx({ handler: (rec) => { calls.push(rec); return { code: 0, stdout: '@@DEVINVM@@ gui Running\n' } } })
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await seedVm(ctx, api, repo, 'windows')
    const info = await D.projectInfo(ctx, repo)
    const o = sink()
    const line = 'set A=1 && "C:\\Users\\Administrator\\Ứng dụng\\x.exe" --port=9333'
    assert.equal(await main(['gui', '--dir', repo, '--cmd', line], { ctx, stdout: o, stderr: sink() }), 0)
    assert.deepEqual(JSON.parse(o.text()), { ok: true, state: 'Running' })
    const ps = calls[0].script
    assert.ok(ps.includes("$exe = 'cmd.exe'"))
    assert.ok(ps.includes(`$arg = '/c ${line}'`))
    assert.ok(ps.includes("$wd = ''") && ps.includes(`$repo = '${info.name}'`), 'không --cwd: để script chọn thư mục kho')
    assert.match(ps, /if \(-not \$wd\) \{ \$wd = \$env:USERPROFILE; if \(\$repo\) \{ \$cand = Join-Path \$env:USERPROFILE \(Join-Path 'repos' \$repo\); if \(Test-Path -LiteralPath \$cand\) \{ \$wd = \$cand \} \} \}/)
    assert.ok(ps.indexOf('if (-not $wd)') < ps.indexOf('New-ScheduledTaskAction'), 'cwd chốt trước khi dựng tác vụ')
    // --cwd rõ ràng + gõ kiểu cũ `-- cmd.exe …` vẫn chạy như trước
    calls.length = 0
    assert.equal(await main(['gui', '--dir', repo, '--cwd', 'D:\\kho', '--cmd', 'dir'], { ctx, stdout: sink(), stderr: sink() }), 0)
    assert.ok(calls[0].script.includes("$wd = 'D:\\kho'") && calls[0].script.includes("$arg = '/c dir'"))
    calls.length = 0
    assert.equal(await main(['gui', '--dir', repo, '--', 'notepad.exe', 'a b.txt'], { ctx, stdout: sink(), stderr: sink() }), 0)
    assert.ok(calls[0].script.includes("$exe = 'notepad.exe'") && calls[0].script.includes('$arg = \'"a b.txt"\''))
  })
  test('gui: --cmd và phần sau "--" không đi cùng nhau; --cmd trống / thiếu cả hai ⇒ lỗi dùng; --cmd một mình hợp lệ', async () => {
    assert.deepEqual(parseArgs(['gui', '--cmd', 'dir']).rest, [])
    for (const bad of [['gui', '--cmd', 'dir', '--', 'x.exe'], ['gui'], ['gui', '--']]) assert.throws(() => parseArgs(bad), D.UsageError, JSON.stringify(bad))
    const { ctx, api } = mkCtx()
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await seedVm(ctx, api, repo, 'windows')
    await assert.rejects(D.guiLaunch(ctx, { dir: repo, cmd: '  ' }), D.UsageError)
    await assert.rejects(D.guiLaunch(ctx, { dir: repo, cmd: 'dir', exe: 'x.exe' }), D.UsageError)
  })
})

// ---------- giữ máy thức (QA vòng 2: máy tạo qua API ngủ sau ~5 phút không có TIN NHẮN) ----------
describe('giữ máy thức (ping)', () => {
  const LINE = 'keepalive: reply with the single word ok. Do not run any tools or commands.'
  const regOf = async (ctx, repo, osName) => D.readRegistry(ctx)[D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, osName)]

  test('run: ping bằng MCP message đúng câu chữ, ghi lastPing; vừa ping (< 3 phút) ⇒ không ping lại; quá 3 phút ⇒ ping lại', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    await D.runProject(ctx, { dir: repo, command: 'echo 1' })
    assert.deepEqual(api.pings().map((b) => [b.params.name, b.params.arguments]), [['devin_session_interact', { action: 'message', session_id: id, message: LINE }]])
    assert.equal(D.KEEPALIVE_MESSAGE, LINE)
    const first = (await regOf(ctx, repo, 'linux')).lastPing
    assert.equal(typeof first, 'number')
    await D.runProject(ctx, { dir: repo, command: 'echo 2' })
    assert.equal(api.pings().length, 1, 'còn tươi ⇒ không ping')
    await ctx.sleep(200_000) // 3 phút 20 giây
    await D.runProject(ctx, { dir: repo, command: 'echo 3' })
    assert.equal(api.pings().length, 2)
    assert.ok((await regOf(ctx, repo, 'linux')).lastPing > first)
    assert.ok(api.calls.filter((c) => c.host === 'mcp.devin.ai').every((c) => c.headers['X-Org-Id'] === 'org-abcdef123456'), 'ping đi cùng header như sleep')
  })
  test('KHÔNG ping máy đang ngủ (do `sleep`): ping sẽ đánh thức nó; ping hỏng không làm hỏng lệnh, chỉ báo một dòng', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux', 'suspended')
    const said = []
    const r = await D.runProject(ctx, { dir: repo, command: 'echo 1', say: (s) => said.push(s) })
    assert.equal(r.code, 0)
    assert.equal(api.pings().length, 0, 'máy suspended ⇒ bỏ qua')
    const bad = mkCtx()
    const repo2 = mkRepo()
    await seedVm(bad.ctx, bad.api, repo2, 'linux')
    bad.api.fail = (rec) => (rec.host === 'mcp.devin.ai' ? new Response('{}', { status: 500 }) : null)
    const said2 = []
    assert.equal((await D.runProject(bad.ctx, { dir: repo2, command: 'echo 1', say: (s) => said2.push(s) })).code, 0)
    assert.ok(said2.some((s) => /Không ping giữ máy thức được/.test(s)))
    assert.ok(said2.every((s) => !/KEYSECRET|Bearer/.test(s)))
  })
  test('run kéo dài: hẹn giờ 4 phút ping tiếp trong lúc lệnh chạy, dừng hẹn giờ khi lệnh xong (kể cả lệnh ném lỗi)', async () => {
    let mk = null
    mk = mkCtx({ handler: async (rec) => { if (rec.script.includes('longjob')) { await mk.ctx.sleep(250_000); await mk.fire() } return null } })
    const repo = mkRepo()
    await seedVm(mk.ctx, mk.api, repo, 'linux')
    await D.runProject(mk.ctx, { dir: repo, command: 'longjob' })
    assert.equal(mk.api.pings().length, 2, 'một ping lúc bắt đầu + một ping do hẹn giờ sau 4 phút')
    assert.deepEqual(mk.timers.map((h) => [h.ms, h.on]), [[4 * 60_000, false]])
    // hẹn giờ nổ khi còn tươi ⇒ không ping thừa
    let m2 = null
    m2 = mkCtx({ handler: async (rec) => { if (rec.script.includes('quick')) await m2.fire(); return null } })
    const repo2 = mkRepo()
    await seedVm(m2.ctx, m2.api, repo2, 'linux')
    await D.runProject(m2.ctx, { dir: repo2, command: 'quick' })
    assert.equal(m2.api.pings().length, 1)
    // lỗi giữa chừng vẫn dừng hẹn giờ
    const m3 = mkCtx({ handler: () => { throw new Error('nổ') } })
    const repo3 = mkRepo()
    await seedVm(m3.ctx, m3.api, repo3, 'linux')
    await assert.rejects(D.runProject(m3.ctx, { dir: repo3, command: 'x' }), /nổ/)
    assert.ok(m3.timers.length === 1 && m3.timers.every((h) => !h.on))
  })
  test('sync và gui ping nếu lần ping cuối > 3 phút; sync hỏng vẫn dừng hẹn giờ', async () => {
    const { ctx, api, timers } = mkCtx({ handler: (rec) => (rec.script.includes('devinvm.bundle') ? { code: 0, stdout: `@@DEVINVM@@ head ${'0'.repeat(40)}\n@@DEVINVM@@ tree ${'1'.repeat(40)}\n` } : { code: 0, stdout: '@@DEVINVM@@ gui Running\n' }) })
    const repo = mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })
    await seedVm(ctx, api, repo, 'windows')
    await assert.rejects(D.syncProject(ctx, { dir: repo }), /không khớp/)
    assert.equal(api.pings().length, 1)
    assert.ok(timers.length === 1 && timers.every((h) => !h.on))
    await D.guiLaunch(ctx, { dir: repo, exe: 'x.exe' })
    assert.equal(api.pings().length, 1, 'vừa ping khi sync ⇒ gui không ping thêm')
    await ctx.sleep(200_000)
    await D.guiLaunch(ctx, { dir: repo, exe: 'x.exe' })
    assert.equal(api.pings().length, 2)
  })

  // ---- tiến trình nền keepalive (do forward sinh ra) ----
  // cmdline mặc định của pid còn sống = `devin forward <id> …` của máy này; ghi đè qua `lines[pid]` (pid bị tiến trình khác mượn lại).
  async function kaSetup({ status = 'running', fwdPids = [4242], kaPid = 9001, ...over } = {}) {
    const alive = new Set(fwdPids)
    const lines = {}
    let id = null
    const mk = mkCtx({ pid: 9001, pidAlive: (p) => alive.has(p), cmdline: async (p) => (p in lines ? lines[p] : alive.has(p) ? `devin.exe forward ${id} 9333:9333` : null), ...over })
    const repo = mkRepo()
    id = await seedVm(mk.ctx, mk.api, repo, 'windows', status)
    const info = await D.projectInfo(mk.ctx, repo)
    const key = D.projectKey(mk.ctx, info.root, 'windows')
    await D.updateRegistry(mk.ctx, (reg) => {
      reg[key].fwd = fwdPids.map((pid) => ({ pid, local: 9333, remote: 9333, at: 'x' }))
      if (kaPid) reg[key].keepalive = { pid: kaPid, at: 'x' }
    })
    return { ...mk, repo, id, key, alive, lines }
  }
  test('runKeepalive: pid của forward còn "sống" nhưng đã bị tiến trình khác mượn lại (cmdline lạ / forward của máy khác) ⇒ KHÔNG coi là forward sống: thoát, không ping', async () => {
    const k = await kaSetup()
    k.lines[4242] = 'chrome.exe --type=renderer'
    assert.equal(await D.runKeepalive(k.ctx, { dir: k.repo, os: 'windows' }), 'no-forward')
    assert.equal(k.api.pings().length, 0)
    assert.equal(D.readRegistry(k.ctx)[k.key].keepalive, undefined)
    const other = await kaSetup()
    other.lines[4242] = 'devin.exe forward devin-may-khac999 9333:9333' // đúng là forward nhưng của máy khác
    assert.equal(await D.runKeepalive(other.ctx, { dir: other.repo, os: 'windows' }), 'no-forward')
    assert.equal(other.api.pings().length, 0)
    const gone = await kaSetup() // cmdline không đọc được (null) ⇒ không xác nhận được ⇒ không giữ máy
    gone.lines[4242] = null
    assert.equal(await D.runKeepalive(gone.ctx, { dir: gone.repo, os: 'windows' }), 'no-forward')
    const two = await kaSetup({ fwdPids: [4242, 4343] }) // một forward thật + một pid mượn ⇒ vẫn còn forward sống
    two.lines[4242] = 'chrome.exe'
    const base = two.ctx.sleep
    let n = 0
    two.ctx.sleep = async (ms) => { await base(ms); if (ms === 4 * 60_000 && ++n === 2) two.alive.delete(4343) }
    assert.equal(await D.runKeepalive(two.ctx, { dir: two.repo, os: 'windows' }), 'no-forward')
    assert.equal(two.api.pings().length, 2)
  })
  test('runKeepalive: mỗi 4 phút một ping tới khi forward cuối cùng chết ⇒ tự thoát và gỡ tên khỏi sổ', async () => {
    const k = await kaSetup()
    const base = k.ctx.sleep
    let loops = 0
    k.ctx.sleep = async (ms) => { await base(ms); if (ms === 4 * 60_000 && ++loops === 3) k.alive.clear() }
    assert.equal(await D.runKeepalive(k.ctx, { dir: k.repo, os: 'windows' }), 'no-forward')
    assert.equal(k.api.pings().length, 3)
    assert.ok(k.api.pings().every((b) => b.params.arguments.session_id === k.id))
    assert.equal(D.readRegistry(k.ctx)[k.key].keepalive, undefined)
  })
  test('runKeepalive: máy đã ngủ (suspended / sleep) ⇒ thoát, không ping; không ai ghi pid mình vào sổ ⇒ thoát "stopped" sau ≤ 10 s, không xoá tên người khác', async () => {
    const asleep = await kaSetup({ status: 'suspended' })
    assert.equal(await D.runKeepalive(asleep.ctx, { dir: asleep.repo, os: 'windows' }), 'asleep')
    assert.equal(asleep.api.pings().length, 0)
    const other = await kaSetup({ kaPid: 7777 }) // sổ ghi keepalive của tiến trình khác (pid 7777), tôi là 9001
    assert.equal(await D.runKeepalive(other.ctx, { dir: other.repo, os: 'windows' }), 'stopped')
    assert.equal(other.api.pings().length, 0)
    assert.equal(D.readRegistry(other.ctx)[other.key].keepalive.pid, 7777)
    const none = await kaSetup({ kaPid: 0 }) // đã bị `forward --stop` gỡ
    assert.equal(await D.runKeepalive(none.ctx, { dir: none.repo, os: 'windows' }), 'stopped')
  })
  test('runKeepalive: quá 6 giờ ⇒ tự thoát; Devin hỏng 5 lần liền ⇒ thoát, không ném; máy đang chạy-nhưng-chưa-sẵn (status khác running) thì không ping', async () => {
    const old = await kaSetup()
    const base = old.ctx.sleep
    old.ctx.sleep = async (ms) => { await base(ms); if (ms === 4 * 60_000) await base(2 * 60 * 60_000) } // mỗi vòng thêm 2 giờ giả
    assert.equal(await D.runKeepalive(old.ctx, { dir: old.repo, os: 'windows' }), 'max-age')
    assert.equal(old.api.pings().length, 3, 'vòng 1 (0 giờ), 2 (2 giờ 4 phút), 3 (4 giờ 8 phút) ping; vòng 4 (6 giờ 12 phút) thoát')
    const down = await kaSetup()
    down.api.fail = (rec) => (rec.host === 'mcp.devin.ai' && JSON.parse(rec.body).method === 'tools/call' ? new Response('{}', { status: 500 }) : null)
    const said = []
    assert.equal(await D.runKeepalive(down.ctx, { dir: down.repo, os: 'windows', say: (s) => said.push(s) }), 'devin-down')
    assert.equal(down.api.pings().length, 5)
    assert.equal(D.readRegistry(down.ctx)[down.key].keepalive, undefined)
    const busy = await kaSetup()
    busy.api.sessions.get(busy.id).status = 'resuming'
    const b2 = busy.ctx.sleep
    let n = 0
    busy.ctx.sleep = async (ms) => { await b2(ms); if (ms === 4 * 60_000 && ++n === 2) busy.alive.clear() }
    assert.equal(await D.runKeepalive(busy.ctx, { dir: busy.repo, os: 'windows' }), 'no-forward')
    assert.equal(busy.api.pings().length, 0)
  })
  test('forward bật keepalive: sinh `node devin-vm.mjs keepalive --dir <gốc> --os <os>`, ghi pid vào sổ; sleep diệt forward + keepalive TRƯỚC khi gửi lệnh ngủ', async () => {
    const st = { started: [], killed: [], cmdlines: {}, order: [] }
    const mk = mkCtx({
      startBackground: (bin, args) => {
        st.started.push([bin, args])
        const pid = bin === 'DEVIN' ? 4242 : 4343
        st.cmdlines[pid] = `${bin} ${args.join(' ')}`
        return { pid, exited: () => false }
      },
      probePort: async () => st.started.length > 0 && st.killed.length === 0,
      kill: (pid) => { st.killed.push(pid); st.order.push(`kill ${pid} khi đã gửi ${mk.api.sleeps().length} lệnh ngủ`) },
      cmdline: async (pid) => st.cmdlines[pid] ?? null,
    })
    const repo = mkRepo()
    const id = await seedVm(mk.ctx, mk.api, repo, 'windows')
    const info = await D.projectInfo(mk.ctx, repo)
    await D.startForward(mk.ctx, { dir: repo, os: 'windows', spec: '9333' })
    assert.deepEqual(st.started[1], [process.execPath, [mk.ctx.cliPath, 'keepalive', '--dir', info.top, '--os', 'windows']])
    assert.match(mk.ctx.cliPath, /devin-vm\.mjs$/)
    assert.equal((await regOf(mk.ctx, repo, 'windows')).keepalive.pid, 4343)
    const r = await D.sleepProject(mk.ctx, { dir: repo, os: 'windows' })
    assert.deepEqual([r.ok, r.status, r.id], [true, 'suspended', id])
    assert.deepEqual(st.order, ['kill 4242 khi đã gửi 0 lệnh ngủ', 'kill 4343 khi đã gửi 0 lệnh ngủ'])
    const e = await regOf(mk.ctx, repo, 'windows')
    assert.deepEqual([e.fwd, e.keepalive], [[], undefined])
    assert.equal(mk.api.sleeps().length, 1)
  })
  test('sleep: nếu một ping đã bay trước khi keepalive bị diệt vừa đánh thức máy ⇒ nhìn lại và cho ngủ lần nữa', async () => {
    const st = { cmdlines: {}, killed: [] }
    const mk = mkCtx({ startBackground: (bin) => ({ pid: bin === 'DEVIN' ? 4242 : 4343, exited: () => false }), kill: (p) => st.killed.push(p), cmdline: async (p) => (p === 4343 ? 'node devin-vm.mjs keepalive' : p === 4242 ? 'devin forward x' : null) })
    const repo = mkRepo()
    const id = await seedVm(mk.ctx, mk.api, repo, 'linux')
    await D.updateRegistry(mk.ctx, async (reg) => { reg[D.projectKey(mk.ctx, (await D.projectInfo(mk.ctx, repo)).root, 'linux')].keepalive = { pid: 4343, at: 'x' } })
    const base = mk.ctx.sleep
    let woke = false
    mk.ctx.sleep = async (ms) => { await base(ms); if (ms === 3000 && !woke) { woke = true; mk.api.sessions.get(id).status = 'running' } } // ping muộn đánh thức lại
    const r = await D.sleepProject(mk.ctx, { dir: repo })
    assert.deepEqual([r.ok, r.status], [true, 'suspended'])
    assert.equal(mk.api.sleeps().length, 2)
    assert.deepEqual(st.killed, [4343])
    // không có keepalive để diệt ⇒ không nhìn lại, một lệnh ngủ thôi
    const m2 = mkCtx()
    const repo2 = mkRepo()
    await seedVm(m2.ctx, m2.api, repo2, 'linux')
    await D.sleepProject(m2.ctx, { dir: repo2 })
    assert.equal(m2.api.sleeps().length, 1)
  })
  test('rm diệt keepalive + forward trước khi xoá máy; keepalive trong sổ mà pid đã bị mượn (cmdline lạ) ⇒ không diệt nhầm, chỉ gỡ khỏi sổ', async () => {
    const killed = []
    const lines = {}
    const mk = mkCtx({ kill: (p) => killed.push(p), cmdline: async (p) => lines[p] ?? null })
    const repo = mkRepo()
    const id = await seedVm(mk.ctx, mk.api, repo, 'linux')
    Object.assign(lines, { 4343: 'node devin-vm.mjs keepalive --dir x', 4242: `devin.exe forward ${id} 9333:9333` })
    const key = D.projectKey(mk.ctx, (await D.projectInfo(mk.ctx, repo)).root, 'linux')
    const setPids = (f, k) => D.updateRegistry(mk.ctx, (reg) => { reg[key].fwd = [{ pid: f, local: 9333, remote: 9333, at: 'x' }]; reg[key].keepalive = { pid: k, at: 'x' } })
    await setPids(4242, 4343)
    const r = await D.removeVm(mk.ctx, { dir: repo })
    assert.equal(r.removed, id)
    assert.deepEqual(killed, [4242, 4343])
    // pid mượn: stopForward không diệt nhầm tiến trình lạ
    const m2 = mkCtx({ kill: (p) => killed.push(p), cmdline: async () => 'chrome.exe' })
    const repo2 = mkRepo()
    await seedVm(m2.ctx, m2.api, repo2, 'linux')
    const key2 = D.projectKey(m2.ctx, (await D.projectInfo(m2.ctx, repo2)).root, 'linux')
    await D.updateRegistry(m2.ctx, (reg) => { reg[key2].keepalive = { pid: 5555, at: 'x' } })
    killed.length = 0
    assert.equal((await D.stopForward(m2.ctx, { dir: repo2 })).keepalive, 0)
    assert.deepEqual(killed, [])
    assert.equal((await regOf(m2.ctx, repo2, 'linux')).keepalive, undefined)
  })
  test('lệnh ẩn `keepalive` có trong CLI (không có trong --help); thân vòng lặp thoát bình thường mã 0', async () => {
    const o = sink()
    await main(['--help'], { ctx: mkCtx().ctx, stdout: o, stderr: sink() })
    assert.ok(!/keepalive/.test(o.text()), 'lệnh ẩn: không ghi trong --help')
    const k = await kaSetup({ kaPid: 0 })
    const err = sink()
    assert.equal(await main(['keepalive', '--dir', k.repo, '--os', 'windows'], { ctx: k.ctx, stdout: sink(), stderr: err }), 0)
    assert.match(err.text(), /keepalive dừng: stopped/)
    assert.deepEqual(parseArgs(['keepalive', '--dir', 'D', '--os', 'windows']).flags, { env: [], dir: 'D', os: 'windows' })
  })
})

// ---------- job (AC-07, 11, 12) ----------
describe('job', () => {
  // runLocal giả: ghi lại lệnh + môi trường, trả mã theo `exit` (hoặc ném lỗi / gửi tín hiệu).
  function jobCtx({ exit = 0, during, handlerExtra, home = fs.mkdtempSync(path.join(os.tmpdir(), 'dvmvm-')), api = fakeApi(), ...over } = {}) {
    const runs = []
    const proc = new EventEmitter()
    const kills = []
    const mk = mkCtx({
      api,
      proc,
      handler: (rec) => handlerExtra?.(rec) ?? vmSim(api, home)(rec),
      runLocal: async (command, o) => {
        runs.push({ command, env: o.env, cwd: o.cwd })
        o.onChild?.({ kill: () => kills.push('kill') })
        await during?.(proc, api)
        if (exit instanceof Error) throw exit
        return exit
      },
      ...over,
    })
    return { ...mk, runs, proc, kills }
  }
  const suspendedCount = (api) => [...api.sessions.values()].filter((s) => s.status === 'suspended').length
  const repoWin = () => mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })

  test('where=local ⇒ chạy lệnh luôn trên máy bạn (DEVIN_VM_RUNNER=local), không đụng Devin', async () => {
    const { ctx, api, runs } = jobCtx()
    const repo = mkRepo()
    write(path.join(repo, '.claude', 'devin.json'), JSON.stringify({ local: ['gpu'] }))
    const said = []
    const code = await D.runJob(ctx, { dir: repo, need: 'gpu', command: 'node qa.mjs', say: (s) => said.push(s) })
    assert.equal(code, 0)
    assert.equal(api.calls.length, 0)
    assert.equal(runs[0].command, 'node qa.mjs')
    assert.equal(runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.match(said[0], /cần máy thật: gpu/)
  })
  test('đường máy ảo: up ⇒ sync ⇒ lệnh chạy với DEVIN_VM_ID/OS/RUNNER ⇒ máy NGỦ (suspended) rồi mới trả mã thoát của lệnh', async () => {
    const { ctx, api, runs } = jobCtx({ exit: 0 })
    const repo = repoWin()
    const code = await D.runJob(ctx, { dir: repo, command: 'node qa.mjs' })
    assert.equal(code, 0)
    assert.equal(api.posts().length, 1)
    assert.deepEqual([runs[0].env.DEVIN_VM_RUNNER, runs[0].env.DEVIN_VM_OS, /^devin-new/.test(runs[0].env.DEVIN_VM_ID)], ['devin', 'windows', true])
    assert.equal(suspendedCount(api), 1)
    assert.equal(api.sleeps().length, 1)
  })
  test('lệnh hỏng (mã 3) ⇒ mã 3 được giữ nguyên VÀ máy vẫn ngủ', async () => {
    const { ctx, api } = jobCtx({ exit: 3 })
    assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x' }), 3)
    assert.equal(suspendedCount(api), 1)
  })
  test('lệnh ném lỗi giữa chừng ⇒ lỗi được ném lại NHƯNG máy vẫn ngủ (charter #4)', async () => {
    const { ctx, api } = jobCtx({ exit: new Error('nổ giữa chừng') })
    await assert.rejects(D.runJob(ctx, { dir: repoWin(), command: 'x' }), /nổ giữa chừng/)
    assert.equal(suspendedCount(api), 1)
  })
  test('sync lỗi (máy ảo không khớp) ⇒ không chạy lệnh, máy vẫn ngủ', async () => {
    const { ctx, api, runs } = jobCtx({ handlerExtra: (rec) => (rec.script.includes('devinvm.bundle') ? { code: 0, stdout: `@@DEVINVM@@ head ${'0'.repeat(40)}\n@@DEVINVM@@ tree ${'1'.repeat(40)}\n` } : null) })
    await assert.rejects(D.runJob(ctx, { dir: repoWin(), command: 'x' }), /không khớp/)
    assert.equal(runs.length, 0)
    assert.equal(suspendedCount(api), 1)
  })
  test('Ctrl+C / SIGTERM giữa lệnh ⇒ chuyển tín hiệu cho lệnh, máy ngủ, mã 130 / 143', async () => {
    for (const [sig, want] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const { ctx, api, kills, proc } = jobCtx({ exit: 1, during: (p) => p.emit(sig, sig) })
      assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x' }), want, sig)
      assert.deepEqual(kills, ['kill'])
      assert.equal(suspendedCount(api), 1)
      assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0, 'gỡ bộ nghe tín hiệu')
    }
  })
  test('máy không ngủ kịp ⇒ lệnh đạt vẫn trả mã 1 (không báo xong khi máy còn bật) + cảnh báo kèm lệnh sleep; lệnh hỏng giữ mã của nó', async () => {
    const api = fakeApi()
    api.stuck = true
    const said = []
    const { ctx } = jobCtx({ api, exit: 0 })
    assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 1)
    assert.ok(said.some((s) => /CẢNH BÁO.*chưa ngủ.*devin-vm\.mjs sleep --os windows/.test(s)))
    const api2 = fakeApi()
    api2.stuck = true
    assert.equal(await D.runJob(jobCtx({ api: api2, exit: 5 }).ctx, { dir: repoWin(), command: 'x' }), 5)
  })
  test('Devin không dùng được lúc up (401 / hết hạn mức) ⇒ chạy lệnh trên máy bạn, mã của lệnh được trả (AC-11)', async () => {
    for (const status of [401, 429]) {
      const api = fakeApi()
      api.fail = (r) => (r.method === 'POST' && r.path.endsWith('/sessions') ? new Response('{}', { status }) : null)
      const { ctx, runs } = jobCtx({ api, exit: 0 })
      const said = []
      assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 0, String(status))
      assert.equal(runs.length, 1)
      assert.equal(runs[0].env.DEVIN_VM_RUNNER, 'local')
      assert.ok(said.some((s) => /Devin không dùng được/.test(s)))
    }
  })
  test('thiếu lệnh ⇒ lỗi dùng', async () => {
    await assert.rejects(D.runJob(jobCtx().ctx, { dir: mkRepo(), command: '  ' }), D.UsageError)
  })
  test('ping giữ máy thức suốt lệnh (hẹn giờ 4 phút); dừng hẹn giờ rồi MỚI cho máy ngủ — lệnh cuối gửi tới Devin là sleep, máy vẫn suspended', async () => {
    let j = null
    j = jobCtx({ during: async () => { await j.ctx.sleep(250_000); await j.fire() } })
    assert.equal(await D.runJob(j.ctx, { dir: repoWin(), command: 'node qa.mjs' }), 0)
    const acts = j.api.mcpCalls().map((b) => b.params.arguments.action)
    assert.equal(acts.filter((a) => a === 'message').length, 2, `ping lúc đầu + ping của hẹn giờ: ${acts}`)
    assert.equal(acts.at(-1), 'sleep')
    assert.equal(acts.filter((a) => a === 'sleep').length, 1)
    assert.ok(j.timers.length >= 1 && j.timers.every((h) => h.ms === 4 * 60_000 && !h.on), 'mọi hẹn giờ (4 phút) đã dừng')
    assert.equal(suspendedCount(j.api), 1)
  })
  test('hẹn giờ nổ ngay lúc lệnh xong, ping còn đang bay ⇒ job CHỜ ping xong rồi mới gửi sleep (không có ping nào sau sleep)', async () => {
    const order = []
    const api = fakeApi()
    const base = api.fetch.bind(api)
    api.fetch = async (u, i) => {
      if (new URL(u).host === 'mcp.devin.ai') {
        const b = JSON.parse(i.body)
        if (b.method === 'tools/call') {
          if (b.params.arguments.action === 'message') { order.push('ping-start'); await new Promise((r) => setTimeout(r, 40)); order.push('ping-end') } else order.push('sleep')
        }
      }
      return base(u, i)
    }
    let j = null
    j = jobCtx({ api, during: async () => { await j.ctx.sleep(250_000); void j.fire() } }) // không chờ: lệnh trả về khi ping còn bay
    assert.equal(await D.runJob(j.ctx, { dir: repoWin(), command: 'x' }), 0)
    assert.deepEqual(order.slice(-2), ['ping-end', 'sleep'])
    assert.equal(order.filter((x) => x === 'ping-start').length, order.filter((x) => x === 'ping-end').length)
  })
  test('job đã TẠO máy rồi quay về chạy trên máy bạn (ssh không nối được) mà máy KHÔNG ngủ được ⇒ mã 1 + một dòng cảnh báo kèm lệnh sleep (không báo xong khi máy còn bật)', async () => {
    const api = fakeApi()
    api.stuck = true
    const said = []
    const { ctx, runs } = jobCtx({ api, exit: 0, handlerExtra: (rec) => (/devinvm-ready/.test(rec.command) ? { code: 255 } : null) })
    assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 1)
    assert.equal(runs.length, 1, 'lệnh vẫn chạy trên máy bạn')
    assert.equal(runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.equal(said.filter((s) => /CẢNH BÁO.*chưa ngủ.*devin-vm\.mjs sleep --os windows/.test(s)).length, 1)
    // lệnh hỏng thì giữ mã của nó
    const api2 = fakeApi()
    api2.stuck = true
    assert.equal(await D.runJob(jobCtx({ api: api2, exit: 5, handlerExtra: (rec) => (/devinvm-ready/.test(rec.command) ? { code: 255 } : null) }).ctx, { dir: repoWin(), command: 'x' }), 5)
    // tạo máy rồi quay về máy bạn nhưng máy ngủ được ⇒ 0
    const ok = jobCtx({ exit: 0, handlerExtra: (rec) => (/devinvm-ready/.test(rec.command) ? { code: 255 } : null) })
    assert.equal(await D.runJob(ok.ctx, { dir: repoWin(), command: 'x' }), 0)
  })
  test('Devin hỏng NGAY LÚC up (chưa tạo/đánh thức gì) mà sổ còn máy cũ không ngủ hỏi được ⇒ vẫn trả mã của lệnh (không đòi những gì job chưa làm)', async () => {
    const api = fakeApi()
    const { ctx, runs } = jobCtx({ api, exit: 0 })
    const repo = repoWin()
    await seedVm(ctx, api, repo, 'windows', 'suspended')
    api.fail = (r) => (r.method === 'GET' ? new Response('{}', { status: 429 }) : null) // hạn mức: getSession lỗi cả ở up lẫn lúc ngủ
    const said = []
    assert.equal(await D.runJob(ctx, { dir: repo, command: 'x', say: (s) => said.push(s) }), 0)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].env.DEVIN_VM_RUNNER, 'local')
  })
  // ---- lease độc quyền theo máy: hai job cùng dự án không được dẫm lên nhau ----
  const JOB_CMDLINE = 'node C:/Users/x/.claude/hooks/devin-vm.mjs job --dir D -- node qa.mjs'
  const leaseKeyFor = async (ctx, repo, osName = 'windows') => D.leaseKey(D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, osName))
  const leaseOf = async (ctx, repo, osName) => D.readRegistry(ctx)[await leaseKeyFor(ctx, repo, osName)]
  test('hai job cùng dự án: job thứ hai CHỜ (báo một dòng) tới khi job đầu ngủ máy + nhả lease rồi mới up/sync/chạy; một máy duy nhất; cuối cùng không còn lease', async () => {
    const events = []
    let aStarted
    const aStartedP = new Promise((r) => { aStarted = r })
    let bWaiting
    const bWaitingP = new Promise((r) => { bWaiting = r })
    let j = null
    j = jobCtx({
      cmdline: async () => JOB_CMDLINE,
      during: async (proc, api) => {
        const cmd = j.runs.at(-1).command
        events.push(`start ${cmd} đã-ngủ=${api.sleeps().length}`)
        if (cmd === 'a') { aStarted(); await Promise.race([bWaitingP, new Promise((r) => setTimeout(r, 3000))]) } // job A giữ máy cho tới khi job B báo đang chờ (quá 3 giây thật mà B không chờ ⇒ để test tự đỏ chứ không treo)
        events.push(`end ${cmd}`)
      },
    })
    const base = j.ctx.sleep
    j.ctx.sleep = async (ms) => { await base(ms); if (ms === 5000) await new Promise((r) => setTimeout(r, 5)) } // nhường thời gian thật cho job A
    const repo = repoWin()
    const saidB = []
    const pA = D.runJob(j.ctx, { dir: repo, command: 'a' })
    await aStartedP
    assert.equal((await leaseOf(j.ctx, repo)).pid, j.ctx.pid, 'A đang giữ lease')
    const pB = D.runJob(j.ctx, { dir: repo, command: 'b', say: (s) => { saidB.push(s); if (/đang chờ máy ảo/i.test(s)) bWaiting() } })
    assert.deepEqual(await Promise.all([pA, pB]), [0, 0])
    assert.deepEqual(events, ['start a đã-ngủ=0', 'end a', 'start b đã-ngủ=1', 'end b'])
    assert.equal(saidB.filter((s) => /Đang chờ máy ảo của dự án đang bận/.test(s)).length, 1, 'báo chờ đúng một dòng')
    assert.equal(j.api.posts().length, 1, 'B dùng lại máy của A, không tạo máy thứ hai')
    assert.equal(j.api.sleeps().length, 2)
    assert.equal(suspendedCount(j.api), 1)
    assert.deepEqual(Object.keys(D.readRegistry(j.ctx)).filter((k) => k.startsWith('lease|')), [], 'không còn lease')
  })
  test('lease của tiến trình đã chết, hoặc pid bị tiến trình khác mượn lại (cmdline lạ) ⇒ không chặn: job vào ngay, không báo chờ', async () => {
    for (const [name, over] of [['pid chết', { pidAlive: () => false, cmdline: async () => null }], ['pid bị mượn', { pidAlive: (p) => p === 777 || p === 9001, cmdline: async (p) => (p === 777 ? 'chrome.exe --type=renderer' : null) }]]) {
      const j = jobCtx({ exit: 0, ...over })
      const repo = repoWin()
      const info = await D.projectInfo(j.ctx, repo)
      await D.updateRegistry(j.ctx, (reg) => { reg[D.leaseKey(D.projectKey(j.ctx, info.root, 'windows'))] = { pid: 777, token: 'cu', at: 'x' } })
      const said = []
      assert.equal(await D.runJob(j.ctx, { dir: repo, command: 'x', say: (s) => said.push(s) }), 0, name)
      assert.ok(!said.some((s) => /đang chờ/i.test(s)), name)
      assert.equal(j.runs.length, 1, name)
      assert.equal(await leaseOf(j.ctx, repo), undefined, `${name}: lease đã nhả`)
    }
  })
  test('máy bận quá 20 phút ⇒ job KHÔNG đụng máy (không up, không sleep, không xoá lease của người khác), chạy lệnh trên máy bạn với mã của lệnh', async () => {
    const j = jobCtx({ exit: 0, pidAlive: (p) => p === 777, cmdline: async () => JOB_CMDLINE })
    const repo = repoWin()
    const info = await D.projectInfo(j.ctx, repo)
    const key = D.leaseKey(D.projectKey(j.ctx, info.root, 'windows'))
    await D.updateRegistry(j.ctx, (reg) => { reg[key] = { pid: 777, token: 'khac', at: 'x' } })
    const said = []
    const t0 = j.ctx.now()
    assert.equal(await D.runJob(j.ctx, { dir: repo, command: 'x', say: (s) => said.push(s) }), 0)
    assert.ok(j.ctx.now() - t0 >= 20 * 60_000, 'chờ đủ 20 phút (đồng hồ giả)')
    assert.ok(said.some((s) => /vẫn bận sau 20 phút/.test(s)))
    assert.equal(j.runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.equal(j.api.posts().length, 0)
    assert.equal(j.api.mcpCalls().length, 0)
    assert.equal(D.readRegistry(j.ctx)[key].token, 'khac', 'lease của người khác còn nguyên')
  })
  test('Ctrl+C trong lúc đang chờ máy ⇒ thôi chờ, mã 130, không up, không sleep, không chạm lease của người khác', async () => {
    const j = jobCtx({ exit: 0, pidAlive: (p) => p === 777, cmdline: async () => JOB_CMDLINE })
    const repo = repoWin()
    const info = await D.projectInfo(j.ctx, repo)
    const key = D.leaseKey(D.projectKey(j.ctx, info.root, 'windows'))
    await D.updateRegistry(j.ctx, (reg) => { reg[key] = { pid: 777, token: 'khac', at: 'x' } })
    const base = j.ctx.sleep
    let n = 0
    j.ctx.sleep = async (ms) => { await base(ms); if (ms === 5000 && ++n === 2) j.proc.emit('SIGINT', 'SIGINT') }
    assert.equal(await D.runJob(j.ctx, { dir: repo, command: 'x' }), 130)
    assert.equal(j.runs.length, 0)
    assert.equal(j.api.posts().length, 0)
    assert.equal(j.api.mcpCalls().length, 0)
    assert.equal(D.readRegistry(j.ctx)[key].token, 'khac')
    assert.equal(j.proc.listenerCount('SIGINT') + j.proc.listenerCount('SIGTERM'), 0)
  })
  test('sleep thủ công: còn lease SỐNG của tiến trình khác ⇒ không cho ngủ (một dòng, mã 1), --force thì ngủ; lease chết hoặc của chính mình thì ngủ bình thường', async () => {
    const lines = { 777: JOB_CMDLINE }
    const { ctx, api } = mkCtx({ pidAlive: (p) => p in lines, cmdline: async (p) => lines[p] ?? null })
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    const key = D.leaseKey(D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, 'linux'))
    await D.updateRegistry(ctx, (reg) => { reg[key] = { pid: 777, token: 'khac', at: 'x' } })
    const r = await D.sleepProject(ctx, { dir: repo })
    assert.deepEqual([r.ok, r.busy, r.status, r.id], [false, true, 'busy', id])
    assert.equal(api.sleeps().length, 0)
    assert.equal(api.sessions.get(id).status, 'running')
    // CLI: một dòng ra stderr, mã 1, nhắc --force; JSON vẫn một dòng ra stdout
    const o = sink()
    const e = sink()
    assert.equal(await main(['sleep', '--dir', repo], { ctx, stdout: o, stderr: e }), 1)
    assert.equal(e.text().trim().split('\n').length, 1)
    assert.match(e.text(), /job khác đang dùng.*--force/)
    assert.equal(JSON.parse(o.text()).busy, true)
    assert.equal(api.sleeps().length, 0)
    assert.equal(await main(['sleep', '--force', '--dir', repo], { ctx, stdout: sink(), stderr: sink() }), 0)
    assert.equal(api.sessions.get(id).status, 'suspended')
    // lease chết ⇒ ngủ được không cần --force
    api.sessions.get(id).status = 'running'
    delete lines[777]
    assert.equal((await D.sleepProject(ctx, { dir: repo })).status, 'suspended')
    // lease của chính job này (token khớp) ⇒ ngủ được
    api.sessions.get(id).status = 'running'
    lines[777] = JOB_CMDLINE
    assert.equal((await D.sleepProject(ctx, { dir: repo, lease: 'khac' })).status, 'suspended')
  })
  test('sleep thủ công GIỮ lease suốt lúc cho ngủ (job vào giữa chừng phải chờ, không bị cho ngủ dưới chân); xong thì nhả; --force không cướp lease của job', async () => {
    const SLEEP_CMDLINE = 'node C:/Users/x/.claude/hooks/devin-vm.mjs sleep --dir D'
    const lines = {}
    const { ctx, api } = mkCtx({ pidAlive: (p) => p === process.pid || p in lines, cmdline: async (p) => (p === process.pid ? SLEEP_CMDLINE : lines[p] ?? null) })
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    const key = D.leaseKey(D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, 'linux'))
    let during = null
    let jobSaw = null
    api.fail = (rec) => {
      let action = null
      try { action = JSON.parse(rec.body ?? 'null')?.params?.arguments?.action } catch { action = null }
      if (rec.host === 'mcp.devin.ai' && action === 'sleep' && !during) {
        during = D.readRegistry(ctx)[key] ?? 'không có'
        jobSaw = during !== 'không có' && during.pid === ctx.pid ? 'phải chờ' : 'vào được'
      }
      return null
    }
    assert.equal((await D.sleepProject(ctx, { dir: repo })).status, 'suspended')
    assert.equal(during?.pid, ctx.pid, 'lease do chính lệnh sleep giữ trong lúc cho ngủ')
    assert.equal(jobSaw, 'phải chờ')
    assert.equal(D.readRegistry(ctx)[key], undefined, 'xong thì nhả lease')
    // --force khi job khác đang giữ: cho ngủ nhưng KHÔNG ghi đè lease của job đó
    lines[777] = JOB_CMDLINE
    api.sessions.get(id).status = 'running'
    await D.updateRegistry(ctx, (reg) => { reg[key] = { pid: 777, token: 'khac', at: 'x' } })
    assert.equal((await D.sleepProject(ctx, { dir: repo, force: true })).status, 'suspended')
    assert.equal(D.readRegistry(ctx)[key].token, 'khac')
    // lease của một lệnh sleep khác còn sống cũng chặn (job / sleep khác thấy máy đang bận)
    lines[778] = SLEEP_CMDLINE
    api.sessions.get(id).status = 'running'
    await D.updateRegistry(ctx, (reg) => { reg[key] = { pid: 778, token: 'ngu', at: 'x' } })
    assert.equal((await D.sleepProject(ctx, { dir: repo })).busy, true)
  })
  test('vmClient (mac-check) giữ lease từ up tới sleep: sleep/job khác thấy máy bận; sleep xong thì nhả (Grok lượt 3)', async () => {
    const MAC_CMDLINE = 'node C:/Users/x/.claude/hooks/mac-check.mjs'
    const { ctx, api } = mkCtx({ pidAlive: (p) => p === process.pid, cmdline: async (p) => (p === process.pid ? MAC_CMDLINE : null) })
    const repo = mkRepo()
    const key = D.leaseKey(D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, 'macos'))
    const vm = D.vmClient(ctx, { dir: repo, os: 'macos', noRepos: true })
    const { id } = await vm.up(() => {})
    assert.equal(D.readRegistry(ctx)[key]?.pid, ctx.pid, 'mac-check giữ lease suốt lúc chạy')
    const other = await D.sleepProject(ctx, { dir: repo, os: 'macos' }) // một lệnh sleep / job khác lúc mac-check đang chạy
    assert.equal(other.busy, true, 'lease của mac-check được coi là còn sống')
    assert.equal(api.sessions.get(id).status, 'running')
    const s = await vm.sleep(() => {})
    assert.equal(s.status, 'suspended')
    assert.equal(D.readRegistry(ctx)[key], undefined, 'sleep xong thì nhả')
  })
  test('vmClient: job khác giữ máy quá 20 phút ⇒ up báo Devin không dùng được, sleep KHÔNG đụng máy / lease của job kia', async () => {
    const lines = { 777: JOB_CMDLINE }
    const { ctx, api } = mkCtx({ pidAlive: (p) => p in lines, cmdline: async (p) => lines[p] ?? null })
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'macos')
    const key = D.leaseKey(D.projectKey(ctx, (await D.projectInfo(ctx, repo)).root, 'macos'))
    await D.updateRegistry(ctx, (reg) => { reg[key] = { pid: 777, token: 'khac', at: 'x' } })
    const vm = D.vmClient(ctx, { dir: repo, os: 'macos', noRepos: true })
    await assert.rejects(vm.up(() => {}), (e) => e instanceof D.DevinUnavailable && /bận/.test(e.message))
    const s = await vm.sleep(() => {})
    assert.equal(s.ok, true)
    assert.equal(api.sleeps().length, 0)
    assert.equal(api.sessions.get(id).status, 'running')
    assert.equal(D.readRegistry(ctx)[key].token, 'khac')
  })
  test('status --all không liệt kê lease như một máy', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    await D.updateRegistry(ctx, (reg) => { reg[D.leaseKey(Object.keys(reg)[0])] = { pid: 1, token: 't', at: 'x' } })
    const s = await D.statusOf(ctx, { all: true })
    assert.deepEqual(s.vms.map((v) => v.id), [id])
  })
  // ---- phanh hạn mức ngày ----
  test('hạn mức ngày < 20% ⇒ job chạy lệnh trên máy bạn với mã của lệnh; không tạo máy, không chạm Devin ngoài việc hỏi hạn mức', async () => {
    const api = fakeApi()
    api.plan = quotaPlan(15)
    const j = jobCtx({ api, exit: 7 })
    const said = []
    assert.equal(await D.runJob(j.ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 7)
    assert.equal(j.runs.length, 1)
    assert.equal(j.runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.equal(api.posts().length, 0)
    assert.equal(api.mcpCalls().length, 0)
    assert.ok(said.some((s) => /Devin còn 15% hạn mức hôm nay \(dưới 20%\)/.test(s)))
    // thiếu trường ⇒ 0 ⇒ chặn
    const api0 = fakeApi()
    api0.plan = quotaPlan(undefined)
    const j0 = jobCtx({ api: api0, exit: 0 })
    assert.equal(await D.runJob(j0.ctx, { dir: repoWin(), command: 'x' }), 0)
    assert.equal(j0.runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.equal(api0.posts().length, 0)
  })
  test('hạn mức tụt xuống dưới 20% giữa lúc where và up ⇒ up chặn TRƯỚC khi tạo máy (không touched): job chạy máy bạn, mã của lệnh, không đòi máy ngủ', async () => {
    const api = fakeApi()
    api.quotaReply = quotaReplies(80, 15)
    const j = jobCtx({ api, exit: 3 })
    const said = []
    assert.equal(await D.runJob(j.ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 3)
    assert.equal(j.runs.length, 1)
    assert.equal(j.runs[0].env.DEVIN_VM_RUNNER, 'local')
    assert.equal(api.posts().length, 0)
    assert.equal(api.mcpCalls().length, 0)
    assert.ok(said.some((s) => /Devin không dùng được \(Devin còn 15%/.test(s)))
  })
  test('đủ hạn mức (20 hoặc hơn) ⇒ job đi tiếp trên máy ảo; lỗi hỏi hạn mức không chặn', async () => {
    for (const reply of [quotaReplies(20), () => new Response('{}', { status: 500 })]) {
      const api = fakeApi()
      api.quotaReply = reply
      const j = jobCtx({ api, exit: 0 })
      assert.equal(await D.runJob(j.ctx, { dir: repoWin(), command: 'x' }), 0)
      assert.equal(j.runs[0].env.DEVIN_VM_RUNNER, 'devin')
      assert.equal(suspendedCount(api), 1)
    }
  })
  test('log của job: hai cột cuối = % ngày TRƯỚC up và SAU khi cho ngủ; chưa biết ⇒ "-"; khoá không vào log / stdout / stderr', async () => {
    const api = fakeApi()
    api.quotaReply = quotaReplies(80, 80, 76) // where · trước up · sau sleep
    const j = jobCtx({ api, exit: 0 })
    const o = sink()
    const e = sink()
    assert.equal(await main(['job', '--dir', repoWin(), '--', 'node qa.mjs'], { ctx: j.ctx, stdout: o, stderr: e }), 0)
    assert.equal(api.quotaCalls().length, 3)
    const last = (c) => fs.readFileSync(c.logFile, 'utf8').trim().split('\n').at(-1)
    assert.match(last(j.ctx), /\tjob\t-\t\d+\t0\t80\t76$/)
    assert.ok(!/KEYSECRET|devin-session-token/.test(fs.readFileSync(j.ctx.logFile, 'utf8') + o.text() + e.text()))
    const api2 = fakeApi()
    api2.quotaReply = () => new Response('{}', { status: 500 })
    const j2 = jobCtx({ api: api2, exit: 0 })
    assert.equal(await main(['job', '--dir', repoWin(), '--', 'x'], { ctx: j2.ctx, stdout: sink(), stderr: sink() }), 0)
    assert.match(last(j2.ctx), /\tjob\t-\t\d+\t0\t-\t-$/)
    // bị phanh ⇒ chạy máy bạn, cột đầu là số đo lúc chặn
    const api3 = fakeApi()
    api3.plan = quotaPlan(15)
    const j3 = jobCtx({ api: api3, exit: 0 })
    assert.equal(await main(['job', '--dir', repoWin(), '--', 'x'], { ctx: j3.ctx, stdout: sink(), stderr: sink() }), 0)
    assert.match(last(j3.ctx), /\tjob\t-\t\d+\t0\t-\t-$/, 'where chặn từ đầu nên job chưa đo gì')
  })
  test('ping hỏng (MCP message trả 500) không làm hỏng job: vẫn chạy lệnh, vẫn cho máy ngủ, chỉ báo một dòng', async () => {
    const api = fakeApi()
    api.fail = (rec) => (rec.host === 'mcp.devin.ai' && JSON.parse(rec.body).method === 'tools/call' && JSON.parse(rec.body).params.arguments.action === 'message' ? new Response('{}', { status: 500 }) : null)
    const said = []
    const { ctx, runs } = jobCtx({ api, exit: 0 })
    assert.equal(await D.runJob(ctx, { dir: repoWin(), command: 'x', say: (s) => said.push(s) }), 0)
    assert.equal(runs.length, 1)
    assert.equal(suspendedCount(api), 1)
    assert.ok(said.some((s) => /Không ping giữ máy thức được/.test(s)))
  })
})

// ---------- CLI ----------
describe('CLI devin-vm.mjs', () => {
  test('tên file KHÔNG khớp mẫu file test mặc định của node --test', () => {
    assert.doesNotMatch('devin-vm.mjs', /^test[-.]|[-._]test\.[cm]?js$|^test\.[cm]?js$/)
  })
  test('parseArgs: cờ giá trị/bật-tắt, phần sau --, đối số vị trí; sai ⇒ UsageError', () => {
    assert.deepEqual(parseArgs(['run', '--dir', 'D', '--env', 'A,B', '--env=C', '--', 'npm', 'test']), { cmd: 'run', flags: { env: ['A', 'B', 'C'], dir: 'D' }, pos: [], rest: ['npm', 'test'] })
    assert.deepEqual(parseArgs(['put', 'a', 'b']).pos, ['a', 'b'])
    assert.equal(parseArgs(['forward', '--stop']).flags.stop, true)
    assert.equal(parseArgs(['-h']).help, true)
    for (const bad of [[], ['bogus'], ['up', '--os', 'beos'], ['up', '--bogus'], ['up', '--os'], ['run'], ['run', '--'], ['where', '--', 'x'], ['put', 'a'], ['forward'], ['forward', '--stop', '9'], ['run', '--timeout', '0', '--', 'x'], ['sync', '--full=1']]) {
      assert.throws(() => parseArgs(bad), D.UsageError, JSON.stringify(bad))
    }
  })
  test('--help dặn rõ: đầu ra dòng dài của run có thể bị bẻ dòng/chèn ESC ⇒ đừng parse stdout, dữ liệu lớn dùng get', async () => {
    const o = sink()
    assert.equal(await main(['--help'], { ctx: mkCtx().ctx, stdout: o, stderr: sink() }), 0)
    assert.match(o.text(), /run[\s\S]*bẻ dòng\/chèn ESC[\s\S]*đừng parse dữ liệu từ stdout[\s\S]*dữ liệu lớn ⇒ get/)
  })
  test('where in JSON một dòng, exit 0 kể cả khi chạy máy bạn', async () => {
    const { ctx } = mkCtx()
    const o = sink()
    assert.equal(await main(['where', '--dir', mkRepo({ 'package.json': '{"devDependencies":{"electron":"1"}}' })], { ctx, stdout: o, stderr: sink() }), 0)
    const j = JSON.parse(o.text())
    assert.deepEqual([j.runner, j.os], ['devin', 'windows'])
    assert.equal(o.text().trim().split('\n').length, 1)
  })
  test('exit 2 dùng sai (kèm dòng dùng) · exit 3 Devin không dùng được (kèm lệnh đăng nhập) · exit 1 lỗi công cụ', async () => {
    const e = sink()
    assert.equal(await main(['up', '--os', 'beos'], { ctx: mkCtx().ctx, stdout: sink(), stderr: e }), 2)
    assert.match(e.text(), /dùng: devin-vm\.mjs/)
    const { ctx } = mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co.toml') } })
    const e3 = sink()
    assert.equal(await main(['up', '--dir', mkRepo()], { ctx, stdout: sink(), stderr: e3 }), 3)
    assert.match(e3.text(), /chưa đăng nhập.*devin auth login/)
    const e1 = sink()
    assert.equal(await main(['sync', '--dir', fresh('khong-git')], { ctx: mkCtx().ctx, stdout: sink(), stderr: e1 }), 1)
    assert.match(e1.text(), /không nằm trong kho git/)
  })
  test('run: đầu ra máy ảo ra stdout, lỗi ra stderr, mã thoát của máy ảo là mã thoát của CLI; quá giờ ⇒ 124', async () => {
    const { ctx, api } = mkCtx({ handler: (rec) => (rec.script.includes('slow') ? { code: null, timedOut: true } : { code: 7, stdout: 'ra ngoài\n', stderr: 'lỗi ngầm\n' }) })
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    const o = sink()
    const e = sink()
    assert.equal(await main(['run', '--dir', repo, '--', 'exit', '7'], { ctx, stdout: o, stderr: e }), 7)
    assert.deepEqual([o.text(), e.text()], ['ra ngoài\n', 'lỗi ngầm\n'])
    assert.equal(await main(['run', '--dir', repo, '--', 'slow'], { ctx, stdout: sink(), stderr: sink() }), 124)
  })
  test('log: mỗi lệnh một dòng (giờ, lệnh, mã máy, ms, mã thoát; up/job thêm % ngày lúc đầu và lúc xong), KHÔNG có nội dung lệnh / khoá / đường dẫn', async () => {
    const { ctx, api } = mkCtx({ env: { MY_KEY: 'giatri-bi-mat-9999' } })
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    await main(['run', '--dir', repo, '--env', 'MY_KEY', '--', 'echo', 'NOIDUNGLENH'], { ctx, stdout: sink(), stderr: sink() })
    await main(['where', '--dir', repo], { ctx, stdout: sink(), stderr: sink() })
    const lines = fs.readFileSync(ctx.logFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\trun\\t${id}\\t\\d+\\t0$`), 'lệnh không đo hạn mức: giữ năm cột như cũ')
    assert.ok(!/NOIDUNGLENH|giatri-bi-mat|MY_KEY/.test(lines.join('\n')))
    D.appendLog(ctx, { cmd: 'a b;c', id: 'x y', ms: 1.6, code: 2 })
    assert.match(fs.readFileSync(ctx.logFile, 'utf8').trim().split('\n').at(-1), /\tabc\txy\t2\t2$/)
    D.appendLog(ctx, { cmd: 'up', id: 'x', ms: 5, code: 0, quota: { start: 81.4, end: 79 } })
    assert.match(fs.readFileSync(ctx.logFile, 'utf8').trim().split('\n').at(-1), /\tup\tx\t5\t0\t81\t79$/)
    D.appendLog(ctx, { cmd: 'up', id: 'x', ms: 5, code: 0, quota: { start: 'khoá-bí-mật;rm', end: null } })
    assert.match(fs.readFileSync(ctx.logFile, 'utf8').trim().split('\n').at(-1), /\t0\t-\t-$/, 'chỉ số mới vào log, chữ lạ thì "-"')
  })
  test('sleep/status/rm qua CLI: JSON một dòng; sleep không ngủ kịp ⇒ exit 1', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    const id = await seedVm(ctx, api, repo, 'linux')
    const o = sink()
    assert.equal(await main(['sleep', '--dir', repo], { ctx, stdout: o, stderr: sink() }), 0)
    assert.deepEqual(JSON.parse(o.text()), { ok: true, status: 'suspended', id, os: 'linux' })
    const s = sink()
    await main(['status', '--dir', repo], { ctx, stdout: s, stderr: sink() })
    assert.equal(JSON.parse(s.text()).vms[0].status, 'suspended')
    const r = sink()
    assert.equal(await main(['rm', '--dir', repo], { ctx, stdout: r, stderr: sink() }), 0)
    assert.equal(JSON.parse(r.text()).removed, id)
  })
})

// ---------- phanh hạn mức: hạn mức NGÀY của Devin còn dưới 20% ⇒ chạy máy user (sổ chốt h18z) ----------
describe('phanh hạn mức ngày', () => {
  const KEY = 'devin-session-token$KEYSECRET123456'
  const RESET_ISO = new Date(QUOTA_RESET * 1000).toISOString()
  const RESET_VN = new Date(QUOTA_RESET * 1000 + 7 * 3600_000).toISOString().slice(11, 16) // giờ Việt Nam = UTC+7
  const withPlan = (plan, over) => { const m = mkCtx(over); m.api.plan = plan; return m }
  const SUFFIX = `, hồi lúc ${RESET_VN} — chạy trên máy bạn`

  test('quotaStatus: POST đúng địa chỉ, header và thân như Devin CLI; đọc % ngày, % tuần, giờ hồi; khoá chỉ nằm trong thân (không header Authorization)', async () => {
    const { ctx, api, warns } = withPlan(quotaPlan(15))
    assert.deepEqual(await D.quotaStatus(ctx), { known: true, daily: 15, weekly: 47, resetAt: RESET_ISO })
    const [c, ...more] = api.quotaCalls()
    assert.equal(more.length, 0)
    assert.equal(c.method, 'POST')
    assert.equal(c.url, 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus')
    assert.equal(c.headers['content-type'], 'application/json')
    assert.equal(c.headers['connect-protocol-version'], '1')
    assert.ok(!Object.keys(c.headers).some((h) => /^authorization$/i.test(h)))
    assert.deepEqual(JSON.parse(c.body), { metadata: { apiKey: KEY, ideName: 'devin-cli', ideVersion: '3000.11.238', extensionVersion: '3000.11.238' } })
    assert.ok(c.signal, 'có hạn 5 giây')
    assert.ok(c.manual, 'không theo chuyển hướng (POST kèm khoá sẽ bị gửi sang nơi khác)')
    assert.deepEqual(warns, [])
  })
  test('thiếu % ngày ⇒ 0 (proto3 bỏ số 0); số dạng chữ nhận được; ngoài 0–100 bị kẹp; planStatus rỗng thì KHÔNG đoán', async () => {
    assert.deepEqual(await D.quotaStatus(withPlan(quotaPlan(undefined)).ctx), { known: true, daily: 0, weekly: 47, resetAt: RESET_ISO })
    assert.equal((await D.quotaStatus(withPlan(quotaPlan('15')).ctx)).daily, 15)
    assert.equal((await D.quotaStatus(withPlan(quotaPlan(150)).ctx)).daily, 100)
    assert.equal((await D.quotaStatus(withPlan(quotaPlan(-3)).ctx)).daily, 0)
    const noWeekly = withPlan({ dailyQuotaRemainingPercent: 60, dailyQuotaResetAtUnix: String(QUOTA_RESET) })
    assert.deepEqual(await D.quotaStatus(noWeekly.ctx), { known: true, daily: 60, weekly: 0, resetAt: RESET_ISO })
    const empty = withPlan({})
    assert.equal((await D.quotaStatus(empty.ctx)).known, false)
    assert.equal(empty.warns.length, 1)
  })
  test('lỗi mạng / quá 5 giây / 401 / 5xx / chuyển hướng / sai dạng ⇒ "chưa biết", KHÔNG chặn, đúng một dòng cảnh báo và không lộ khoá', async () => {
    const BAD = {
      'lỗi mạng': () => new TypeError('fetch failed'),
      'quá 5 giây': () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      '401': () => new Response('{}', { status: 401 }),
      '500': () => new Response('{}', { status: 500 }),
      'chuyển hướng 307': () => new Response(null, { status: 307, headers: { location: 'https://evil.example.com/x' } }),
      'không phải JSON': () => new Response('<html>', { status: 200 }),
      'thiếu userStatus': () => json(200, {}),
      'planStatus không phải object': () => json(200, { userStatus: { planStatus: 'x' } }),
    }
    for (const [name, reply] of Object.entries(BAD)) {
      const m = mkCtx()
      m.api.quotaReply = reply
      assert.deepEqual(await D.quotaStatus(m.ctx), { known: false, daily: null, weekly: null, resetAt: null }, name)
      assert.equal(m.warns.length, 1, name)
      assert.ok(!/\n/.test(m.warns[0]) && !/KEYSECRET|Bearer/.test(m.warns[0]), name)
      const w = await D.where(m.ctx, { dir: mkRepo() })
      assert.equal(w.runner, 'devin', `${name}: không biết thì không chặn`)
    }
  })
  test('chưa đăng nhập ⇒ chưa biết, êm (không cảnh báo, không gọi mạng)', async () => {
    const m = mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co.toml') } })
    assert.equal((await D.quotaStatus(m.ctx)).known, false)
    assert.deepEqual([m.warns, m.api.calls.length], [[], 0])
  })
  test('khoá CHỈ gửi tới https + host codeium.com / windsurf.com / devin.ai; host lạ, http, tên giả (codeium.com.evil.org) ⇒ không gửi gì, chưa biết', async () => {
    for (const server of ['https://evil.example.com', 'http://server.codeium.com', 'https://codeium.com.evil.org', 'https://notcodeium.com', 'https://server.codeium.com@evil.example.com', 'ftp://server.codeium.com', 'không-phải-url']) {
      const m = mkCtx({ server })
      assert.equal((await D.quotaStatus(m.ctx)).known, false, server)
      assert.equal(m.api.calls.length, 0, `${server}: không request nào được gửi đi`)
      assert.equal(m.warns.length, 1, server)
      assert.ok(!/KEYSECRET/.test(m.warns[0]), server)
    }
    for (const [server, want] of [['https://server.codeium.com/', 'https://server.codeium.com/exa'], ['https://windsurf.com', 'https://windsurf.com/exa'], ['https://a.b.windsurf.com:443', 'https://a.b.windsurf.com/exa'], ['https://codeium.com', 'https://codeium.com/exa'], ['https://api.devin.ai', 'https://api.devin.ai/exa'], [null, 'https://server.codeium.com/exa']]) {
      const m = mkCtx({ server })
      assert.equal((await D.quotaStatus(m.ctx)).known, true, String(server))
      assert.ok(m.api.quotaCalls()[0].url.startsWith(want), `${server} ⇒ ${m.api.quotaCalls()[0]?.url}`)
    }
  })
  test('ngưỡng 20: 0, 15, 19 chặn; đúng 20 và hơn thì đi tiếp; DEVIN_VM_MIN_DAILY đổi ngưỡng, giá trị rác ⇒ 20', async () => {
    const repo = mkRepo()
    for (const [daily, env, blocked] of [[0, {}, true], [15, {}, true], [19, {}, true], [20, {}, false], [21, {}, false], [100, {}, false], [40, { DEVIN_VM_MIN_DAILY: '50' }, true], [60, { DEVIN_VM_MIN_DAILY: '50' }, false], [15, { DEVIN_VM_MIN_DAILY: '10' }, false], [15, { DEVIN_VM_MIN_DAILY: 'rác' }, true], [25, { DEVIN_VM_MIN_DAILY: 'rác' }, false]]) {
      const m = withPlan(quotaPlan(daily), { env })
      assert.equal((await D.where(m.ctx, { dir: repo })).runner, blocked ? 'local' : 'devin', `${daily} ${JSON.stringify(env)}`)
    }
  })
  test('where dưới ngưỡng: {runner:"local", reason:"Devin còn X% hạn mức hôm nay (dưới 20%), hồi lúc HH:MM — chạy trên máy bạn"} (giờ VN); thiếu trường ⇒ còn 0%; qua CLI cũng vậy', async () => {
    const repo = mkRepo()
    const m = withPlan(quotaPlan(15))
    const w = await D.where(m.ctx, { dir: repo })
    assert.deepEqual([w.runner, w.os, w.reason], ['local', 'linux', `Devin còn 15% hạn mức hôm nay (dưới 20%)${SUFFIX}`])
    const z = withPlan(quotaPlan(undefined))
    assert.equal((await D.where(z.ctx, { dir: repo })).reason, `Devin còn 0% hạn mức hôm nay (dưới 20%)${SUFFIX}`)
    const o = sink()
    assert.equal(await main(['where', '--dir', repo], { ctx: m.ctx, stdout: o, stderr: sink() }), 0)
    assert.deepEqual(JSON.parse(o.text()), { runner: 'local', os: 'linux', reason: `Devin còn 15% hạn mức hôm nay (dưới 20%)${SUFFIX}` })
    const ok = withPlan(quotaPlan(20))
    assert.equal((await D.where(ok.ctx, { dir: repo })).runner, 'devin')
    const env20 = withPlan(quotaPlan(15), { env: { DEVIN_VM_MIN_DAILY: '10' } })
    assert.equal((await D.where(env20.ctx, { dir: repo })).runner, 'devin')
    assert.match((await D.where(withPlan(quotaPlan(15), { env: { DEVIN_VM_MIN_DAILY: '30' } }).ctx, { dir: repo })).reason, /\(dưới 30%\)/)
  })
  test('where: các lý do khác (tắt, cần máy thật, chưa đăng nhập) vẫn đứng trước và KHÔNG hỏi hạn mức', async () => {
    const repo = mkRepo()
    write(path.join(repo, '.claude', 'devin.json'), JSON.stringify({ local: ['gpu'] }))
    const m = withPlan(quotaPlan(5))
    assert.match((await D.where(m.ctx, { dir: repo, need: 'gpu' })).reason, /cần máy thật: gpu/)
    assert.equal(m.api.quotaCalls().length, 0)
  })
  test('up dưới ngưỡng ⇒ DevinUnavailable(quota) TRƯỚC khi tạo / đánh thức: không POST tạo máy, không ssh, sổ không đổi, không cờ touched; máy cũ đang ngủ vẫn ngủ', async () => {
    const m = withPlan(quotaPlan(15))
    const repo = mkRepo()
    await assert.rejects(D.up(m.ctx, { dir: repo }), (e) => e instanceof D.DevinUnavailable && e.kind === 'quota' && !e.touched && e.message === `Devin còn 15% hạn mức hôm nay (dưới 20%)${SUFFIX}`)
    assert.equal(m.api.posts().length, 0)
    assert.equal(m.ssh.calls.length, 0)
    assert.deepEqual(D.readRegistry(m.ctx), {})
    const repo2 = mkRepo()
    const id = await seedVm(m.ctx, m.api, repo2, 'linux', 'suspended')
    await assert.rejects(D.up(m.ctx, { dir: repo2 }), /Devin còn 15%/)
    assert.equal(m.ssh.calls.length, 0, 'không đánh thức')
    assert.equal(m.api.sessions.get(id).status, 'suspended')
    // CLI: exit 3 như mọi lý do "Devin không dùng được"
    const e = sink()
    assert.equal(await main(['up', '--dir', repo], { ctx: m.ctx, stdout: sink(), stderr: e }), 3)
    assert.match(e.text(), /Devin còn 15% hạn mức hôm nay/)
    // đủ 20% ⇒ đi tiếp và tạo máy bình thường
    m.api.plan = quotaPlan(20)
    assert.equal((await D.up(m.ctx, { dir: repo })).created, true)
  })
  test('KHÔNG kiểm ở sleep / rm / run / put / status: dưới ngưỡng vẫn làm được việc dọn và việc đang dở', async () => {
    const m = withPlan(quotaPlan(5), { handler: (rec) => (/devinvm-ready/.test(rec.command) ? null : { code: 0, stdout: '@@DEVINVM@@ size 2\n' }) })
    const repo = mkRepo()
    await seedVm(m.ctx, m.api, repo, 'linux')
    assert.equal((await D.runProject(m.ctx, { dir: repo, command: 'echo 1' })).code, 0)
    const f = path.join(fresh('up'), 'a.txt')
    write(f, 'ab')
    assert.equal((await D.putFile(m.ctx, { dir: repo, local: f, remote: 'x' })).ok, true)
    assert.equal((await D.sleepProject(m.ctx, { dir: repo })).status, 'suspended')
    assert.equal((await D.removeVm(m.ctx, { dir: repo })).ok, true)
    assert.equal(m.api.quotaCalls().length, 0)
  })
  test('status và status --all có "quota":{daily, weekly, resetAt}; chưa biết ⇒ null hết; chưa đăng nhập ⇒ null và không gọi mạng; status không chặn gì', async () => {
    const m = withPlan(quotaPlan(15))
    const repo = mkRepo()
    await seedVm(m.ctx, m.api, repo, 'linux')
    const want = { daily: 15, weekly: 47, resetAt: RESET_ISO }
    assert.deepEqual((await D.statusOf(m.ctx, { dir: repo })).quota, want)
    assert.deepEqual((await D.statusOf(m.ctx, { all: true })).quota, want)
    const o = sink()
    assert.equal(await main(['status', '--dir', repo], { ctx: m.ctx, stdout: o, stderr: sink() }), 0)
    assert.deepEqual(JSON.parse(o.text()).quota, want)
    assert.equal(JSON.parse(o.text()).vms.length, 1)
    const unk = mkCtx()
    unk.api.quotaReply = () => new Response('{}', { status: 500 })
    await seedVm(unk.ctx, unk.api, repo, 'linux')
    assert.deepEqual((await D.statusOf(unk.ctx, { dir: repo })).quota, { daily: null, weekly: null, resetAt: null })
    const off = mkCtx({ env: { DEVIN_CREDENTIALS: path.join(ROOT, 'khong-co.toml') }, stateDir: m.ctx.stateDir })
    assert.deepEqual((await D.statusOf(off.ctx, { all: true })).quota, { daily: null, weekly: null, resetAt: null })
    assert.equal(off.api.calls.length, 0)
  })
  test('log của up: hai cột cuối = % ngày lúc bắt đầu và lúc xong; chưa biết ⇒ "-"; bị phanh ⇒ chỉ có cột đầu; khoá không bao giờ vào log / stdout / stderr', async () => {
    const m = mkCtx()
    m.api.quotaReply = quotaReplies(80, 78)
    const repo = mkRepo()
    const o = sink()
    const e = sink()
    assert.equal(await main(['up', '--dir', repo], { ctx: m.ctx, stdout: o, stderr: e }), 0)
    const lines = () => fs.readFileSync(m.ctx.logFile, 'utf8').trim().split('\n')
    assert.match(lines().at(-1), /\tup\tdevin-new\w+\t\d+\t0\t80\t78$/)
    assert.equal(m.api.quotaCalls().length, 2)
    const unk = mkCtx()
    unk.api.quotaReply = () => new Response('{}', { status: 500 })
    assert.equal(await main(['up', '--dir', mkRepo()], { ctx: unk.ctx, stdout: sink(), stderr: sink() }), 0)
    assert.match(fs.readFileSync(unk.ctx.logFile, 'utf8').trim().split('\n').at(-1), /\t0\t-\t-$/)
    const blocked = withPlan(quotaPlan(15))
    assert.equal(await main(['up', '--dir', mkRepo()], { ctx: blocked.ctx, stdout: sink(), stderr: sink() }), 3)
    assert.match(fs.readFileSync(blocked.ctx.logFile, 'utf8').trim().split('\n').at(-1), /\tup\t-\t\d+\t3\t15\t-$/)
    for (const text of [fs.readFileSync(m.ctx.logFile, 'utf8'), fs.readFileSync(blocked.ctx.logFile, 'utf8'), o.text(), e.text()]) assert.ok(!/KEYSECRET|devin-session-token/.test(text))
  })
})

// ---------- không nuốt lỗi lạ (luật ai-catch-swallow-error) ----------
describe('bỏ qua đúng lỗi mong đợi, lỗi lạ không biến mất', () => {
  test('appendLog: không ghi được log thì KHÔNG làm hỏng lệnh nhưng để lại một dòng ở stderr', () => {
    const { ctx, dir } = mkCtx()
    const blocker = path.join(dir, 'la-file')
    write(blocker, 'x')
    ctx.logFile = path.join(blocker, 'con', 'devin-vm.log') // cha là FILE ⇒ mkdir lỗi
    const lines = []
    const orig = process.stderr.write
    process.stderr.write = (s) => { lines.push(String(s)); return true }
    try {
      D.appendLog(ctx, { cmd: 'run', id: 'x', ms: 1, code: 0 })
    } finally {
      process.stderr.write = orig
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /devin-vm: không ghi được hooks\/devin-vm\.log: \w+/)
  })
  test('--env: .env có mà không đọc được (là thư mục) ⇒ ToolError nêu tên file, không lộ gì khác; chưa có .env thì vẫn báo thiếu khoá như cũ', async () => {
    const { ctx, api } = mkCtx()
    const repo = mkRepo()
    await seedVm(ctx, api, repo, 'linux')
    await assert.rejects(D.runProject(ctx, { dir: repo, command: 'x', env: ['MY_KEY_X'] }), /Thiếu giá trị cho MY_KEY_X/)
    fs.mkdirSync(path.join(repo, '.env'))
    await assert.rejects(D.runProject(ctx, { dir: repo, command: 'x', env: ['MY_KEY_X'] }), (e) => e instanceof D.ToolError && /Không đọc được \.env/.test(e.message))
  })
  test('parseOrgId: JSON hỏng thì tìm chữ (SyntaxError được bỏ qua đúng chỗ)', () => {
    assert.equal(D.parseOrgId('{"org_id":"org-1"}'), 'org-1')
    assert.equal(D.parseOrgId('org_id = "org-2" (không phải JSON)'), 'org-2')
    assert.equal(D.parseOrgId('{hỏng'), null)
  })
})

// ---------- tiến trình thật ----------
describe('runProc', () => {
  test('mã thoát + stdout/stderr; stdin đóng (không treo); quá giờ ⇒ diệt và báo timedOut; lệnh không có ⇒ error.code', async () => {
    const r = await D.runProc(process.execPath, ['-e', 'process.stdout.write("ra");process.stderr.write("lỗi");process.exit(3)'])
    assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut], [3, 'ra', 'lỗi', false])
    const noStdin = await D.runProc(process.execPath, ['-e', 'process.stdin.on("end",()=>process.exit(0));process.stdin.resume()'], { timeout: 10_000 })
    assert.deepEqual([noStdin.code, noStdin.timedOut], [0, false])
    const slow = await D.runProc(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeout: 300 })
    assert.equal(slow.timedOut, true)
    assert.equal((await D.runProc('khong-co-lenh-nay-123', [])).error.code, 'ENOENT')
    const withInput = await D.runProc(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'vào' })
    assert.equal(withInput.stdout, 'vào')
  })
  test('cmdline của chính tiến trình này đọc được (bỏ qua nếu hệ không cho)', async (t) => {
    const c = await D.makeCtx().cmdline(process.pid)
    if (!c) return t.skip('không đọc được dòng lệnh tiến trình')
    assert.match(c, /node/i)
  })
})

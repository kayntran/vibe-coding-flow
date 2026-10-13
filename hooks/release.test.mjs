// Test cho hooks/release.mjs (CLI): node --test hooks/release.test.mjs
// Phần lớn chạy main() với `run`/`fetch` giả (không gọi Cloudflare/ssh thật); riêng cuối file có vài ca chạy tiến trình thật
// để kiểm dây nối với flow-gate/flow-check và spawnSync mảng tham số. Thư mục dự án có dấu cách + tiếng Việt.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, realRun } from './release.mjs'
import { readState, statePath, writeState } from './lib/release-state.mjs'

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HOOKS_DIR, 'release.mjs')
const NOW = Date.parse('2026-10-13T00:00:00.000Z')
const DAY = 86400000
const ID = '11111111-2222-3333-4444-555555555555'
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

function fixture({ wrangler = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release cli thử '))
  tmpDirs.push(root)
  const dir = path.join(root, 'ứng dụng')
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  if (wrangler) {
    put('node_modules/wrangler/package.json', JSON.stringify({ bin: { wrangler: 'bin/wrangler.js' } }))
    put('node_modules/wrangler/bin/wrangler.js', '')
  }
  put('node_modules/@playwright/test/package.json', JSON.stringify({ bin: { playwright: 'cli.js' } }))
  put('node_modules/@playwright/test/cli.js', '')
  put('wrangler.jsonc', '{ "name": "my-app" }')
  return {
    dir, root, put, logDir: path.join(root, 'logs'),
    wr: path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), pw: path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js'),
  }
}

// Chạy main() với đầu ra gom vào chuỗi. run giả ghi lại lời gọi.
async function cli(f, argv, { handler = () => ({}), fetch, env = {}, realClock = false } = {}) {
  let stdout = ''
  let stderr = ''
  const calls = []
  const world = { deployment: [{ version_id: OLD, percentage: 100 }] } // deployment Cloudflare giả của một lần chạy
  const run = (cmd, args, opts = {}) => {
    const kind = args[0] === f.wr ? `wrangler:${args[1]}` : args[0] === f.pw ? 'playwright'
      : args[0]?.endsWith?.('flow-gate.mjs') ? 'gate' : args[0]?.endsWith?.('flow-check.mjs') ? 'check' : args[0] === '-e' ? 'probe' : cmd
    const call = { cmd, args, opts, kind, world }
    calls.push(call)
    return { status: 0, stdout: '', stderr: '', error: null, ...handler(call) }
  }
  const code = await main(argv, {
    run, fetch, env, ...(realClock ? {} : { now: NOW }), sleep: () => {}, logDir: f.logDir, hooksDir: HOOKS_DIR,
    stdout: { write: (s) => { stdout += s } }, stderr: { write: (s) => { stderr += s } },
  })
  return { code, stdout, stderr, calls, kinds: () => calls.map((c) => c.kind) }
}
const OLD = '99999999-8888-7777-6666-555555555555'
const okHandler = (c) => {
  if (c.kind === 'git') return { stdout: 'abc1234\n' }
  if (c.kind === 'wrangler:versions') {
    if (c.args[2] === 'upload') return { stdout: `Worker Version ID: ${ID}\n` }
    c.world.deployment = c.args.filter((a) => /@\d+%$/.test(a)).map((s) => { const [version_id, p] = s.split('@'); return { version_id, percentage: parseInt(p, 10) } })
    return {}
  }
  if (c.kind === 'wrangler:deployments') return { stdout: `${JSON.stringify({ id: 'd1', versions: c.world.deployment }, null, 2)}\n` }
  if (c.kind === 'probe') { // Cloudflare: header override chỉ trúng bản nằm trong deployment (đúng Worker); còn lại là bản đang 100%
    const m = /^([^=]+)="(.+)"$/.exec(JSON.parse(c.opts.env.PROBE_HEADERS || '{}')['Cloudflare-Workers-Version-Overrides'] ?? '')
    const version = m && c.world.deployment.some((v) => v.version_id === m[2]) ? m[2] : c.world.deployment.find((v) => v.percentage === 100)?.version_id
    return { stdout: `${JSON.stringify({ status: 200, version })}\n` }
  }
  if (c.args[0]?.endsWith('flow-gate.mjs')) return { stdout: 'pid: x\nreview: có\nqa: có\ntest: có\n' }
  if (c.args[0]?.endsWith('flow-check.mjs')) return { stdout: JSON.stringify({ results: [{ id: 'secret-build', status: 'pass' }] }) }
  return {}
}

// ---------- dùng sai ----------

test('help ⇒ exit 0 và liệt kê lệnh; không có lệnh ⇒ exit 1; lệnh/cờ lạ, thiếu giá trị ⇒ exit 1 kèm lý do trên stderr', async () => {
  const f = fixture()
  const h = await cli(f, ['--help'])
  assert.equal(h.code, 0)
  for (const w of ['preflight', 'cf', 'rollback', 'vps', 'logs']) assert.match(h.stdout, new RegExp(w))
  assert.equal((await cli(f, [])).code, 1)
  assert.match((await cli(f, ['xoa-het'])).stderr, /lệnh lạ/)
  assert.match((await cli(f, ['cf', '--dir', f.dir, '--force'])).stderr, /cờ lạ --force/)
  assert.match((await cli(f, ['cf', '--dir'])).stderr, /cần một giá trị/)
  assert.match((await cli(f, ['cf', '--dir', f.dir, 'thua'])).stderr, /đối số thừa/)
  assert.match((await cli(f, ['preflight', '--dir', f.dir, '--zap-exit', 'abc'])).stderr, /--zap-exit phải là số/)
  assert.match((await cli(f, ['logs', '--dir', f.dir, '--since', '5'])).stderr, /--since dạng/)
  assert.match((await cli(f, ['cf', '--dir', path.join(f.root, 'không-có'), '--url', 'https://a.example.com'])).stderr, /không thấy thư mục dự án/)
})

// ---------- preflight ----------

test('preflight: đủ điều kiện ⇒ exit 0; còn mục thiếu ⇒ exit 1 và liệt kê bằng lời; --zap-exit 1 chặn', async () => {
  const f = fixture()
  writeState(f.dir, { v: 1, rollbackTested: true, backup: { choice: 'off' } }, { logDir: f.logDir })
  const ok = await cli(f, ['preflight', '--dir', f.dir, '--zap-exit', '0'], { handler: okHandler })
  assert.equal(ok.code, 0, ok.stdout)
  assert.match(ok.stdout, /Đủ điều kiện phát hành/)
  const zap = await cli(f, ['preflight', '--dir', f.dir, '--zap-exit=1'], { handler: okHandler })
  assert.equal(zap.code, 1)
  assert.match(zap.stdout, /còn 1 mục[\s\S]*mức cao/)
  const bare = fixture()
  const r = await cli(bare, ['preflight', '--dir', bare.dir, '--has-data'], { handler: okHandler })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /còn 1 mục[\s\S]*sao lưu/)
  assert.doesNotMatch(r.stdout, /quay lại/, 'chưa phát hành lần nào ⇒ chưa đòi đã thử quay lại (K3)')
  const two = fixture()
  writeState(two.dir, { v: 1, releaseCount: 2, rollbackTested: false, backup: { choice: 'off' } }, { logDir: two.logDir })
  const late = await cli(two, ['preflight', '--dir', two.dir], { handler: okHandler })
  assert.equal(late.code, 1)
  assert.match(late.stdout, /còn 1 mục[\s\S]*thử quay lại/)
})

// ---------- cf / rollback ----------

test('cf: cờ --url/--worker/--message đi vào lệnh; thành công ⇒ exit 0 và release.json có lastRelease', async () => {
  const f = fixture()
  const r = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com', '--worker', 'worker-khac', '--message', 'bản thử', '--first-release', '--zap-exit', '2'], { handler: okHandler })
  assert.equal(r.code, 0, r.stdout)
  assert.deepEqual(r.kinds(), ['gate', 'check', 'git', 'wrangler:versions', 'wrangler:deployments', 'wrangler:versions', 'probe', 'playwright', 'wrangler:deployments', 'wrangler:versions'])
  assert.match(r.stdout, /Cảnh báo: .*mức vừa/, 'zap-exit 2 ⇒ cảnh báo, không chặn')
  assert.deepEqual(r.calls[3].args.slice(1, 5), ['versions', 'upload', '--message', 'bản thử'])
  assert.deepEqual(r.calls[4].args.slice(1), ['deployments', 'status', '--json'])
  assert.deepEqual(r.calls[5].args.slice(1), ['versions', 'deploy', `${OLD}@100%`, `${ID}@0%`, '-y'], 'K2: bản mới vào deployment ở 0% trước khi thử nhanh')
  assert.equal(r.calls[6].opts.env.PROBE_URL, 'https://app.example.com', 'dò header bản trên địa chỉ thật trước khi thử nhanh')
  assert.deepEqual(JSON.parse(r.calls[6].opts.env.PROBE_HEADERS), { 'Cloudflare-Workers-Version-Overrides': `worker-khac="${ID}"` })
  assert.deepEqual(JSON.parse(r.calls[7].opts.env.SMOKE_EXTRA_HTTP_HEADERS), { 'Cloudflare-Workers-Version-Overrides': `worker-khac="${ID}"` })
  assert.deepEqual(r.calls[9].args.slice(1), ['versions', 'deploy', `${ID}@100%`, '-y'])
  const st = readState(f.dir, { logDir: f.logDir })
  assert.equal(st.lastRelease.version, ID)
  assert.equal(st.target, 'https://app.example.com', 'finding 3: địa chỉ vừa thử đạt được lưu làm target')
})

test('L4 cf (CLI): chạy thật không tiêm giờ ⇒ lastRelease.at là giờ lúc ghi (sau khi mở 100%), mốc nhắc +1 ngày tính từ đó', async () => {
  const f = fixture()
  const before = Date.now()
  const r = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com', '--first-release'], { handler: okHandler, realClock: true })
  const after = Date.now()
  assert.equal(r.code, 0, r.stdout)
  const st = readState(f.dir, { logDir: f.logDir })
  const at = Date.parse(st.lastRelease.at)
  assert.ok(at >= before && at <= after, `${st.lastRelease.at} nằm trong lúc chạy`)
  assert.equal(Date.parse(st.checkAt[0]), at + DAY)
})

test('cf: thử nhanh trượt ⇒ exit 1, gỡ bản mới về bản cũ và không có lệnh mở 100%; chưa đăng nhập ⇒ exit 3', async () => {
  const f = fixture()
  const r = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com', '--first-release'], { handler: (c) => (c.kind === 'playwright' ? { status: 1, stdout: 'fail' } : okHandler(c)) })
  assert.equal(r.code, 1)
  assert.deepEqual(r.kinds(), ['gate', 'check', 'git', 'wrangler:versions', 'wrangler:deployments', 'wrangler:versions', 'probe', 'playwright', 'wrangler:deployments', 'wrangler:versions'])
  assert.deepEqual(r.calls.at(-1).args.slice(1), ['versions', 'deploy', `${OLD}@100%`, '-y'])
  assert.ok(!r.calls.some((c) => c.args.includes(`${ID}@100%`)), 'bản mới không bao giờ được mở 100%')
  const g = fixture()
  const l = await cli(g, ['cf', '--dir', g.dir, '--url', 'https://app.example.com', '--first-release'], { handler: (c) => (c.kind === 'wrangler:versions' ? { status: 1, stderr: 'not authenticated' } : okHandler(c)) })
  assert.equal(l.code, 3)
  assert.match(l.stdout, /wrangler login/)
})

test('K1 cf: Worker chưa tồn tại — không --first-release ⇒ exit 3 bảo thêm cờ; có --first-release ⇒ wrangler deploy rồi thử nhanh, exit 0, ghi mốc', async () => {
  const notYet = (c) => {
    if (c.kind === 'wrangler:versions' && c.args[2] === 'upload') return { status: 1, stderr: '✘ [ERROR] You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.\n\n🪵  Logs were written to "x.log"\n' }
    if (c.kind === 'wrangler:deploy') { c.world.deployment = [{ version_id: ID, percentage: 100 }]; return { stdout: `Uploaded my-app\nCurrent Version ID: ${ID}\n` } }
    return okHandler(c)
  }
  const f = fixture()
  const no = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com'], { handler: notYet })
  assert.equal(no.code, 3, no.stdout)
  assert.match(no.stdout, /--first-release/)
  assert.deepEqual(no.kinds(), ['gate', 'check', 'git', 'wrangler:versions'])
  const g = fixture()
  const yes = await cli(g, ['cf', '--dir', g.dir, '--url', 'https://app.example.com', '--first-release'], { handler: notYet })
  assert.equal(yes.code, 0, yes.stdout)
  assert.deepEqual(yes.kinds(), ['gate', 'check', 'git', 'wrangler:versions', 'wrangler:deploy', 'probe', 'playwright'])
  assert.equal(readState(g.dir, { logDir: g.logDir }).lastRelease.version, ID)
})

test('K7 cf: package.json có script build ⇒ chạy build bằng trình quản lý gói của app trước khi tải lên; build lỗi ⇒ exit 1, chưa tải gì', async () => {
  const f = fixture()
  f.put('.git/HEAD', 'ref: refs/heads/main\n')
  f.put('pnpm-lock.yaml', '')
  f.put('package.json', JSON.stringify({ name: 'app', scripts: { build: 'vite build' } }))
  const ok = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com', '--first-release'], { handler: okHandler })
  assert.equal(ok.code, 0, ok.stdout)
  assert.deepEqual(ok.kinds().slice(0, 5), ['pnpm', 'gate', 'check', 'git', 'wrangler:versions'], 'build trước, rồi quét khoá trên bản vừa build, rồi mới tải lên')
  assert.deepEqual(ok.calls[0].args, ['run', 'build'])
  assert.match(ok.stdout, /Đã build bằng `pnpm run build`\./)
  const g = fixture()
  g.put('.git/HEAD', 'ref: refs/heads/main\n')
  g.put('pnpm-lock.yaml', '')
  g.put('package.json', JSON.stringify({ name: 'app', scripts: { build: 'vite build' } }))
  const bad = await cli(g, ['cf', '--dir', g.dir, '--url', 'https://app.example.com', '--first-release'], { handler: (c) => (c.kind === 'pnpm' ? { status: 1, stdout: 'error during build:\nboom' } : okHandler(c)) })
  assert.equal(bad.code, 1)
  assert.match(bad.stdout, /boom[\s\S]*Chưa tải gì lên Cloudflare/)
  assert.deepEqual(bad.kinds(), ['pnpm'])
  assert.equal(fs.existsSync(statePath(g.dir)), false)
})

test('cf tự chạy preflight với đúng cờ: chặn ⇒ exit 1, không có lệnh wrangler/Playwright/git nào, không ghi release.json', async () => {
  const blocked = [
    [['--first-release', '--zap-exit', '1'], okHandler, /mức cao/],
    [['--first-release', '--zap-exit', '3'], okHandler, /Java/],
    [[], okHandler, /thử quay lại/, { v: 1, releaseCount: 2, rollbackTested: false }],
    [['--first-release', '--has-data'], okHandler, /chưa chọn phương án sao lưu/],
    [['--first-release'], (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: không\nqa: có\ntest: có\n' } : okHandler(c)), /dấu review/],
  ]
  for (const [flags, handler, re, state] of blocked) {
    const f = fixture()
    if (state) writeState(f.dir, state, { logDir: f.logDir })
    const r = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com', ...flags], { handler })
    assert.equal(r.code, 1, flags.join(' '))
    assert.match(r.stdout, re, flags.join(' '))
    assert.match(r.stdout, /Chưa tải gì lên Cloudflare/)
    assert.deepEqual(r.kinds(), ['gate', 'check'], flags.join(' '))
    assert.deepEqual(readState(f.dir, { logDir: f.logDir }), state ? { ...state } : null, 'không ghi release.json')
  }
  const f = fixture()
  assert.match((await cli(f, ['cf', '--dir', f.dir, '--zap-exit', 'abc'])).stderr, /--zap-exit phải là số/)
})

test('BUG-2 cf: chưa cài wrangler mà thay đổi còn thiếu dấu review/QA ⇒ exit 1 + danh sách chặn (không phải "Thiếu wrangler"); hết chặn mới tới exit 3', async () => {
  const noMarks = (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: không\nqa: không\ntest: có\n' } : okHandler(c))
  const f = fixture({ wrangler: false })
  const blocked = await cli(f, ['cf', '--dir', f.dir, '--first-release', '--zap-exit', '0'], { handler: noMarks })
  assert.equal(blocked.code, 1, blocked.stdout)
  assert.match(blocked.stdout, /Chưa có dấu review/)
  assert.match(blocked.stdout, /Chưa có dấu QA/)
  assert.doesNotMatch(blocked.stdout, /Thiếu wrangler/)
  assert.deepEqual(blocked.kinds(), ['gate', 'check'])
  const g = fixture({ wrangler: false })
  const missing = await cli(g, ['cf', '--dir', g.dir, '--url', 'https://app.example.com', '--first-release'], { handler: okHandler })
  assert.equal(missing.code, 3)
  assert.match(missing.stdout, /Thiếu wrangler/)
  assert.deepEqual(missing.kinds(), ['gate', 'check'])
})

test('vps --run tự chạy preflight: chặn ⇒ exit 1, không ssh/scp; --rollback --run không qua preflight', async () => {
  const f = fixture()
  writeState(f.dir, { v: 1, releaseCount: 2, rollbackTested: false }, { logDir: f.logDir })
  const base = ['vps', '--dir', f.dir, '--mode', 'symlink', '--host', 'deploy@h', '--root', '/srv/app', '--sha', 'abc1234', '--url', 'https://app.example.com', '--run']
  const blocked = await cli(f, base, { handler: okHandler })
  assert.equal(blocked.code, 1)
  assert.match(blocked.stdout, /thử quay lại[\s\S]*Chưa đụng tới máy chủ/)
  assert.deepEqual(blocked.kinds(), ['gate', 'check'])
  const rb = await cli(f, [...base, '--rollback'], { handler: okHandler })
  assert.equal(rb.code, 0, rb.stdout)
  assert.deepEqual(rb.kinds(), ['ssh', 'playwright'], 'quay lại là cứu hộ: không chạy preflight')
})

test('rollback: wrangler rollback --message rồi thử nhanh; --version-id; in "dữ liệu không quay theo"', async () => {
  const f = fixture()
  const r = await cli(f, ['rollback', '--dir', f.dir, '--url', 'https://app.example.com', '--version-id', ID, '--message', 'lỗi'])
  assert.equal(r.code, 0, r.stdout)
  assert.deepEqual(r.calls[0].args.slice(1), ['rollback', ID, '--message', 'lỗi'])
  assert.deepEqual(r.kinds(), ['wrangler:rollback', 'playwright'])
  assert.match(r.stdout, /dữ liệu không quay theo/)
  assert.equal(readState(f.dir, { logDir: f.logDir }).rollbackTested, true)
})

test('BUG-3 rollback: --worker đi vào wrangler bằng --name; wrangler đòi tên Worker mà không có ⇒ exit 3 nói thiếu tên Worker', async () => {
  const f = fixture()
  const ok = await cli(f, ['rollback', '--dir', f.dir, '--url', 'https://app.example.com', '--worker', 'app-khac'])
  assert.equal(ok.code, 0, ok.stdout)
  assert.deepEqual(ok.calls[0].args.slice(1), ['rollback', '--message', 'flow rollback', '--name', 'app-khac'])
  const g = fixture()
  const noName = await cli(g, ['rollback', '--dir', g.dir, '--url', 'https://app.example.com'], {
    handler: (c) => (c.kind === 'wrangler:rollback' ? { status: 1, stderr: '✘ [ERROR] Missing Worker name. Pass it with --name\n\n🪵  Logs were written to "x.log"\n' } : {}),
  })
  assert.equal(noName.code, 3)
  assert.match(noName.stdout, /Thiếu tên Worker[\s\S]*--worker/)
  assert.doesNotMatch(noName.stdout, /Logs were written/)
})

// ---------- vps ----------

test('vps: thiếu cờ ⇒ exit 1 kèm lý do; đủ cờ không --run ⇒ chỉ in; quay lại dùng cấu hình đã nhớ trong release.json', async () => {
  const f = fixture()
  const bad = await cli(f, ['vps', '--dir', f.dir, '--sha', 'abc1234'])
  assert.equal(bad.code, 1)
  assert.match(bad.stdout, /--mode/)
  const plan = await cli(f, ['vps', '--dir', f.dir, '--mode', 'symlink', '--host', 'deploy@h', '--root', '/srv/app', '--sha', 'abc1234', '--keep', '1'])
  assert.equal(plan.code, 0)
  assert.deepEqual(plan.kinds(), [])
  assert.match(plan.stdout, /tail -n \+4/, 'keep dưới 3 bị nâng lên 3')
  writeState(f.dir, { v: 1, vps: { mode: 'docker', host: 'srv', root: '/opt/app' } }, { logDir: f.logDir })
  const rb = await cli(f, ['vps', '--dir', f.dir, '--rollback'])
  assert.equal(rb.code, 0, rb.stdout)
  assert.match(rb.stdout, /srv 'cd \/opt\/app && prev=\$\(cat \.previous-image-tag/)
})

test('vps --run: chạy thật qua run giả, thử nhanh, ghi trạng thái', async () => {
  const f = fixture()
  const r = await cli(f, ['vps', '--dir', f.dir, '--mode', 'symlink', '--host', 'deploy@h', '--root', '/srv/app', '--service', 'app', '--url', 'https://app.example.com', '--run', '--first-release'], { handler: okHandler })
  assert.equal(r.code, 0, r.stdout)
  assert.deepEqual(r.kinds(), ['gate', 'check', 'git', 'ssh', 'scp', 'ssh', 'playwright'])
  const st = readState(f.dir, { logDir: f.logDir })
  assert.equal(st.platform, 'vps')
  assert.equal(st.vps.service, 'app')
})

// ---------- logs ----------

const okFetch = (events) => async () => ({ ok: true, status: 200, json: async () => ({ result: { events: { events } } }) })
const cfEnv = { CF_LOGS_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }

test('logs: đọc xong ⇒ kể lỗi bằng lời và bỏ các mốc nhắc đã tới hạn (giữ mốc chưa tới)', async () => {
  const f = fixture()
  const so = { logDir: f.logDir }
  const future = new Date(NOW + 6 * DAY).toISOString()
  writeState(f.dir, { v: 1, logs: { source: 'workers-observability', retentionDays: 3 }, checkAt: [new Date(NOW - 3600000).toISOString(), future] }, so)
  const events = [{ timestamp: NOW - 60000, $metadata: { message: 'D1 down', trigger: 'GET /api/x' } }]
  const r = await cli(f, ['logs', '--dir', f.dir, '--since', '24h'], { fetch: okFetch(events), env: cfEnv })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Có 1 lỗi trong 1 ngày qua/)
  assert.match(r.stdout, /D1 down/)
  assert.deepEqual(readState(f.dir, so).checkAt, [future])
})

test('logs: trong lúc đang đọc nhật ký, `release cf` ghi mốc nhắc mới ⇒ chỉ bỏ mốc cũ đã tới hạn, mốc mới và lastRelease còn nguyên', async () => {
  const f = fixture()
  const so = { logDir: f.logDir }
  const due = new Date(NOW - 3600000).toISOString()
  writeState(f.dir, { v: 1, logs: { source: 'workers-observability', retentionDays: 3 }, checkAt: [due] }, so)
  const fresh = [new Date(NOW + DAY).toISOString(), new Date(NOW + 7 * DAY).toISOString()]
  const lastRelease = { at: new Date(NOW).toISOString(), version: ID, smoke: 'pass' }
  const fetch = async () => {
    writeState(f.dir, { ...readState(f.dir, so), lastRelease, checkAt: [due, ...fresh] }, so) // phát hành xong giữa chừng
    return { ok: true, status: 200, json: async () => ({ result: { events: { events: [] } } }) }
  }
  const r = await cli(f, ['logs', '--dir', f.dir], { fetch, env: cfEnv })
  assert.equal(r.code, 0)
  const st = readState(f.dir, so)
  assert.deepEqual(st.checkAt, fresh)
  assert.deepEqual(st.lastRelease, lastRelease)
})

test('logs: không có lỗi / vượt thời gian giữ / không truy cập được — ba câu khác nhau; không truy cập được ⇒ exit 3 và GIỮ mốc nhắc', async () => {
  const f = fixture()
  const so = { logDir: f.logDir }
  const due = new Date(NOW - 3600000).toISOString()
  writeState(f.dir, { v: 1, logs: { source: 'workers-observability', retentionDays: 3 }, checkAt: [due] }, so)
  const unreachable = await cli(f, ['logs', '--dir', f.dir], { fetch: okFetch([]), env: {} })
  assert.equal(unreachable.code, 3)
  assert.match(unreachable.stdout, /Chưa đọc được nhật ký/)
  assert.deepEqual(readState(f.dir, so).checkAt, [due], 'chưa đọc được ⇒ chưa xem ⇒ mốc nhắc còn')
  const beyond = await cli(f, ['logs', '--dir', f.dir, '--since', '7d'], { fetch: okFetch([]), env: cfEnv })
  assert.equal(beyond.code, 0)
  assert.match(beyond.stdout, /chỉ giữ nhật ký 3 ngày/)
  assert.deepEqual(readState(f.dir, so).checkAt, [], 'đã xem ⇒ bỏ mốc đến hạn')
  const clean = await cli(f, ['logs', '--dir', f.dir, '--since', '12h'], { fetch: okFetch([]), env: cfEnv })
  assert.equal(clean.code, 0)
  assert.match(clean.stdout, /Không thấy lỗi nào trong 12 giờ qua/)
})

test('BUG-4 logs supabase: --project-ref sai dạng ⇒ "không hợp lệ" (không phải "thiếu"); token giả bị Cloudflare từ chối 400 ⇒ bảo kiểm lại token / ID tài khoản', async () => {
  const f = fixture()
  writeState(f.dir, { v: 1, logs: { source: 'supabase' } }, { logDir: f.logDir })
  const bad = await cli(f, ['logs', '--dir', f.dir, '--project-ref', 'x;rm'], { env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch: okFetch([]) })
  assert.equal(bad.code, 3)
  assert.match(bad.stdout, /mã dự án Supabase không hợp lệ/)
  assert.doesNotMatch(bad.stdout, /thiếu mã/)
  const g = fixture()
  writeState(g.dir, { v: 1, logs: { source: 'workers-observability', retentionDays: 3 } }, { logDir: g.logDir })
  const tok = await cli(g, ['logs', '--dir', g.dir], { env: cfEnv, fetch: async () => ({ ok: false, status: 400 }) })
  assert.equal(tok.code, 3)
  assert.match(tok.stdout, /HTTP 400[\s\S]*kiểm lại token \/ ID tài khoản/)
  assert.doesNotMatch(tok.stdout, /thử lại sau/)
})

test('logs vps: lấy host/service đã nhớ trong release.json', async () => {
  const f = fixture()
  writeState(f.dir, { v: 1, logs: { source: 'vps-journald' }, vps: { mode: 'symlink', host: 'deploy@h', root: '/srv/app', service: 'app' } }, { logDir: f.logDir })
  const r = await cli(f, ['logs', '--dir', f.dir, '--since', '1h'], { handler: () => ({ stdout: '2026-10-12T23:30:00+0000 srv app[1]: Error: x\n' }) })
  assert.equal(r.code, 0)
  assert.equal(r.calls[0].args.at(-2), 'deploy@h')
  assert.match(r.calls[0].args.at(-1), /^journalctl -u app --since=-3600s/)
  assert.match(r.stdout, /Có 1 lỗi/)
})

// ---------- lỗi nội bộ ----------

test('lỗi nội bộ ⇒ exit 1, một dòng trong release.log, không in stack ra màn hình', async () => {
  const f = fixture()
  const r = await cli(f, ['cf', '--dir', f.dir, '--url', 'https://app.example.com'], { handler: () => { throw new Error('hỏng bất ngờ') } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /lỗi nội bộ/)
  assert.doesNotMatch(r.stderr, /hỏng bất ngờ/)
  const log = fs.readFileSync(path.join(f.logDir, 'release.log'), 'utf8')
  assert.equal(log.trim().split('\n').length, 1)
  assert.match(log, /hỏng bất ngờ/)
})

// ---------- tiến trình thật ----------

test('realRun: mảng tham số (không shell), env undefined gỡ biến, stdin đóng ngay, thiếu lệnh ⇒ error', () => {
  process.env.FLOW_RELEASE_TEST_VAR = 'a'
  const show = realRun(process.execPath, ['-e', 'console.log(String(process.env.FLOW_RELEASE_TEST_VAR) + "|" + String(process.env.EXTRA_X))'], { env: { FLOW_RELEASE_TEST_VAR: undefined, EXTRA_X: 'x y' } })
  assert.equal(show.stdout.trim(), 'undefined|x y')
  const meta = realRun(process.execPath, ['-e', 'console.log(process.argv[1])', 'a b; c && d'])
  assert.equal(meta.stdout.trim(), 'a b; c && d')
  const eof = realRun(process.execPath, ['-e', "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('eof'))"])
  assert.equal(eof.stdout.trim(), 'eof')
  const none = realRun('lenh-khong-ton-tai-flow-release', [])
  assert.equal(none.error, 'ENOENT')
  assert.equal(none.status, null)
})

test('realRun: npm/pnpm/yarn là file .cmd trên Windows nhưng vẫn chạy được (K7 cần chạy `npm run build`); đối số lạ bị từ chối thay vì đi qua cmd.exe', () => {
  const has = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['npm'], { encoding: 'utf8' })
  if (has.status !== 0) return // máy không có npm: không kiểm được
  const v = realRun('npm', ['--version'])
  assert.equal(v.error, null, `npm có trên máy mà realRun không chạy được: ${v.error}`)
  assert.equal(v.status, 0, v.stderr)
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/)
  if (process.platform === 'win32') {
    const bad = realRun('npm', ['run', 'a&calc'])
    assert.equal(bad.status, null)
    assert.equal(bad.error, 'EUNSAFE')
  }
})

test('tiến trình thật: --help exit 0, lệnh lạ exit 1', () => {
  const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(h.status, 0)
  assert.match(h.stdout, /preflight/)
  const bad = spawnSync(process.execPath, [CLI, 'khong-co'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
})

test('tiến trình thật: preflight nối đúng flow-gate + flow-check — dist có khoá ⇒ chặn, không in giá trị khoá; dist sạch ⇒ qua mục khoá', () => {
  const f = fixture()
  f.put('package.json', JSON.stringify({ name: 'app', dependencies: { vite: '^6.0.0' } }))
  const key = 'sk_' + 'live_' + '51H' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3'
  f.put('dist/index.js', `const k = "${key}"\n`)
  const bad = spawnSync(process.execPath, [CLI, 'preflight', '--dir', f.dir, '--first-release'], { encoding: 'utf8' })
  assert.equal(bad.status, 1, bad.stdout + bad.stderr)
  assert.match(bad.stdout, /khoá bí mật \(dist\/index\.js\)/)
  assert.doesNotMatch(bad.stdout + bad.stderr, new RegExp(key.slice(0, 20)))
  assert.match(bad.stdout, /Chưa kiểm được dấu review\/QA\/test/, 'thư mục thử không phải git ⇒ không coi là đạt')
  fs.writeFileSync(path.join(f.dir, 'dist', 'index.js'), 'console.log("sạch")\n')
  const clean = spawnSync(process.execPath, [CLI, 'preflight', '--dir', f.dir, '--first-release'], { encoding: 'utf8' })
  assert.doesNotMatch(clean.stdout, /khoá bí mật/)
  assert.equal(fs.existsSync(statePath(f.dir)), false, 'preflight chỉ đọc, không ghi release.json')
})

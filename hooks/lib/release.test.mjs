// Test cho lib/release.mjs: node --test hooks/lib/release.test.mjs
// Không gọi Cloudflare/ssh/wrangler thật: mọi lệnh ngoài đi qua `run` giả, HTTP qua `fetch` giả. Thư mục dự án có dấu cách + tiếng Việt.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  EXIT, OVERRIDE_HEADER, PROBE_SRC, VERSION_HEADER, dropDueMarks, findBin, formatLogs, formatPreflight, groupErrors, parseGateStatus, parseLogLines, parseSince,
  parseVersionId, pkgManager, preflight, readLogs, readWorkerName, releaseCf, releaseVps, rollbackCf, scrub, vpsPlan,
} from './release.mjs'
import { readState, statePath, writeState } from './release-state.mjs'

const execFileP = promisify(execFile)
const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-10-13T00:00:00.000Z')
const DAY = 86400000
const ID = '11111111-2222-3333-4444-555555555555'
const OLD = '99999999-8888-7777-6666-555555555555' // bản đang chạy 100% trước lần phát hành
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

function fixture({ wrangler = true, playwright = true, config = 'jsonc' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release thử '))
  tmpDirs.push(root)
  const dir = path.join(root, 'ứng dụng')
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const bins = {}
  if (wrangler) {
    put('node_modules/wrangler/package.json', JSON.stringify({ name: 'wrangler', bin: { wrangler: 'bin/wrangler.js' } }))
    put('node_modules/wrangler/bin/wrangler.js', '')
    bins.wr = path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  }
  if (playwright) {
    put('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', bin: { playwright: 'cli.js' } }))
    put('node_modules/@playwright/test/cli.js', '')
    bins.pw = path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js')
  }
  if (config === 'jsonc') put('wrangler.jsonc', '{\n  // tên\n  "name": "my-app", /* ghi chú */\n  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "C" },] },\n}\n')
  fs.mkdirSync(dir, { recursive: true })
  return { dir, root, so: { logDir: path.join(root, 'logs') }, ...bins }
}

// run giả: ghi lại mọi lời gọi; handler(call) trả { status, stdout, stderr } (thiếu ⇒ thành công, output rỗng).
// Lệnh của preflight (flow-gate status, flow-check) mà handler không trả gì ⇒ tự trả "đạt" để các ca phát hành không phải lặp lại.
// call.world = trạng thái Cloudflare giả của MỘT lần chạy (deployment hiện tại), để okHandler mô phỏng `versions deploy` / `deployments status` / dò header.
function fakeRun(f, handler = () => ({}), deployment = [{ version_id: OLD, percentage: 100 }]) {
  const calls = []
  const world = { deployment }
  const run = (cmd, args, opts = {}) => {
    const call = { cmd, args, opts, kind: kindOf(f, cmd, args), world }
    calls.push(call)
    const h = handler(call) ?? {}
    return { status: 0, stdout: '', stderr: '', error: null, ...(Object.keys(h).length ? h : preflightOk(call)) }
  }
  return { run, calls, kinds: () => calls.map((c) => c.kind) }
}
function kindOf(f, cmd, args) {
  if (f?.wr && args[0] === f.wr) return `wrangler:${args.slice(1, 3).filter((a) => !a.startsWith('-')).join(' ')}`
  if (f?.pw && args[0] === f.pw) return 'playwright'
  if (args[0]?.endsWith?.('flow-gate.mjs')) return 'gate'
  if (args[0]?.endsWith?.('flow-check.mjs')) return 'check'
  if (args[0] === '-e') return 'probe' // dò header x-flow-version của địa chỉ thật
  return cmd
}
const preflightOk = (c) => (c.kind === 'gate' ? { stdout: GATE_OK } : c.kind === 'check' ? { stdout: SB_PASS } : {})
const noSleep = () => {} // không chờ thật giữa các lần dò header bản
const GATE = { hooksDir: HOOKS_DIR, firstRelease: true, sleep: noSleep }
const PRE = ['gate', 'check'] // hai lệnh preflight chạy trước khi phát hành thật
// Lỗi wrangler thật: có mã màu, dòng "✘ [ERROR]", rồi dòng "🪵 Logs were written to" đứng cuối.
const wranglerFail = (msg) => ({ status: 1, stdout: '', stderr: `\u001b[31m✘ \u001b[41;31m[ERROR]\u001b[0m \u001b[1m${msg}\u001b[0m\n\n🪵  Logs were written to "C:\\Users\\x\\AppData\\Roaming\\xdg.config\\.wrangler\\logs\\wrangler-2026-10-13.log"\n` })
// `wrangler deployments status --json` thật: app dựng bằng plugin Vite của Cloudflare in thêm vài dòng "Using redirected Wrangler
// configuration" TRƯỚC khối JSON (bằng chứng nghiệm thu: bang-chung/wrangler-deploy-first.txt).
const deployStatus = (versions) => ({
  stdout: 'Using redirected Wrangler configuration.\n - Configuration being used: "dist\\my_app\\wrangler.json"\n'
    + `${JSON.stringify({ id: 'dep-1', source: 'wrangler', strategy: 'percentage', author_email: 'a@b.c', annotations: { 'workers/message': 'x' }, versions, created_on: '2026-10-12T10:00:00.000Z' }, null, 2)}\n`,
})
// `versions deploy <mã>@<%> …` → deployment mới.
const deploymentOf = (args) => args.filter((a) => /@\d+%$/.test(a)).map((s) => { const [version_id, p] = s.split('@'); return { version_id, percentage: parseInt(p, 10) } })
// Dò header x-flow-version: header override trúng bản NẰM TRONG deployment, còn lại request vào bản đang 100% — đúng điều đã đo thật (K2).
const APP_WORKER = 'my-app' // "name" trong wrangler.jsonc của fixture; header override ghi tên Worker khác thì Cloudflare bỏ qua
const probeAnswer = (c, deployment) => {
  const hdr = JSON.parse(c.opts.env.PROBE_HEADERS || '{}')[OVERRIDE_HEADER]
  const m = hdr ? /^([^=]+)="(.+)"$/.exec(hdr) : null
  const want = m && m[1] === APP_WORKER ? m[2] : null
  const version = deployment?.some((v) => v.version_id === want) ? want : deployment?.find((v) => v.percentage === 100)?.version_id
  return { stdout: `${JSON.stringify({ status: 200, version: version ?? null })}\n` }
}
const okHandler = (c) => {
  if (c.kind === 'git') return { stdout: 'abc1234\n' }
  if (c.kind === 'wrangler:versions upload') return { stdout: `Uploaded my-app\nWorker Version ID: ${ID}\n` }
  if (c.kind === 'wrangler:deployments status') return deployStatus(c.world.deployment)
  if (c.kind === 'wrangler:versions deploy') { c.world.deployment = deploymentOf(c.args); return {} }
  if (c.kind === 'probe') return probeAnswer(c, c.world.deployment)
  return {}
}
// Lệnh `versions deploy` mở bản mới 100% (khác lệnh gắn bản mới ở 0% và lệnh gỡ về bản cũ).
const opens = (c) => c.kind === 'wrangler:versions deploy' && c.args.includes(`${ID}@100%`)
// Lệnh gỡ bản mới: về bản cũ 100% một mình.
const pulls = (c) => c.kind === 'wrangler:versions deploy' && c.args.includes(`${OLD}@100%`) && !c.args.includes(`${ID}@0%`)
// Cloudflare giả đúng điều đã đo thật (K2): header Cloudflare-Workers-Version-Overrides chỉ trúng bản NẰM TRONG deployment hiện tại;
// bản chỉ mới `versions upload` mà chưa vào deployment thì header bị bỏ qua và request đi vào bản đang chạy 100%.
function cfWorld({ deployment = [{ version_id: OLD, percentage: 100 }], smokeFails = false } = {}) {
  const w = { deployment, served: null }
  const handler = (c) => {
    if (c.kind === 'wrangler:deployments status') return w.deployment ? deployStatus(w.deployment) : { status: 1, stderr: 'The Worker viec-can-lam has no deployments.' }
    if (c.kind === 'wrangler:versions deploy') {
      w.deployment = deploymentOf(c.args)
      return {}
    }
    if (c.kind === 'probe') return probeAnswer(c, w.deployment)
    if (c.kind === 'playwright') {
      const hdr = c.opts.env.SMOKE_EXTRA_HTTP_HEADERS ? JSON.parse(c.opts.env.SMOKE_EXTRA_HTTP_HEADERS)[OVERRIDE_HEADER] : null
      const want = hdr ? /"(.+)"/.exec(hdr)[1] : null
      w.served = w.deployment?.some((v) => v.version_id === want) ? want : w.deployment?.find((v) => v.percentage === 100)?.version_id
      return smokeFails ? { status: 1, stdout: 'Error: expected visible' } : {}
    }
    return okHandler(c)
  }
  return { w, handler }
}

// ---------- tiện ích ----------

test('parseSince: 90m, 24h, 7d; sai dạng hoặc 0 ⇒ null', () => {
  assert.equal(parseSince('90m'), 90 * 60000)
  assert.equal(parseSince('24h'), 24 * 3600000)
  assert.equal(parseSince('7d'), 7 * DAY)
  for (const bad of ['', '5', 'abc', '-1d', '0h', '1.5h', '1w', undefined]) assert.equal(parseSince(bad), null, String(bad))
})

test('parseVersionId: lấy mã từ output của wrangler', () => {
  assert.equal(parseVersionId(`x\nWorker Version ID: ${ID.toUpperCase()}\ny`), ID)
  assert.equal(parseVersionId(`{"version_id":"${ID}"}`), ID)
  assert.equal(parseVersionId('Uploaded OK'), null)
})

test('findBin: thấy ở thư mục cha (monorepo), không thấy ⇒ null', () => {
  const f = fixture()
  const sub = path.join(f.dir, 'apps', 'web')
  fs.mkdirSync(sub, { recursive: true })
  assert.equal(findBin(sub, ['wrangler'], 'wrangler'), f.wr)
  assert.equal(findBin(sub, ['không-có-gói-này'], 'x'), null)
})

test('readWorkerName: jsonc có chú thích + dấu phẩy thừa, toml, không có', () => {
  const f = fixture()
  assert.equal(readWorkerName(f.dir), 'my-app')
  const g = fixture({ config: 'none' })
  assert.equal(readWorkerName(g.dir), null)
  fs.writeFileSync(path.join(g.dir, 'wrangler.toml'), '# c\nname = "toml-app"\n[vars]\nname = "khác"\n')
  assert.equal(readWorkerName(g.dir), 'toml-app')
})

test('scrub: che token, JWT, email', () => {
  const s = scrub('Bearer abcdefghijklmnop1234 eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.abc a@b.com sb_secret_abcdef ok')
  assert.doesNotMatch(s, /abcdefghijklmnop|eyJhbGci|a@b\.com|sb_secret_abcdef/)
  assert.match(s, /ok$/)
})

// ---------- preflight (AC-22b) ----------

const GATE_OK = 'branch: feat (base main, worktree)\npid: abc\nuiTouched: false\nreview: có\nqa: có\ntest: có\n'
const SB_PASS = JSON.stringify({ results: [{ id: 'secret-build', status: 'pass' }] })
function pre(over = {}) {
  const f = fixture()
  const gate = over.gate ?? { stdout: GATE_OK }
  const sb = over.sb ?? { stdout: SB_PASS }
  const { run, calls } = fakeRun(f, (c) => (c.args[0]?.endsWith('flow-gate.mjs') ? gate : c.args[0]?.endsWith('flow-check.mjs') ? sb : {}))
  const state = 'state' in over ? over.state : { v: 1, rollbackTested: true, backup: { choice: 'off' } }
  const dir = over.setup?.(f) ?? f.dir // setup(f) có thể dựng .git / .claude/allow-direct-edit và trả thư mục dự án khác f.dir
  const r = preflight({ dir, state, now: NOW, run, hooksDir: HOOKS_DIR, zapExit: over.zapExit, hasData: over.hasData, firstRelease: over.firstRelease })
  return { r, calls, codes: r.blockers.map((b) => b.code) }
}

test('preflight: mọi thứ đạt ⇒ ok, không mục thiếu', () => {
  const { r, calls } = pre({ zapExit: 0 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.blockers, [])
  assert.equal(formatPreflight(r)[0], 'Đủ điều kiện phát hành.')
  assert.equal(calls.length, 2) // flow-gate + flow-check
  assert.ok(calls.every((c) => c.cmd === process.execPath), 'chạy bằng node, không qua shell')
})

test('parseGateStatus: có / không đòi ⇒ đạt, không ⇒ thiếu, diff rỗng', () => {
  const g = parseGateStatus('pid: x\nreview: có\nqa: không (thiếu dòng "P-nn…" cho P-01)\ntest: không đòi (diff chỉ có tài liệu)\n')
  assert.deepEqual([g.valid, g.review, g.qa, g.test, g.empty], [true, true, false, true, false])
  assert.equal(parseGateStatus('pid: (diff rỗng)\nreview: không\nqa: không\ntest: không\n').empty, true)
  assert.equal(parseGateStatus('lạ').valid, false)
})

test('preflight: thiếu dấu review/qa/test ⇒ từng mục một câu', () => {
  const { r, codes } = pre({ gate: { stdout: 'pid: x\nreview: không\nqa: không (diff có UI nhưng N/A)\ntest: không\n' } })
  assert.deepEqual(codes, ['gate-review', 'gate-qa', 'gate-test'])
  assert.match(r.blockers[1].text, /diff có UI/)
  assert.equal(r.ok, false)
  assert.match(formatPreflight(r)[0], /còn 3 mục/)
})

test('preflight: diff rỗng (đã gộp) ⇒ không đòi dấu, có ghi chú', () => {
  const { r, codes } = pre({ gate: { stdout: 'pid: (diff rỗng)\nreview: không\nqa: không\ntest: không\n' } })
  assert.deepEqual(codes, [])
  assert.ok(r.notes.some((n) => /không đòi dấu/.test(n)))
  assert.deepEqual(r.warnings, [], 'repo thường (không allow-direct-edit) ⇒ không cảnh báo thêm')
})

// K5: repo sửa thẳng nhánh chính (.claude/allow-direct-edit) không bao giờ có diff so với main ⇒ cổng không đòi dấu nào và không ai
// kiểm gì. Không đổi cổng; preflight chỉ nói thẳng để người phát hành biết mình tự chịu phần kiểm.
const EMPTY_GATE = { stdout: 'branch: main (base main, thư mục chính)\npid: (diff rỗng)\nuiTouched: false\nreview: không\nqa: không\ntest: không\n' }
const directEdit = (f, where = f.dir) => { fs.mkdirSync(path.join(f.dir, '.git'), { recursive: true }); fs.mkdirSync(path.join(where, '.claude'), { recursive: true }); fs.writeFileSync(path.join(where, '.claude', 'allow-direct-edit'), '') }
const DIRECT_WARN = /sửa thẳng nhánh chính[\s\S]*không có dấu review\/QA\/test[\s\S]*tự kiểm/

test('K5 preflight: repo có .claude/allow-direct-edit và không có thay đổi chờ gộp ⇒ vẫn qua nhưng in cảnh báo tự kiểm (không chặn, không đổi cổng)', () => {
  const a = pre({ gate: EMPTY_GATE, setup: (f) => { directEdit(f); return f.dir } })
  assert.deepEqual(a.codes, [])
  assert.equal(a.r.ok, true)
  assert.equal(a.r.warnings.length, 1)
  assert.match(a.r.warnings[0], DIRECT_WARN)
  assert.ok(a.r.notes.some((n) => /không đòi dấu/.test(n)), 'ghi chú cũ giữ nguyên')
  assert.ok(formatPreflight(a.r).some((l) => l.startsWith('Cảnh báo: ') && DIRECT_WARN.test(l)))
  // thư mục app là thư mục con của repo (monorepo): file nằm ở gốc repo (nơi có .git) vẫn được thấy
  const b = pre({ gate: EMPTY_GATE, setup: (f) => { directEdit(f); const sub = path.join(f.dir, 'apps', 'web'); fs.mkdirSync(sub, { recursive: true }); return sub } })
  assert.match(b.r.warnings[0] ?? '', DIRECT_WARN)
  // có file mà đang có thay đổi chờ gộp ⇒ dấu vẫn được đòi và kiểm như thường, không cần cảnh báo
  const c = pre({ gate: { stdout: GATE_OK }, setup: (f) => { directEdit(f); return f.dir } })
  assert.deepEqual(c.r.warnings, [])
  const d = pre({ gate: { stdout: 'pid: x\nreview: không\nqa: có\ntest: có\n' }, setup: (f) => { directEdit(f); return f.dir } })
  assert.deepEqual(d.codes, ['gate-review'], 'cổng không đổi')
  // không phải repo git (không có .git) ⇒ không đoán
  const e = pre({ gate: EMPTY_GATE })
  assert.deepEqual(e.r.warnings, [])
})

test('preflight: flow-gate lỗi (không phải git) ⇒ chặn, không coi là đạt', () => {
  const { codes } = pre({ gate: { status: 1, stderr: 'Không phải git repo.' } })
  assert.deepEqual(codes, ['gate-unreadable'])
})

test('preflight: secret-build chạy riêng checker quét build (file checkers tạm chỉ có internal secret-scan-build)', () => {
  const f = fixture()
  let seen
  const { run } = fakeRun(f, (c) => {
    if (c.args[0]?.endsWith('flow-gate.mjs')) return { stdout: GATE_OK }
    const file = c.args[c.args.indexOf('--checkers') + 1]
    seen = { file, json: JSON.parse(fs.readFileSync(file, 'utf8')), args: c.args }
    return { stdout: SB_PASS }
  })
  preflight({ dir: f.dir, state: { rollbackTested: true }, now: NOW, run, hooksDir: HOOKS_DIR })
  assert.ok(seen.json.checkers.length >= 1 && seen.json.checkers.every((c) => c.internal === 'secret-scan-build'))
  assert.ok(seen.args.includes('--json') && seen.args.includes(f.dir))
  assert.equal(fs.existsSync(path.dirname(seen.file)), false, 'file tạm đã dọn')
})

test('preflight: secret-build đỏ / chưa build / không đọc được / không áp dụng', () => {
  const rep = (status, detail) => ({ stdout: JSON.stringify({ results: [{ id: 'secret-build', status, detail }] }) })
  const red = pre({ sb: rep('fail', ['dist/assets/index.js:3 Stripe key (sk_l…)']) })
  assert.deepEqual(red.codes, ['secret-build'])
  assert.match(red.r.blockers[0].text, /dist\/assets\/index\.js/)
  assert.doesNotMatch(red.r.blockers[0].text, /sk_l/, 'không in giá trị khoá')
  const nb = pre({ sb: rep('missing') })
  assert.match(nb.r.blockers[0].text, /Chưa build/)
  assert.deepEqual(pre({ sb: { status: 2, stdout: 'không phải JSON', stderr: 'cờ lạ' } }).codes, ['secret-build-unreadable'])
  const na = pre({ sb: { stdout: JSON.stringify({ results: [] }) } })
  assert.deepEqual(na.codes, [])
  assert.ok(na.r.notes.some((n) => /không có bước quét khoá/.test(n)))
})

test('preflight: kết quả zap-scan — 1 và 3 chặn, 2 cảnh báo, 0/chưa có thì qua', () => {
  assert.deepEqual(pre({ zapExit: 1 }).codes, ['zap'])
  assert.match(pre({ zapExit: 1 }).r.blockers[0].text, /mức cao/)
  assert.deepEqual(pre({ zapExit: 3 }).codes, ['zap'])
  assert.match(pre({ zapExit: 3 }).r.blockers[0].text, /Java/)
  assert.deepEqual(pre({ zapExit: 9 }).codes, ['zap'])
  const warn = pre({ zapExit: 2 })
  assert.deepEqual(warn.codes, [])
  assert.equal(warn.r.warnings.length, 1)
  assert.deepEqual(pre({ zapExit: 0 }).codes, [])
  const none = pre({})
  assert.deepEqual(none.codes, [])
  assert.ok(none.r.notes.some((n) => /zap-scan/.test(n)))
})

// K3: nghiệm thu thật bị chặn ở lần 2 ("Chưa thử quay lại") dù sau lần 1 chỉ có MỘT bản nên không thể quay lại.
// Giờ chỉ đòi khi release.json ghi đã có ≥ 2 lần phát hành (đếm bằng releaseCount; file cũ suy từ lastRelease).
test('K3 preflight: chưa thử quay lại chỉ chặn khi đã phát hành ≥ 2 lần; chưa/mới 1 lần (kể cả file cũ không có releaseCount) thì không', () => {
  assert.deepEqual(pre({ state: null }).codes, [], 'chưa có release.json = chưa phát hành lần nào')
  assert.deepEqual(pre({ state: { v: 1, rollbackTested: false } }).codes, [])
  assert.deepEqual(pre({ state: { v: 1, rollbackTested: false, releaseCount: 1 } }).codes, [])
  assert.deepEqual(pre({ state: { v: 1, rollbackTested: false, lastRelease: { at: new Date(NOW - DAY).toISOString(), version: ID, smoke: 'pass' } } }).codes, [], 'file cũ có lastRelease ⇒ suy ra 1 lần')
  const two = pre({ state: { v: 1, rollbackTested: false, releaseCount: 2 } })
  assert.deepEqual(two.codes, ['rollback'])
  assert.match(two.r.blockers[0].text, /thử quay lại[\s\S]*release rollback/)
  assert.doesNotMatch(two.r.blockers[0].text, /first-release/, 'không còn bảo user "thêm --first-release" để lách')
  assert.deepEqual(pre({ state: { v: 1, rollbackTested: true, releaseCount: 7 } }).codes, [])
  assert.deepEqual(pre({ state: { v: 1, rollbackTested: false, releaseCount: 2 }, firstRelease: true }).codes, ['rollback'], '--first-release không còn là lối lách')
})

test('preflight ↔ backupReady: bật sao lưu mà chưa có lịch/lần chạy/khôi phục thử ⇒ chặn từng lý do', () => {
  const on = pre({ state: { rollbackTested: true, backup: { choice: 'on' } } })
  assert.deepEqual(on.codes, ['backup-no-scheduler', 'backup-no-interval', 'backup-no-backup', 'backup-no-restore-check'])
  const ready = pre({
    state: {
      rollbackTested: true,
      backup: { choice: 'on', scheduler: { kind: 'cron', id: 'x' }, everyHours: 24, lastBackup: new Date(NOW - 3600000).toISOString(), lastRestoreCheck: new Date(NOW - DAY).toISOString() },
    },
  })
  assert.deepEqual(ready.codes, [])
  const stale = pre({
    state: {
      rollbackTested: true,
      backup: { choice: 'on', scheduler: { kind: 'cron', id: 'x' }, everyHours: 24, lastBackup: new Date(NOW - 3 * DAY).toISOString(), lastRestoreCheck: new Date(NOW - DAY).toISOString() },
    },
  })
  assert.deepEqual(stale.codes, ['backup-stale'])
})

test('preflight --has-data: chưa chọn phương án sao lưu ⇒ chặn; chọn tắt ⇒ qua', () => {
  assert.deepEqual(pre({ hasData: true, state: { rollbackTested: true } }).codes, ['backup-choice'])
  assert.deepEqual(pre({ hasData: true, state: { rollbackTested: true, backup: { choice: 'off' } } }).codes, [])
  assert.deepEqual(pre({ state: { rollbackTested: true } }).codes, [], 'không biết app có dữ liệu ⇒ không tự chặn')
})

// ---------- Cloudflare Workers (AC-48, 48a) ----------

test('cf (K2): tải lên → đọc bản đang chạy → gắn bản mới ở 0% vào deployment → thử nhanh (header) → mở 100%, rồi ghi mốc nhắc +1/+7 ngày', () => {
  const f = fixture()
  const { run, calls, kinds } = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deployments status', 'wrangler:versions deploy', 'probe', 'playwright', 'wrangler:deployments status', 'wrangler:versions deploy'])
  const [, , , up, status, attach, probe, sm, , open] = calls
  assert.equal(probe.cmd, process.execPath)
  assert.deepEqual(probe.args, ['-e', PROBE_SRC])
  assert.equal(probe.opts.env.PROBE_URL, 'https://app.example.com')
  assert.deepEqual(JSON.parse(probe.opts.env.PROBE_HEADERS), { [OVERRIDE_HEADER]: `my-app="${ID}"` }, 'dò bằng đúng header override sẽ dùng khi thử nhanh')
  assert.deepEqual(up.args.slice(0, 4), [f.wr, 'versions', 'upload', '--message'])
  assert.equal(up.cmd, process.execPath)
  assert.equal(up.opts.cwd, f.dir)
  assert.deepEqual(status.args, [f.wr, 'deployments', 'status', '--json'], 'đọc bản đang chạy bằng JSON, chịu được các dòng "Using redirected Wrangler configuration" đứng trước')
  assert.equal(status.opts.cwd, f.dir)
  assert.deepEqual(attach.args, [f.wr, 'versions', 'deploy', `${OLD}@100%`, `${ID}@0%`, '-y'], 'bản cũ giữ 100%, bản mới vào deployment ở 0%')
  assert.deepEqual(sm.args, [f.pw, 'test', '--grep', '@smoke', '--retries=2'])
  assert.equal(sm.opts.env.BASE_URL, 'https://app.example.com')
  assert.deepEqual(JSON.parse(sm.opts.env.SMOKE_EXTRA_HTTP_HEADERS), { [OVERRIDE_HEADER]: `my-app="${ID}"` })
  assert.deepEqual(open.args, [f.wr, 'versions', 'deploy', `${ID}@100%`, '-y'])
  const st = readState(f.dir, f.so)
  assert.deepEqual(st.lastRelease, { at: new Date(NOW).toISOString(), version: ID, commit: 'abc1234', smoke: 'pass' })
  assert.deepEqual(st.checkAt, [new Date(NOW + DAY).toISOString(), new Date(NOW + 7 * DAY).toISOString()])
  assert.equal(st.platform, 'cloudflare-workers')
  assert.equal(st.target, 'https://app.example.com')
  assert.equal(st.rollbackTested, false)
  assert.equal(st.releaseCount, 1)
  assert.deepEqual(st.logs, { source: 'workers-observability', retentionDays: 3 })
})

test('K2 cf: bài thử nhanh với header override thật sự trúng BẢN MỚI (Cloudflare chỉ nghe header với bản nằm trong deployment); đạt ⇒ bản mới 100% một mình', () => {
  const f = fixture()
  const { w, handler } = cfWorld()
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, handler).run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.equal(w.served, ID, 'bản chạy bài thử nhanh phải là bản mới, không phải bản cũ')
  assert.deepEqual(w.deployment, [{ version_id: ID, percentage: 100 }])
})

test('K2 cf: thử nhanh trượt ⇒ gỡ bản mới khỏi deployment (bản cũ 100% một mình), exit 1, không ghi trạng thái, báo rõ', () => {
  const f = fixture()
  const { w, handler } = cfWorld({ smokeFails: true })
  const { run, calls, kinds } = fakeRun(f, handler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deployments status', 'wrangler:versions deploy', 'probe', 'playwright', 'wrangler:deployments status', 'wrangler:versions deploy'])
  assert.equal(w.served, ID, 'bài thử đã chạy vào bản mới nên trượt là trượt thật')
  assert.deepEqual(calls.at(-1).args, [f.wr, 'versions', 'deploy', `${OLD}@100%`, '-y'])
  assert.deepEqual(w.deployment, [{ version_id: OLD, percentage: 100 }], 'bản mới không còn trong deployment')
  assert.ok(!calls.some(opens), 'không có lệnh mở bản mới 100%')
  assert.match(r.lines[0], /CHƯA mở/)
  assert.match(r.lines.join('\n'), /bản đang chạy giữ nguyên/)
  assert.match(r.lines.join('\n'), /expected visible/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('K2 cf: thử nhanh trượt mà gỡ bản mới cũng lỗi ⇒ vẫn exit 1, nói bản mới còn ở 0% (chưa ai thấy) kèm lệnh gỡ tay', () => {
  const f = fixture()
  const { handler } = cfWorld({ smokeFails: true })
  const { run } = fakeRun(f, (c) => (c.kind === 'wrangler:versions deploy' && c.args.includes(`${OLD}@100%`) && !c.args.includes(`${ID}@0%`) ? wranglerFail('A request to the Cloudflare API failed [code: 10001]') : handler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /CHƯA mở/)
  assert.match(text, /gỡ bản mới khỏi deployment không được[\s\S]*A request to the Cloudflare API failed/)
  assert.match(text, /vẫn ở 0%[\s\S]*chưa ai thấy/)
  assert.ok(text.includes(`versions deploy ${OLD}@100% -y`), text)
  assert.doesNotMatch(text, /Logs were written|\u001b/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('K2 cf: không gắn được bản mới ở 0% vào deployment ⇒ exit 1, không thử nhanh, không mở 100%, bản đang chạy không bị đụng', () => {
  const f = fixture()
  const { run, calls, kinds } = fakeRun(f, (c) => (c.kind === 'wrangler:versions deploy' ? wranglerFail('Version is not deployable [code: 10215]') : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deployments status', 'wrangler:versions deploy'])
  assert.deepEqual(calls.at(-1).args, [f.wr, 'versions', 'deploy', `${OLD}@100%`, `${ID}@0%`, '-y'])
  assert.match(r.lines[0], /Version is not deployable/)
  assert.match(r.lines.join('\n'), /chưa ai thấy bản mới/)
  assert.doesNotMatch(r.lines.join('\n'), /Logs were written/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('K2 cf: không đọc được bản đang chạy (lỗi, không phải JSON, không có bản nào 100%, đang chia tải) ⇒ exit 1, KHÔNG thử nhanh vào bản cũ, không mở gì', () => {
  const cases = [
    ['wrangler lỗi', () => wranglerFail('The Worker my-app has no deployments.'), /no deployments/],
    ['không phải JSON', () => ({ stdout: 'Created: 2026-10-12\nVersion(s): (100%) x\n' }), /đọc được bản đang chạy/],
    ['deployment rỗng', () => deployStatus([]), /đọc được bản đang chạy/],
    ['đang chia tải 70/30', () => deployStatus([{ version_id: OLD, percentage: 70 }, { version_id: '77777777-6666-5555-4444-333333333333', percentage: 30 }]), /chia tải/],
  ]
  for (const [name, status, re] of cases) {
    const f = fixture()
    const { run, kinds } = fakeRun(f, (c) => (c.kind === 'wrangler:deployments status' ? status() : okHandler(c)))
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
    const text = r.lines.join('\n')
    assert.equal(r.code, EXIT.FAIL, name)
    assert.match(text, re, name)
    assert.match(text, /chưa thử và chưa mở/, name)
    assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deployments status'], `${name}: dừng ngay sau khi đọc`)
    assert.equal(fs.existsSync(statePath(f.dir)), false, name)
  }
})

test('K2 cf: deployment còn sót bản 0% từ lần trước (cũ 100% + khác 0%) ⇒ lấy đúng bản 100% làm bản cũ, không gắn bản sót lại', () => {
  const f = fixture()
  const leftover = '77777777-6666-5555-4444-333333333333'
  const { run, calls } = fakeRun(f, okHandler, [{ version_id: leftover, percentage: 0 }, { version_id: OLD, percentage: 100 }])
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(calls.find((c) => c.kind === 'wrangler:versions deploy').args, [f.wr, 'versions', 'deploy', `${OLD}@100%`, `${ID}@0%`, '-y'])
})

// ---------- finding 2: xác nhận địa chỉ thật đang phục vụ ĐÚNG bản mới (x-flow-version) trước khi thử nhanh và mở ----------

const probeIs = (version) => ({ stdout: `${JSON.stringify({ status: 200, version })}\n` })
const probeCalls = (calls) => calls.filter((c) => c.kind === 'probe')
// Phát hành một lần với `probe(callIndex)` quyết định câu trả lời của mỗi lần dò (thiếu ⇒ như Cloudflare thật qua okHandler).
function releaseWithProbe(probe, over = {}) {
  const f = fixture()
  const sleeps = []
  let n = 0
  const a = fakeRun(f, (c) => (c.kind === 'probe' ? (probe(++n, c) ?? okHandler(c)) : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f.so, ...GATE, sleep: (ms) => sleeps.push(ms), ...over })
  return { f, r, sleeps, text: r.lines.join('\n'), ...a }
}
// Sau khi không xác nhận được: bản mới bị gỡ (cũ@100% một mình), không thử nhanh, không mở 100%, không ghi trạng thái.
function assertNotOpened({ f, r, calls, kinds }) {
  assert.equal(r.code, EXIT.FAIL)
  assert.ok(!kinds().includes('playwright'), 'chưa xác nhận được thì chưa thử nhanh')
  assert.ok(!calls.some(opens), 'không mở bản mới 100%')
  assert.deepEqual(calls.at(-1).args, [f.wr, 'versions', 'deploy', `${OLD}@100%`, '-y'], 'gỡ bản mới: bản cũ 100% một mình')
  assert.match(r.lines[0], /CHƯA mở/)
  assert.match(r.lines[0], /bản đang chạy giữ nguyên/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
}

test('finding 2 cf: override chưa áp dụng kịp (vài lần đầu địa chỉ vẫn trả bản cũ) ⇒ dò lại cách 2 giây tới khi x-flow-version == bản mới, rồi mới thử nhanh và mở 100%', () => {
  const x = releaseWithProbe((n) => (n <= 3 ? probeIs(OLD) : undefined))
  assert.equal(x.r.code, EXIT.OK, x.text)
  assert.equal(probeCalls(x.calls).length, 4)
  assert.deepEqual(x.sleeps, [2000, 2000, 2000])
  assert.deepEqual(x.kinds().filter((k) => k === 'probe' || k === 'playwright'), ['probe', 'probe', 'probe', 'probe', 'playwright'], 'thử nhanh chỉ chạy SAU khi dò khớp')
  assert.ok(x.calls.some(opens))
})

test('finding 2 cf: sau 10 lần dò địa chỉ vẫn trả bản cũ ⇒ gỡ bản mới (cũ@100%), exit 1, nói rõ, KHÔNG thử nhanh, KHÔNG mở 100%', () => {
  const x = releaseWithProbe(() => probeIs(OLD))
  assertNotOpened(x)
  assert.equal(probeCalls(x.calls).length, 10, 'dò có giới hạn: 10 lần')
  assert.equal(x.sleeps.length, 9)
  assert.match(x.text, /Sau 10 lần dò[\s\S]*vẫn trả bản 99999999 chứ không phải bản mới \(11111111\)[\s\S]*--worker\/--url trỏ nhầm/)
})

test('finding 2 cf: --worker sai tên (Cloudflare bỏ qua header override cho Worker khác) ⇒ không xác nhận được, gỡ bản mới, không mở', () => {
  const f = fixture()
  const a = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', worker: 'ten-sai', run: a.run, now: NOW, stateOpts: f.so, ...GATE })
  assertNotOpened({ f, r, calls: a.calls, kinds: a.kinds })
  assert.match(r.lines.join('\n'), /--worker\/--url trỏ nhầm/)
})

test('finding 2 cf: Worker KHÔNG trả header x-flow-version ⇒ exit 1 trước khi mở, bảo thêm binding version_metadata theo công thức; không promote khi không xác nhận được', () => {
  const x = releaseWithProbe(() => probeIs(null))
  assertNotOpened(x)
  assert.equal(probeCalls(x.calls).length, 10, 'lần đầu thêm binding thì bản cũ cũng chưa có header: dò đủ lượt rồi mới kết luận')
  assert.match(x.text, new RegExp(`không trả header ${VERSION_HEADER}`))
  assert.match(x.text, /version_metadata/)
  assert.match(x.text, /CF_VERSION_METADATA\.id/)
  assert.match(x.text, /recipes\/cloudflare-workers\.md/)
})

test('finding 2 cf: không gọi được địa chỉ (mạng/DNS) ⇒ cũng không mở; nói lý do thật', () => {
  const x = releaseWithProbe(() => ({ status: 2, stderr: 'ENOTFOUND\n' }))
  assertNotOpened(x)
  assert.match(x.text, /Không gọi được https:\/\/app\.example\.com[\s\S]*ENOTFOUND/)
})

test('finding 2 cf K1 --first-release: header == "Current Version ID" ⇒ thử nhanh; thiếu header ⇒ chỉ cảnh báo (vẫn thử nhanh, vẫn ghi mốc); header là bản KHÁC ⇒ dừng, không thử nhầm site', () => {
  const run1 = (probe, over = {}) => {
    const f = fixture()
    const a = fakeRun(f, (c) => (c.kind === 'probe' ? probe : firstWorld(over)(c)))
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f.so, ...GATE })
    return { f, r, text: r.lines.join('\n'), ...a }
  }
  const match = run1(probeIs(ID))
  assert.equal(match.r.code, EXIT.OK, match.text)
  assert.doesNotMatch(match.text, /Cảnh báo/)
  const none = run1(probeIs(null))
  assert.equal(none.r.code, EXIT.OK, none.text)
  assert.ok(none.kinds().includes('playwright'))
  assert.match(none.text, /Cảnh báo: .*không trả header x-flow-version[\s\S]*version_metadata/)
  assert.equal(readState(none.f.dir, none.f.so).lastRelease.version, ID)
  const other = run1(probeIs(OLD))
  assert.equal(other.r.code, EXIT.FAIL)
  assert.ok(!other.kinds().includes('playwright'))
  assert.match(other.text, /đang trả bản 99999999[\s\S]*không phải app của Worker vừa tạo/)
  assert.equal(fs.existsSync(statePath(other.f.dir)), false)
  assert.equal(probeCalls(other.calls).length, 10)
})

test('PROBE_SRC chạy thật (node + HTTP cục bộ): gửi header override, đọc x-flow-version; không đi theo redirect; không có header ⇒ version null; cổng đóng ⇒ exit 2 kèm lý do', async () => {
  const server = http.createServer((req, res) => {
    if (req.headers[OVERRIDE_HEADER.toLowerCase()] === 'my-app="abc"') res.setHeader(VERSION_HEADER, 'ABC')
    res.statusCode = 302
    res.setHeader('location', '/dich-khac')
    res.end('chuyển')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const probe = (url, headers) => execFileP(process.execPath, ['-e', PROBE_SRC], { env: { ...process.env, PROBE_URL: url, PROBE_HEADERS: JSON.stringify(headers) }, timeout: 30_000 })
  try {
    const hit = await probe(`http://127.0.0.1:${port}/`, { [OVERRIDE_HEADER]: 'my-app="abc"' })
    assert.deepEqual(JSON.parse(hit.stdout), { status: 302, version: 'ABC' })
    const none = await probe(`http://127.0.0.1:${port}/`, {})
    assert.deepEqual(JSON.parse(none.stdout), { status: 302, version: null })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  await assert.rejects(probe(`http://127.0.0.1:${port}/`, {}), (e) => e.code === 2 && /ECONNREFUSED/.test(e.stderr))
})

// ---------- finding 3: phát hành đạt thì lưu --url đã thử; --url khác target đã lưu thì cảnh báo ----------

test('finding 3 cf: phát hành đạt với --url mới ⇒ lưu làm target (lượt sau bỏ --url thử đúng site này); target dạng object giữ trường khác', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, target: 'https://cu.example.com' }, f.so)
  const r1 = releaseCf({ dir: f.dir, url: 'https://moi.example.com', run: fakeRun(f, cfWorld().handler).run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r1.code, EXIT.OK, r1.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).target, 'https://moi.example.com')
  const a = fakeRun(f, cfWorld().handler)
  const r2 = releaseCf({ dir: f.dir, run: a.run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r2.code, EXIT.OK, r2.lines.join('\n'))
  assert.equal(a.calls.find((c) => c.kind === 'playwright').opts.env.BASE_URL, 'https://moi.example.com', 'bỏ --url ⇒ thử đúng site vừa phát hành')
  const g = fixture()
  writeState(g.dir, { v: 1, target: { url: 'https://cu.example.com', note: 'giữ' } }, g.so)
  const r3 = releaseCf({ dir: g.dir, url: 'https://moi.example.com', run: fakeRun(g, cfWorld().handler).run, now: NOW, stateOpts: g.so, ...GATE })
  assert.equal(r3.code, EXIT.OK, r3.lines.join('\n'))
  assert.deepEqual(readState(g.dir, g.so).target, { url: 'https://moi.example.com', note: 'giữ' })
})

test('finding 3 cf --first-release: lần đầu cũng lưu --url đã thử làm target', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, target: 'https://cu.example.com' }, f.so)
  const r = releaseCf({ dir: f.dir, url: 'https://moi.example.com', run: fakeRun(f, firstWorld()).run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).target, 'https://moi.example.com')
})

test('finding 3 cf: --url khác target đã lưu ⇒ cảnh báo ở đầu kết quả; cùng địa chỉ (kể cả thêm dấu /), không có --url, hoặc chưa lưu gì ⇒ không cảnh báo', () => {
  const warn = (saved, url) => {
    const f = fixture()
    if (saved) writeState(f.dir, { v: 1, target: saved }, f.so)
    const r = releaseCf({ dir: f.dir, url, run: fakeRun(f, cfWorld().handler).run, now: NOW, stateOpts: f.so, ...GATE })
    assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
    return r.lines.filter((l) => /^Cảnh báo: --url/.test(l))
  }
  const diff = warn('https://cu.example.com', 'https://moi.example.com')
  assert.equal(diff.length, 1)
  assert.match(diff[0], /--url \(https:\/\/moi\.example\.com\) khác địa chỉ đã lưu[\s\S]*https:\/\/cu\.example\.com[\s\S]*"my-app"/)
  assert.equal(warn({ url: 'https://cu.example.com' }, 'https://moi.example.com').length, 1, 'target dạng object cũng được so')
  assert.equal(warn('https://cu.example.com', 'https://cu.example.com/').length, 0)
  assert.equal(warn('https://cu.example.com', undefined).length, 0)
  assert.equal(warn(null, 'https://moi.example.com').length, 0)
})

// ---------- finding 4: hai lượt phát hành chồng nhau — chỉ đổi lưu lượng khi deployment vẫn là của lượt này ----------

const OTHER = '55555555-4444-3333-2222-111111111111' // bản do lượt phát hành KHÁC vừa mở 100%

test('finding 4 cf: lượt khác phát hành xong (B@100%) trong lúc bài thử nhanh của lượt này chạy ⇒ lượt này KHÔNG mở bản mới, không gỡ; báo có lượt khác; không ghi trạng thái', () => {
  const f = fixture()
  const { run, calls } = fakeRun(f, (c) => {
    if (c.kind === 'playwright') c.world.deployment = [{ version_id: OTHER, percentage: 100 }] // B phát hành xong giữa chừng
    return okHandler(c)
  })
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(text, /có lượt phát hành khác vừa đổi app/i)
  assert.match(text, /deployments status/)
  assert.ok(!calls.some(opens), 'không mở bản mới đè lên B')
  assert.equal(calls.filter((c) => c.kind === 'wrangler:versions deploy').length, 1, 'chỉ có lệnh gắn 0% lúc đầu; không lệnh nào đổi lưu lượng sau đó')
  assert.deepEqual(calls.at(-1).kind, 'wrangler:deployments status')
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('finding 4 cf: bài thử nhanh trượt mà lượt khác đã đổi deployment ⇒ KHÔNG gỡ về bản cũ (không hạ bản của lượt kia); báo có lượt khác', () => {
  const f = fixture()
  const { run, calls } = fakeRun(f, (c) => {
    if (c.kind === 'playwright') { c.world.deployment = [{ version_id: OTHER, percentage: 100 }]; return { status: 1, stdout: 'Error: expected visible' } }
    return okHandler(c)
  })
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /CHƯA mở/)
  assert.match(text, /có lượt phát hành khác vừa đổi app/i)
  assert.match(text, /expected visible/)
  assert.ok(!calls.some(pulls), 'không triển khai lại bản cũ đè lên lượt kia')
  assert.ok(!calls.some(opens))
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('finding 4 cf: không đọc lại được deployment lúc sắp mở / sắp gỡ ⇒ không đụng gì, nói "chưa rõ" kèm lệnh kiểm', () => {
  const unreadable = (smokeFails) => {
    const f = fixture()
    let status = 0
    const a = fakeRun(f, (c) => {
      if (c.kind === 'wrangler:deployments status' && ++status === 2) return wranglerFail('network down')
      if (c.kind === 'playwright' && smokeFails) return { status: 1, stdout: 'boom' }
      return okHandler(c)
    })
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f.so, ...GATE })
    return { r, text: r.lines.join('\n'), ...a }
  }
  for (const smokeFails of [false, true]) {
    const x = unreadable(smokeFails)
    assert.equal(x.r.code, EXIT.FAIL, String(smokeFails))
    assert.match(x.text, /Chưa rõ app đang chạy bản nào[\s\S]*deployments status/, String(smokeFails))
    assert.equal(x.calls.filter((c) => c.kind === 'wrangler:versions deploy').length, 1, `${smokeFails}: chỉ lệnh gắn 0%`)
  }
})

// ---------- finding 5: lệnh đổi lưu lượng lỗi/hết giờ ⇒ đọc lại deployment rồi mới kết luận ----------

test('finding 5 cf: lệnh mở 100% báo hết giờ nhưng Cloudflare đã áp dụng ⇒ báo ĐÚNG là bản mới đang chạy 100% và vẫn ghi mốc phát hành (không nói "vẫn 0%")', () => {
  const f = fixture()
  const { run, calls } = fakeRun(f, (c) => {
    if (opens(c)) { c.world.deployment = deploymentOf(c.args); return { status: null, error: 'ETIMEDOUT' } }
    return okHandler(c)
  })
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.OK, text)
  assert.match(text, /Đã mở bản mới \(11111111\) cho mọi người dùng/)
  assert.match(text, /Lệnh mở báo lỗi \(ETIMEDOUT\) nhưng đối chiếu lại thấy bản mới đã chạy 100%/)
  assert.doesNotMatch(text, /vẫn ở 0%/)
  assert.equal(calls.filter((c) => c.kind === 'wrangler:deployments status').length, 3, 'đọc bản đang chạy, đọc trước khi mở, đọc lại sau lỗi')
  const st = readState(f.dir, f.so)
  assert.equal(st.lastRelease.version, ID)
  assert.equal(st.releaseCount, 1)
  assert.equal(st.checkAt.length, 2)
})

test('finding 5 cf: lệnh mở 100% lỗi và đọc lại thấy vẫn 0% ⇒ như cũ (vẫn ở 0%, lệnh mở lại); đọc lại không được / deployment đã khác ⇒ "chưa rõ" + lệnh kiểm, không ghi trạng thái', () => {
  const f1 = fixture()
  const a = fakeRun(f1, (c) => (opens(c) ? wranglerFail('API error') : okHandler(c)))
  const r1 = releaseCf({ dir: f1.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f1.so, ...GATE })
  assert.equal(r1.code, EXIT.FAIL)
  assert.match(r1.lines.join('\n'), /vẫn ở 0%[\s\S]*chưa ai thấy/)
  assert.ok(r1.lines.join('\n').includes(`versions deploy ${ID}@100% -y`))
  for (const [name, after] of [['không đọc được', () => wranglerFail('network down')], ['đã khác', () => deployStatus([{ version_id: OTHER, percentage: 100 }])]]) {
    const f = fixture()
    let status = 0
    const b = fakeRun(f, (c) => {
      if (c.kind === 'wrangler:deployments status' && ++status === 3) return after()
      return opens(c) ? wranglerFail('API error') : okHandler(c)
    })
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: b.run, now: NOW, stateOpts: f.so, ...GATE })
    const text = r.lines.join('\n')
    assert.equal(r.code, EXIT.FAIL, name)
    assert.match(text, /chưa rõ kết quả/, name)
    assert.match(text, /deployments status/, name)
    assert.doesNotMatch(text, /Đã mở bản mới/, name)
    assert.equal(fs.existsSync(statePath(f.dir)), false, name)
  }
})

test('finding 5 cf: lệnh gỡ bản mới báo lỗi nhưng thực ra đã gỡ xong ⇒ không nói "gỡ không được"; chưa rõ ⇒ nói chưa rõ kèm lệnh kiểm', () => {
  const f = fixture()
  const gone = fakeRun(f, (c) => {
    if (pulls(c)) { c.world.deployment = deploymentOf(c.args); return { status: null, error: 'ETIMEDOUT' } }
    return c.kind === 'playwright' ? { status: 1, stdout: 'Error: expected visible' } : okHandler(c)
  })
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: gone.run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /CHƯA mở[\s\S]*bản đang chạy giữ nguyên/)
  assert.doesNotMatch(text, /gỡ bản mới khỏi deployment không được/)
  const g = fixture()
  let status = 0
  const unsure = fakeRun(g, (c) => {
    if (c.kind === 'wrangler:deployments status' && ++status === 3) return wranglerFail('network down')
    if (pulls(c)) return { status: null, error: 'ETIMEDOUT' }
    return c.kind === 'playwright' ? { status: 1, stdout: 'boom' } : okHandler(c)
  })
  const r2 = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: unsure.run, now: NOW, stateOpts: g.so, ...GATE })
  assert.equal(r2.code, EXIT.FAIL)
  assert.match(r2.lines.join('\n'), /Chưa rõ kết quả[\s\S]*deployments status[\s\S]*versions deploy 99999999-8888-7777-6666-555555555555@100% -y/)
})

// ---------- L3 / L4 ----------

test('L3 cf: bài thử nhanh trượt ⇒ lời trích giữ dòng Expected/Received (không chỉ vài dòng cuối), cắt ngắn; nhánh trượt cũng giữ dòng "Cảnh báo:" của preflight', () => {
  const noisy = [
    'Running 1 test using 1 worker',
    '  1) [chromium] › tests/smoke.spec.ts:5:1 › @smoke trang chủ ──────',
    '    Error: expect(locator).toHaveText(expected) // deep equality',
    '    Expected: "Việc cần làm"',
    `    Received: "${'Lỗi '.repeat(80)}"`,
    '    Call log:',
    '      - Expect "toHaveText" with timeout 5000ms',
    '      - waiting for getByRole(\'heading\')',
    '      at tests/smoke.spec.ts:7:3',
    '  1 failed',
    '    [chromium] › tests/smoke.spec.ts:5:1 › @smoke trang chủ',
  ].join('\n')
  const f = fixture()
  const { run } = fakeRun(f, (c) => (c.kind === 'playwright' ? { status: 1, stdout: noisy } : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE, zapExit: 2 })
  const quoted = r.lines.filter((l) => l.startsWith('  | '))
  assert.equal(r.code, EXIT.FAIL)
  assert.ok(quoted.some((l) => /Expected: "Việc cần làm"/.test(l)), quoted.join('\n'))
  assert.ok(quoted.some((l) => /Received: "Lỗi/.test(l)))
  assert.ok(quoted.every((l) => l.length <= 204), 'mỗi dòng cắt ngắn')
  assert.ok(quoted.length <= 8)
  assert.ok(quoted.some((l) => /@smoke trang chủ/.test(l)), 'vẫn có tên bài trượt ở cuối')
  assert.match(r.lines[0], /^Cảnh báo: .*mức vừa/, 'nhánh trượt giữ cảnh báo của preflight như nhánh đạt')
})

test('L3 cf --first-release / rollback: thử nhanh trượt cũng trích Expected/Received và giữ cảnh báo preflight', () => {
  const noisy = 'Error: expect(page).toHaveTitle\nExpected: "A"\nReceived: "B"\nCall log:\n  - a\n  - b\n  - c\n  - d\n  1 failed'
  const f = fixture()
  const first = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, (c) => (c.kind === 'playwright' ? { status: 1, stdout: noisy } : firstWorld()(c))).run, now: NOW, stateOpts: f.so, ...GATE, zapExit: 2 })
  assert.equal(first.code, EXIT.FAIL)
  assert.match(first.lines[0], /^Cảnh báo: .*mức vừa/)
  assert.ok(first.lines.some((l) => /Received: "B"/.test(l)), first.lines.join('\n'))
  const g = fixture()
  writeState(g.dir, { v: 1, target: 'https://app.example.com' }, g.so)
  const rb = rollbackCf({ dir: g.dir, run: fakeRun(g, (c) => (c.kind === 'playwright' ? { status: 1, stdout: noisy } : {})).run, stateOpts: g.so })
  assert.equal(rb.code, EXIT.FAIL)
  assert.ok(rb.lines.some((l) => /Expected: "A"/.test(l)), rb.lines.join('\n'))
})

test('L4 cf: lastRelease.at và mốc nhắc tính từ lúc MỞ 100% (clock sau khi promote), không phải giờ bắt đầu lệnh', () => {
  const calls = []
  const f = fixture()
  const clock = () => { calls.push('clock'); return NOW + 41_000 }
  const a = fakeRun(f, (c) => { calls.push(c.kind === 'wrangler:versions deploy' ? (opens(c) ? 'open' : 'attach') : c.kind); return okHandler(c) })
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, clock, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  const st = readState(f.dir, f.so)
  assert.equal(st.lastRelease.at, new Date(NOW + 41_000).toISOString())
  assert.deepEqual(st.checkAt, [new Date(NOW + 41_000 + DAY).toISOString(), new Date(NOW + 41_000 + 7 * DAY).toISOString()])
  assert.ok(calls.lastIndexOf('clock') > calls.lastIndexOf('open'), `đọc giờ SAU lệnh mở 100%: ${calls.join(',')}`)
  assert.equal(calls.filter((x) => x === 'clock').length, 1)
  const g = fixture()
  const first = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: fakeRun(g, firstWorld()).run, now: NOW, clock, stateOpts: g.so, ...GATE })
  assert.equal(first.code, EXIT.OK, first.lines.join('\n'))
  assert.equal(readState(g.dir, g.so).lastRelease.at, new Date(NOW + 41_000).toISOString())
})

test('cf: ghi giữ trường sẵn có (rollbackTested, backup, trường lạ) và dùng target trong release.json làm địa chỉ', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, target: 'https://co-san.example.com', rollbackTested: true, backup: { choice: 'off' }, lạ: 1, checkAt: ['2020-01-01T00:00:00.000Z'] }, f.so)
  const { run, calls } = fakeRun(f, okHandler)
  assert.equal(releaseCf({ dir: f.dir, run, now: NOW, stateOpts: f.so, hooksDir: HOOKS_DIR }).code, 0, 'rollbackTested đã true ⇒ không cần --first-release')
  assert.equal(calls.find((c) => c.kind === 'playwright').opts.env.BASE_URL, 'https://co-san.example.com')
  const st = readState(f.dir, f.so)
  assert.equal(st.rollbackTested, true)
  assert.deepEqual(st.backup, { choice: 'off' })
  assert.equal(st.lạ, 1)
  assert.equal(st.checkAt.length, 2, 'mốc cũ được thay bằng mốc của lần phát hành mới')
})

// --- ghi trạng thái cùng lúc với `backup` (lịch sao lưu tự chạy song song với phát hành) ---
// Mỗi lần ghi của release chỉ gộp trường của mình trên bản MỚI NHẤT của file: lastBackup do backup ghi giữa chừng không bị mất.
const iso = (ms) => new Date(ms).toISOString()
const BACKUP_ON = { choice: 'on', method: 'd1', db: 'kho', everyHours: 24, scheduler: { kind: 'cron', id: 'flow-backup-x' }, lastBackup: iso(NOW - 5 * 3600000), lastRestoreCheck: iso(NOW - DAY) }
const NEWER_BACKUP = iso(NOW - 60000)
// handler: tới lúc thử nhanh thì "backup" ghi lastBackup mới (và mốc khôi phục thử mới) vào release.json
const backupWritesDuringSmoke = (f, inner = () => ({})) => (c) => {
  if (c.kind === 'playwright') writeState(f.dir, { ...readState(f.dir, f.so), backup: { ...BACKUP_ON, lastBackup: NEWER_BACKUP, lastRestoreCheck: NEWER_BACKUP } }, f.so)
  return inner(c)
}
const keptBackup = (f) => {
  const st = readState(f.dir, f.so)
  assert.equal(st.backup.lastBackup, NEWER_BACKUP)
  assert.equal(st.backup.lastRestoreCheck, NEWER_BACKUP)
  assert.deepEqual(st.backup.scheduler, BACKUP_ON.scheduler)
  return st
}

test('cf: backup ghi lastBackup trong lúc thử nhanh ⇒ phát hành xong lastBackup vẫn còn, cùng lastRelease + mốc nhắc mới', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, rollbackTested: true, backup: BACKUP_ON, health: { lastAt: iso(NOW - DAY) } }, f.so)
  const { run } = fakeRun(f, backupWritesDuringSmoke(f, okHandler))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, hooksDir: HOOKS_DIR })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  const st = keptBackup(f)
  assert.equal(st.lastRelease.version, ID)
  assert.equal(st.checkAt.length, 2)
  assert.deepEqual(st.health, { lastAt: iso(NOW - DAY) })
})

test('rollback cf: backup ghi trong lúc thử nhanh ⇒ rollbackTested = true và lastBackup vẫn còn', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, target: 'https://app.example.com', rollbackTested: false, backup: BACKUP_ON, lastRelease: { at: iso(NOW), version: ID, smoke: 'pass' } }, f.so)
  const { run } = fakeRun(f, backupWritesDuringSmoke(f))
  assert.equal(rollbackCf({ dir: f.dir, run, stateOpts: f.so }).code, EXIT.OK)
  const st = keptBackup(f)
  assert.equal(st.rollbackTested, true)
  assert.equal(st.lastRelease.version, ID)
})

test('vps --run: backup ghi trong lúc thử nhanh ⇒ lastBackup vẫn còn cạnh lastRelease/vps; --rollback --run cũng vậy', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, rollbackTested: true, backup: BACKUP_ON }, f.so)
  const a = fakeRun(f, backupWritesDuringSmoke(f, (c) => (c.kind === 'git' ? { stdout: 'abc1234\n' } : {})))
  const r = releaseVps({ dir: f.dir, run: a.run, ...VPS, sha: undefined, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  const st = keptBackup(f)
  assert.equal(st.lastRelease.version, 'abc1234')
  assert.equal(st.vps.host, 'deploy@203.0.113.7')
  const g = fixture()
  writeState(g.dir, { v: 1, rollbackTested: false, backup: BACKUP_ON }, g.so)
  const b = fakeRun(g, backupWritesDuringSmoke(g))
  assert.equal(releaseVps({ dir: g.dir, run: b.run, ...VPS, rollback: true, doRun: true, url: 'https://app.example.com', stateOpts: g.so, now: NOW }).code, EXIT.OK)
  assert.equal(keptBackup(g).rollbackTested, true)
})

test('release.json đang hỏng: phát hành xong vẫn báo thành công nhưng KHÔNG ghi đè file, nói rõ vì sao chưa ghi mốc; dropDueMarks cũng không ghi đè', () => {
  const f = fixture()
  fs.mkdirSync(path.dirname(statePath(f.dir)), { recursive: true })
  fs.writeFileSync(statePath(f.dir), '{ hỏng')
  const { run } = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /Chưa ghi được mốc nhắc vì \.claude\/release\.json đang hỏng/)
  assert.equal(fs.readFileSync(statePath(f.dir), 'utf8'), '{ hỏng')
  const rb = rollbackCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f).run, stateOpts: f.so })
  assert.equal(rb.code, EXIT.OK)
  assert.match(rb.lines.join('\n'), /đang hỏng/)
  assert.equal(dropDueMarks(f.dir, NOW, f.so), false)
  assert.equal(fs.readFileSync(statePath(f.dir), 'utf8'), '{ hỏng')
})

// K1: nghiệm thu thật — Worker chưa từng tồn tại thì `wrangler versions upload` từ chối, người không code kẹt ngay lần phát hành đầu.
const NOT_EXIST = "You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first."
const firstDeployOut = `Uploaded my-app (9.65 sec)\nDeployed my-app triggers (2.48 sec)\n  https://my-app.example.workers.dev\nCurrent Version ID: ${ID}\n`
// Worker chưa có: upload lỗi như wrangler thật; `wrangler deploy` tạo Worker và in "Current Version ID".
const firstWorld = (over = {}) => (c) => {
  if (c.kind === 'wrangler:versions upload') return wranglerFail(NOT_EXIST)
  if (c.kind === 'wrangler:deploy') {
    if (over.deployFails) return over.deployFails
    c.world.deployment = [{ version_id: ID, percentage: 100 }] // Worker mới tạo, một bản 100%
    return { stdout: firstDeployOut }
  }
  if (c.kind === 'playwright' && over.smokeFails) return { status: 1, stdout: 'Error: expected visible' }
  return okHandler(c)
}

test('K1 cf --first-release: Worker chưa tồn tại ⇒ wrangler deploy tạo Worker, thử nhanh địa chỉ thật (không header), ghi mốc; không versions deploy/deployments status', () => {
  const f = fixture()
  const { run, calls, kinds } = fakeRun(f, firstWorld())
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deploy', 'probe', 'playwright'])
  const dep = calls.find((c) => c.kind === 'wrangler:deploy')
  assert.deepEqual(dep.args, [f.wr, 'deploy', '--message', 'flow release abc1234'])
  assert.equal(dep.opts.cwd, f.dir)
  const sm = calls.find((c) => c.kind === 'playwright')
  assert.equal(sm.opts.env.BASE_URL, 'https://app.example.com')
  assert.equal(sm.opts.env.SMOKE_EXTRA_HTTP_HEADERS, undefined, 'đã 100% nên không cần header override')
  const text = r.lines.join('\n')
  assert.match(text, /lần đầu/)
  assert.match(text, new RegExp(ID.slice(0, 8)))
  const st = readState(f.dir, f.so)
  assert.equal(st.lastRelease.version, ID)
  assert.equal(st.lastRelease.smoke, 'pass')
  assert.equal(st.releaseCount, 1)
  assert.equal(st.platform, 'cloudflare-workers')
  assert.equal(st.checkAt.length, 2)
})

test('K1 cf --first-release: thử nhanh trượt sau khi tạo Worker ⇒ exit 1, nói app đang chạy bản lỗi nhưng chưa ai dùng, sửa rồi phát hành lại; không ghi trạng thái', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, firstWorld({ smokeFails: true }))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload', 'wrangler:deploy', 'probe', 'playwright'])
  assert.match(text, /bài thử nhanh trượt/i)
  assert.match(text, /đang chạy bản lỗi/)
  assert.match(text, /chưa có người dùng|chưa ai dùng/)
  assert.match(text, /sửa[\s\S]*phát hành lại/i)
  assert.match(text, /expected visible/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('K1 cf: Worker chưa tồn tại mà KHÔNG có --first-release ⇒ exit 3, bảo thêm --first-release, không deploy gì', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, firstWorld())
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, hooksDir: HOOKS_DIR })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.MISSING)
  assert.match(text, /chưa có trên Cloudflare|chưa tồn tại/)
  assert.match(text, /--first-release/)
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload'], 'không chạy wrangler deploy khi user chưa đồng ý')
  assert.doesNotMatch(text, /Logs were written|\u001b/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('K1 cf --first-release mà Worker ĐÃ có (vd chạy lại sau khi lần đầu trượt) ⇒ vẫn đi đường an toàn 0% → thử nhanh → 100%, không wrangler deploy thẳng', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.ok(!kinds().includes('wrangler:deploy'), kinds().join(' '))
  assert.ok(kinds().includes('wrangler:deployments status'))
})

test('K1 cf --first-release: wrangler deploy lỗi ⇒ exit 1 (nêu dòng ERROR thật), chưa đăng nhập ⇒ exit 3; cả hai không thử nhanh, không ghi trạng thái', () => {
  const f = fixture()
  const bad = fakeRun(f, firstWorld({ deployFails: wranglerFail('Missing entry-point to Worker script or to assets directory') }))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: bad.run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /Missing entry-point/)
  assert.doesNotMatch(r.lines.join('\n'), /Logs were written|\u001b|✘/)
  assert.ok(!bad.kinds().includes('playwright'))
  const g = fixture()
  const login = fakeRun(g, firstWorld({ deployFails: { status: 1, stderr: 'You are not authenticated. Please run `wrangler login`.' } }))
  const l = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: login.run, now: NOW, stateOpts: g.so, ...GATE })
  assert.equal(l.code, EXIT.MISSING)
  assert.match(l.lines.join('\n'), /wrangler login/)
  assert.ok(!login.kinds().includes('playwright'))
  assert.equal(fs.existsSync(statePath(f.dir)) || fs.existsSync(statePath(g.dir)), false)
})

test('K1 cf --first-release: deploy xong nhưng wrangler không in mã bản ⇒ vẫn thử nhanh, vẫn ghi mốc (không có version)', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'wrangler:deploy' ? { stdout: 'Deployed my-app triggers\n' } : firstWorld()(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.ok(kinds().includes('playwright'))
  const st = readState(f.dir, f.so)
  assert.equal(st.lastRelease.smoke, 'pass')
  assert.equal(st.lastRelease.version, undefined)
})

test('cf: chưa đăng nhập Cloudflare ⇒ exit 3 + lời hướng dẫn đăng nhập, dừng ngay', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'wrangler:versions upload' ? { status: 1, stderr: 'You are not authenticated. Please run `wrangler login`.' } : {}))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.MISSING)
  assert.match(r.lines.join('\n'), /wrangler login/)
  assert.deepEqual(kinds(), [...PRE, 'git', 'wrangler:versions upload'])
})

test('cf: lỗi tải lên khác ⇒ exit 1, nói bản đang chạy không bị đụng', () => {
  const f = fixture()
  const { run } = fakeRun(f, (c) => (c.kind === 'wrangler:versions upload' ? { status: 1, stderr: 'Script too large' } : {}))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines.join('\n'), /Script too large[\s\S]*không bị đụng/)
})

test('cf: không đọc được mã bản mới ⇒ dừng trước khi thử nhanh', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'wrangler:versions upload' ? { stdout: 'Uploaded' } : {}))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.ok(!kinds().includes('playwright'))
})

test('cf: mở 100% lỗi ⇒ exit 1, bản mới vẫn 0% (bản cũ vẫn 100%), in lệnh mở lại, không ghi trạng thái', () => {
  const f = fixture()
  const { run } = fakeRun(f, (c) => (opens(c) ? { status: 1, stderr: 'API error' } : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines.join('\n'), new RegExp(`versions deploy ${ID}@100%`))
  assert.match(r.lines.join('\n'), /vẫn ở 0%/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('cf: preflight đã qua mà thiếu wrangler / Playwright / địa chỉ / tên Worker ⇒ exit 3 kèm cách xử lý, chỉ chạy preflight (chưa đụng Cloudflare)', () => {
  const cases = [
    [{ wrangler: false }, { url: 'https://a.example.com' }, /npm i -D wrangler/],
    [{ playwright: false }, { url: 'https://a.example.com' }, /@playwright\/test/],
    [{}, {}, /--url/],
    [{}, { url: 'không phải địa chỉ' }, /--url/],
    [{ config: 'none' }, { url: 'https://a.example.com' }, /--worker/],
  ]
  for (const [fx, opts, re] of cases) {
    const f = fixture(fx)
    fs.mkdirSync(path.join(f.dir, '.git'), { recursive: true }) // chặn pkgManager tìm lockfile lạ ở thư mục cha của thư mục tạm
    const { run, kinds } = fakeRun(f)
    const r = releaseCf({ dir: f.dir, run, now: NOW, stateOpts: f.so, ...GATE, ...opts })
    assert.equal(r.code, EXIT.MISSING, JSON.stringify(fx))
    assert.match(r.lines.join('\n'), re)
    assert.deepEqual(kinds(), PRE, 'chỉ preflight, không gọi wrangler/thử nhanh')
  }
})

test('BUG-2 cf: preflight chạy TRƯỚC khi kiểm công cụ / địa chỉ / tên Worker — còn mục chặn thì nêu danh sách chặn (exit 1) dù thiếu wrangler', () => {
  const noMarks = (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: không\nqa: không\ntest: có\n' } : {})
  const cases = [
    [{ wrangler: false }, { url: 'https://a.example.com' }],
    [{ playwright: false }, { url: 'https://a.example.com' }],
    [{}, {}],
    [{}, { url: 'không phải địa chỉ' }],
    [{ config: 'none' }, { url: 'https://a.example.com' }],
  ]
  for (const [fx, opts] of cases) {
    const f = fixture(fx)
    const { run, kinds } = fakeRun(f, noMarks)
    const r = releaseCf({ dir: f.dir, run, now: NOW, stateOpts: f.so, ...GATE, ...opts })
    const text = r.lines.join('\n')
    assert.equal(r.code, EXIT.FAIL, `${JSON.stringify(fx)} ${text}`)
    assert.match(text, /Chưa có dấu review/)
    assert.match(text, /Chưa có dấu QA/)
    assert.doesNotMatch(text, /Thiếu wrangler|Thiếu Playwright|--url|--worker/)
    assert.match(r.lines.at(-1), /Chưa tải gì lên Cloudflare/)
    assert.deepEqual(kinds(), PRE)
  }
})

test('BUG-5 pkgManager: pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock/không có → npm; nhận lockfile ở thư mục cha (monorepo), không vượt gốc repo', () => {
  const f = fixture()
  fs.mkdirSync(path.join(f.dir, '.git')) // chặn tìm lên quá gốc repo (tránh dính lockfile lạ ở thư mục tạm)
  assert.equal(pkgManager(f.dir), 'npm')
  fs.writeFileSync(path.join(f.dir, 'package-lock.json'), '{}')
  assert.equal(pkgManager(f.dir), 'npm')
  fs.writeFileSync(path.join(f.dir, 'yarn.lock'), '')
  assert.equal(pkgManager(f.dir), 'yarn')
  fs.writeFileSync(path.join(f.dir, 'pnpm-lock.yaml'), '')
  assert.equal(pkgManager(f.dir), 'pnpm')
  const g = fixture()
  fs.writeFileSync(path.join(g.root, 'pnpm-lock.yaml'), '')
  fs.mkdirSync(path.join(g.dir, 'apps', 'web'), { recursive: true })
  assert.equal(pkgManager(path.join(g.dir, 'apps', 'web')), 'pnpm', 'monorepo: lockfile ở thư mục cha')
  const h = fixture()
  fs.writeFileSync(path.join(h.root, 'pnpm-lock.yaml'), '')
  fs.mkdirSync(path.join(h.dir, '.git'))
  assert.equal(pkgManager(h.dir), 'npm', '.git là gốc repo: lockfile bên ngoài repo không tính')
})

test('BUG-5 cf/rollback: gợi ý cài và chạy theo trình quản lý gói của app (pnpm, yarn; mặc định npm)', () => {
  const cases = [
    ['pnpm-lock.yaml', /pnpm add -D wrangler --allow-build=workerd[\s\S]*pnpm approve-builds/, /pnpm add -D @playwright\/test[\s\S]*pnpm exec playwright install chromium/, 'pnpm exec wrangler login', 'pnpm exec wrangler versions deploy'],
    ['yarn.lock', /yarn add -D wrangler/, /yarn add -D @playwright\/test[\s\S]*yarn playwright install chromium/, 'yarn wrangler login', 'yarn wrangler versions deploy'],
    [null, /npm i -D wrangler/, /npm i -D @playwright\/test[\s\S]*npx playwright install chromium/, 'npx wrangler login', 'npx wrangler versions deploy'],
  ]
  for (const [lock, reWr, rePw, login, deploy] of cases) {
    const lockFile = (f) => { fs.mkdirSync(path.join(f.dir, '.git'), { recursive: true }); if (lock) fs.writeFileSync(path.join(f.dir, lock), '') }
    const a = fixture({ wrangler: false })
    lockFile(a)
    const ra = releaseCf({ dir: a.dir, url: 'https://a.example.com', run: fakeRun(a).run, now: NOW, stateOpts: a.so, ...GATE })
    assert.equal(ra.code, EXIT.MISSING)
    assert.match(ra.lines.join('\n'), reWr, String(lock))
    if (lock) assert.doesNotMatch(ra.lines.join('\n'), /npm i|npx/, String(lock))
    const b = fixture({ playwright: false })
    lockFile(b)
    const rb = releaseCf({ dir: b.dir, url: 'https://a.example.com', run: fakeRun(b).run, now: NOW, stateOpts: b.so, ...GATE })
    assert.match(rb.lines.join('\n'), rePw, String(lock))
    const c = fixture()
    lockFile(c)
    const needLogin = (x) => (k) => (k.kind === 'wrangler:versions upload' || k.kind === 'wrangler:rollback' ? { status: 1, stderr: 'You are not authenticated. Please run `wrangler login`.' } : {})
    const rc = releaseCf({ dir: c.dir, url: 'https://a.example.com', run: fakeRun(c, needLogin(c)).run, now: NOW, stateOpts: c.so, ...GATE })
    assert.equal(rc.code, EXIT.MISSING)
    assert.ok(rc.lines.join('\n').includes(login), `cf login: ${rc.lines.join(' | ')}`)
    const rr = rollbackCf({ dir: c.dir, url: 'https://a.example.com', run: fakeRun(c, needLogin(c)).run, stateOpts: c.so })
    assert.equal(rr.code, EXIT.MISSING)
    assert.ok(rr.lines.join('\n').includes(login), `rollback login: ${rr.lines.join(' | ')}`)
    const d = fixture()
    lockFile(d)
    const dep = releaseCf({ dir: d.dir, url: 'https://a.example.com', run: fakeRun(d, (k) => (opens(k) ? { status: 1, stderr: 'API error' } : okHandler(k))).run, now: NOW, stateOpts: d.so, ...GATE })
    assert.ok(dep.lines.join('\n').includes(deploy), `deploy: ${dep.lines.join(' | ')}`)
  }
})

test('cf tự chạy preflight: còn mục chặn ⇒ exit 1, KHÔNG gọi versions upload / thử nhanh / deploy, không ghi trạng thái', () => {
  const sbFail = { stdout: JSON.stringify({ results: [{ id: 'secret-build', status: 'fail', detail: ['dist/a.js:1 khoá'] }] }) }
  const cases = [
    ['thiếu dấu review', (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: không\nqa: có\ntest: có\n' } : {}), /dấu review/, GATE],
    ['khoá trong bản build', (c) => (c.kind === 'check' ? sbFail : {}), /khoá bí mật/, GATE],
    ['quét bảo mật đỏ', () => ({}), /mức cao/, { ...GATE, zapExit: 1 }],
    ['thiếu công cụ quét bảo mật', () => ({}), /Java/, { ...GATE, zapExit: 3 }],
    ['chưa thử quay lại (đã phát hành 2 lần)', () => ({}), /thử quay lại/, { hooksDir: HOOKS_DIR }, { v: 1, releaseCount: 2, rollbackTested: false }],
    ['có dữ liệu mà chưa chọn sao lưu', () => ({}), /sao lưu/, { ...GATE, hasData: true }],
  ]
  for (const [name, handler, re, gate, state] of cases) {
    const f = fixture()
    if (state) writeState(f.dir, state, f.so)
    const before = readState(f.dir, f.so)
    const { run, kinds } = fakeRun(f, handler)
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...gate })
    assert.equal(r.code, EXIT.FAIL, name)
    assert.match(r.lines.join('\n'), re, name)
    assert.match(r.lines.at(-1), /Chưa tải gì lên Cloudflare/, name)
    assert.deepEqual(kinds(), PRE, `${name}: chỉ chạy preflight, không đụng Cloudflare`)
    assert.deepEqual(readState(f.dir, f.so), before, `${name}: không ghi trạng thái`)
  }
})

test('cf: thiếu hooksDir (không kiểm được preflight) ⇒ không phát hành; cảnh báo mức vừa của quét bảo mật không chặn mà được nhắc', () => {
  const f = fixture()
  const a = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f.so })
  assert.equal(r.code, EXIT.FAIL)
  assert.equal(a.calls.length, 0)
  const g = fixture()
  const b = fakeRun(g, okHandler)
  const ok = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: b.run, now: NOW, stateOpts: g.so, ...GATE, zapExit: 2 })
  assert.equal(ok.code, EXIT.OK)
  assert.match(ok.lines[0], /^Cảnh báo: .*mức vừa/)
})

// ---------- K3: đếm lần phát hành, nhắc thử quay lại sau lần thứ 2 ----------

const releaseOnce = (f, over = {}) => releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, cfWorld().handler).run, now: NOW, stateOpts: f.so, hooksDir: HOOKS_DIR, ...over })

test('K3 cf: lần 1 và lần 2 không cần --first-release; sau lần 2 chưa thử quay lại ⇒ nhắc một dòng; lần 3 bị chặn tới khi đã rollback; rollback xong phát hành tiếp được', () => {
  const f = fixture()
  const one = releaseOnce(f)
  assert.equal(one.code, EXIT.OK, one.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).releaseCount, 1)
  assert.doesNotMatch(one.lines.join('\n'), /thử quay lại/, 'mới có 1 bản thì chưa có gì để quay lại')
  const two = releaseOnce(f)
  assert.equal(two.code, EXIT.OK, two.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).releaseCount, 2)
  const nudge = two.lines.filter((l) => /thử quay lại/.test(l))
  assert.equal(nudge.length, 1, two.lines.join('\n'))
  assert.match(nudge[0], /nên thử quay lại một lần[\s\S]*release rollback[\s\S]*vài giây[\s\S]*phát hành lại bản mới/)
  const blocked = fakeRun(f, okHandler)
  const three = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: blocked.run, now: NOW, stateOpts: f.so, hooksDir: HOOKS_DIR })
  assert.equal(three.code, EXIT.FAIL)
  assert.match(three.lines.join('\n'), /thử quay lại/)
  assert.deepEqual(blocked.kinds(), PRE, 'lần 3 bị chặn trước khi đụng Cloudflare')
  assert.equal(rollbackCf({ dir: f.dir, run: fakeRun(f).run, stateOpts: f.so }).code, EXIT.OK)
  const four = releaseOnce(f)
  assert.equal(four.code, EXIT.OK, four.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).releaseCount, 3)
  assert.doesNotMatch(four.lines.join('\n'), /thử quay lại/, 'đã thử quay lại rồi thì không nhắc nữa')
})

test('K3 cf: release.json cũ (có lastRelease, chưa có releaseCount) ⇒ coi như đã phát hành 1 lần: lần này là lần 2 và có nhắc; đã thử quay lại thì im', () => {
  const f = fixture()
  const old = { v: 1, platform: 'cloudflare-workers', target: 'https://app.example.com', lastRelease: { at: new Date(NOW - DAY).toISOString(), version: OLD, smoke: 'pass' }, checkAt: [], rollbackTested: false }
  writeState(f.dir, old, f.so)
  const r = releaseOnce(f)
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).releaseCount, 2)
  assert.ok(r.lines.some((l) => /nên thử quay lại một lần/.test(l)))
  const g = fixture()
  writeState(g.dir, { ...old, rollbackTested: true }, g.so)
  const q = releaseOnce(g)
  assert.equal(readState(g.dir, g.so).releaseCount, 2)
  assert.doesNotMatch(q.lines.join('\n'), /thử quay lại/)
})

test('K3 vps --run: cũng đếm lần phát hành và nhắc `release vps --rollback --run` sau lần thứ 2', () => {
  const f = fixture()
  const go = () => releaseVps({ dir: f.dir, run: fakeRun(f, (c) => (c.kind === 'git' ? { stdout: 'abc1234\n' } : {})).run, ...VPS, sha: undefined, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  const one = go()
  assert.equal(one.code, EXIT.OK, one.lines.join('\n'))
  assert.doesNotMatch(one.lines.join('\n'), /thử quay lại/)
  const two = go()
  assert.equal(two.code, EXIT.OK, two.lines.join('\n'))
  assert.equal(readState(f.dir, f.so).releaseCount, 2)
  assert.ok(two.lines.some((l) => /nên thử quay lại một lần.*release vps --rollback --run/.test(l)), two.lines.join('\n'))
})

// ---------- K7: tự build trước khi tải lên ----------

function buildApp(lock, scripts = { build: 'vite build' }) {
  const f = fixture()
  fs.mkdirSync(path.join(f.dir, '.git'), { recursive: true }) // chặn pkgManager tìm lockfile lạ ở thư mục cha của thư mục tạm
  if (lock) fs.writeFileSync(path.join(f.dir, lock), '')
  if (scripts) fs.writeFileSync(path.join(f.dir, 'package.json'), JSON.stringify({ name: 'app', scripts }))
  return f
}

test('K7 cf: package.json có script build ⇒ chạy `<pnpm|yarn|npm> run build` trong thư mục app TRƯỚC preflight và TRƯỚC khi tải lên (nghiệm thu thật: quên build ⇒ tải bản cũ); in một dòng đã build', () => {
  for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], [null, 'npm']]) {
    const f = buildApp(lock)
    const { run, calls, kinds } = fakeRun(f, okHandler)
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
    assert.equal(r.code, EXIT.OK, `${pm}: ${r.lines.join('\n')}`)
    assert.deepEqual(kinds(), [pm, ...PRE, 'git', 'wrangler:versions upload', 'wrangler:deployments status', 'wrangler:versions deploy', 'probe', 'playwright', 'wrangler:deployments status', 'wrangler:versions deploy'], pm)
    const b = calls.find((c) => c.kind === pm)
    assert.equal(b.cmd, pm)
    assert.deepEqual(b.args, ['run', 'build'])
    assert.equal(b.opts.cwd, f.dir)
    assert.ok(r.lines.includes(`Đã build bằng \`${pm} run build\`.`), `L2: kết quả nói đã build: ${r.lines.join(' | ')}`)
  }
})

test('K7/L2 cf: không có script build ⇒ không có dòng "Đã build"', () => {
  const f = fixture()
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, okHandler).run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.ok(!r.lines.some((l) => /Đã build/.test(l)))
})

// Mô phỏng thật: flow-check quét thư mục build. Chưa build ⇒ "missing"; build xong ⇒ thấy khoá nếu app nhúng khoá vào bản mới.
const scanWorld = ({ leaksAfterBuild = false } = {}) => {
  const w = { built: false, scannedBuilt: null }
  const handler = (c) => {
    if (c.kind === 'pnpm') { w.built = true; return {} }
    if (c.kind === 'check') {
      w.scannedBuilt = w.built
      const status = !w.built ? 'missing' : leaksAfterBuild ? 'fail' : 'pass'
      return { stdout: JSON.stringify({ results: [{ id: 'secret-build', status, detail: status === 'fail' ? ['dist/assets/app.js:1 khoá'] : [] }] }) }
    }
    return okHandler(c)
  }
  return { w, handler }
}

test('finding 1 cf: quét khoá chạy trên bản VỪA BUILD (build → preflight → tải lên), không quét dist cũ; khoá nhúng vào bản mới ⇒ chặn, chưa tải gì', () => {
  const f = buildApp('pnpm-lock.yaml')
  const s = scanWorld({ leaksAfterBuild: true })
  const { run, kinds } = fakeRun(f, s.handler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(s.w.scannedBuilt, true, 'lúc quét, build đã chạy xong')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines.join('\n'), /giống khoá bí mật[\s\S]*dist\/assets\/app\.js/)
  assert.match(r.lines.at(-1), /Chưa tải gì lên Cloudflare/)
  assert.deepEqual(kinds(), ['pnpm', ...PRE], 'build rồi quét; không git/wrangler nào chạy')
  assert.equal(fs.existsSync(statePath(f.dir)), false)
  assert.equal(r.lines[0], 'Đã build bằng `pnpm run build`.', 'N1: nhánh chặn cũng nói đã build')
})

test('N2/N3 cf: báo tiến trình từng bước lúc đang chạy (không im lặng cả phút)', () => {
  const f = fixture()
  const { handler } = cfWorld()
  const said = []
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, handler).run, now: NOW, stateOpts: f.so, say: (s) => said.push(s), ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  const order = [/Đang tải bản mới/, /0%.*xác nhận/, /bài thử nhanh/, /mở cho mọi người/]
  let at = -1
  for (const re of order) {
    const i = said.findIndex((s, k) => k > at && re.test(s))
    assert.ok(i > at, `thiếu hoặc sai thứ tự "${re}": ${said.join(' | ')}`)
    at = i
  }
})

test('L1 cf: dự án CHƯA từng build ⇒ không còn bị chặn "Chưa build nên chưa kiểm được khoá" — build tự chạy trước rồi quét đạt; vẫn phát hành được', () => {
  const f = buildApp('pnpm-lock.yaml')
  const s = scanWorld()
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: fakeRun(f, s.handler).run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.equal(s.w.scannedBuilt, true)
  assert.doesNotMatch(r.lines.join('\n'), /Chưa build nên chưa kiểm được khoá/)
})

test('finding 1 cf: thiếu hooksDir ⇒ không build gì cả (không kiểm được thì không phát hành)', () => {
  const f = buildApp('pnpm-lock.yaml')
  const a = fakeRun(f, okHandler)
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: a.run, now: NOW, stateOpts: f.so })
  assert.equal(r.code, EXIT.FAIL)
  assert.equal(a.calls.length, 0)
})

test('K7 cf: không có script build (không package.json, package.json thiếu build, hoặc hỏng) ⇒ không build, phát hành như thường', () => {
  for (const make of [() => buildApp(null, null), () => buildApp('pnpm-lock.yaml', { dev: 'vite' }), () => buildApp('pnpm-lock.yaml', { build: '' }), () => { const f = buildApp(null, null); fs.writeFileSync(path.join(f.dir, 'package.json'), '{ hỏng'); return f }]) {
    const f = make()
    const { run, kinds } = fakeRun(f, okHandler)
    const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
    assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
    assert.ok(!kinds().some((k) => ['npm', 'pnpm', 'yarn'].includes(k)), kinds().join(' '))
  }
})

test('K7 cf: build lỗi ⇒ exit 1, chưa tải gì lên Cloudflare (không lệnh wrangler nào), nêu lỗi build thật chứ không chỉ dòng ELIFECYCLE của pnpm', () => {
  const f = buildApp('pnpm-lock.yaml')
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'pnpm' ? { status: 1, stdout: 'vite v6.0.0 building for production...\nerror during build:\nCould not resolve "./missing" from "src/main.tsx"\n', stderr: ' ELIFECYCLE  Command failed with exit code 1.\n' } : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /Build/i)
  assert.match(text, /Could not resolve "\.\/missing"/)
  assert.match(r.lines.at(-1), /Chưa tải gì lên Cloudflare/)
  assert.deepEqual(kinds(), ['pnpm'], 'build lỗi ⇒ dừng ngay: chưa quét, chưa git, chưa wrangler')
  assert.equal(fs.existsSync(statePath(f.dir)), false)
  const g = buildApp('pnpm-lock.yaml')
  const none = fakeRun(g, (c) => (c.kind === 'pnpm' ? { status: null, error: 'ENOENT' } : okHandler(c)))
  const r2 = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: none.run, now: NOW, stateOpts: g.so, ...GATE })
  assert.equal(r2.code, EXIT.FAIL)
  assert.match(r2.lines.join('\n'), /ENOENT/)
  assert.deepEqual(none.kinds(), ['pnpm'])
})

test('K7 cf --first-release: build cũng chạy trước wrangler deploy lần đầu', () => {
  const f = buildApp('pnpm-lock.yaml')
  const { run, kinds } = fakeRun(f, firstWorld())
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(kinds(), ['pnpm', ...PRE, 'git', 'wrangler:versions upload', 'wrangler:deploy', 'probe', 'playwright'])
})

test('K5 cf: cảnh báo repo sửa thẳng nhánh chính hiện đầu kết quả phát hành và không chặn', () => {
  const f = fixture()
  directEdit(f)
  const { run } = fakeRun(f, (c) => (c.kind === 'gate' ? EMPTY_GATE : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.match(r.lines[0], /^Cảnh báo: .*sửa thẳng nhánh chính/)
})

test('rollback cf: wrangler rollback --message → thử nhanh lại → ghi rollbackTested; nói dữ liệu không quay theo', () => {
  const f = fixture()
  writeState(f.dir, { v: 1, target: 'https://app.example.com', rollbackTested: false, lastRelease: { at: new Date(NOW).toISOString(), version: ID, smoke: 'pass' } }, f.so)
  const { run, calls, kinds } = fakeRun(f)
  const r = rollbackCf({ dir: f.dir, message: 'lỗi đăng nhập', run, stateOpts: f.so })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(kinds(), ['wrangler:rollback', 'playwright'])
  assert.deepEqual(calls[0].args, [f.wr, 'rollback', '--message', 'lỗi đăng nhập'])
  assert.equal(calls[1].opts.env.BASE_URL, 'https://app.example.com')
  assert.equal(calls[1].opts.env.SMOKE_EXTRA_HTTP_HEADERS, undefined, 'sau khi quay lại không cần header override')
  assert.match(r.lines.join('\n'), /dữ liệu không quay theo/)
  assert.equal(readState(f.dir, f.so).rollbackTested, true)
  assert.equal(readState(f.dir, f.so).lastRelease.version, ID)
})

test('rollback cf: nhận mã bản cụ thể; wrangler lỗi ⇒ exit 1 và không đánh dấu đã thử', () => {
  const f = fixture()
  const { run, calls } = fakeRun(f, (c) => (c.args[1] === 'rollback' ? { status: 1, stderr: 'Durable Object changed' } : {}))
  const r = rollbackCf({ dir: f.dir, url: 'https://app.example.com', versionId: ID, run, stateOpts: f.so })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(calls[0].args, [f.wr, 'rollback', ID, '--message', 'flow rollback'])
  assert.match(r.lines.join('\n'), /Durable Object/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('BUG-3 rollback cf: lỗi wrangler không phải đăng nhập ⇒ nêu dòng ERROR thật (bỏ mã màu, bỏ dòng "Logs were written"); chỉ gợi ý Durable Object khi lỗi thật nói chuyện đó', () => {
  const f = fixture()
  const other = fakeRun(f, (c) => (c.kind === 'wrangler:rollback' ? wranglerFail('Cannot roll back: the previous version no longer exists [code: 10007]') : {}))
  const r = rollbackCf({ dir: f.dir, url: 'https://app.example.com', run: other.run, stateOpts: f.so })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.FAIL)
  assert.match(text, /Cannot roll back: the previous version no longer exists/)
  assert.doesNotMatch(text, /Logs were written|\u001b|✘|\[ERROR\]/)
  assert.doesNotMatch(text, /Durable Object|Hay gặp/)
  assert.match(text, /Bản đang chạy giữ nguyên/)
  const dur = fakeRun(f, (c) => (c.kind === 'wrangler:rollback' ? wranglerFail('Durable Object migration tag mismatch between versions') : {}))
  const d = rollbackCf({ dir: f.dir, url: 'https://app.example.com', run: dur.run, stateOpts: f.so })
  assert.match(d.lines.join('\n'), /Durable Object migration tag mismatch/)
  assert.match(d.lines.join('\n'), /Hay gặp: giữa hai bản có đổi Durable Object/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
})

test('BUG-3 rollback cf: wrangler đòi tên Worker ⇒ exit 3, nói rõ thiếu tên Worker (name trong wrangler.jsonc hoặc --worker); --worker đi vào wrangler bằng --name', () => {
  const f = fixture({ config: 'none' })
  const miss = fakeRun(f, (c) => (c.kind === 'wrangler:rollback' ? wranglerFail('You need to provide a name for your Worker. Either pass it as a cli arg with `--name <name>` or in your config file as `name = "<name>"`') : {}))
  const r = rollbackCf({ dir: f.dir, url: 'https://app.example.com', run: miss.run, stateOpts: f.so })
  const text = r.lines.join('\n')
  assert.equal(r.code, EXIT.MISSING)
  assert.match(text, /Thiếu tên Worker/)
  assert.match(text, /wrangler\.jsonc/)
  assert.match(text, /--worker/)
  assert.doesNotMatch(text, /Durable Object|Logs were written/)
  const ok = fakeRun(f)
  const named = rollbackCf({ dir: f.dir, url: 'https://app.example.com', worker: 'app-khac', run: ok.run, stateOpts: f.so })
  assert.equal(named.code, EXIT.OK, named.lines.join('\n'))
  assert.deepEqual(ok.calls[0].args, [f.wr, 'rollback', '--message', 'flow rollback', '--name', 'app-khac'])
})

test('BUG-3 cf: tải lên / mở 100% lỗi không phải đăng nhập ⇒ nêu dòng ERROR thật, không phải dòng "Logs were written"', () => {
  const f = fixture()
  const up = fakeRun(f, (c) => (c.kind === 'wrangler:versions upload' ? wranglerFail('Missing entry-point to Worker script or to assets directory') : okHandler(c)))
  const r = releaseCf({ dir: f.dir, url: 'https://app.example.com', run: up.run, now: NOW, stateOpts: f.so, ...GATE })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines[0], /Missing entry-point to Worker script/)
  assert.doesNotMatch(r.lines.join('\n'), /Logs were written|\u001b|✘/)
  const g = fixture()
  const dep = fakeRun(g, (c) => (opens(c) ? wranglerFail('A request to the Cloudflare API failed [code: 10001]') : okHandler(c)))
  const r2 = releaseCf({ dir: g.dir, url: 'https://app.example.com', run: dep.run, now: NOW, stateOpts: g.so, ...GATE })
  assert.match(r2.lines[0], /A request to the Cloudflare API failed/)
  assert.doesNotMatch(r2.lines.join('\n'), /Logs were written/)
})

test('rollback cf: thử nhanh vẫn trượt ⇒ exit 1, chưa đánh dấu đã thử, vẫn nhắc dữ liệu', () => {
  const f = fixture()
  const { run } = fakeRun(f, (c) => (c.kind === 'playwright' ? { status: 1, stdout: 'timeout' } : {}))
  const r = rollbackCf({ dir: f.dir, url: 'https://app.example.com', run, stateOpts: f.so })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.lines.join('\n'), /dữ liệu không quay theo/)
  assert.equal(readState(f.dir, f.so), null)
})

test('rollback cf: chưa đăng nhập ⇒ exit 3; thiếu địa chỉ ⇒ exit 3 không chạy gì', () => {
  const f = fixture()
  const a = fakeRun(f, (c) => (c.kind === 'wrangler:rollback' ? { status: 1, stderr: 'Please run wrangler login' } : {}))
  assert.equal(rollbackCf({ dir: f.dir, url: 'https://a.example.com', run: a.run, stateOpts: f.so }).code, EXIT.MISSING)
  const b = fakeRun(f)
  assert.equal(rollbackCf({ dir: f.dir, run: b.run, stateOpts: f.so }).code, EXIT.MISSING)
  assert.equal(b.calls.length, 0)
})

// ---------- VPS (AC-48c) ----------

const VPS = { mode: 'symlink', host: 'deploy@203.0.113.7', root: '/srv/app/', sha: 'abc1234', service: 'app', keep: 3, ...GATE }

test('vpsPlan symlink: tạo releases/<mã>, chép build, trỏ current, giữ bản trước để quay lại; liệt kê bản cũ hơn keep', () => {
  const p = vpsPlan(VPS)
  assert.equal(p.error, undefined)
  assert.equal(p.root, '/srv/app')
  assert.deepEqual(p.steps.map((s) => s.argv[0]), ['ssh', 'scp', 'ssh'])
  assert.equal(p.steps[0].argv[2], 'mkdir -p /srv/app/releases/abc1234')
  assert.deepEqual(p.steps[1].argv, ['scp', '-r', 'dist/.', 'deploy@203.0.113.7:/srv/app/releases/abc1234/'])
  assert.match(p.steps[2].argv[2], /ln -sfn \/srv\/app\/releases\/abc1234 current && systemctl restart app$/)
  assert.match(p.steps[2].argv[2], /echo "\$cur" > \.previous/)
  assert.match(p.rollback[0].argv[2], /prev=\$\(cat \.previous.*ln -sfn "\$prev" current.*systemctl restart app$/)
  assert.match(p.prune.argv[2], /ls -1t \| tail -n \+4$/)
})

test('vpsPlan: keep không bao giờ dưới 3; --sudo thêm sudo -n cho restart', () => {
  assert.match(vpsPlan({ ...VPS, keep: 1 }).prune.argv[2], /tail -n \+4$/)
  assert.match(vpsPlan({ ...VPS, keep: 5 }).prune.argv[2], /tail -n \+6$/)
  assert.match(vpsPlan({ ...VPS, sudo: true }).steps[2].argv[2], /sudo -n systemctl restart app$/)
  assert.doesNotMatch(vpsPlan({ ...VPS, service: undefined }).steps[2].argv[2], /systemctl/)
})

test('vpsPlan docker: IMAGE_TAG theo mã commit, nhớ thẻ trước, quay lại bằng thẻ cũ', () => {
  const p = vpsPlan({ mode: 'docker', host: 'srv', root: '/srv/app', sha: 'abc1234' })
  assert.equal(p.steps.length, 1)
  assert.match(p.steps[0].argv[2], /IMAGE_TAG=abc1234 docker compose up -d$/)
  assert.match(p.steps[0].argv[2], /\.previous-image-tag/)
  assert.match(p.rollback[0].argv[2], /IMAGE_TAG=\$prev docker compose up -d$/)
  assert.equal(p.prune, null)
})

test('vpsPlan: từ chối giá trị có thể chèn lệnh hoặc cờ ssh', () => {
  const bad = [
    { host: '-oProxyCommand=x' }, { host: 'a b' }, { host: 'a;rm' }, { host: undefined }, { root: 'srv/app' }, { root: '/a/../b' }, { root: '/a;b' },
    { mode: 'lạ' }, { sha: 'a;b' }, { sha: 'ab' }, { service: 'a;b' }, { dist: '../x' }, { dist: 'C:\\x' }, { dist: '-r' }, { dist: '/abs' },
  ]
  for (const b of bad) assert.ok(vpsPlan({ ...VPS, ...b }).error, JSON.stringify(b))
})

test('vps không --run: chỉ in lệnh (kể cả quay lại), không chạy ssh/scp, không ghi trạng thái', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'git' ? { stdout: 'abc1234\n' } : {}))
  const r = releaseVps({ dir: f.dir, run, ...VPS, sha: undefined, stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.OK)
  assert.deepEqual(kinds(), ['git'])
  const text = r.lines.join('\n')
  assert.match(text, /ssh deploy@203\.0\.113\.7 'mkdir -p \/srv\/app\/releases\/abc1234'/)
  assert.match(text, /Quay về bản trước/)
  assert.match(text, /--run/)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
  const rb = releaseVps({ dir: f.dir, run, ...VPS, rollback: true, stateOpts: f.so })
  assert.match(rb.lines.join('\n'), /prev=\$\(cat \.previous/)
})

test('vps --run: mkdir → scp → chuyển bản → thử nhanh; ssh có BatchMode; ghi lastRelease, vps, mốc nhắc', () => {
  const f = fixture()
  const { run, calls, kinds } = fakeRun(f, (c) => (c.kind === 'git' ? { stdout: 'abc1234\n' } : {}))
  const r = releaseVps({ dir: f.dir, run, ...VPS, sha: undefined, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.OK, r.lines.join('\n'))
  assert.deepEqual(kinds(), [...PRE, 'git', 'ssh', 'scp', 'ssh', 'playwright'], 'preflight chạy đầu tiên')
  assert.deepEqual(calls[3].args.slice(0, 3), ['-o', 'BatchMode=yes', 'deploy@203.0.113.7'])
  assert.deepEqual(calls[4].args.slice(0, 3), ['-o', 'BatchMode=yes', '-r'])
  assert.equal(calls[6].opts.env.BASE_URL, 'https://app.example.com')
  assert.equal(calls[6].opts.env.SMOKE_EXTRA_HTTP_HEADERS, undefined)
  const st = readState(f.dir, f.so)
  assert.equal(st.platform, 'vps')
  assert.equal(st.lastRelease.version, 'abc1234')
  assert.equal(st.lastRelease.smoke, 'pass')
  assert.deepEqual(st.vps, { mode: 'symlink', host: 'deploy@203.0.113.7', root: '/srv/app', service: 'app' })
  assert.equal(st.checkAt.length, 2)
  assert.equal(st.logs.source, 'vps-journald')
})

test('vps --run: thử nhanh trượt ⇒ tự chạy lệnh quay lại, exit 1, không ghi lastRelease', () => {
  const f = fixture()
  const { run, calls, kinds } = fakeRun(f, (c) => (c.kind === 'playwright' ? { status: 1, stdout: 'boom' } : {}))
  const r = releaseVps({ dir: f.dir, run, ...VPS, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), [...PRE, 'ssh', 'scp', 'ssh', 'playwright', 'ssh'])
  assert.match(calls[6].args[calls[6].args.length - 1], /prev=\$\(cat \.previous/)
  assert.match(r.lines.join('\n'), /Đã tự quay về bản trước/)
  assert.equal(readState(f.dir, f.so), null)
})

test('vps --run: một bước lỗi ⇒ dừng ngay, không thử nhanh, không ghi trạng thái', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'scp' ? { status: 1, stderr: 'Permission denied' } : {}))
  const r = releaseVps({ dir: f.dir, run, ...VPS, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), [...PRE, 'ssh', 'scp'])
  assert.match(r.lines.join('\n'), /Chép bản build[\s\S]*Permission denied/)
  assert.equal(readState(f.dir, f.so), null)
})

test('vps --run tự chạy preflight: còn mục chặn ⇒ exit 1, KHÔNG gọi ssh/scp/thử nhanh nào, không ghi trạng thái', () => {
  const cases = [
    ['thiếu dấu QA', (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: có\nqa: không\ntest: có\n' } : {}), /dấu QA/, GATE],
    ['quét bảo mật đỏ', () => ({}), /mức cao/, { ...GATE, zapExit: 1 }],
    ['chưa thử quay lại (đã phát hành 2 lần)', () => ({}), /thử quay lại/, { hooksDir: HOOKS_DIR }, { v: 1, releaseCount: 2, rollbackTested: false }],
    ['sao lưu bật mà chưa đạt', () => ({}), /Sao lưu chưa đạt/, GATE, { v: 1, rollbackTested: true, backup: { choice: 'on' } }],
  ]
  for (const [name, handler, re, gate, state] of cases) {
    const f = fixture()
    if (state) writeState(f.dir, state, f.so)
    const { run, kinds } = fakeRun(f, handler)
    const r = releaseVps({ dir: f.dir, run, ...VPS, ...gate, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
    assert.equal(r.code, EXIT.FAIL, name)
    assert.match(r.lines.join('\n'), re, name)
    assert.match(r.lines.at(-1), /Chưa đụng tới máy chủ/, name)
    assert.deepEqual(kinds(), PRE, `${name}: chỉ chạy preflight`)
    assert.equal(readState(f.dir, f.so)?.lastRelease, undefined, name)
  }
  const g = fixture()
  const none = fakeRun(g)
  const { hooksDir: _drop, ...noHooks } = VPS
  assert.equal(releaseVps({ dir: g.dir, run: none.run, ...noHooks, doRun: true, url: 'https://app.example.com', stateOpts: g.so, now: NOW }).code, EXIT.FAIL)
  assert.equal(none.calls.length, 0, 'thiếu hooksDir ⇒ không kiểm được ⇒ không đụng máy chủ')
})

test('vps --run: preflight đã qua mà thiếu địa chỉ thử nhanh / Playwright ⇒ exit 3, chỉ chạy preflight (chưa đụng máy chủ)', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f)
  const r = releaseVps({ dir: f.dir, run, ...VPS, doRun: true, stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.MISSING)
  assert.deepEqual(kinds(), PRE)
  const g = fixture({ playwright: false })
  const b = fakeRun(g)
  const r2 = releaseVps({ dir: g.dir, run: b.run, ...VPS, doRun: true, url: 'https://app.example.com', stateOpts: g.so, now: NOW })
  assert.equal(r2.code, EXIT.MISSING)
  assert.match(r2.lines.join('\n'), /Playwright/)
  assert.deepEqual(b.kinds(), PRE)
})

test('BUG-2 vps --run: preflight chạy TRƯỚC khi kiểm địa chỉ / Playwright / --root — còn mục chặn thì nêu danh sách chặn (exit 1), --rollback --run vẫn không qua preflight', () => {
  const noMarks = (c) => (c.kind === 'gate' ? { stdout: 'pid: x\nreview: không\nqa: không\ntest: có\n' } : {})
  const cases = [
    [{ playwright: false }, { url: 'https://app.example.com' }],
    [{}, {}],
    [{}, { url: 'https://app.example.com', root: undefined }],
    [{}, { url: 'https://app.example.com', host: undefined }],
  ]
  for (const [fx, over] of cases) {
    const f = fixture(fx)
    const { run, kinds } = fakeRun(f, noMarks)
    const r = releaseVps({ dir: f.dir, run, ...VPS, doRun: true, stateOpts: f.so, now: NOW, ...over })
    const text = r.lines.join('\n')
    assert.equal(r.code, EXIT.FAIL, `${JSON.stringify(over)} ${text}`)
    assert.match(text, /Chưa có dấu review/)
    assert.match(text, /Chưa có dấu QA/)
    assert.doesNotMatch(text, /Thiếu Playwright|--url|--root|--host/)
    assert.match(r.lines.at(-1), /Chưa đụng tới máy chủ/)
    assert.deepEqual(kinds(), PRE)
  }
  const g = fixture({ playwright: false })
  const rb = fakeRun(g, noMarks)
  releaseVps({ dir: g.dir, run: rb.run, ...VPS, rollback: true, doRun: true, stateOpts: g.so, now: NOW })
  assert.deepEqual(rb.kinds(), ['ssh'], 'quay lại là cứu hộ: không preflight')
})

test('vps --rollback --run: chạy lệnh quay lại rồi thử nhanh ⇒ rollbackTested; không có địa chỉ ⇒ vẫn quay lại nhưng chưa đánh dấu', () => {
  const f = fixture()
  const a = fakeRun(f)
  const r = releaseVps({ dir: f.dir, run: a.run, ...VPS, rollback: true, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.OK)
  assert.deepEqual(a.kinds(), ['ssh', 'playwright'])
  assert.equal(readState(f.dir, f.so).rollbackTested, true)
  assert.match(r.lines.join('\n'), /dữ liệu không quay theo/)
  const g = fixture()
  const b = fakeRun(g)
  const r2 = releaseVps({ dir: g.dir, run: b.run, ...VPS, rollback: true, doRun: true, stateOpts: g.so, now: NOW })
  assert.equal(r2.code, EXIT.OK)
  assert.deepEqual(b.kinds(), ['ssh'])
  assert.equal(readState(g.dir, g.so), null)
})

test('vps --rollback --run: lệnh quay lại lỗi (chưa có bản trước) ⇒ exit 1 kèm lý do', () => {
  const f = fixture()
  const { run, kinds } = fakeRun(f, (c) => (c.kind === 'ssh' ? { status: 1 } : {}))
  const r = releaseVps({ dir: f.dir, run, ...VPS, rollback: true, doRun: true, url: 'https://app.example.com', stateOpts: f.so, now: NOW })
  assert.equal(r.code, EXIT.FAIL)
  assert.deepEqual(kinds(), ['ssh'])
  assert.match(r.lines.join('\n'), /Chưa có bản trước/)
})

// ---------- đọc nhật ký (AC-48e) ----------

function cfFetch(events, { status = 200 } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: status === 200, status, json: async () => ({ success: true, result: { events: { events } } }) }
  }
  return { fetch, calls }
}
const cfState = (over = {}) => ({ v: 1, logs: { source: 'workers-observability', retentionDays: 3, ...over } })
const cfEnv = { CF_LOGS_TOKEN: 'tok-chi-doc-123', CLOUDFLARE_ACCOUNT_ID: 'acc123' }
const ev = (minAgo, message, trigger) => ({ timestamp: NOW - minAgo * 60000, $metadata: { message, trigger, level: 'error' } })

test('logs workers: không có lỗi ⇒ clean, nói không thấy lỗi', async () => {
  const { fetch, calls } = cfFetch([])
  const r = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch, opts: { worker: 'my-app' } })
  assert.equal(r.status, 'clean')
  assert.match(formatLogs(r)[0], /Không thấy lỗi nào trong 1 ngày qua/)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/accounts\/acc123\/workers\/observability\/telemetry\/query$/)
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-chi-doc-123')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.timeframe, { from: NOW - DAY, to: NOW })
  assert.ok(body.parameters.filters.some((x) => x.key === '$metadata.service' && x.value === 'my-app'))
})

test('logs workers: có lỗi ⇒ gom theo loại + luồng, đếm, từ-đến; che token trong thông điệp; không in token của chính kit', async () => {
  const { fetch } = cfFetch([
    ev(10, 'D1 query failed id 123', 'GET /api/notes'),
    ev(30, 'D1 query failed id 456', 'GET /api/notes'),
    ev(20, 'Unauthorized Bearer abcdefghijklmnopqrstuvwxyz0123', 'POST /api/login'),
  ])
  const r = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch, opts: { worker: 'my-app' } })
  assert.equal(r.status, 'errors')
  assert.equal(r.total, 3)
  assert.equal(r.groups.length, 2)
  assert.equal(r.groups[0].count, 2)
  assert.equal(r.groups[0].flow, 'GET /api/notes')
  assert.equal(r.groups[0].first, NOW - 30 * 60000)
  assert.equal(r.groups[0].last, NOW - 10 * 60000)
  const text = formatLogs(r).join('\n')
  assert.match(text, /Có 3 lỗi trong 1 ngày qua, 2 loại/)
  assert.match(text, /2 lần · "D1 query failed id 123" · ở GET \/api\/notes/)
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz0123|tok-chi-doc-123/)
})

test('logs workers: hỏi 7 ngày mà log chỉ giữ 3 ngày ⇒ beyond-retention, chỉ truy vấn phần còn log, nói rõ khoảng không còn', async () => {
  const { fetch, calls } = cfFetch([])
  const r = await readLogs({ state: cfState(), since: 7 * DAY, now: NOW, env: cfEnv, fetch, opts: { worker: 'my-app' } })
  assert.equal(r.status, 'beyond-retention')
  assert.equal(JSON.parse(calls[0].init.body).timeframe.from, NOW - 3 * DAY)
  assert.equal(r.availableFrom, NOW - 3 * DAY)
  const text = formatLogs(r).join('\n')
  assert.match(text, /chỉ giữ nhật ký 3 ngày/)
  assert.match(text, /không còn log để xem/)
  assert.match(text, /Không thấy lỗi nào trong phần còn log/)
})

test('logs workers: beyond-retention mà phần còn log có lỗi ⇒ vẫn kể lỗi', async () => {
  const { fetch } = cfFetch([ev(5, 'boom', 'GET /')])
  const r = await readLogs({ state: cfState(), since: 5 * DAY, now: NOW, env: cfEnv, fetch, opts: { worker: 'my-app' } })
  assert.equal(r.status, 'beyond-retention')
  assert.equal(r.groups.length, 1)
  assert.match(formatLogs(r).join('\n'), /Có 1 lỗi trong phần còn log/)
})

test('logs workers: không truy cập được (thiếu token / thiếu account / 403 / mạng / dữ liệu hỏng) ⇒ unreachable, không ném, không gọi khi thiếu điều kiện', async () => {
  const opts = { worker: 'my-app' }
  const a = cfFetch([])
  const noTok = await readLogs({ state: cfState(), since: DAY, now: NOW, env: { CLOUDFLARE_ACCOUNT_ID: 'x' }, fetch: a.fetch, opts })
  assert.equal(noTok.status, 'unreachable')
  assert.match(noTok.reason, /thiếu token/)
  assert.equal(a.calls.length, 0)
  assert.match(formatLogs(noTok).join('\n'), /Chưa kết luận được app có lỗi hay không/)
  assert.match((await readLogs({ state: cfState(), since: DAY, now: NOW, env: { CF_LOGS_TOKEN: 't' }, fetch: a.fetch, opts })).reason, /Account ID/)
  assert.match((await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: a.fetch, opts: {} })).reason, /tên Worker/)
  const denied = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: cfFetch([], { status: 403 }).fetch, opts })
  assert.equal(denied.status, 'unreachable')
  assert.match(denied.reason, /từ chối quyền[\s\S]*403/)
  const down = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: async () => { throw new Error('ECONNRESET tok-chi-doc-123') }, opts })
  assert.equal(down.status, 'unreachable')
  assert.doesNotMatch(JSON.stringify(down), /tok-chi-doc-123/)
  const bad = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x') } }), opts })
  assert.equal(bad.status, 'unreachable')
})

test('logs: chưa chọn nguồn ⇒ unreachable (không im lặng)', async () => {
  for (const state of [null, { v: 1 }, { v: 1, logs: { source: 'none' } }, { v: 1, logs: { source: 'lạ' } }]) {
    const r = await readLogs({ state, since: DAY, now: NOW, env: cfEnv, fetch: cfFetch([]).fetch })
    assert.equal(r.status, 'unreachable')
  }
})

test('logs supabase: gọi Management API theo từng ngày, log giữ 1 ngày ⇒ hỏi 3 ngày là beyond-retention', async () => {
  const urls = []
  const fetch = async (url, init) => {
    urls.push({ url, auth: init.headers.authorization })
    return { ok: true, status: 200, json: async () => ({ result: [{ timestamp: (NOW - 3600000) * 1000, event_message: 'GET | 500 | /rest/v1/notes 77' }] }) }
  }
  const state = { v: 1, logs: { source: 'supabase' } }
  const r = await readLogs({ state, since: 3 * DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 'sbp_tok' }, fetch, opts: { projectRef: 'abcdefghijklmnop' } })
  assert.equal(r.status, 'beyond-retention')
  assert.equal(r.retentionDays, 1)
  assert.equal(urls.length, 2, '1 ngày × 2 truy vấn (edge, postgres)')
  assert.match(urls[0].url, /^https:\/\/api\.supabase\.com\/v1\/projects\/abcdefghijklmnop\/analytics\/endpoints\/logs\.all\?/)
  assert.equal(urls[0].auth, 'Bearer sbp_tok')
  assert.equal(r.total, 2)
  assert.equal(r.groups[0].count, 2)
  assert.equal(r.groups[0].last, NOW - 3600000)
})

test('logs supabase: thiếu token / mã dự án / 401 ⇒ unreachable', async () => {
  const state = { v: 1, logs: { source: 'supabase' } }
  assert.match((await readLogs({ state, since: DAY, now: NOW, env: {}, opts: { projectRef: 'abcdefghijklmnop' } })).reason, /token Supabase/)
  assert.match((await readLogs({ state, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, opts: {} })).reason, /mã dự án/)
  const r = await readLogs({ state, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch: async () => ({ ok: false, status: 401 }), opts: { projectRef: 'abcdefghijklmnop' } })
  assert.equal(r.status, 'unreachable')
  assert.match(r.reason, /401/)
})

test('BUG-4 logs supabase: --project-ref sai dạng ⇒ "không hợp lệ" (khác với thiếu), không gọi mạng, không in lại giá trị sai', async () => {
  const state = { v: 1, logs: { source: 'supabase' } }
  let n = 0
  const fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ result: [] }) } }
  for (const bad of ['x;rm', 'abc', 'a'.repeat(41), '../etc/passwd']) {
    const r = await readLogs({ state, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch, opts: { projectRef: bad } })
    assert.equal(r.status, 'unreachable')
    assert.match(r.reason, /mã dự án Supabase không hợp lệ/, bad)
    assert.doesNotMatch(r.reason, /thiếu/, bad)
    assert.doesNotMatch(JSON.stringify(r), /passwd|x;rm/)
  }
  const none = await readLogs({ state, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch, opts: {} })
  assert.match(none.reason, /thiếu mã dự án Supabase/)
  assert.equal(n, 0)
})

test('BUG-4 logs: HTTP 400/401/403 (Cloudflare lẫn Supabase) ⇒ "kiểm lại token / ID tài khoản", không bảo thử lại sau; 429/5xx mới bảo thử lại sau', async () => {
  const cf = (status) => readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: cfFetch([], { status }).fetch, opts: { worker: 'my-app' } })
  const sb = (status) => readLogs({ state: { v: 1, logs: { source: 'supabase' } }, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch: async () => ({ ok: false, status }), opts: { projectRef: 'abcdefghijklmnop' } })
  for (const status of [400, 401, 403]) {
    for (const [name, r] of [['cloudflare', await cf(status)], ['supabase', await sb(status)]]) {
      assert.equal(r.status, 'unreachable', `${name} ${status}`)
      assert.match(r.reason, new RegExp(`HTTP ${status}`), `${name} ${status}`)
      assert.match(r.fix, /kiểm lại token \/ ID tài khoản/, `${name} ${status}`)
      assert.doesNotMatch(r.fix, /thử lại sau/, `${name} ${status}`)
    }
  }
  for (const status of [429, 500, 502, 503]) {
    for (const [name, r] of [['cloudflare', await cf(status)], ['supabase', await sb(status)]]) {
      assert.match(r.reason, new RegExp(`HTTP ${status}`), `${name} ${status}`)
      assert.match(r.fix, /thử lại sau/, `${name} ${status}`)
      assert.doesNotMatch(r.fix, /kiểm lại token/, `${name} ${status}`)
    }
  }
  assert.match(formatLogs(await cf(400)).join('\n'), /Cách xử lý: kiểm lại token \/ ID tài khoản/)
})

test('logs: mọi cuộc gọi mạng (Cloudflare, Supabase) có hạn giờ — fetch nhận AbortSignal chưa huỷ; hết giờ ⇒ unreachable, không treo', async () => {
  const signals = []
  const spy = (body) => async (url, init) => {
    signals.push(init.signal)
    return { ok: true, status: 200, json: async () => body }
  }
  await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: spy({ result: { events: { events: [] } } }), opts: { worker: 'my-app' } })
  await readLogs({ state: { v: 1, logs: { source: 'supabase' } }, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, fetch: spy({ result: [] }), opts: { projectRef: 'abcdefghijklmnop' } })
  assert.equal(signals.length, 3, '1 cuộc gọi Cloudflare + 2 truy vấn Supabase')
  for (const s of signals) assert.ok(s instanceof AbortSignal && !s.aborted)

  // AbortSignal.timeout huỷ fetch bằng TimeoutError: cả hai nguồn phải trả "không truy cập được", kể cả khi hết giờ ở truy vấn thứ hai.
  const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const cf = await readLogs({ state: cfState(), since: DAY, now: NOW, env: cfEnv, fetch: async () => { throw timeout() }, opts: { worker: 'my-app' } })
  assert.equal(cf.status, 'unreachable')
  let n = 0
  const sb = await readLogs({
    state: { v: 1, logs: { source: 'supabase' } }, since: DAY, now: NOW, env: { SUPABASE_ACCESS_TOKEN: 't' }, opts: { projectRef: 'abcdefghijklmnop' },
    fetch: async () => { if (++n === 2) throw timeout(); return { ok: true, status: 200, json: async () => ({ result: [] }) } },
  })
  assert.equal(sb.status, 'unreachable')
  assert.match(sb.reason, /không kết nối được tới Supabase/)
  assert.match(formatLogs(sb).join('\n'), /Chưa kết luận được app có lỗi hay không/)
})

test('parseLogLines: chỉ dòng có mốc thời gian đầu dòng; docker lọc theo chữ lỗi', () => {
  const j = '-- Logs begin --\n2026-10-12T20:00:00+0700 srv app[1]: TypeError: x is undefined\n    at foo (a.js:1)\n-- No entries --\n'
  const ev1 = parseLogLines(j, { onlyErrors: false })
  assert.equal(ev1.length, 1)
  assert.equal(ev1[0].at, Date.parse('2026-10-12T20:00:00+07:00'))
  assert.match(ev1[0].message, /TypeError/)
  const d = 'app-1  | 2026-10-12T13:00:00.123456789Z listening on 3000\napp-1  | 2026-10-12T13:00:05Z ERROR db timeout\n'
  const ev2 = parseLogLines(d, { onlyErrors: true })
  assert.equal(ev2.length, 1)
  assert.match(ev2[0].message, /db timeout/)
})

test('logs vps journald: ssh với --since=-giây, -p err; gom lỗi; ssh 255 ⇒ unreachable', async () => {
  const state = { v: 1, logs: { source: 'vps-journald' } }
  const f = fixture()
  const out = [0, 1, 2].map((i) => `2026-10-12T${String(10 + i).padStart(2, '0')}:00:00+0000 srv app[1]: Error: db timeout ${i}`).join('\n')
  const { run, calls } = fakeRun(f, () => ({ stdout: out }))
  const r = await readLogs({ state, since: 2 * DAY, now: Date.parse('2026-10-13T00:00:00Z'), run, opts: { host: 'deploy@h', service: 'app', mode: 'symlink' } })
  assert.equal(r.status, 'errors')
  assert.equal(r.groups[0].count, 3)
  assert.deepEqual(calls[0].args, ['-o', 'BatchMode=yes', 'deploy@h', `journalctl -u app --since=-${2 * 86400}s -p err --no-pager -o short-iso`])
  const dead = await readLogs({ state, since: DAY, now: NOW, run: () => ({ status: 255, stdout: '', stderr: 'timeout', error: null }), opts: { host: 'deploy@h' } })
  assert.equal(dead.status, 'unreachable')
  assert.match(dead.reason, /ssh/)
  assert.equal((await readLogs({ state, since: DAY, now: NOW, run: () => ({}), opts: { host: '-oProxyCommand=x' } })).status, 'unreachable')
})

test('logs vps docker: docker compose logs --since, lọc chữ lỗi; không có lỗi ⇒ clean', async () => {
  const state = { v: 1, logs: { source: 'vps-journald' } }
  const f = fixture()
  const { run, calls } = fakeRun(f, () => ({ stdout: 'app-1  | 2026-10-12T23:00:00Z ready\n' }))
  const r = await readLogs({ state, since: DAY, now: NOW, run, opts: { host: 'h', root: '/srv/app', mode: 'docker' } })
  assert.equal(r.status, 'clean')
  assert.equal(calls[0].args.at(-1), `cd /srv/app && docker compose logs --since ${86400}s --no-color -t`)
  const noRoot = await readLogs({ state, since: DAY, now: NOW, run, opts: { host: 'h', mode: 'docker' } })
  assert.equal(noRoot.status, 'unreachable')
})

test('groupErrors: gom theo thông điệp đã bỏ số/mã, sắp theo số lần', () => {
  const g = groupErrors([
    { at: 1, message: 'a 1' }, { at: 3, message: 'a 22' }, { at: 2, message: 'b' }, { at: 4, message: 'a 5', flow: 'GET /x' },
  ])
  assert.deepEqual(g.map((x) => x.count), [2, 1, 1])
  assert.equal(g[0].first, 1)
  assert.equal(g[0].last, 3)
})

test('dropDueMarks: bỏ mốc đã tới hạn, giữ mốc chưa tới; không có gì đến hạn ⇒ không ghi', () => {
  const f = fixture()
  const past = new Date(NOW - DAY).toISOString()
  const future = new Date(NOW + 6 * DAY).toISOString()
  writeState(f.dir, { v: 1, checkAt: [past, future] }, f.so)
  assert.equal(dropDueMarks(f.dir, NOW, f.so), true)
  assert.deepEqual(readState(f.dir, f.so).checkAt, [future])
  assert.equal(dropDueMarks(f.dir, NOW, f.so), false)
  assert.equal(dropDueMarks(fixture().dir, NOW, f.so), false, 'chưa có release.json')
})

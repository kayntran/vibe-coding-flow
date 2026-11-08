import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeKey, label, listHomes, markSpent, order, quotaText, readState, runWithAccounts, waitMs } from './codex-accounts.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acc-'))
function world(n = 2) {
  const home = tmp()
  const dirs = ['.codex', '.codex-2', '.codex-3'].slice(0, n)
  for (const d of [...dirs, '.codex-empty']) fs.mkdirSync(path.join(home, d))
  for (const d of dirs) fs.writeFileSync(path.join(home, d, 'auth.json'), '{}')
  const [a, b, c] = dirs.map((d) => path.join(home, d))
  return { home, a, b, c, file: path.join(home, 'state.json') }
}
const QUOTA = { status: 1, stdout: '', stderr: "user\nlàm gì đó\nERROR: You've hit your usage limit. Try again in 2 hours 30 minutes." }
const OK = { status: 0, stdout: 'xong', stderr: '' }

test('listHomes: tài khoản đang dùng trước, rồi ~/.codex-* có auth.json; thư mục không đăng nhập bị bỏ', () => {
  const w = world()
  assert.deepEqual(listHomes({ env: {}, home: w.home }), [w.a, w.b])
  assert.deepEqual(listHomes({ env: { CODEX_HOME: w.b }, home: w.home }), [w.b, w.a])
  assert.deepEqual(listHomes({ env: { FLOW_CODEX_HOMES: [w.b, path.join(w.home, '.codex-empty')].join(path.delimiter) }, home: w.home }), [w.b])
  assert.equal(label(w.a), '1')
  assert.equal(label(w.b), '2')
})

test('waitMs đọc giờ mở lại, không đọc được ⇒ 1 giờ', () => {
  assert.equal(waitMs('try again in 2 hours 30 minutes'), 2.5 * 3600_000)
  assert.equal(waitMs('Usage limit reached. Try again in 3 days.'), 3 * 86_400_000)
  assert.equal(waitMs('usage limit'), 3600_000)
  const now = new Date(2026, 10, 8, 15, 0).getTime()
  const msg = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Dec 5th, 2026 1:53 PM."
  assert.equal(waitMs(msg, now), new Date(2026, 11, 5, 13, 53).getTime() - now, 'ngày mở lại cụ thể (giờ máy)')
  assert.equal(waitMs('try again at Jan 1st, 2020 1:00 PM', now), 3600_000, 'ngày đã qua ⇒ 1 giờ')
  assert.equal(waitMs('Try again at Dec 5th, 2026 1:53 PM UTC.', now), Date.UTC(2026, 11, 5, 13, 53) - now, 'có múi giờ ⇒ theo múi giờ đó')
})

test('homeKey: Windows không phân biệt hoa thường (sổ ghi C:/Users/admin vẫn khớp C:\\Users\\Admin), máy khác giữ nguyên', () => {
  assert.equal(homeKey('C:/Users/admin/.codex-2', 'win32'), homeKey('C:\\Users\\Admin\\.codex-2', 'win32'))
  assert.notEqual(homeKey('/home/A/.codex', 'linux'), homeKey('/home/a/.codex', 'linux'))
  const w = world()
  const now = 1000
  markSpent(w.a.toUpperCase(), 'ERROR: usage limit', { file: w.file, now })
  if (process.platform === 'win32') {
    assert.equal(order([w.a, w.b], readState(w.file), now).live[0], w.b, 'mục ghi bằng chữ hoa vẫn được nhận')
    assert.equal(Object.keys(readState(w.file)).length, 1)
  }
})

test('markSpent: ghi tài khoản hết lượt tới ngày mở lại; giữ mục tài khoản khác', () => {
  const w = world()
  fs.writeFileSync(w.file, JSON.stringify({ [w.b]: { until: 1 } }))
  const now = new Date(2026, 10, 8, 15, 0).getTime()
  const until = markSpent(w.a, 'ERROR: try again at Dec 5th, 2026 1:53 PM', { file: w.file, now })
  assert.equal(until, new Date(2026, 11, 5, 13, 53).getTime())
  assert.equal(readState(w.file)[homeKey(w.a)].until, until)
  assert.ok(readState(w.file)[w.b])
})

test('quotaText: chỉ dòng lỗi cuối của Codex; chữ "usage limit" trong prompt/nhật ký hay 429 thoáng qua không tính', () => {
  assert.match(quotaText(QUOTA), /usage limit/)
  assert.equal(quotaText({ status: 1, stdout: '', stderr: 'user\nsửa QUOTA_RE cho "usage limit"\nERROR: stream disconnected' }), null)
  assert.equal(quotaText({ status: 1, stdout: '', stderr: 'ERROR: rate limit exceeded, retrying (429 Too Many Requests)' }), null)
  assert.equal(quotaText({ ...QUOTA, timedOut: true }), null)
})

test('hết lượt ⇒ sang tài khoản kế, báo một dòng, nhớ tài khoản đã hết; lần sau dùng thẳng tài khoản còn lượt', async () => {
  const w = world()
  const calls = []
  const say = []
  const run = async (env) => { calls.push(env.CODEX_HOME); return env.CODEX_HOME === w.a ? QUOTA : OK }
  const r = await runWithAccounts(run, { env: {}, home: w.home, file: w.file, say: (s) => say.push(s), now: () => 1000 })
  assert.equal(r.status, 0)
  assert.equal(r.home, w.b)
  assert.deepEqual(calls, [w.a, w.b])
  assert.deepEqual(say, ['Codex: tài khoản 1 hết lượt ⇒ đã chuyển sang tài khoản 2.'])
  assert.equal(readState(w.file)[homeKey(w.a)].until, 1000 + 2.5 * 3600_000)

  calls.length = 0
  await runWithAccounts(run, { env: {}, home: w.home, file: w.file, now: () => 2000 })
  assert.deepEqual(calls, [w.b], 'tài khoản 1 còn trong giờ hết lượt ⇒ không thử lại')

  calls.length = 0
  await runWithAccounts(async (env) => { calls.push(env.CODEX_HOME); return OK }, { env: {}, home: w.home, file: w.file, now: () => 1000 + 3 * 3600_000 })
  assert.deepEqual(calls, [w.a], 'qua giờ mở lại ⇒ tài khoản 1 dùng lại, sổ được xoá')
  assert.equal(readState(w.file)[homeKey(w.a)], undefined)
})

test('tài khoản còn lượt duy nhất cũng hết ⇒ không gọi thêm vào tài khoản đã biết là hết lượt', async () => {
  const w = world(3)
  fs.writeFileSync(w.file, JSON.stringify({ [w.b]: { until: 9e15 }, [w.c]: { until: 9e15 } }))
  const calls = []
  const say = []
  const r = await runWithAccounts(async (env) => { calls.push(env.CODEX_HOME); return QUOTA }, { env: {}, home: w.home, file: w.file, say: (s) => say.push(s) })
  assert.deepEqual(calls, [w.a])
  assert.equal(r.quota, true)
  assert.match(say.at(-1), /tài khoản 1 cũng hết lượt/)
  assert.ok(readState(w.file)[w.b], 'mục của tài khoản khác giữ nguyên khi ghi sổ')
})

test('lỗi khác hết lượt ⇒ dừng ngay, không đốt tài khoản khác', async () => {
  const w = world()
  const calls = []
  const r = await runWithAccounts(async (env) => { calls.push(env.CODEX_HOME); return { status: 1, stdout: '', stderr: 'ERROR: ECONNRESET' } },
    { env: {}, home: w.home, file: w.file })
  assert.equal(r.status, 1)
  assert.deepEqual(calls, [w.a])
})

test('mọi tài khoản hết lượt ⇒ báo hết, kết quả đánh dấu quota; ok() riêng: exit 0 mà không ra kết quả vẫn xét dòng lỗi', async () => {
  const w = world()
  const say = []
  const r = await runWithAccounts(async () => ({ ...QUOTA, status: 0 }), { env: {}, home: w.home, file: w.file, ok: (x) => x.stdout === 'xong', say: (s) => say.push(s) })
  assert.equal(r.quota, true)
  assert.match(say.at(-1), /tài khoản 2 cũng hết lượt/)
  assert.equal(order([w.a, w.b], readState(w.file), Date.now()).live.length, 0)
  const again = []
  await runWithAccounts(async (env) => { again.push(env.CODEX_HOME); return OK }, { env: {}, home: w.home, file: w.file, say: (s) => again.push(s) })
  assert.equal(again.filter((x) => !x.startsWith('Codex:')).length, 1, 'hết cả ⇒ chỉ thử một tài khoản mở lại sớm nhất')
})

test('không có tài khoản nào ⇒ chạy một lần với env sẵn có', async () => {
  const home = tmp()
  const r = await runWithAccounts(async (env) => ({ ...OK, seen: env.CODEX_HOME }), { env: { X: '1' }, home, file: path.join(home, 's.json') })
  assert.equal(r.home, null)
  assert.equal(r.seen, undefined)
})

// Test cho lib/release-state.mjs: node --test hooks/lib/release-state.test.mjs
// Log trỏ vào thư mục tạm (opts.logDir): không đụng ~/.claude/logs thật. Thư mục dự án có dấu cách + tiếng Việt.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION, backupReady, dueReminders, readState, releaseCount, statePath, updateState, writeState } from './release-state.mjs'

const tmpDirs = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-state thử '))
  tmpDirs.push(root)
  const dir = path.join(root, 'ứng dụng')
  fs.mkdirSync(dir)
  const logDir = path.join(root, 'logs')
  return { dir, opts: { logDir }, log: path.join(logDir, 'release-state.log') }
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

const NOW = '2026-10-13T00:00:00.000Z'
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()
const hoursAgo = (n) => new Date(Date.parse(NOW) - n * 3600000).toISOString()
const sample = () => ({
  v: 1, platform: 'cloudflare', target: 'app',
  lastRelease: { at: daysAgo(1), version: '1.0.0', commit: 'abc1234', smoke: 'pass' },
  checkAt: [], rollbackTested: true,
  backup: { choice: 'off' }, health: { lastAt: daysAgo(2) },
})

// --- readState / writeState ---------------------------------------------------------------------------------------------------

test('chưa có file ⇒ null, không log', () => {
  const f = fixture()
  assert.equal(readState(f.dir, f.opts), null)
  assert.equal(fs.existsSync(f.log), false)
})

test('ghi rồi đọc lại đủ trường, kể cả trường lạ; tạo thư mục .claude; không để file tạm', () => {
  const f = fixture()
  const s = { ...sample(), tuyBien: { x: 1 } }
  assert.equal(writeState(f.dir, s, f.opts), true)
  assert.deepEqual(readState(f.dir, f.opts), s)
  assert.deepEqual(fs.readdirSync(path.dirname(statePath(f.dir))), ['release.json'])
})

test('writeState luôn ghi v hiện tại và ghi đè bản cũ', () => {
  const f = fixture()
  writeState(f.dir, { ...sample(), v: 99, target: 'a' }, f.opts)
  assert.equal(readState(f.dir, f.opts).v, VERSION)
  writeState(f.dir, { ...sample(), target: 'b' }, f.opts)
  assert.equal(readState(f.dir, f.opts).target, 'b')
})

test('ghi không đổi state truyền vào; state không phải object ⇒ false + log', () => {
  const f = fixture()
  const s = { platform: 'x' }
  writeState(f.dir, s, f.opts)
  assert.deepEqual(s, { platform: 'x' })
  assert.equal(writeState(f.dir, [1], f.opts), false)
  assert.equal(writeState(f.dir, null, f.opts), false)
  assert.match(fs.readFileSync(f.log, 'utf8'), /không ghi/)
})

test('rename lỗi ⇒ false, không ném, dọn file tạm, bản cũ còn nguyên', () => {
  const f = fixture()
  writeState(f.dir, sample(), f.opts)
  const file = statePath(f.dir)
  fs.rmSync(file)
  fs.mkdirSync(file) // thư mục đúng tên đích ⇒ rename file lên thư mục phải lỗi
  assert.equal(writeState(f.dir, sample(), f.opts), false)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['release.json'])
  assert.match(fs.readFileSync(f.log, 'utf8'), /không ghi được/)
})

for (const [ten, noiDung, mongLog] of [
  ['không phải JSON', '{ hỏng', /không phải JSON/],
  ['file rỗng', '', /không phải JSON/],
  ['mảng', '[1,2]', /không phải object/],
  ['thiếu v', '{"platform":"x"}', /thiếu hoặc sai trường v/],
  ['v sai kiểu', '{"v":"1"}', /thiếu hoặc sai trường v/],
  ['v mới hơn', '{"v":2}', /mới hơn/],
]) {
  test(`file hỏng (${ten}) ⇒ null, đúng 1 dòng log, không ném`, () => {
    const f = fixture()
    fs.mkdirSync(path.dirname(statePath(f.dir)), { recursive: true })
    fs.writeFileSync(statePath(f.dir), noiDung)
    assert.equal(readState(f.dir, f.opts), null)
    const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], mongLog)
  })
}

test('đọc được file có BOM', () => {
  const f = fixture()
  fs.mkdirSync(path.dirname(statePath(f.dir)), { recursive: true })
  fs.writeFileSync(statePath(f.dir), '﻿' + JSON.stringify(sample()))
  assert.equal(readState(f.dir, f.opts).target, 'app')
})

test('không in ra stdout', () => {
  const f = fixture()
  const orig = process.stdout.write
  let wrote = ''
  process.stdout.write = (c, ...r) => { wrote += String(c); return true }
  try {
    writeState(f.dir, sample(), f.opts)
    readState(f.dir, f.opts)
    fs.writeFileSync(statePath(f.dir), '{ hỏng')
    readState(f.dir, f.opts)
    dueReminders(sample(), NOW)
  } finally { process.stdout.write = orig }
  assert.equal(wrote, '')
})

// --- updateState: đọc lại NGAY trước khi ghi (lệnh chạy lâu không được ghi đè cái người khác vừa ghi) ----------------------------

test('updateState: fn nhận trạng thái MỚI NHẤT trên đĩa, không phải bản đã đọc từ trước; trường lạ giữ nguyên', () => {
  const f = fixture()
  writeState(f.dir, { ...sample(), tuyBien: { x: 1 } }, f.opts)
  const early = readState(f.dir, f.opts) // bản "đọc sớm" của một lệnh chạy lâu
  writeState(f.dir, { ...early, checkAt: [daysAgo(-1)], lastRelease: { at: NOW, version: '2.0.0' } }, f.opts) // lúc đó `release cf` ghi
  const r = updateState(f.dir, (s) => ({ ...s, backup: { ...s.backup, lastBackup: NOW } }), f.opts)
  assert.equal(r.ok, true)
  const now = readState(f.dir, f.opts)
  assert.deepEqual(now.checkAt, [daysAgo(-1)])
  assert.equal(now.lastRelease.version, '2.0.0')
  assert.equal(now.backup.lastBackup, NOW)
  assert.deepEqual(now.tuyBien, { x: 1 })
  assert.deepEqual(r.state, now)
})

test('updateState: chưa có file ⇒ fn nhận {} và tạo file; fn trả null/undefined ⇒ không ghi gì', () => {
  const f = fixture()
  assert.equal(updateState(f.dir, () => null, f.opts).ok, true)
  assert.equal(fs.existsSync(statePath(f.dir)), false)
  const r = updateState(f.dir, (s) => { assert.deepEqual(s, {}); return { health: { lastAt: NOW } } }, f.opts)
  assert.equal(r.ok, true)
  assert.deepEqual(readState(f.dir, f.opts), { health: { lastAt: NOW }, v: VERSION })
  const before = fs.readFileSync(statePath(f.dir), 'utf8')
  const same = updateState(f.dir, () => undefined, f.opts)
  assert.deepEqual([same.ok, same.changed], [true, false])
  assert.equal(fs.readFileSync(statePath(f.dir), 'utf8'), before)
})

for (const [ten, noiDung] of [['không phải JSON', '{ hỏng'], ['v mới hơn', '{"v":2,"x":1}'], ['mảng', '[1]']]) {
  test(`updateState: file đang có mà hỏng (${ten}) ⇒ KHÔNG ghi đè, không gọi fn, trả reason "corrupt"`, () => {
    const f = fixture()
    fs.mkdirSync(path.dirname(statePath(f.dir)), { recursive: true })
    fs.writeFileSync(statePath(f.dir), noiDung)
    let called = false
    const r = updateState(f.dir, () => { called = true; return { a: 1 } }, f.opts)
    assert.deepEqual([r.ok, r.reason], [false, 'corrupt'])
    assert.equal(called, false)
    assert.equal(fs.readFileSync(statePath(f.dir), 'utf8'), noiDung)
  })
}

test('updateState: ghi không được ⇒ { ok:false, reason:"failed" }, không ném; fn trả thứ không phải object ⇒ failed', () => {
  const f = fixture()
  writeState(f.dir, sample(), f.opts)
  const file = statePath(f.dir)
  const before = fs.readFileSync(file, 'utf8')
  assert.deepEqual(updateState(f.dir, () => [1], f.opts), { ok: false, reason: 'failed' })
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  fs.rmSync(file)
  fs.mkdirSync(file) // thư mục đúng tên đích ⇒ không đọc được file, rename lỗi
  const r = updateState(f.dir, (s) => ({ ...s, a: 1 }), f.opts)
  assert.equal(r.ok, false)
})

// --- backupReady --------------------------------------------------------------------------------------------------------------

const on =(extra = {}) => ({ ...sample(), backup: { choice: 'on', everyHours: 24, scheduler: { kind: 'schtasks', id: 't1' }, lastBackup: hoursAgo(10), lastRestoreCheck: daysAgo(3), ...extra } })

test('backupReady: choice khác on / không có backup ⇒ không áp dụng, không chặn', () => {
  for (const s of [sample(), { ...sample(), backup: { choice: 'advise-pro' } }, { ...sample(), backup: undefined }, null, {}]) {
    assert.deepEqual(backupReady(s, NOW), { applicable: false, ready: true, reasons: [] })
  }
})

test('backupReady: on đủ điều kiện ⇒ ready', () => {
  assert.deepEqual(backupReady(on(), NOW), { applicable: true, ready: true, reasons: [] })
})

test('backupReady: lần sao lưu đúng 2×everyHours vẫn đạt, quá một chút thì không', () => {
  assert.equal(backupReady(on({ lastBackup: hoursAgo(48) }), NOW).ready, true)
  const r = backupReady(on({ lastBackup: hoursAgo(48.01) }), NOW)
  assert.equal(r.ready, false)
  assert.deepEqual(r.reasons.map((x) => x.code), ['stale'])
})

test('backupReady: từng thiếu sót ra đúng mã lý do', () => {
  const code = (extra) => backupReady(on(extra), NOW).reasons.map((x) => x.code)
  assert.deepEqual(code({ scheduler: undefined }), ['no-scheduler'])
  assert.deepEqual(code({ scheduler: { kind: 'cron' } }), ['no-scheduler'])
  assert.deepEqual(code({ lastBackup: undefined }), ['no-backup'])
  assert.deepEqual(code({ lastBackup: 'không phải ngày' }), ['no-backup'])
  assert.deepEqual(code({ lastRestoreCheck: undefined }), ['no-restore-check'])
  assert.deepEqual(code({ everyHours: 0 }), ['no-interval'])
  assert.deepEqual(code({ everyHours: undefined }), ['no-interval'])
  assert.ok(backupReady(on({ lastRestoreCheck: undefined }), NOW).reasons[0].text.length > 0)
})

test('backupReady: on trơ trọi ⇒ nhiều lý do', () => {
  const r = backupReady({ backup: { choice: 'on' } }, NOW)
  assert.equal(r.ready, false)
  assert.deepEqual(r.reasons.map((x) => x.code), ['no-scheduler', 'no-interval', 'no-backup', 'no-restore-check'])
})

// --- dueReminders -------------------------------------------------------------------------------------------------------------

test('dueReminders: state null/rác ⇒ rỗng; now không hiểu ⇒ rỗng', () => {
  assert.deepEqual(dueReminders(null, NOW), [])
  assert.deepEqual(dueReminders([], NOW), [])
  assert.deepEqual(dueReminders(sample(), 'hôm qua'), [])
})

test('dueReminders: dự án khoẻ ⇒ rỗng', () => {
  assert.deepEqual(dueReminders(sample(), NOW), [])
})

test('dueReminders: mốc checkAt đã tới hạn (kể cả đúng lúc) ⇒ nhắc kèm các mốc đó; mốc tương lai bỏ qua', () => {
  const s = { ...sample(), checkAt: [daysAgo(1), NOW, daysAgo(-3), 'rác'] }
  const r = dueReminders(s, NOW)
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'check')
  assert.deepEqual(r[0].due, [daysAgo(1), NOW])
  assert.deepEqual(dueReminders({ ...sample(), checkAt: [daysAgo(-1)] }, NOW), [])
})

test('dueReminders: now nhận Date, số ms, chuỗi ISO như nhau', () => {
  const s = { ...sample(), checkAt: [daysAgo(1)] }
  const a = dueReminders(s, NOW), b = dueReminders(s, new Date(NOW)), c = dueReminders(s, Date.parse(NOW))
  assert.deepEqual(a, b)
  assert.deepEqual(a, c)
  assert.equal(a.length, 1)
})

test('dueReminders: khám sức khoẻ — đúng 30 ngày chưa nhắc, quá thì nhắc', () => {
  assert.deepEqual(dueReminders({ ...sample(), health: { lastAt: daysAgo(30) } }, NOW), [])
  const r = dueReminders({ ...sample(), health: { lastAt: daysAgo(31) } }, NOW)
  assert.deepEqual(r.map((x) => x.kind), ['health'])
})

test('dueReminders: chưa khám lần nào ⇒ lấy ngày phát hành làm mốc; chưa phát hành cũng chưa khám ⇒ không nhắc', () => {
  const s = sample()
  delete s.health
  s.lastRelease.at = daysAgo(40)
  assert.deepEqual(dueReminders(s, NOW).map((x) => x.kind), ['health'])
  s.lastRelease.at = daysAgo(5)
  assert.deepEqual(dueReminders(s, NOW), [])
  assert.deepEqual(dueReminders({ v: 1 }, NOW), [])
})

test('dueReminders: đã phát hành mà chưa chọn sao lưu ⇒ nhắc; chưa phát hành ⇒ không', () => {
  const s = sample()
  delete s.backup
  assert.deepEqual(dueReminders(s, NOW).map((x) => x.kind), ['backup'])
  delete s.lastRelease
  assert.deepEqual(dueReminders(s, NOW), [])
})

test('dueReminders: backup on chưa đạt ⇒ nhắc kèm lý do; đạt ⇒ im', () => {
  const r = dueReminders(on({ lastRestoreCheck: undefined }), NOW)
  assert.deepEqual(r.map((x) => x.kind), ['backup'])
  assert.deepEqual(r[0].reasons.map((x) => x.code), ['no-restore-check'])
  assert.deepEqual(dueReminders(on(), NOW), [])
})

test('dueReminders: nhiều lời nhắc theo thứ tự check, backup, health; không đổi state', () => {
  const s = { ...sample(), checkAt: [daysAgo(1)], backup: undefined, health: { lastAt: daysAgo(60) } }
  const copy = JSON.parse(JSON.stringify(s))
  assert.deepEqual(dueReminders(s, NOW).map((x) => x.kind), ['check', 'backup', 'health'])
  assert.deepEqual(JSON.parse(JSON.stringify(s)), copy)
})

// --- releaseCount (K3: đếm số lần phát hành để preflight chỉ đòi "đã thử quay lại" từ lần phát hành thứ 3) ---------------------

test('releaseCount: có trường releaseCount ⇒ dùng nó; file cũ không có ⇒ suy từ lastRelease (1 hoặc 0); không có state ⇒ 0', () => {
  assert.equal(releaseCount({ releaseCount: 5, lastRelease: { at: daysAgo(1) } }), 5)
  assert.equal(releaseCount({ lastRelease: { at: daysAgo(1), version: 'x' } }), 1, 'file cũ đã có một lần phát hành')
  assert.equal(releaseCount({ platform: 'vps' }), 0)
  for (const bad of [null, undefined, 'x', [], { releaseCount: -1 }, { releaseCount: 1.5 }, { releaseCount: 'hai' }]) assert.equal(releaseCount(bad), 0, JSON.stringify(bad))
  assert.equal(releaseCount({ releaseCount: 0, lastRelease: { at: daysAgo(1) } }), 0, 'trường có thật thì thắng suy đoán')
})

test('releaseCount đi qua updateState: tăng 1 từ file cũ, giữ trường lạ', () => {
  const f = fixture()
  writeState(f.dir, { ...sample(), lạ: 1 }, f.opts)
  const r = updateState(f.dir, (cur) => ({ ...cur, releaseCount: releaseCount(cur) + 1 }), f.opts)
  assert.equal(r.ok, true)
  assert.equal(readState(f.dir, f.opts).releaseCount, 2, 'file cũ đã có lastRelease ⇒ coi như 1, thêm 1')
  assert.equal(readState(f.dir, f.opts).lạ, 1)
  assert.equal(readState(f.dir, f.opts).v, VERSION, 'thêm trường tuỳ chọn có suy luận ⇒ không cần tăng VERSION')
})

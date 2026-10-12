// Test cho lib/solutions.mjs: node --test ~/.claude/hooks/lib/solutions.test.mjs
// Mọi thứ chạy trong thư mục tạm (fs.mkdtempSync); giờ cố định bằng tham số `now`.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from './solutions.mjs'

const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'solutions-test-'))); roots.push(d); return d }
const NOW = Date.UTC(2026, 9, 12, 5, 0) // 2026-10-12 12:00 giờ VN
const dayMs = 86400000
const SOL = (root) => path.join(root, 'docs', 'solutions')
const read = (root, name) => fs.readFileSync(path.join(SOL(root), name), 'utf8')
const base = (o = {}) => ({
  dang_loi: 'Quên đổi .env.example', tom_tat: 'Thêm biến môi trường mà không cập nhật .env.example',
  tags: ['env', 'cau-hinh'], nguon: 'abc1234', vi_sao_khong_suy_ra: 'Chỉ lộ ra khi người khác clone repo mới', cach_tranh: 'Thêm biến thì thêm cả vào .env.example',
  ...o,
})

describe('nhan', () => {
  test('bỏ dấu, thường, nối gạch', () => {
    assert.equal(S.nhan('Quên đổi .env.example'), 'quen-doi-env-example')
    assert.equal(S.nhan('  Đường dẫn  Tuyệt đối!! '), 'duong-dan-tuyet-doi')
    assert.equal(S.nhan(''), '')
  })
})

describe('ghi', () => {
  test('tạo file <ngày>-<slug>.md với front matter đủ trường', () => {
    const root = tmp()
    const r = S.ghi(root, base(), { now: NOW })
    assert.equal(r.file, '2026-10-12-quen-doi-env-example.md')
    const t = read(root, r.file)
    const p = S.parseBaiHoc(t, r.file)
    assert.equal(p.loi, undefined)
    assert.deepEqual([p.dang_loi, p.lan, p.may_kiem, p.ngay, p.ra_soat, p.tai_phat, p.vong_sua, p.bao_nham], ['quen-doi-env-example', 1, 'none', '2026-10-12', '2026-10-12', 0, 0, 0])
    assert.deepEqual(p.tags, ['env', 'cau-hinh'])
    assert.equal(p.nguon, 'abc1234')
    assert.match(p.vi_sao_khong_suy_ra, /clone repo/)
    for (const h of ['## Chuyện gì', '## Vì sao không suy ra được từ code', '## Cách tránh']) assert.ok(t.includes(h), h)
  })
  test('thiếu / rỗng vi_sao_khong_suy_ra ⇒ từ chối, không tạo file', () => {
    const root = tmp()
    for (const v of [undefined, '', '   \n']) {
      assert.throws(() => S.ghi(root, base({ vi_sao_khong_suy_ra: v }), { now: NOW }), /đọc code là biết, không cần ghi/)
    }
    assert.equal(fs.existsSync(SOL(root)), false)
  })
  test('thiếu dang_loi / tom_tat, may_kiem lạ ⇒ lỗi', () => {
    const root = tmp()
    assert.throws(() => S.ghi(root, base({ dang_loi: ' ' })), /dang_loi/)
    assert.throws(() => S.ghi(root, base({ tom_tat: '' })), /tom_tat/)
    assert.throws(() => S.ghi(root, base({ may_kiem: 'magic' })), /may_kiem/)
    assert.throws(() => S.ghi(root, base({ ngay: '12/10/2026' })), /ngay/)
  })
  test('trùng dang_loi ⇒ từ chối, chỉ sang gap', () => {
    const root = tmp()
    S.ghi(root, base(), { now: NOW })
    assert.throws(() => S.ghi(root, base({ dang_loi: 'quen doi ENV example' }), { now: NOW }), /gap/)
  })
  test('hai nhãn khác nhau cùng slug cùng ngày ⇒ không đè file', () => {
    const root = tmp()
    const a = S.ghi(root, base({ dang_loi: 'a b c d e f g h' }), { now: NOW })
    const b = S.ghi(root, base({ dang_loi: 'a b c d e f g i' }), { now: NOW })
    assert.notEqual(a.file, b.file)
    assert.equal(S.scan(root).items.length, 2)
  })
  test('nội dung có dấu nháy/dấu hai chấm vẫn đọc lại đúng', () => {
    const root = tmp()
    const r = S.ghi(root, base({ tom_tat: 'Lỗi "lạ": a: b', vi_sao_khong_suy_ra: 'vì "x": y' }), { now: NOW })
    const p = S.parseBaiHoc(read(root, r.file))
    assert.equal(p.tom_tat, 'Lỗi "lạ": a: b')
    assert.equal(p.vi_sao_khong_suy_ra, 'vì "x": y')
  })
  test('không để lại file tạm', () => {
    const root = tmp()
    S.ghi(root, base(), { now: NOW })
    assert.deepEqual(fs.readdirSync(SOL(root)).filter((n) => n.includes('.tmp-')), [])
  })
})

describe('gap', () => {
  test('lần 2: tăng lan + tai_phat, cập nhật ra_soat, may_kiem none ⇒ đề xuất theo thang', () => {
    const root = tmp()
    const g = S.ghi(root, base(), { now: NOW - 40 * dayMs })
    const r = S.gap(root, 'QUÊN ĐỔI .env.example', { now: NOW })
    assert.equal(r.lan, 2)
    assert.equal(r.tai_phat, 1)
    const p = S.parseBaiHoc(read(root, g.file))
    assert.deepEqual([p.lan, p.tai_phat, p.ra_soat, p.ngay], [2, 1, '2026-10-12', '2026-09-02'])
    const text = r.de_xuat.join('\n')
    const order = ['luật có sẵn', 'no-restricted-*/depguard', 'ast-grep', 'test', 'hook', 'lời dặn'].map((k) => text.indexOf(k))
    assert.ok(order.every((i) => i >= 0), text)
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'thang phải đúng thứ tự')
    assert.match(p.than, /Cách tránh/) // thân giữ nguyên
  })
  test('đã có máy kiểm ⇒ chỉ đếm, không đề xuất', () => {
    const root = tmp()
    S.ghi(root, base({ may_kiem: 'lint' }), { now: NOW })
    const r = S.gap(root, 'quen-doi-env-example', { now: NOW })
    assert.equal(r.lan, 2)
    assert.deepEqual(r.de_xuat, [])
  })
  test('chưa có bài học ⇒ lỗi', () => {
    assert.throws(() => S.gap(tmp(), 'khong-co', { now: NOW }), /không có bài học/)
  })
  test('lan ghi sẵn ≥ 2 thì gap vẫn đề xuất', () => {
    const root = tmp()
    S.ghi(root, base({ lan: 3 }), { now: NOW })
    assert.ok(S.gap(root, 'quen-doi-env-example', { now: NOW }).de_xuat.length > 0)
  })
})

describe('raSoat', () => {
  test('liệt kê bài học quá hạn (mặc định 30 ngày), cũ nhất trước', () => {
    const root = tmp()
    S.ghi(root, base({ dang_loi: 'cu-nhat' }), { now: NOW - 90 * dayMs })
    S.ghi(root, base({ dang_loi: 'cu' }), { now: NOW - 31 * dayMs })
    S.ghi(root, base({ dang_loi: 'vua-du' }), { now: NOW - 30 * dayMs })
    S.ghi(root, base({ dang_loi: 'moi' }), { now: NOW - 2 * dayMs })
    const r = S.raSoat(root, { now: NOW })
    assert.deepEqual(r.map((b) => b.dang_loi), ['cu-nhat', 'cu'])
    assert.equal(r[0].tuoi, 90)
    assert.deepEqual(S.raSoat(root, { days: 1, now: NOW }).map((b) => b.dang_loi), ['cu-nhat', 'cu', 'vua-du', 'moi'])
  })
  test('gap làm mới ra_soat ⇒ hết quá hạn', () => {
    const root = tmp()
    S.ghi(root, base(), { now: NOW - 90 * dayMs })
    assert.equal(S.raSoat(root, { now: NOW }).length, 1)
    S.gap(root, 'quen-doi-env-example', { now: NOW })
    assert.equal(S.raSoat(root, { now: NOW }).length, 0)
  })
  test('không có thư mục solutions ⇒ rỗng; --days sai ⇒ lỗi', () => {
    assert.deepEqual(S.raSoat(tmp(), { now: NOW }), [])
    assert.throws(() => S.raSoat(tmp(), { days: 'x' }), /days/)
  })
})

describe('index', () => {
  test('sinh INDEX.md có dòng đánh dấu, mục lặp chưa có máy kiểm ở đầu, chạy lại không đổi', () => {
    const root = tmp()
    S.ghi(root, base({ dang_loi: 'loi-a' }), { now: NOW })
    S.ghi(root, base({ dang_loi: 'loi-b', may_kiem: 'test' }), { now: NOW - dayMs })
    S.gap(root, 'loi-a', { now: NOW })
    const r = S.index(root)
    assert.equal(r.ghi, true)
    const t = read(root, 'INDEX.md')
    assert.ok(t.startsWith(S.GEN_MARK))
    assert.match(t, /## Lặp lại mà chưa có máy kiểm \(1\)\n- \[loi-a\]/)
    assert.match(t, /## Tất cả \(2\)/)
    assert.equal(S.scan(root).items.length, 2, 'INDEX.md không tính là bài học')
    assert.equal(S.index(root).ghi, false)
  })
  test('INDEX.md viết tay ⇒ không ghi đè', () => {
    const root = tmp()
    fs.mkdirSync(SOL(root), { recursive: true })
    fs.writeFileSync(path.join(SOL(root), 'INDEX.md'), '# Của tôi\n')
    const r = S.index(root)
    assert.equal(r.ghi, false)
    assert.match(r.bo_qua, /viết tay/)
    assert.equal(read(root, 'INDEX.md'), '# Của tôi\n')
  })
  test('file hỏng bị bỏ qua, không làm hỏng cả mục lục', () => {
    const root = tmp()
    S.ghi(root, base(), { now: NOW })
    fs.writeFileSync(path.join(SOL(root), '2026-01-01-hong.md'), 'không có front matter')
    assert.equal(S.scan(root).items.length, 1)
    assert.equal(S.scan(root).loi.length, 1)
    assert.equal(S.index(root).ghi, true)
  })
})

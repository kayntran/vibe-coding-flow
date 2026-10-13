// Test cho CLI spec-check.mjs: node --test ~/.claude/hooks/spec-check.test.mjs
// Chạy script thật trong thư mục tạm có dấu cách + tiếng Việt. Logic nằm ở lib/spec-codes.test.mjs; ở đây chỉ kiểm lệnh, cờ, mã thoát, lời báo.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec-check.mjs')
const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spec CLI Việt '))); roots.push(d); return d }
const put = (dir, rel, text = '') => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const cli = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts })

const table = (first, whens = ['Có dữ liệu', 'Trống', 'Đang tải', 'Lỗi']) =>
  `| mã | khi | thấy gì | làm được gì |\n|---|---|---|---|\n${whens.map((w, i) => `| S-0${first + i} | ${w} | thấy | làm |\n`).join('')}`
const SPEC = (screens = `#### Danh sách đơn\n\n${table(1)}`, rights = '- P-01: Chủ đơn thấy đơn của mình\n') =>
  `# SPEC\n\n## Bạn duyệt\n\n### Ai dùng\nChủ cửa hàng.\n\n### Các màn hình\n\n${screens}\n### Làm được gì\n- Xem đơn.\n\n### Để sau\nKhông có.\n\n### Phí phát sinh\nKhông.\n\n### Ai thấy/sửa được dữ liệu gì\n${rights}\n## Kỹ thuật\nGhi chú.\n`
const APP = '<a data-s="S-01"/><a data-s="S-02"/><a data-s="S-03"/><a data-s="S-04"/>\n'
const TEST = "test('S-01 S-02 S-03 S-04', () => {})\ntest('P-01 chủ khác không thấy', () => {})\n"
// dự án có một SPEC đang làm, app + test đủ mã
const project = (files = {}) => {
  const dir = tmp()
  const all = { 'docs/specs/don-hang/SPEC.md': SPEC(), 'docs/specs/don-hang/progress.md': 'Trạng thái: đang làm\n', 'src/Orders.tsx': APP, 'e2e/orders.spec.ts': TEST, ...files }
  for (const [rel, text] of Object.entries(all)) if (text !== null) put(dir, rel, text)
  return dir
}

describe('dùng sai lệnh', () => {
  test('không lệnh / lệnh lạ / thiếu giá trị cờ / cờ lạ / thiếu SPEC / SPEC không đọc được ⇒ exit 2 + dòng "dùng:"', () => {
    const dir = tmp()
    for (const args of [[], ['xoa-het'], ['codes', '--dir'], ['codes', '--spec'], ['codes', '--la'], ['codes', 'SPEC.md'], ['spec'], ['spec', 'a.md', 'b.md'], ['spec', 'a.md', '--dir', dir], ['spec', path.join(dir, 'khong-co.md')], ['codes', '--dir', dir, '--spec', path.join(dir, 'khong-co.md')]]) {
      const r = cli(args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /dùng:/, args.join(' '))
      assert.equal(r.stdout, '', args.join(' '))
    }
  })
})

describe('spec', () => {
  test('SPEC đủ ⇒ exit 0, tóm tắt số màn / mã', () => {
    const dir = tmp()
    put(dir, 'SPEC.md', SPEC())
    const r = cli(['spec', 'SPEC.md'], { cwd: dir })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /SPEC đạt: SPEC\.md — 1 màn, 4 mã trạng thái S-nn, 1 mã quyền P-nn/)
  })

  test('màn thiếu bảng + màn thiếu "lỗi" ⇒ exit 1, nêu tên màn và cách sửa', () => {
    const dir = tmp()
    put(dir, 'docs/SPEC.md', SPEC(`#### Danh sách đơn\n\n${table(1)}\n#### Chi tiết đơn\n\nChỉ có chữ.\n\n#### Thanh toán\n\n${table(5, ['Có dữ liệu', 'Trống', 'Đang tải'])}`))
    const r = cli(['spec', path.join(dir, 'docs', 'SPEC.md')])
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stdout, /cần sửa 2 chỗ/)
    assert.match(r.stdout, /Màn "Chi tiết đơn".*chưa có bảng trạng thái/)
    assert.match(r.stdout, /Màn "Thanh toán".*thiếu trạng thái: lỗi\./)
    assert.doesNotMatch(r.stdout, /Danh sách đơn/)
    assert.match(r.stdout, /Sửa: /)
  })

  test('SPEC kiểu cũ ⇒ exit 1 với đúng một dòng "SPEC chưa có phần Bạn duyệt"', () => {
    const dir = tmp()
    put(dir, 'SPEC.md', '# SPEC\n\n## Mục tiêu\nX\n')
    const r = cli(['spec', 'SPEC.md'], { cwd: dir })
    assert.equal(r.status, 1)
    assert.equal(r.stdout.match(/^- /gm).length, 1)
    assert.match(r.stdout, /SPEC chưa có phần Bạn duyệt/)
  })

  test('SPEC nằm trong docs/specs/<tên>/ mà dùng mã S-nn/P-nn đã dùng ở SPEC khác của dự án (kể cả đã xong) ⇒ exit 1 ngay lúc viết SPEC; SPEC ngoài docs/specs không so', () => {
    const dir = project({ 'docs/specs/cu/SPEC.md': SPEC(), 'docs/specs/cu/progress.md': 'Trạng thái: xong\n', 'docs/specs/moi/SPEC.md': SPEC(), 'docs/specs/khac/SPEC.md': SPEC(`#### Màn khác\n\n${table(5)}`, '- P-21: Chủ đơn thấy đơn của mình\n') })
    const bad = cli(['spec', 'docs/specs/moi/SPEC.md'], { cwd: dir })
    assert.equal(bad.status, 1, bad.stdout)
    assert.match(bad.stdout, /S-01 \(docs\/specs\/moi\/SPEC\.md:\d+\) đã dùng ở docs\/specs\//)
    assert.match(bad.stdout, /Sửa: Đổi sang mã chưa dùng, vd S-/)
    assert.equal(JSON.parse(cli(['spec', 'docs/specs/moi/SPEC.md', '--json'], { cwd: dir }).stdout).problems.length, 5)
    assert.equal(cli(['spec', 'docs/specs/khac/SPEC.md'], { cwd: dir }).status, 0, 'mã riêng ⇒ đạt')
    put(dir, 'ngoai/SPEC.md', SPEC())
    assert.equal(cli(['spec', 'ngoai/SPEC.md'], { cwd: dir }).status, 0, 'không nằm trong docs/specs/<tên>/ ⇒ không biết gốc dự án, không so')
  })

  test('--json: cùng mã thoát, có ok / problems / counts', () => {
    const dir = tmp()
    put(dir, 'good.md', SPEC())
    put(dir, 'bad.md', SPEC('#### A\n\nKhông bảng.\n'))
    const good = cli(['spec', 'good.md', '--json'], { cwd: dir })
    assert.equal(good.status, 0)
    assert.deepEqual(JSON.parse(good.stdout), { ok: true, file: 'good.md', problems: [], counts: { screens: 1, s: 4, p: 1 } })
    const bad = cli(['spec', 'bad.md', '--json'], { cwd: dir })
    assert.equal(bad.status, 1)
    const j = JSON.parse(bad.stdout)
    assert.equal(j.ok, false)
    assert.equal(j.problems.length, 1)
    assert.ok(j.problems[0].msg && j.problems[0].fix)
  })
})

describe('codes', () => {
  test('không có SPEC đang làm (không docs/specs, hoặc mọi SPEC đã xong) ⇒ exit 0 + một dòng báo', () => {
    for (const dir of [tmp(), project({ 'docs/specs/don-hang/progress.md': '- **Trạng thái:** xong\n' })]) {
      const r = cli(['codes', '--dir', dir])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim().split('\n').length, 1)
      assert.match(r.stdout, /không có SPEC đang làm/)
    }
    assert.deepEqual(JSON.parse(cli(['codes', '--dir', tmp(), '--json']).stdout).specs, [])
  })

  test('SPEC đang làm, app + test đủ mã ⇒ exit 0 (mặc định lấy SPEC đang mở; --dir mặc định là thư mục hiện tại)', () => {
    const dir = project()
    for (const r of [cli(['codes', '--dir', dir]), cli(['codes'], { cwd: dir })]) {
      assert.equal(r.status, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /Mã SPEC khớp .*docs\/specs\/don-hang\/SPEC\.md.*4 mã S-nn có trong app và test, 1 mã P-nn có trong test/)
    }
  })

  test('xoá data-s của một S-nn + P-nn không test ⇒ exit 1, nêu mã, SPEC:dòng và cách sửa', () => {
    const dir = project({ 'src/Orders.tsx': APP.replace('<a data-s="S-03"/>', ''), 'e2e/orders.spec.ts': TEST.replace(/P-01/, 'P-1') })
    const r = cli(['codes', '--dir', dir])
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stdout, /chưa khớp ở 2 chỗ/)
    assert.match(r.stdout, /- S-03 \(docs\/specs\/don-hang\/SPEC\.md:\d+\) chưa thấy trong mã app\./)
    assert.match(r.stdout, /Sửa: Gắn data-s="S-03"/)
    assert.match(r.stdout, /- P-01 .* chưa có test nào nhắc\./)
  })

  test('--spec chọn SPEC cụ thể (lặp được), bỏ qua docs/specs đang mở', () => {
    const dir = project({ 'docs/specs/don-hang/SPEC.md': SPEC(`#### X\n\n${table(1)}`), 'other/SPEC.md': SPEC(`#### Y\n\n${table(5)}`) })
    const only = cli(['codes', '--dir', dir, '--spec', path.join(dir, 'other', 'SPEC.md')])
    assert.equal(only.status, 1)
    assert.match(only.stdout, /S-05/)
    assert.doesNotMatch(only.stdout, /S-01/)
    const both = cli(['codes', '--spec', 'docs/specs/don-hang/SPEC.md', '--spec', 'other/SPEC.md'], { cwd: dir })
    assert.equal(both.status, 1)
    assert.match(both.stdout, /other\/SPEC\.md:\d+/)
  })

  test('--json: ok / specs / problems / counts', () => {
    const dir = project({ 'src/Orders.tsx': '' })
    const r = cli(['codes', '--dir', dir, '--json'])
    assert.equal(r.status, 1)
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, false)
    assert.deepEqual(j.counts, { s: 4, p: 1 })
    assert.deepEqual(j.problems.map((p) => `${p.code}:${p.kind}`), ['S-01:missing-in-app', 'S-02:missing-in-app', 'S-03:missing-in-app', 'S-04:missing-in-app'])
    assert.ok(j.problems.every((p) => p.file === 'docs/specs/don-hang/SPEC.md' && p.fix))
    const ok = JSON.parse(cli(['codes', '--dir', project(), '--json']).stdout)
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.problems, [])
  })

  test('SPEC mới đánh lại từ S-01 mà tính năng cũ (đã xong) đã dùng các mã đó ⇒ exit 1 (không "khớp giả" nhờ app/test của tính năng cũ), nêu SPEC cũ + gợi ý mã kế tiếp', () => {
    const dir = project({ 'docs/specs/cu/SPEC.md': SPEC(), 'docs/specs/cu/progress.md': 'Trạng thái: xong\n' })
    const r = cli(['codes', '--dir', dir])
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stdout, /- S-01 \(docs\/specs\/don-hang\/SPEC\.md:\d+\) đã dùng ở docs\/specs\/cu\/SPEC\.md \(dòng \d+\)/)
    assert.match(r.stdout, /Sửa: Đổi sang mã chưa dùng, vd S-05/)
    assert.match(r.stdout, /P-01 .*đã dùng ở docs\/specs\/cu\/SPEC\.md/)
    const j = JSON.parse(cli(['codes', '--dir', dir, '--json']).stdout)
    assert.deepEqual(j.problems.map((p) => `${p.code}:${p.kind}`), ['S-01', 'S-02', 'S-03', 'S-04', 'P-01'].map((c) => `${c}:duplicate-code`))
    // đổi sang mã chưa dùng (cả SPEC lẫn app + test) ⇒ đạt
    const renum = (s) => s.replace(/S-0(\d)/g, 'S-1$1').replace(/P-01/g, 'P-11')
    const fixed = project({ 'docs/specs/cu/SPEC.md': SPEC(), 'docs/specs/cu/progress.md': 'Trạng thái: xong\n', 'docs/specs/don-hang/SPEC.md': renum(SPEC()), 'src/Orders.tsx': renum(APP), 'e2e/orders.spec.ts': renum(TEST) })
    const ok = cli(['codes', '--dir', fixed])
    assert.equal(ok.status, 0, ok.stdout)
  })

  test('SPEC kiểu cũ đang mở ⇒ không có mã để đối chiếu, vẫn đạt', () => {
    const dir = project({ 'docs/specs/don-hang/SPEC.md': '# SPEC cũ\n\n## Mục tiêu\nX\n', 'src/Orders.tsx': null, 'e2e/orders.spec.ts': null })
    const r = cli(['codes', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /0 mã S-nn.*0 mã P-nn/)
  })
})

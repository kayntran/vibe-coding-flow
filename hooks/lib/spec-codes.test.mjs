// Test cho lib/spec-codes.mjs: node --test ~/.claude/hooks/lib/spec-codes.test.mjs
// SPEC giả dựng từ chuỗi; dự án giả trong thư mục tạm có dấu cách + tiếng Việt (Windows lẫn Mac). Không xoá thư mục bằng lệnh shell.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SECTIONS, openSpecs, parseSpec, specProblems, traceCodes } from './spec-codes.mjs'

const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spec Việt '))); roots.push(d); return d }
const put = (dir, rel, text = '') => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const HAS_GIT = spawnSync('git', ['--version']).status === 0
const git = (dir, ...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout }

// --- dựng SPEC ----------------------------------------------------------------------------------------------------------------------

const HEAD = '| mã | khi | thấy gì | làm được gì |\n|---|---|---|---|\n'
const row = (code, when) => `| ${code} | ${when} | thấy | làm |\n`
const table = (first, whens = ['Có dữ liệu', 'Trống', 'Đang tải', 'Lỗi']) => HEAD + whens.map((w, i) => row(`S-${String(first + i).padStart(2, '0')}`, w)).join('')
const screenA = `#### Danh sách đơn\n\n${table(1)}`
const screenB = `#### Chi tiết đơn\n\n${table(5)}`
const RIGHTS = '- P-01: Chủ đơn thấy đơn của mình\n- P-02: Nhân viên sửa đơn được giao\n'
// sections: ghi đè nội dung từng mục; giá trị null = bỏ hẳn mục
function spec({ screens = [screenA], rights = RIGHTS, sections = {}, head = '# SPEC — đơn hàng\n\nGiới thiệu.\n\n', tech = '## Kỹ thuật\n\n### Ghi chú\nDùng bảng orders.\n' } = {}) {
  const body = {
    'Ai dùng': 'Chủ cửa hàng.\n',
    'Các màn hình': `${screens.join('\n')}`,
    'Làm được gì': '- Xem đơn.\n',
    'Để sau': 'Không có.\n',
    'Phí phát sinh': 'Không.\n',
    'Ai thấy/sửa được dữ liệu gì': rights,
    ...sections,
  }
  const parts = SECTIONS.filter((n) => body[n] !== null).map((n) => `### ${n}\n\n${body[n]}\n`)
  return `${head}## Bạn duyệt\n\n${parts.join('')}${tech}`
}
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1
const msgs = (text) => specProblems(text).map((p) => p.msg)

describe('parseSpec', () => {
  test('SPEC đủ: 6 mục, màn, trạng thái kèm số dòng, mã S/P', () => {
    const text = spec({ screens: [screenA, screenB] })
    const s = parseSpec(text)
    assert.equal(s.hasApproval, true)
    assert.deepEqual(Object.keys(s.sections), SECTIONS)
    assert.deepEqual(s.missing, [])
    assert.deepEqual(s.screens.map((x) => [x.name, x.line, x.loadsData, x.hasTable]), [['Danh sách đơn', lineOf(text, '#### Danh sách đơn'), true, true], ['Chi tiết đơn', lineOf(text, '#### Chi tiết đơn'), true, true]])
    assert.deepEqual(s.screens[0].states.map((x) => x.code), ['S-01', 'S-02', 'S-03', 'S-04'])
    assert.deepEqual(s.screens[0].states[1], { code: 'S-02', when: 'Trống', line: lineOf(text, '| S-02 |') })
    assert.deepEqual(s.sCodes.filter((c) => c.screen === 'Chi tiết đơn').map((c) => c.code), ['S-05', 'S-06', 'S-07', 'S-08'])
    assert.deepEqual(s.pCodes, [
      { code: 'P-01', line: lineOf(text, 'P-01'), text: 'Chủ đơn thấy đơn của mình' },
      { code: 'P-02', line: lineOf(text, 'P-02'), text: 'Nhân viên sửa đơn được giao' },
    ])
    assert.equal(s.pNotApplicable, false)
    assert.deepEqual(s.dupes, [])
    assert.match(s.sections['Ai dùng'], /Chủ cửa hàng/)
  })

  test('tên mục không phân biệt hoa thường / dấu / khoảng trắng quanh "/"; CRLF; tiêu đề "Phần bạn duyệt …"', () => {
    const text = spec({ head: '# SPEC\n' })
      .replace('## Bạn duyệt', '## Phần BẠN DUYỆT — người dùng sẽ thấy gì')
      .replace('### Ai dùng', '### AI DUNG')
      .replace('### Các màn hình', '### Cac man hinh:')
      .replace('### Ai thấy/sửa được dữ liệu gì', '### ai thay / sua duoc du lieu gi?')
      .replace(/\n/g, '\r\n')
    const s = parseSpec(text)
    assert.deepEqual(s.missing, [])
    assert.deepEqual(Object.keys(s.sections), SECTIONS)
    assert.equal(s.screens.length, 1)
    assert.equal(s.pCodes.length, 2)
  })

  test('SPEC kiểu cũ (không có "Bạn duyệt"): hasApproval=false, thiếu cả 6 mục', () => {
    const s = parseSpec('# SPEC\n\n## Mục tiêu\nLàm gì đó.\n\n## Acceptance criteria\n- AC-1\n')
    assert.equal(s.hasApproval, false)
    assert.deepEqual(s.missing, SECTIONS)
    assert.deepEqual([s.screens, s.sCodes, s.pCodes], [[], [], []])
    assert.equal(parseSpec('').hasApproval, false)
    assert.equal(parseSpec(undefined).hasApproval, false)
  })

  test('mục chỉ có dưới phần kỹ thuật không tính; mục trống hoặc chỉ ghi chú HTML tính là thiếu', () => {
    const text = spec({ sections: { 'Để sau': null, 'Phí phát sinh': '', 'Làm được gì': '<!-- điền vào -->\n' }, tech: '## Kỹ thuật\n\n### Để sau\nRefactor.\n' })
    const s = parseSpec(text)
    assert.deepEqual(s.missing, ['Làm được gì', 'Để sau', 'Phí phát sinh'])
    assert.ok(!('Để sau' in s.sections))
    assert.equal(s.sections['Phí phát sinh'], '')
  })

  test('tiêu đề và bảng trong khối ``` không tính', () => {
    const fenced = '```md\n#### Màn ma\n\n| mã | khi | thấy gì | làm được gì |\n|---|---|---|---|\n| S-99 | Lỗi | x | y |\n```\n'
    const s = parseSpec(spec({ screens: [screenA, fenced] }))
    assert.deepEqual(s.screens.map((x) => x.name), ['Danh sách đơn'])
    assert.ok(!s.sCodes.some((c) => c.code === 'S-99'))
  })

  test('màn "Không tải dữ liệu" ⇒ loadsData=false; markdown quanh mã được bóc', () => {
    const s = parseSpec(spec({ screens: [`#### Đăng nhập\n\n*Không tải dữ liệu.*\n\n${HEAD}| **\`S-01\`** | Mở màn | form | nhập |\n`] }))
    assert.equal(s.screens[0].loadsData, false)
    assert.deepEqual(s.screens[0].states.map((x) => x.code), ['S-01'])
  })

  test('chỉ dòng ĐÚNG câu "Không tải dữ liệu" (± lý do sau gạch) mới miễn; câu dài hơn không miễn', () => {
    const at = (note) => parseSpec(spec({ screens: [`#### Lọc\n\n${note}\n\n${HEAD}| S-01 | Có dữ liệu | bảng | lọc |\n`] })).screens[0].loadsData
    assert.equal(at('- Không tải dữ liệu cũ khi đổi bộ lọc.'), true)
    assert.equal(at('Không tải dữ liệu — form tĩnh'), false)
    assert.equal(at('**Không tải dữ liệu**'), false)
  })

  test('mã trùng: S-nn giữa hai màn, P-nn hai dòng ⇒ dupes liệt kê mỗi mã một lần', () => {
    const s = parseSpec(spec({ screens: [screenA, `#### B\n\n${table(4)}`], rights: '- P-01: a thấy x\n- P-01: b sửa y\n- P-02: c xoá z\n' }))
    assert.deepEqual(s.dupes, ['S-04', 'P-01'])
  })

  test('"Không áp dụng — lý do" ⇒ pNotApplicable; thiếu lý do thì không', () => {
    assert.equal(parseSpec(spec({ rights: 'Không áp dụng — app chỉ một người dùng.\n' })).pNotApplicable, true)
    assert.equal(parseSpec(spec({ rights: '- **Không áp dụng** - app chỉ một người dùng\n' })).pNotApplicable, true)
    assert.equal(parseSpec(spec({ rights: 'Không áp dụng\n' })).pNotApplicable, false)
    assert.equal(parseSpec(spec({ rights: 'Không áp dụng —\n' })).pNotApplicable, false)
  })
})

describe('specProblems', () => {
  test('SPEC đủ ⇒ không có vấn đề; mỗi vấn đề (khi có) đều kèm msg + fix', () => {
    assert.deepEqual(specProblems(spec({ screens: [screenA, screenB] })), [])
    for (const p of specProblems(spec({ screens: ['#### X\n'], sections: { 'Ai dùng': null } }))) {
      assert.equal(typeof p.msg, 'string')
      assert.ok(p.msg && p.fix)
    }
  })

  test('SPEC kiểu cũ ⇒ đúng MỘT vấn đề "SPEC chưa có phần Bạn duyệt"', () => {
    const r = specProblems('# SPEC\n\n## Mục tiêu\nX\n')
    assert.equal(r.length, 1)
    assert.equal(r[0].msg, 'SPEC chưa có phần Bạn duyệt')
    assert.match(r[0].fix, /## Bạn duyệt/)
  })

  test('màn A đủ nhưng màn B không có bảng ⇒ chỉ báo màn B', () => {
    const r = specProblems(spec({ screens: [screenA, '#### Chi tiết đơn\n\nHiện thông tin đơn.\n'] }))
    assert.equal(r.length, 1)
    assert.match(r[0].msg, /Màn "Chi tiết đơn".*chưa có bảng/)
    assert.doesNotMatch(r[0].msg, /Danh sách/)
    assert.match(r[0].fix, /\| mã \| khi \| thấy gì \| làm được gì \|/)
  })

  test('màn A đủ nhưng màn B thiếu "lỗi" ⇒ báo đúng màn B + đúng trạng thái thiếu', () => {
    const r = specProblems(spec({ screens: [screenA, `#### Chi tiết đơn\n\n${table(5, ['Có dữ liệu', 'Trống', 'Đang tải'])}`] }))
    assert.equal(r.length, 1)
    assert.match(r[0].msg, /Màn "Chi tiết đơn".*thiếu trạng thái: lỗi\./)
  })

  test('thiếu nhiều trạng thái ⇒ liệt kê đủ; chỉ có "có dữ liệu" ⇒ thiếu 3', () => {
    const r = specProblems(spec({ screens: [`#### B\n\n${table(1, ['Có dữ liệu'])}`] }))
    assert.equal(r.length, 1)
    assert.match(r[0].msg, /thiếu trạng thái: trống, đang tải, lỗi\./)
  })

  test('màn không tải dữ liệu: ≥1 dòng là đủ; bảng không dòng hoặc không bảng ⇒ báo', () => {
    const none = (body) => `#### Đăng nhập\n\nKhông tải dữ liệu\n\n${body}`
    assert.deepEqual(specProblems(spec({ screens: [none(table(1, ['Mở màn']))] })), [])
    assert.match(msgs(spec({ screens: [none(HEAD)] }))[0], /chưa có dòng trạng thái nào/)
    assert.match(msgs(spec({ screens: [none('Chỉ là form.\n')] }))[0], /chưa có bảng/)
  })

  test('nhận cột "khi" không dấu; "Chưa có dữ liệu" là trống chứ không phải có dữ liệu', () => {
    assert.deepEqual(specProblems(spec({ screens: [`#### B\n\n${table(1, ['co du lieu', 'trong', 'dang tai', 'loi'])}`] })), [])
    assert.match(msgs(spec({ screens: [`#### B\n\n${table(1, ['Chưa có dữ liệu', 'Đang tải', 'Lỗi'])}`] }))[0], /thiếu trạng thái: có dữ liệu\./)
    assert.deepEqual(specProblems(spec({ screens: [`#### B\n\n${table(1, ['Có dữ liệu', 'Danh sách trống', 'Đang tải dữ liệu', 'Tải lỗi'])}`] })), [])
  })

  test('"trong" nghĩa "bên trong" không bị nhầm với "trống" khi ô có dấu', () => {
    const r = specProblems(spec({ screens: [`#### B\n\n${table(1, ['Có dữ liệu trong ngày', 'Đang tải', 'Lỗi'])}`] }))
    assert.match(r[0].msg, /thiếu trạng thái: trống\./)
  })

  test('bảng khác (không phải | mã | khi |…) không tính là bảng trạng thái', () => {
    const r = specProblems(spec({ screens: ['#### B\n\n| tên | giá |\n|---|---|\n| S-01 | 5 |\n'] }))
    assert.match(r[0].msg, /chưa có bảng/)
  })

  test('mã sai dạng trong bảng ⇒ báo dòng đó', () => {
    const text = spec({ screens: [`#### B\n\n${table(1)}${row('S1', 'Lỗi')}`] })
    const r = specProblems(text)
    assert.equal(r.length, 1)
    assert.match(r[0].msg, new RegExp(`dòng ${lineOf(text, '| S1 |')} có mã "S1" không đúng dạng S-nn`))
  })

  test('thiếu mục / mục trống ⇒ nêu tên mục + cách thêm', () => {
    const r = specProblems(spec({ sections: { 'Để sau': null, 'Phí phát sinh': '' } }))
    assert.equal(r.length, 2)
    assert.match(r[0].msg, /thiếu mục "Để sau"/)
    assert.match(r[0].fix, /### Để sau/)
    assert.match(r[1].msg, /"Phí phát sinh".*để trống/)
  })

  test('mục ai thấy/sửa: không có P-nn lẫn "Không áp dụng" ⇒ báo; có một trong hai ⇒ ổn', () => {
    assert.match(msgs(spec({ rights: 'Mọi người đều thấy hết.\n' }))[0], /chưa có dòng P-nn nào/)
    assert.match(msgs(spec({ rights: 'Không áp dụng\n' }))[0], /chưa có dòng P-nn nào/)
    assert.deepEqual(specProblems(spec({ rights: 'Không áp dụng — app một người dùng.\n' })), [])
    assert.deepEqual(specProblems(spec({ rights: '- P-01: Chủ thấy đơn của mình\n' })), [])
  })

  test('mục ai thấy/sửa bỏ hẳn ⇒ chỉ một vấn đề (thiếu mục), không báo thêm "chưa có P-nn"', () => {
    const r = specProblems(spec({ sections: { 'Ai thấy/sửa được dữ liệu gì': null } }))
    assert.equal(r.length, 1)
    assert.match(r[0].msg, /thiếu mục "Ai thấy\/sửa được dữ liệu gì"/)
  })

  test('mã trùng ⇒ báo mã + các dòng', () => {
    const text = spec({ screens: [screenA, `#### B\n\n${table(4)}`] })
    const r = specProblems(text)
    assert.equal(r.length, 1)
    assert.match(r[0].msg, /Mã S-04 bị dùng 2 lần/)
    assert.ok(r[0].msg.includes(String(lineOf(text, '| S-04 |'))))
  })
})

describe('openSpecs', () => {
  const sheet = (dir, name, spec, progress) => {
    if (spec !== null) put(dir, `docs/specs/${name}/SPEC.md`, spec)
    if (progress !== undefined) put(dir, `docs/specs/${name}/progress.md`, progress)
  }
  test('không có docs/specs ⇒ []', () => assert.deepEqual(openSpecs(tmp()), []))
  test('mở = chưa `Trạng thái: xong` (không có progress cũng mở); thư mục thiếu SPEC.md bị bỏ; sắp theo tên; đường dẫn tuyệt đối', () => {
    const dir = tmp()
    sheet(dir, 'b-moi', '# b', undefined)
    sheet(dir, 'a-dang', '# a', '# Tiến độ\nTrạng thái: đang làm\n')
    sheet(dir, 'c-chua-xong', '# c', 'Trạng thái: chưa xong\n')
    sheet(dir, 'd-xong', '# d', '# Tiến độ\nTrạng thái: xong\n')
    sheet(dir, 'e-xong-md', '# e', '- **Trạng thái:** xong\n')
    sheet(dir, 'f-xong-hoa', '# f', 'TRẠNG THÁI: Xong.\n')
    sheet(dir, 'g-khong-spec', null, 'Trạng thái: đang làm\n')
    put(dir, 'docs/specs/h-file-le.md', 'x')
    const got = openSpecs(dir)
    assert.deepEqual(got, ['a-dang', 'b-moi', 'c-chua-xong'].map((n) => path.join(dir, 'docs', 'specs', n, 'SPEC.md')))
    assert.ok(got.every((p) => path.isAbsolute(p)))
  })
  test('progress viết dạng NFD (dấu tách rời) vẫn nhận "xong"', () => {
    const dir = tmp()
    sheet(dir, 'x', '# x', 'Trạng thái: xong\n'.normalize('NFD'))
    assert.deepEqual(openSpecs(dir), [])
  })
})

describe('traceCodes', () => {
  const SPEC_REL = 'docs/specs/don-hang/SPEC.md'
  const APP = '<main data-s="S-01"/>\n<ul data-s=\'S-02\'/>\n<p data-s={"S-03"}/>\n<p data-s="S-04"/>\n'
  const TEST = "test('S-01 S-02 S-03 S-04 hiện đủ', () => {})\ntest('P-01 chủ khác không thấy', () => {})\ntest('P-02 nhân viên không sửa', () => {})\n"
  // dự án mẫu: SPEC (S-01..S-04, P-01, P-02) + app + test đủ mã; overrides ghi đè/thêm file (null = bỏ)
  function project(files = {}) {
    const dir = tmp()
    const all = { [SPEC_REL]: spec(), 'src/Orders.tsx': APP, 'e2e/orders.spec.ts': TEST, ...files }
    for (const [rel, text] of Object.entries(all)) if (text !== null) put(dir, rel, text)
    return dir
  }
  const kinds = (r) => r.problems.map((p) => `${p.code}:${p.kind}`)

  test('đủ mã trong app (3 kiểu data-s) và test ⇒ ok, đếm mã', () => {
    const r = traceCodes(project(), [SPEC_REL])
    assert.deepEqual(r.problems, [])
    assert.equal(r.ok, true)
    assert.deepEqual(r.counts, { s: 4, p: 2 })
  })

  test('S-nn mất khỏi app ⇒ missing-in-app, nêu SPEC + dòng của mã', () => {
    const r = traceCodes(project({ 'src/Orders.tsx': APP.replace('<p data-s={"S-03"}/>\n', '') }), [SPEC_REL])
    assert.equal(r.ok, false)
    assert.deepEqual(kinds(r), ['S-03:missing-in-app'])
    assert.equal(r.problems[0].file, SPEC_REL)
    assert.equal(r.problems[0].line, lineOf(spec(), '| S-03 |'))
    assert.match(r.problems[0].fix, /data-s="S-03"/)
  })

  test('S-nn không test nào nhắc ⇒ missing-test; P-nn không test nhắc ⇒ missing-test', () => {
    const r = traceCodes(project({ 'e2e/orders.spec.ts': TEST.replace(' S-04', '').replace('P-02', 'P-0') }), [SPEC_REL])
    assert.deepEqual(kinds(r), ['S-04:missing-test', 'P-02:missing-test'])
    assert.match(r.problems[1].fix, /P-02/)
  })

  test('mã chỉ trong file test không tính là có trong app; mã P chỉ trong code app không tính là có test', () => {
    for (const testFile of ['src/Orders.test.tsx', 'tests/orders.ts', 'src/__tests__/orders.ts', 'web/e2e/orders.ts', 'src/orders.spec.js']) {
      const r = traceCodes(project({ 'src/Orders.tsx': null, [testFile]: TEST }), [SPEC_REL])
      assert.deepEqual(kinds(r).filter((k) => k.includes('missing-in-app')), ['S-01', 'S-02', 'S-03', 'S-04'].map((c) => `${c}:missing-in-app`), testFile)
    }
    const r = traceCodes(project({ 'src/Orders.tsx': `${APP}// P-01 P-02\n`, 'e2e/orders.spec.ts': 'test("S-01 S-02 S-03 S-04", () => {})\n' }), [SPEC_REL])
    assert.deepEqual(kinds(r), ['P-01:missing-test', 'P-02:missing-test'])
  })

  test('mã chỉ nằm trong docs/, .md, .json, node_modules, dist, build, .claude thì không tính cho app', () => {
    const noise = { 'docs/notes.tsx': APP, 'README.md': APP, 'ui.json': APP, '.claude/ui.json': APP, 'node_modules/x/index.js': APP, 'dist/app.js': APP, 'build/app.js': APP, '.claude/hooks/a.mjs': APP }
    const r = traceCodes(project({ 'src/Orders.tsx': null, ...noise }), [SPEC_REL])
    assert.deepEqual(kinds(r), ['S-01', 'S-02', 'S-03', 'S-04'].map((c) => `${c}:missing-in-app`))
    // và không tính cho test: test thật nằm ở node_modules/ docs/ thì vẫn thiếu
    const t = traceCodes(project({ 'e2e/orders.spec.ts': null, 'node_modules/x/a.test.js': TEST, 'docs/a.test.ts': TEST, 'tests/readme.md': TEST }), [SPEC_REL])
    assert.equal(t.ok, false)
    assert.equal(t.problems.length, 6)
  })

  test('chỉ khớp từ nguyên: S-011 không thay cho S-01, XS-01 / S-01x / S-02-backup cũng không', () => {
    const r = traceCodes(project({ 'src/Orders.tsx': '<a data-s="S-011"/><a data-s="XS-01"/><a id="S-02x"/><a data-s="S-02-backup"/><a data-s="S-03"/><a data-s="S-04"/>\n' }), [SPEC_REL])
    assert.deepEqual(kinds(r), ['S-01:missing-in-app', 'S-02:missing-in-app'])
  })

  test('SPEC không có mã (kiểu cũ hoặc không màn/không P) ⇒ ok, đếm 0', () => {
    const dir = project({ [SPEC_REL]: '# SPEC cũ\n\n## Mục tiêu\nX\n', 'src/Orders.tsx': null, 'e2e/orders.spec.ts': null })
    assert.deepEqual(traceCodes(dir, [SPEC_REL]), { ok: true, problems: [], counts: { s: 0, p: 0 } })
    assert.deepEqual(traceCodes(dir, []), { ok: true, problems: [], counts: { s: 0, p: 0 } })
  })

  test('nhận đường dẫn SPEC tuyệt đối lẫn tương đối; hai SPEC ⇒ vấn đề gắn đúng SPEC; SPEC không đọc được ⇒ ném lỗi', () => {
    const second = 'docs/specs/khach/SPEC.md'
    const dir = project({ [second]: spec({ screens: [`#### Khách\n\n${table(21)}`], rights: 'Không áp dụng — một người.\n' }) })
    const r = traceCodes(dir, [path.join(dir, ...SPEC_REL.split('/')), second])
    assert.deepEqual(r.problems.map((p) => `${p.file}|${p.code}|${p.kind}`).sort(), ['S-21', 'S-22', 'S-23', 'S-24'].flatMap((c) => [`${second}|${c}|missing-in-app`, `${second}|${c}|missing-test`]).sort())
    assert.equal(r.counts.s, 8)
    assert.throws(() => traceCodes(dir, ['docs/specs/khong-co/SPEC.md']), /không đọc được SPEC/)
  })

  test('một mã khai hai lần trong SPEC chỉ sinh một vấn đề', () => {
    const dup = spec({ screens: [screenA, `#### B\n\n${HEAD}${row('S-04', 'Có dữ liệu')}`] })
    const r = traceCodes(project({ [SPEC_REL]: dup, 'src/Orders.tsx': APP.replace('<p data-s="S-04"/>\n', '') }), [SPEC_REL])
    assert.deepEqual(kinds(r), ['S-04:missing-in-app'])
  })

  describe('mã duy nhất toàn dự án', () => {
    const OLD = 'docs/specs/2026-09-01-don-hang/SPEC.md'
    const NEW = 'docs/specs/2026-10-14-khach/SPEC.md'
    const doneProgress = { 'docs/specs/2026-09-01-don-hang/progress.md': 'Trạng thái: xong\n' }
    const proj = (files) => project({ [SPEC_REL]: null, ...files }) // bỏ SPEC mẫu mặc định: chỉ còn các SPEC của từng ca (app + test mẫu vẫn đủ mọi mã)
    const dupes = (r) => r.problems.filter((p) => p.kind === 'duplicate-code')

    test('SPEC mới đánh lại từ S-01 trong khi tính năng cũ (đã xong) dùng S-01..S-04, P-01, P-02 ⇒ KHÔNG đạt giả nhờ mã của tính năng cũ; mỗi mã trùng có gợi ý số kế tiếp sau mã lớn nhất', () => {
      // app + test cũ đã có đủ mã ⇒ trước đây SPEC mới "đạt giả"
      const dir = proj({ ...doneProgress, [OLD]: spec(), [NEW]: spec() })
      const r = traceCodes(dir, [NEW])
      assert.equal(r.ok, false)
      assert.deepEqual(r.problems.map((p) => `${p.code}:${p.kind}`), ['S-01', 'S-02', 'S-03', 'S-04', 'P-01', 'P-02'].map((c) => `${c}:duplicate-code`))
      assert.ok(r.problems.every((p) => p.file === NEW))
      assert.match(r.problems[0].msg, new RegExp(`^S-01 \\(${NEW}:\\d+\\) đã dùng ở ${OLD} \\(dòng \\d+\\)`))
      assert.match(r.problems[0].msg, /duy nhất|khác nhau/)
      assert.deepEqual(r.problems.map((p) => /\b([SP]-\d+)\b/.exec(p.fix)[1]), ['S-05', 'S-06', 'S-07', 'S-08', 'P-03', 'P-04'], 'số kế tiếp sau mã lớn nhất đã dùng, mỗi mã một số khác nhau')
      assert.match(r.problems[0].fix, /^Đổi sang mã chưa dùng/)
    })

    test('chỉ mã trùng bị báo; số kế tiếp tính theo mã lớn nhất ở MỌI SPEC (kể cả mã của chính SPEC đang kiểm)', () => {
      const dir = proj({ ...doneProgress, [OLD]: spec(), [NEW]: spec({ screens: [`#### A\n\n${table(4)}`, `#### B\n\n${table(40)}`], rights: '- P-09: Ai đó xem\n' }) })
      const r = traceCodes(dir, [NEW])
      assert.deepEqual(dupes(r).map((p) => p.code), ['S-04'])
      assert.match(dupes(r)[0].fix, /S-44/, 'lớn nhất là S-43 của chính SPEC mới')
    })

    test('cùng một mã lặp trong CÙNG một SPEC không phải lỗi trùng dự án; kiểm chính SPEC cũ cũng không tự trùng với mình', () => {
      const dup = spec({ screens: [screenA, `#### B\n\n${HEAD}${row('S-04', 'Có dữ liệu')}`] })
      const dir = proj({ ...doneProgress, [OLD]: dup })
      assert.deepEqual(dupes(traceCodes(dir, [OLD])), [])
      const abs = path.join(dir, ...OLD.split('/'))
      assert.deepEqual(dupes(traceCodes(dir, [abs, OLD])), [], 'cùng SPEC nêu hai lần (tuyệt đối + tương đối)')
    })

    test('hai SPEC mã khác nhau ⇒ không báo; SPEC kiểu cũ (không có mã) ở docs/specs không gây trùng', () => {
      const dir = proj({ ...doneProgress, [OLD]: spec(), [NEW]: spec({ screens: [`#### K\n\n${table(21)}`], rights: '- P-21: Khách xem\n' }), 'docs/specs/cu/SPEC.md': '# SPEC cũ\n\n## Mục tiêu\nX\n' })
      assert.deepEqual(dupes(traceCodes(dir, [NEW])), [])
    })

    test('SPEC kiểm nằm ngoài docs/specs (--spec) vẫn bị so với mọi SPEC trong docs/specs; hai SPEC cùng được kiểm mà trùng nhau ⇒ cả hai đều bị báo', () => {
      const dir = proj({ ...doneProgress, [OLD]: spec(), 'lam-thu/SPEC.md': spec({ screens: [`#### T\n\n${table(1, ['Có dữ liệu'])}`], rights: 'Không áp dụng — thử.\n' }) })
      const r = traceCodes(dir, ['lam-thu/SPEC.md'])
      assert.deepEqual(dupes(r).map((p) => `${p.file}|${p.code}`), ['lam-thu/SPEC.md|S-01'])
      const both = traceCodes(dir, ['lam-thu/SPEC.md', OLD])
      assert.deepEqual(dupes(both).map((p) => `${p.file}|${p.code}`).sort(), [`${OLD}|S-01`, 'lam-thu/SPEC.md|S-01'].sort())
      assert.notEqual(dupes(both)[0].fix, dupes(both)[1].fix, 'hai gợi ý không đụng nhau')
    })
  })

  test('dự án git: thư mục git-ignore bị bỏ; file mới chưa add vẫn tính; file đã add rồi xoá khỏi đĩa thì không', { skip: !HAS_GIT }, () => {
    const dir = project({ '.gitignore': 'ignored/\n', 'src/Orders.tsx': null, 'ignored/Orders.tsx': APP, 'src/Gone.tsx': '<a data-s="S-01"/>\n', 'src/Fresh.tsx': '<a data-s="S-02"/><a data-s="S-03"/><a data-s="S-04"/>\n' })
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    fs.rmSync(path.join(dir, 'src', 'Gone.tsx'))
    put(dir, 'src/Untracked.tsx', '<a data-s="S-04"/>\n')
    const r = traceCodes(dir, [SPEC_REL])
    assert.deepEqual(kinds(r), ['S-01:missing-in-app'])
    // bỏ .gitignore ⇒ thư mục ignored/ hiện ra và (là mã nguồn app) được tính
    fs.rmSync(path.join(dir, '.gitignore'))
    assert.deepEqual(traceCodes(dir, [SPEC_REL]).problems, [])
  })
})

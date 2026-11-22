// Kiểm bài đo buổi hỏi business (kit/evals/business-session.json) và tài liệu nó dựa vào (skills/flow-business, flow-stack):
// cấu trúc 5 ca, mọi mã B-xx có trong danh sách điều cần biết, hồ sơ/chương bỏ/số vòng ước tính tính ra từ cột "Hỏi khi" của
// cau-hoi.md và khớp bảng ở thich-ung.md; luật hộp hỏi (≤ 4 đáp án), UT8 một chiều, TG1 ở vòng 1, câu business ở bản mẫu.
// Không gọi AI: bài đo là đề + đáp án chấm; chạy đề thật do người hoặc AI phụ làm (xem trường "_" trong file JSON).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SK = path.join(ROOT, 'skills')
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replaceAll('\r\n', '\n')
const CAU_HOI = rd('skills', 'flow-business', 'references', 'cau-hoi.md')
const THICH_UNG = rd('skills', 'flow-business', 'references', 'thich-ung.md')
const BUSINESS_TPL = rd('skills', 'flow-business', 'assets', 'business.md')
const BIZ_SKILL = rd('skills', 'flow-business', 'SKILL.md')
const EVAL = JSON.parse(rd('kit', 'evals', 'business-session.json'))

const CHAPTERS = ['TQ', 'KH', 'VD', 'GT', 'DT', 'TG', 'CP', 'KN', 'TD', 'PV', 'VH', 'PL', 'TH', 'RR', 'MR', 'UT']
const FLAGS = ['tien', 'thu-dich-vu', 'ban-app', 'dlcn', 'nhay', 'tre-em', 'quoc-te', 'nhieu-vai', 'ugc', 'ai', 'gui-thu', 'tai-file', 'san', 'nganh', 'may-tinh', 'extension']
const PROFILES = ['R', 'N', 'C', '$', 'S']
const LEVEL = { R: 0, N: 1, C: 2, $: 3 }
const REQUIRED_IDS = ['dung-rieng', 'noi-bo', 'mo-mien-phi', 'co-thu-tien', 'nganh-nhay-cam']
const GATE = new Set(['TG1']) // câu cổng: hỏi ở vòng 1 để biết có lên hồ sơ $ không, dù chương TG bị bỏ
const GATES4 = ['Tiêu tiền thật', 'Xoá dữ liệu', 'Gửi gì ra ngoài cho khách', 'Đưa app lên mạng']

const ROWS = CAU_HOI.split('\n').filter((l) => /^\| [A-Z]{2}\d+/.test(l)).map((l) => {
  const c = l.split('|').slice(1, -1).map((x) => x.trim())
  return { cells: c.length, id: c[0].split(' ')[0], star: c[0].includes('⭐'), q: c[1], decide: c[2], ans: c[3], def: c[4], whenRaw: c[5], when: c[5]?.split(' · ')[0], kieu: c[6] }
})
const CODE_SET = new Set(ROWS.map((r) => r.id))
const chapterOf = (code) => code.slice(0, 2)

const section = (text, heading) => {
  const i = text.indexOf(`\n## ${heading}`)
  assert.ok(i >= 0, `thiếu mục "## ${heading}"`)
  const rest = text.slice(i + 1)
  const j = rest.indexOf('\n## ', 4)
  return j < 0 ? rest : rest.slice(0, j)
}
const tableRows = (text, firstCell) =>
  text.split('\n').filter((l) => firstCell.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))

// Mã trong một ô bảng; "TG3 đến TG14" mở rộng thành dãy.
function expandIds(cell) {
  const out = []
  const rest = cell.replace(/\b([A-Z]{2})(\d+) đến \1(\d+)\b/g, (_, c, a, b) => {
    for (let i = Number(a); i <= Number(b); i++) out.push(c + i)
    return ' '
  })
  for (const m of rest.matchAll(/\b([A-Z]{2}\d+)\b/g)) out.push(m[1])
  return out
}

// Hồ sơ tính ra từ cột "Hỏi khi": dòng mang R/N/C/$ thuộc hồ sơ đó và các hồ sơ lớn hơn.
const derived = (p) => new Set(ROWS.filter((r) => r.when in LEVEL && LEVEL[r.when] <= LEVEL[p]).map((r) => r.id))

// Bảng "Năm hồ sơ và ước tính số vòng" ở thich-ung.md: R + N + C + $ cộng dồn.
function profileTable() {
  const rows = tableRows(section(THICH_UNG, 'Năm hồ sơ và ước tính số vòng'), /^\| \*\*[RNC$S]\*\*/)
  assert.equal(rows.length, 5, 'bảng hồ sơ phải có 5 dòng R N C $ S')
  const out = {}
  let acc = new Set()
  for (const r of rows) {
    const key = r[0].match(/^\*\*(.)\*\*/)[1]
    if (key === 'S') { out.S = {}; continue }
    acc = new Set([...acc, ...expandIds(r[2])])
    out[key] = { ids: new Set(acc), stated: Number(r[2].match(/(\d+) câu/)?.[1]), est: Number(r[3].match(/≈ (\d+) vòng/)?.[1]) }
  }
  return out
}
const dropTable = () => {
  const out = {}
  for (const r of tableRows(section(THICH_UNG, 'Chương bỏ theo hồ sơ'), /^\| (R|N|C|\$) \|/)) out[r[0]] = r[1].startsWith('(') ? [] : r[1].split(/\s+/).filter(Boolean)
  return out
}
// Hồ sơ S: nền + PL12, và PL1 PL2 PL3 nếu nền chưa có.
const sIds = (base) => new Set([...derived(base), 'PL1', 'PL2', 'PL3', 'PL12'])

test('danh sách điều cần biết có đúng 146 điều, 16 chương, 54 ⭐, mã không trùng, đủ 7 cột', () => {
  assert.equal(ROWS.length, 146)
  assert.equal(CODE_SET.size, 146, 'có mã trùng')
  assert.equal(ROWS.filter((r) => r.star).length, 54)
  assert.deepEqual([...new Set(ROWS.map((r) => chapterOf(r.id)))].sort(), [...CHAPTERS].sort())
  for (const r of ROWS) {
    assert.equal(r.cells, 7, `${r.id}: phải đủ 7 cột`)
    assert.ok(['QĐ', 'ST', 'TD'].includes(r.kieu), `${r.id}: kiểu "${r.kieu}" lạ`)
  }
})

test('cột "Hỏi khi": R/N/C/$, cờ có thật, hoặc mặc định; mọi câu ⭐ thuộc một hồ sơ hoặc một cờ', () => {
  for (const r of ROWS) {
    if (r.when in LEVEL || r.when === 'mặc định') continue
    assert.match(r.when, /^cờ [a-z-]+(, [a-z-]+)*$/, `${r.id}: "Hỏi khi" lạ: ${r.whenRaw}`)
    for (const f of r.when.slice(3).split(', ')) assert.ok(FLAGS.includes(f), `${r.id}: cờ ${f} lạ`)
  }
  for (const r of ROWS.filter((x) => x.star)) assert.ok(r.when !== 'mặc định', `${r.id}: câu ⭐ không được để mặc định`)
})

test('hộp hỏi: mọi câu có 2 đến 4 đáp án (chọn một tối đa 3 đáp án thật + Chưa biết; chọn nhiều tối đa 4)', () => {
  for (const r of ROWS) {
    if (r.kieu === 'TD') continue
    for (const g of r.ans.split(' // ')) {
      const multi = /chọn nhiều/.test(g)
      const opts = g.replace(/\([^)]*\)/g, '').split(' · ').map((x) => x.replace(/^[^:]*:\s*/, '').trim()).filter(Boolean)
      assert.ok(opts.length >= 2, `${r.id}: cần ít nhất 2 đáp án (${g})`)
      assert.ok(opts.length <= (multi ? 4 : 3), `${r.id}: ${opts.length} đáp án ${multi ? 'chọn nhiều (tối đa 4)' : 'chọn một (tối đa 3, ô thứ 4 là Chưa biết)'}: ${g}`)
    }
  }
  const pv9 = ROWS.find((r) => r.id === 'PV9')
  assert.equal(pv9.ans.split(' // ').length, 2, 'PV9 phải tách thành hai câu chọn nhiều')
  const ut1 = ROWS.find((r) => r.id === 'UT1')
  assert.doesNotMatch(ut1.ans, / \/\/ /, 'UT1 chỉ một câu "điều quan trọng nhất"; câu thứ hai chỉ khi cần')
  assert.equal(ut1.ans.split(' · ').length, 3)
  assert.match(ut1.decide, /điều thứ hai[^.]*chỉ hỏi khi cần/)
  assert.match(ut1.decide, /ước tính số vòng đã tính cả nó/)
  assert.match(BIZ_SKILL, /Hộp hỏi nhận 2–4 đáp án/)
  assert.match(BIZ_SKILL, /tối đa 3 đáp án thật/)
  assert.match(BIZ_SKILL, /tối đa 4, không cần "Chưa biết"/)
  assert.match(BIZ_SKILL, /UT1 không xếp hạng: hỏi điều quan trọng nhất, thứ hai chỉ khi cần/)
})

test('mỗi câu hỏi một ý: ô "Câu hỏi" tối đa một dấu ?, ý phụ nằm ở "Đào sâu"; TQ9 bỏ "Không chắc" (Chưa biết = không chắc)', () => {
  for (const r of ROWS) assert.ok((r.q.match(/\?/g) || []).length <= 1, `${r.id}: câu kép (${r.q})`)
  for (const id of ['KH4', 'DT2', 'TG3', 'TG11', 'PL4', 'PL11']) {
    const r = ROWS.find((x) => x.id === id)
    assert.equal((r.q.match(/\?/g) || []).length, 1, `${id}: phải đúng một câu hỏi`)
    assert.doesNotMatch(r.q.replace(/\([^)]*\)/g, ''), / và | hay /, `${id}: vẫn còn câu kép`)
    assert.match(r.q + r.decide, /Đào sâu|đào sâu|lấy từ TQ3/, `${id}: ý phụ phải chuyển sang "Đào sâu"`)
  }
  const tq9 = ROWS.find((r) => r.id === 'TQ9')
  assert.doesNotMatch(tq9.ans, /Không chắc/)
  assert.equal(tq9.ans.replace(/\([^)]*\)/g, '').split(' · ').length, 2)
  assert.match(tq9.def, /Chưa biết ⇒ coi là không chắc/)
})

test('"Chưa biết" lấy phương án AI suy riêng cho app (kèm lý do); cột Mặc định chỉ khi không có căn cứ riêng', () => {
  assert.match(CAU_HOI, /"Chưa biết" ⇒ lấy phương án AI suy riêng cho đúng app/)
  assert.match(CAU_HOI, /cột Mặc định chỉ dùng khi không có căn cứ riêng/)
  assert.match(BIZ_SKILL, /"Chưa biết" không gặng: lấy phương án AI suy riêng cho đúng app/)
  assert.match(BIZ_SKILL, /cột Mặc định chỉ khi không có căn cứ riêng/)
  assert.match(THICH_UNG, /chỉ khi không có căn cứ riêng mới lấy cột Mặc định/)
  assert.match(rd('skills', 'flow-stack', 'SKILL.md'), /mặc định của gói chỉ khi không có căn cứ riêng/)
})

test('cờ không mở lại chương hồ sơ đã bỏ, trừ cờ an toàn (nhay, tre-em, nganh) luôn mở câu PL của chúng', () => {
  for (const [n, t] of [['cau-hoi', CAU_HOI], ['thich-ung', THICH_UNG]]) {
    assert.match(t, /chương hồ sơ đã bỏ hẳn thì cờ không mở lại/, `${n}: thiếu luật cờ không mở lại chương đã bỏ`)
    assert.match(t, /cờ an toàn `nhay`, `tre-em`, `nganh`/, `${n}: thiếu ngoại lệ cờ an toàn`)
  }
  assert.match(THICH_UNG, /luôn mở câu PL của chúng\*\* \(PL1 PL2 PL3 PL12\)/)
  assert.match(BIZ_SKILL, /chương đã bỏ thì cờ không mở lại, trừ cờ an toàn `nhay`, `tre-em`, `nganh`/)
  // ví dụ nêu trong luật phải đúng: các câu đó nằm ở chương mà hồ sơ tương ứng đã bỏ
  const d = dropTable()
  assert.ok(d.R.includes('CP') && ROWS.find((r) => r.id === 'CP2').when.startsWith('cờ may-tinh'))
  assert.ok(d.C.includes('TG') && ROWS.find((r) => r.id === 'TG14').when.startsWith('cờ ai'))
  assert.ok(d.R.includes('PL') && ROWS.find((r) => r.id === 'PL16').when === 'N')
  // cờ an toàn chỉ mở câu PL ở bảng cờ như luật nói (TD6 của tre-em là câu theo chương TD)
  assert.ok(ROWS.find((r) => r.id === 'PL12').when === 'cờ nganh')
})

test('PL3 "Chưa biết" khi có cờ nganh hoặc nhay ⇒ giả định an toàn bật cờ tre-em; PL12 chỉ dừng phần chuyên môn, vẫn làm phần ghi, nhắc, gửi', () => {
  const pl3 = ROWS.find((r) => r.id === 'PL3')
  assert.match(pl3.def, /Chưa biết mà có cờ `nganh` hoặc `nhay` ⇒ giả định an toàn: bật cờ `tre-em`/)
  assert.match(THICH_UNG, /PL3 "Chưa biết" mà đang có cờ nhay hoặc nganh \(giả định an toàn\)/)
  const pl12 = ROWS.find((r) => r.id === 'PL12')
  assert.match(pl12.decide, /dừng phần app đưa ra đánh giá, khuyên hoặc quyết định chuyên môn/)
  assert.match(pl12.decide, /phần ghi, nhắc, gửi dữ liệu do người dùng tự nhập vẫn làm/)
  assert.match(pl12.decide, /Câu hỏi mở "cần người có chuyên môn"/)
  assert.match(BIZ_SKILL, /dừng phần app đưa ra đánh giá, khuyên hoặc quyết định\s+chuyên môn/)
  assert.match(BIZ_SKILL, /phần ghi, nhắc, gửi dữ liệu người dùng tự nhập vẫn làm/)
  assert.doesNotMatch(CAU_HOI + THICH_UNG + BIZ_SKILL, /dừng phần tính năng đó/, 'còn câu "dừng phần tính năng đó" mơ hồ')
  const s = EVAL.cases.find((c) => c.id === 'nganh-nhay-cam')
  assert.ok(s.co.includes('tre-em'), 'ca S: PL3 Chưa biết ⇒ cờ tre-em')
  assert.match(s.persona.tra_loi.PL3, /^Chưa biết/)
  assert.ok(s.must.some((m) => /B-PL3/.test(m) && /tre-em/.test(m) && /không mặc định 'Không'/.test(m)))
  assert.ok(s.must.some((m) => /DỪNG phần app đưa ra đánh giá/.test(m) && /vẫn làm phần ghi/.test(m)))
  assert.ok(s.mustNot.some((m) => /dừng cả app/.test(m)))
})

test('đường nhanh gom cả câu ⭐: 3 "Chưa biết" liên tiếp, đề xuất riêng cho app, ≤ 4 câu xác nhận mỗi câu một điều, [AI đề xuất, bạn gật], đếm về 0, sang chương kế', () => {
  assert.match(THICH_UNG, /ba câu liên tiếp\*\*/)
  assert.match(THICH_UNG, /gồm cả câu ⭐/)
  assert.match(THICH_UNG, /tối đa 4 câu xác nhận mỗi vòng, \*\*mỗi câu một điều chính\*\*/)
  assert.match(THICH_UNG, /"Tôi đề xuất: …"/)
  assert.match(THICH_UNG, /"Chưa biết" = giữ đề xuất, ghi giả định/)
  assert.match(THICH_UNG, /`\[AI đề xuất, bạn gật\]`/)
  assert.match(THICH_UNG, /về 0 khi có một câu trả lời thật \*\*và ngay sau khi đường nhanh bật\*\*/)
  assert.match(THICH_UNG, /Chương hết điều thì sang chương kế theo bảng thứ tự vòng/)
  assert.doesNotMatch(THICH_UNG, /Câu ⭐ không vào đường nhanh/)
  assert.match(BIZ_SKILL, /đường nhanh:\s+AI soạn đề xuất cho cả chương, gồm ⭐/)
  assert.match(BUSINESS_TPL, /\[AI đề xuất, bạn gật\]/)
  assert.match(BUSINESS_TPL, /skill khác coi như \[Bạn nói\]/)
  assert.ok(EVAL.cases.find((c) => c.id === 'co-thu-tien').must.some((m) => /đường nhanh/.test(m) && /gồm câu ⭐/.test(m) && /AI đề xuất, bạn gật/.test(m)))
})

test('bảng hồ sơ tính ra từ cột "Hỏi khi": đúng mã, đúng số câu ghi, số vòng ước tính = (số câu + 2) ÷ 4 làm tròn lên', () => {
  const p = profileTable()
  for (const k of ['R', 'N', 'C', '$']) {
    assert.deepEqual([...p[k].ids].sort(), [...derived(k)].sort(), `hồ sơ ${k}: danh sách ở thich-ung.md lệch cột "Hỏi khi" của cau-hoi.md`)
    assert.equal(p[k].stated, p[k].ids.size, `hồ sơ ${k}: ghi ${p[k].stated} câu nhưng đếm được ${p[k].ids.size}`)
    assert.equal(p[k].est, Math.ceil((p[k].ids.size + 2) / 4), `hồ sơ ${k}: ước tính vòng = (số câu + 2) ÷ 4 làm tròn lên`)
  }
  for (const [a, b] of [['R', 'N'], ['N', 'C'], ['C', '$']]) assert.ok(p[a].ids.size < p[b].ids.size, `${b} phải nhiều câu hơn ${a}`)
  const m = BIZ_SKILL.match(/dùng riêng ~(\d+) câu ≈ (\d+) vòng · nội bộ ~(\d+) ≈ (\d+) · mở miễn phí ~(\d+) ≈ (\d+) · có thu tiền ~(\d+) ≈ (\d+)/)
  assert.ok(m, 'SKILL.md bước 3 phải ghi số câu và số vòng ước tính của 4 hồ sơ')
  assert.deepEqual(m.slice(1).map(Number), ['R', 'N', 'C', '$'].flatMap((k) => [p[k].ids.size, p[k].est]))
})

test('không còn trần vòng cứng: số vòng chỉ để báo user ước tính, câu ⭐ không cắt, câu không ⭐ vượt ước tính đi đường nhanh', () => {
  assert.doesNotMatch(THICH_UNG, /Vòng tối đa|trần vòng|vòng tối đa/i)
  assert.match(THICH_UNG, /chỉ để báo user ước tính/)
  assert.match(THICH_UNG, /Câu ⭐ không bao giờ cắt/)
  assert.match(BIZ_SKILL, /Số vòng chỉ để báo user ước tính/)
  assert.match(BIZ_SKILL, /Câu ⭐ không bao giờ cắt/)
})

test('chương bỏ theo hồ sơ khớp danh sách câu của hồ sơ (chương bỏ không còn câu nào, trừ câu cổng)', () => {
  const d = dropTable()
  assert.deepEqual(Object.keys(d).sort(), ['$', 'C', 'N', 'R'])
  for (const k of ['R', 'N', 'C', '$']) {
    const ids = derived(k)
    for (const ch of d[k]) assert.ok(CHAPTERS.includes(ch), `${k}: chương ${ch} lạ`)
    for (const id of ids) {
      if (GATE.has(id)) continue
      assert.ok(!d[k].includes(chapterOf(id)), `hồ sơ ${k} bỏ chương ${chapterOf(id)} nhưng vẫn có câu ${id}`)
    }
    for (const ch of CHAPTERS) {
      if (d[k].includes(ch)) continue
      assert.ok([...ids].some((id) => chapterOf(id) === ch), `hồ sơ ${k} không bỏ chương ${ch} nhưng chưa có câu nào`)
    }
  }
})

test('thứ tự vòng: mỗi câu của hồ sơ có đúng một chỗ, mỗi vòng ≤ 4 câu, TG1 chỉ ở vòng 1', () => {
  const rows = tableRows(section(THICH_UNG, 'Thứ tự vòng'), /^\| \d+ \|/)
  const seen = []
  rows.forEach((r, i) => {
    assert.equal(Number(r[0]), i + 1, 'vòng phải đánh số liền')
    const ids = expandIds(r[1])
    assert.ok(ids.length >= 1 && ids.length <= 4, `vòng ${r[0]}: ${ids.length} câu (tối đa 4)`)
    seen.push(...ids)
  })
  assert.equal(new Set(seen).size, seen.length, 'có câu xuất hiện hai lần trong bảng vòng')
  assert.deepEqual([...seen].sort(), [...derived('$')].sort(), 'bảng vòng phải chứa đúng mọi câu của hồ sơ $ (hồ sơ nhỏ chỉ bỏ bớt)')
  assert.deepEqual(expandIds(rows[0][1]).sort(), ['TG1', 'TQ1', 'TQ2', 'TQ9'], 'vòng 1 = TQ1 TQ2 TQ9 TG1')
  assert.equal(rows.filter((r) => expandIds(r[1]).includes('TG1')).length, 1, 'TG1 hỏi đúng một vòng')
})

test('TG1 hỏi ở vòng 1 ở mọi chỗ; TQ2 không còn đáp án "có bán"', () => {
  const tq2 = ROWS.find((r) => r.id === 'TQ2')
  assert.doesNotMatch(tq2.ans, /có bán/i)
  assert.equal(tq2.ans.split(' · ').length, 3)
  const tg1 = ROWS.find((r) => r.id === 'TG1')
  assert.match(tg1.whenRaw, /vòng 1/)
  assert.match(CAU_HOI, /TG1 là \*\*câu cổng\*\*, hỏi ở vòng 1/)
  assert.match(BIZ_SKILL, /Vòng 1 xác định tầm cỡ\*\* \(TQ1 TQ2 TQ9 TG1/)
  assert.doesNotMatch(THICH_UNG + CAU_HOI + BIZ_SKILL, /TG1[^.\n]{0,40}vòng 2|vòng 2[^.\n]{0,40}\bTG1\b/)
  for (const c of EVAL.cases) {
    for (const line of c.must) assert.doesNotMatch(line, /Vòng 2 hỏi[^;]*B-TG1/, `${c.id}: bài đo đòi hỏi TG1 ở vòng 2`)
    const v1 = c.must.find((m) => /^Vòng 1 hỏi/.test(m))
    assert.ok(v1, `${c.id}: thiếu dòng vòng 1`)
    const askedTG1 = /hỏi[^;]*B-TG1(?!\d)/.test(v1.split(/không hỏi|bỏ /i)[0])
    if (c.ho_so === 'R') continue
    if (c.da_ro_tu_loi_ke.includes('TG1')) assert.ok(!askedTG1 && /B-TG1(?!\d)/.test(v1), `${c.id}: TG1 đã rõ từ lời kể, vòng 1 không được hỏi nhưng phải nêu lý do`)
    else assert.ok(askedTG1, `${c.id}: lời kể chưa rõ chuyện tiền nên vòng 1 phải hỏi B-TG1`)
  }
})

test('câu đã rõ từ lời kể thì không hỏi (da_ro_tu_loi_ke): lời kể của ca thực sự nói điều đó, must nêu rõ, persona vẫn giữ để điền "Bạn nói"', () => {
  assert.match(CAU_HOI, /Lời kể đã rõ thì không hỏi/)
  assert.match(THICH_UNG, /Câu rõ từ lời kể thì không hỏi/)
  assert.match(BIZ_SKILL, /Rõ từ lời kể thì không hỏi/)
  const say = Object.fromEntries(EVAL.cases.map((c) => [c.id, c.say]))
  for (const c of EVAL.cases) {
    assert.ok(Array.isArray(c.da_ro_tu_loi_ke), `${c.id}: thiếu da_ro_tu_loi_ke`)
    for (const code of c.da_ro_tu_loi_ke) {
      assert.ok(CODE_SET.has(code), `${c.id}: ${code} không có trong danh sách`)
      const lines = c.must.filter((m) => m.includes(`B-${code}`))
      assert.ok(lines.length, `${c.id}: must phải nêu B-${code} (không hỏi vì rõ từ lời kể)`)
      for (const l of lines) assert.ok(!new RegExp(`hỏi[^;.]*B-${code}`).test(l.split(/không hỏi|bỏ |rõ từ lời kể|đã nói/i)[0]), `${c.id}: must bắt hỏi B-${code} dù lời kể đã rõ`)
    }
  }
  assert.deepEqual(EVAL.cases.find((c) => c.id === 'co-thu-tien').da_ro_tu_loi_ke.sort(), ['TG1', 'TG7'])
  assert.match(say['co-thu-tien'], /chuyển khoản tiền cọc/)
  assert.match(say['mo-mien-phi'], /miễn phí/)
  assert.match(say['nganh-nhay-cam'], /miễn phí/)
  assert.doesNotMatch(say['noi-bo'], /miễn phí|tiền|thu phí/)
  assert.deepEqual(EVAL.cases.find((c) => c.id === 'noi-bo').da_ro_tu_loi_ke, [])
  const tt = EVAL.cases.find((c) => c.id === 'co-thu-tien')
  assert.ok(!/^Vòng 1 hỏi[^;]*B-TG7/.test(tt.must[0].split(/không hỏi/i)[0]))
})

test('mỗi câu "Hỏi khi = cờ x" được liệt kê ở dòng cờ x của bảng cờ; có cờ thu-dich-vu và ban-app tách hai kiểu thu tiền', () => {
  const flagRows = tableRows(section(THICH_UNG, 'Cờ mở câu'), /^\| [a-z-]+(, [a-z-]+)* \|/)
  const byFlag = {}
  for (const r of flagRows) for (const f of r[0].split(', ')) byFlag[f] = new Set(expandIds(r[2]))
  for (const f of ['tien', 'thu-dich-vu', 'ban-app']) assert.ok(byFlag[f], `thiếu cờ ${f} trong bảng cờ`)
  for (const r of ROWS.filter((x) => x.when.startsWith('cờ '))) {
    for (const f of r.when.slice(3).split(', ')) assert.ok(byFlag[f]?.has(r.id), `${r.id} cần có ở dòng cờ ${f} của bảng cờ`)
  }
  for (const id of ['TG4', 'TG5', 'TG6', 'TG10', 'DT6', 'CP5', 'UT6']) assert.equal(ROWS.find((r) => r.id === id).when, 'cờ ban-app', `${id} là câu khuôn bán phần mềm: chỉ mở khi ban-app`)
  assert.match(CAU_HOI, /chỉ mở khi `ban-app`/)
})

test('10 quyết định thử: đủ 10, mã "bản phải có" có thật; "tin nhắc lúc mấy giờ" trỏ giờ hẹn của việc', () => {
  const rows = tableRows(section(THICH_UNG, '10 quyết định thử'), /^\| \d+ \|/)
  assert.equal(rows.length, 10)
  for (const r of rows) {
    const ids = expandIds(r[2])
    assert.ok(ids.length >= 1, `quyết định ${r[0]} không trỏ mã nào`)
    for (const id of ids) assert.ok(CODE_SET.has(id), `quyết định ${r[0]}: mã ${id} không có`)
  }
  assert.match(rows[0][2], /giờ hẹn/)
  assert.match(rows[0][3], /theo giờ của việc/)
})

test('bốn cổng của kit luôn hỏi, cố định, không ai tắt được và KHÔNG nằm trong đáp án UT8; UT8 chỉ hỏi việc thêm', () => {
  const ut8 = ROWS.find((r) => r.id === 'UT8')
  assert.match(ut8.q, /^Ngoài 4 việc kit luôn hỏi[^?]*bạn muốn AI hỏi thêm việc nào\?$/)
  assert.match(ut8.ans, /chọn nhiều/)
  // không đáp án UT8 nào là một trong bốn cổng
  const opts = ut8.ans.replace(/\([^)]*\)/g, '').split(' · ').map((x) => x.trim())
  assert.ok(opts.length >= 2 && opts.length <= 4)
  const gateWords = [/tiêu tiền/i, /xoá dữ liệu/i, /gửi (gì )?ra ngoài/i, /đưa (app )?lên mạng/i, /phát hành/i, /gộp/i]
  for (const o of opts) for (const g of gateWords) assert.doesNotMatch(o, g, `đáp án UT8 "${o}" là một trong bốn cổng: cổng phải cố định, không cho chọn bỏ`)
  for (const g of GATES4) assert.ok(!ut8.ans.includes(g), `UT8 không được có đáp án "${g}"`)
  assert.match(ut8.decide, /bốn cổng của kit LUÔN hỏi, cố định, không ai tắt được, \*\*không nằm trong đáp án\*\*/)
  assert.match(ut8.decide, /bốn cổng luôn hỏi \+ việc chọn ở đây; còn lại AI tự suy/)
  assert.match(ut8.def, /Không thêm gì \(bỏ trống = không thêm, khuyên dùng\)/)
  assert.equal(ut8.kieu, 'QĐ')
  const files = { 'SKILL.md': BIZ_SKILL, 'cau-hoi.md': CAU_HOI, 'thich-ung.md': THICH_UNG, 'business.md': BUSINESS_TPL }
  for (const [n, t] of Object.entries(files)) {
    assert.doesNotMatch(t, /việc nào AI (?:KHÔNG )?(?:được tự quyết|PHẢI hỏi)/i, `${n}: còn câu UT8 kiểu cũ`)
    assert.doesNotMatch(t, /Việc nào AI KHÔNG được|AI PHẢI hỏi trước khi làm|PHẢI hỏi bạn trước khi làm/, `${n}: còn câu UT8 kiểu cũ`)
    assert.match(t, /cố định/, `${n}: phải nói bốn cổng là cố định`)
    for (const g of ['tiêu tiền thật', 'xoá dữ liệu', 'gửi gì ra ngoài cho khách|gửi ra ngoài cho khách', 'đưa app lên mạng|đưa lên mạng']) assert.match(t, new RegExp(g), `${n}: thiếu cổng "${g}"`)
  }
  assert.match(BIZ_SKILL, /"Ngoài 4 việc kit luôn hỏi, bạn muốn AI hỏi thêm việc\s+nào\?"/)
  assert.match(BIZ_SKILL, /luôn hỏi, cố định, không ai tắt được, không nằm trong đáp\s+án UT8/)
  assert.match(BIZ_SKILL, /"4 cổng luôn hỏi \+ việc chọn ở UT8; còn lại AI tự suy"/)
  assert.match(BUSINESS_TPL, /4 cổng luôn hỏi \(cố định, không tắt được, không nằm trong câu UT8\)/)
  assert.match(THICH_UNG, /Cố định, không ai tắt được, không nằm trong đáp án UT8/)
  assert.match(THICH_UNG, /bốn cổng luôn hỏi \+ việc chọn ở UT8; còn lại AI tự suy/)
  for (const c of EVAL.cases) {
    const blob = JSON.stringify([c.must, c.mustNot, c.persona])
    assert.doesNotMatch(blob, /AI được tự quyết|PHẢI hỏi bạn trước khi làm/, `${c.id}: bài đo còn UT8 kiểu cũ`)
    if (c.persona.tra_loi.UT8) for (const g of GATES4) assert.ok(!c.persona.tra_loi.UT8.includes(g), `${c.id}: persona chọn bỏ một cổng cố định`)
  }
  for (const id of ['dung-rieng', 'co-thu-tien']) {
    const line = EVAL.cases.find((c) => c.id === id).must.find((m) => m.includes('B-UT8'))
    assert.ok(line && /Ngoài 4 việc kit luôn hỏi/.test(line) && /luôn hỏi, cố định/.test(line) && /không nằm trong đáp án/.test(line) && /Chưa biết/.test(line), `${id}: must UT8 phải nói bốn cổng luôn hỏi, cố định, không nằm trong đáp án, "Chưa biết" = không thêm`)
  }
})

test('bài đo có đủ 5 ca, mỗi hồ sơ một ca, đủ trường', () => {
  assert.ok(Array.isArray(EVAL.criteria) && EVAL.criteria.length >= 5)
  assert.ok(Array.isArray(EVAL.cases) && EVAL.cases.length >= 5)
  const ids = EVAL.cases.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'id trùng')
  for (const id of REQUIRED_IDS) assert.ok(ids.includes(id), `thiếu ca ${id}`)
  assert.deepEqual(EVAL.cases.map((c) => c.ho_so).sort(), [...PROFILES].sort())
  for (const c of EVAL.cases) {
    assert.ok(typeof c.say === 'string' && c.say.length >= 40, `${c.id}: say quá ngắn`)
    assert.ok(Number.isInteger(c.vong_uoc) && Number.isInteger(c.so_cau_uoc), `${c.id}: thiếu vong_uoc/so_cau_uoc`)
    assert.ok(Array.isArray(c.co) && c.co.every((f) => FLAGS.includes(f)), `${c.id}: cờ lạ`)
    assert.ok(Array.isArray(c.chuong_bo) && c.chuong_bo.every((x) => CHAPTERS.includes(x)), `${c.id}: chuong_bo có chương lạ`)
    assert.ok(Array.isArray(c.must) && c.must.length >= 5 && c.must.every((m) => typeof m === 'string' && m.length > 10), `${c.id}: must thiếu`)
    assert.ok(Array.isArray(c.mustNot) && c.mustNot.length >= 1, `${c.id}: mustNot thiếu`)
    assert.ok(c.persona?.ten && c.persona?.boi_canh && Object.keys(c.persona.tra_loi ?? {}).length >= 5, `${c.id}: persona thiếu`)
    assert.ok(!('vong_toi_da' in c), `${c.id}: còn trường vong_toi_da (đã bỏ trần vòng)`)
  }
})

test('hồ sơ, vòng ước tính, số câu, chương bỏ của từng ca khớp bảng tính từ "Hỏi khi"', () => {
  const d = dropTable()
  for (const c of EVAL.cases) {
    const base = c.ho_so === 'S' ? c.ho_so_nen : c.ho_so
    assert.ok(['R', 'N', 'C', '$'].includes(base), `${c.id}: ca S phải khai ho_so_nen`)
    const n = c.ho_so === 'S' ? sIds(base).size : derived(base).size
    assert.equal(c.so_cau_uoc, n, `${c.id}: số câu`)
    assert.equal(c.vong_uoc, Math.ceil((n + 2) / 4), `${c.id}: vòng ước tính`)
    assert.deepEqual([...c.chuong_bo].sort(), [...d[base]].sort(), `${c.id}: chương bỏ lệch bảng hồ sơ ${base}`)
    assert.ok(c.must.some((m) => m.includes(`khoảng ${c.vong_uoc} vòng`)), `${c.id}: must phải nói "khoảng ${c.vong_uoc} vòng"`)
    assert.ok(c.must.some((m) => m.includes(`khoảng ${c.so_cau_uoc} câu`)), `${c.id}: must phải nói "khoảng ${c.so_cau_uoc} câu"`)
  }
})

test('persona khớp hồ sơ: TQ2, TQ9, TG1 dẫn tới đúng hồ sơ; mọi câu persona trả lời có thật và nằm ở chương còn hỏi', () => {
  const tq2 = { R: /^Mình/, N: /^Nhóm/, C: /^Người ngoài/, $: /^Người ngoài/, S: /^Người ngoài/ }
  for (const c of EVAL.cases) {
    const a = c.persona.tra_loi
    assert.ok(a.TQ1 && a.TQ2 && a.TQ9, `${c.id}: persona thiếu TQ1/TQ2/TQ9`)
    assert.match(a.TQ2, tq2[c.ho_so], `${c.id}: TQ2 không khớp hồ sơ ${c.ho_so}`)
    if (c.ho_so === 'S') assert.match(a.TQ9, /^Có|^Chưa biết/, `${c.id}: hồ sơ S cần TQ9 có hoặc Chưa biết`)
    else assert.match(a.TQ9, /^Không$/, `${c.id}: TQ9 phải là Không`)
    if (c.ho_so === 'R') assert.ok(!a.TG1, `${c.id}: hồ sơ R không hỏi TG1`)
    if (c.ho_so === '$') assert.match(a.TG1 ?? '', /^Thu tiền/, `${c.id}: hồ sơ $ cần TG1 có thu tiền`)
    if (['N', 'C', 'S'].includes(c.ho_so)) assert.match(a.TG1, /^Miễn phí hẳn/, `${c.id}: TG1 phải là miễn phí hẳn`)
    for (const code of Object.keys(a)) {
      assert.ok(CODE_SET.has(code), `${c.id}: persona trả lời mã ${code} không có trong danh sách`)
      if (!GATE.has(code)) assert.ok(!c.chuong_bo.includes(chapterOf(code)), `${c.id}: persona trả lời ${code} ở chương phải bỏ`)
    }
  }
  const tt = EVAL.cases.find((c) => c.id === 'co-thu-tien')
  assert.ok(tt.co.includes('thu-dich-vu') && !tt.co.includes('ban-app'), 'tiệm tóc thu cọc dịch vụ: cờ thu-dich-vu, không ban-app')
})

test('mọi mã B-xx trong must/mustNot có trong cau-hoi.md; must không bắt hỏi mã ở chương phải bỏ', () => {
  for (const c of EVAL.cases) {
    for (const line of [...c.must, ...c.mustNot]) {
      for (const [, code] of line.matchAll(/\bB-([A-Z]{2}\d+)\b/g)) assert.ok(CODE_SET.has(code), `${c.id}: B-${code} không có trong cau-hoi.md`)
    }
    for (const line of c.must) {
      const asked = line.split(/không hỏi|bỏ /i)[0] // phần sau "không hỏi"/"bỏ" nói về điều KHÔNG được hỏi
      for (const [, code] of asked.matchAll(/\bB-([A-Z]{2}\d+)\b/g)) {
        if (GATE.has(code)) continue
        assert.ok(!c.chuong_bo.includes(chapterOf(code)), `${c.id}: must bắt hỏi B-${code} nhưng chương ${chapterOf(code)} phải bỏ`)
      }
    }
    assert.ok(c.must.some((m) => /B-TQ2/.test(m) && /B-TQ9/.test(m)), `${c.id}: vòng 1 phải hỏi B-TQ2 và B-TQ9`)
  }
})

test('ca có thu tiền hỏi chương tiền theo kiểu thu dịch vụ; ca ngành nhạy cảm kéo PL12 lên sớm và dừng chờ người chuyên môn', () => {
  const byId = Object.fromEntries(EVAL.cases.map((c) => [c.id, c]))
  const money = byId['co-thu-tien'].must.join('\n')
  for (const code of ['B-TG1', 'B-TG3', 'B-TG7', 'B-TG8', 'B-TG9', 'B-CP1']) assert.ok(money.includes(code), `co-thu-tien: thiếu ${code}`)
  assert.match(money, /không hỏi các câu theo khuôn bán phần mềm/)
  const risky = byId['nganh-nhay-cam'].must.join('\n')
  for (const code of ['B-PL12', 'B-PL2', 'B-PL3']) assert.ok(risky.includes(code), `nganh-nhay-cam: thiếu ${code}`)
  assert.match(risky, /DỪNG/)
  assert.ok(byId['nganh-nhay-cam'].co.includes('nganh') && byId['nganh-nhay-cam'].co.includes('nhay'))
  assert.ok(byId['dung-rieng'].chuong_bo.includes('TG') && byId['dung-rieng'].chuong_bo.includes('PL'))
})

test('luật chung: thư mục cha thay thư mục phiên; mặc định thua [Bạn nói]; đổi ý và lỗ hổng; câu hỏi mở có cột Xử lý', () => {
  for (const [n, t] of [['SKILL', BIZ_SKILL], ['business.md', BUSINESS_TPL], ['flow-stack SKILL', rd('skills', 'flow-stack', 'SKILL.md')], ['stack.md', rd('skills', 'flow-stack', 'assets', 'stack.md')]]) {
    assert.doesNotMatch(t, /thư mục phiên/, `${n}: còn "thư mục phiên" (phải là thư mục cha sẽ tạo app)`)
    assert.match(t, /<thư mục cha>|thư mục cha/, `${n}: thiếu thư mục cha`)
  }
  assert.match(BIZ_SKILL, /Mặc định và suy luận đều thua điều user đã nói/)
  assert.match(BIZ_SKILL, /ngược mục `\[Bạn nói\]`/)
  assert.match(BIZ_SKILL, /Trái mục `\[AI đoán\]` hoặc `\[Mặc định\]`[^.]*không hỏi/)
  assert.match(BIZ_SKILL, /Chỉ skill này sửa nội dung/)
  assert.match(BIZ_SKILL, /Ngay sau vòng 1\*\* giao `researcher`/)
  assert.match(BUSINESS_TPL, /\| OQ \| Chủ \| Chặn việc gì \| Xử lý \|/)
  assert.doesNotMatch(BUSINESS_TPL, /Hỏi lại khi nào/)
  assert.match(THICH_UNG, /Đếm "Chưa biết" theo câu, không theo vòng/)
  assert.match(THICH_UNG, /chương của câu "Chưa biết" thứ ba/)
  assert.match(CAU_HOI, /VD1 ⭐[^\n]*\| ST \|$/m)
  assert.match(BUSINESS_TPL, /hồ sơ R không có chương pháp lý/)
  assert.match(BUSINESS_TPL, /Ngoài hồ sơ <R\|N\|C\|\$>/)
  assert.match(BUSINESS_TPL, /≤ 15 dòng và ≤ 1\.500 ký tự/)
})

test('flow-stack: gói nền theo trần chi, tai-may cho app không máy chủ, khung web mặc định, AI_RULES sau khi tạo app, SePay hoàn cọc', () => {
  const sk = rd('skills', 'flow-stack', 'SKILL.md')
  const mang = rd('skills', 'flow-stack', 'references', 'mang.md')
  const stack = rd('skills', 'flow-stack', 'assets', 'stack.md')
  assert.match(sk, /trần\s+chi mỗi tháng \(B-CP1\) đủ cho Chắc/)
  // N5: luật gói dùng đúng đáp án thật của UT1 (Chạy chắc và riêng tư · Ra nhanh và rẻ · Dễ dùng và gọn)
  assert.match(sk, /khuyên theo đáp án thật của B-UT1/)
  assert.match(sk, /"Chạy chắc và riêng tư" ⇒ Chắc/)
  assert.match(sk, /"Ra nhanh và rẻ" ⇒ Nhẹ/)
  assert.match(sk, /"Dễ dùng và gọn" hoặc Chưa biết ⇒ theo quy mô/)
  assert.match(mang, /"Chạy chắc và riêng tư" ⇒ Chắc/)
  assert.match(mang, /"Ra nhanh và rẻ" ⇒ Nhẹ/)
  assert.doesNotMatch(sk + mang, /ưu tiên mở rộng lâu dài ⇒ Chắc; ưu tiên tiết kiệm|ưu tiên tiết kiệm ⇒ Nhẹ/, 'còn hạng mục UT1 không có (ưu tiên mở rộng/tiết kiệm)')
  const ut1 = ROWS.find((r) => r.id === 'UT1').ans
  for (const o of ['Chạy chắc và riêng tư', 'Ra nhanh và rẻ', 'Dễ dùng và gọn']) assert.ok(ut1.includes(o), `UT1 thiếu đáp án ${o}`)
  // N6: dữ liệu nhạy cảm cũng khuyên Chắc
  assert.match(sk, /cờ `nhay`\/`nganh`\/`tre-em`, vì cần DB khoá quyền/)
  assert.match(mang, /cờ `nhay`, `nganh`, `tre-em`, vì cần DB khoá quyền/)
  assert.match(sk, /Dữ liệu nhạy cảm mà trần thấp hơn ⇒\s+vẫn khuyên Chắc, nói rõ vượt trần bao nhiêu/)
  // N13: thư mục cha
  assert.match(sk, /thư mục cha = giá trị `--dir` của `flow-new-app`; chưa chốt thì thư mục làm việc hiện tại của phiên, nói user một dòng/)
  assert.match(stack, /thư mục cha = giá trị `--dir` của `flow-new-app`; chưa chốt thì thư mục làm việc hiện tại của phiên/)
  assert.match(BIZ_SKILL, /thư mục cha = giá trị `--dir` của `flow-new-app`/)
  assert.match(BIZ_SKILL, /thư mục\s+làm việc hiện tại của phiên và nói user một dòng/)
  assert.match(sk, /mốc đo được để\s+chuyển sang Postgres/)
  // N11: mảng 16 và 18 không còn mâu thuẫn giữa "điều kiện bỏ câu" và "bỏ câu khi"
  assert.doesNotMatch(mang, /Còn 1, 2 \(hoặc không cần máy chủ\), 4, 8, 16, 18, 19\./)
  assert.match(mang, /16 chỉ khi chạy trên máy chủ[^.]*; 18 chỉ khi có trang công khai/)
  assert.match(sk, /vượt\s+trần bao nhiêu/)
  assert.match(sk, /Vượt trần khoảng|vượt trần khoảng/i)
  assert.match(sk, /chỉ cho app có máy chủ/)
  assert.match(sk, /goi: tai-may/)
  assert.match(mang, /goi: tai-may/)
  assert.match(stack, /goi: <nhe\|chac\|may-chu-rieng\|tai-may>/)
  assert.match(mang, /"Chưa biết" ⇒ `web-public`/)
  assert.match(sk, /sau khi app được\s+tạo/)
  assert.doesNotMatch(stack, /skill chính hãng đã cài mức dự án/)
  assert.match(sk + mang, /refunds\.md|tài liệu hoàn tiền/)
  assert.match(mang, /Mặc định thua điều user đã nói/)
  assert.match(sk, /Mặc định và lời khuyên thua điều user đã nói/)
})

test('bản mẫu ban-mau-*.md và flow-spec: câu business không hỏi user (lấy từ BUSINESS.md, chưa có thì tự suy); flow-spec đòi "Chưa biết"', () => {
  const dir = path.join(SK, 'flow-system-design', 'references')
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('ban-mau-') && f.endsWith('.md'))
  assert.equal(files.length, 8)
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8').replaceAll('\r\n', '\n')
    assert.ok(t.includes('Câu business trong "Hỏi user" không hỏi user'), `${f}: thiếu luật chung câu business`)
    assert.match(t, /lấy từ BUSINESS\.md[^)]*chưa có thì tự suy/, `${f}: chưa gắn thẻ "lấy từ BUSINESS.md; chưa có thì tự suy" cho câu business`)
  }
  const gd = fs.readFileSync(path.join(dir, 'ban-mau-gui-di.md'), 'utf8')
  for (const q of ['Khách ở những nước nào?', 'Có thật cần SMS', 'Mỗi tháng chi tối đa bao nhiêu cho SMS?']) {
    const line = gd.split('\n').find((l) => l.includes(q))
    assert.ok(line && /lấy từ BUSINESS\.md/.test(line), `ban-mau-gui-di: câu "${q}" phải gắn thẻ BUSINESS.md`)
  }
  const dl = fs.readFileSync(path.join(dir, 'ban-mau-du-lieu.md'), 'utf8')
  assert.match(dl.split('\n').find((l) => l.includes('Nhắc theo giờ của ai?')), /lấy từ BUSINESS\.md/)
  const spec = rd('skills', 'flow-spec', 'SKILL.md')
  assert.match(spec, /câu nào cũng có\s+"Chưa biết"/)
  assert.match(spec, /Câu business trong mục "Hỏi user"/)
  assert.match(spec, /tự suy, ghi `\(AI suy từ B-xx\)`/)
})

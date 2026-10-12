// solutions: thư viện rút kinh nghiệm — mỗi bài học một file docs/solutions/<YYYY-MM-DD>-<slug>.md (PLAN đợt 2 mục 5, AC-47).
// Front matter: dang_loi (nhãn ổn định) · tom_tat · tags · lan (số lần gặp) · may_kiem none|lint|ast-grep|test|hook|chu · nguon ·
// ngay · ra_soat (ngày rà gần nhất) · tai_phat · vong_sua · bao_nham · vi_sao_khong_suy_ra. Thân: chuyện gì · vì sao không suy ra được từ code · cách tránh.
// "Durable bar": vi_sao_khong_suy_ra rỗng ⇒ từ chối ghi (đọc code là biết thì không cần ghi).
// docs/solutions/INDEX.md tự sinh (có dòng đánh dấu); file INDEX.md viết tay thì không ghi đè.
// Mượn tiện ích của so-chot.mjs (safePath, slugOf, oneLine, vnTime); ghi file nguyên tử (tạo tạm rồi đổi tên).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { oneLine, safePath, slugOf, vnTime } from './so-chot.mjs'

export const SOLUTIONS_REL = 'docs/solutions'
export const INDEX_REL = `${SOLUTIONS_REL}/INDEX.md`
export const GEN_MARK = '<!-- tự sinh bởi solutions.mjs, đừng sửa tay -->'
export const MAY_KIEM = ['none', 'lint', 'ast-grep', 'test', 'hook', 'chu']
export const NGAY_QUA_HAN = 30
export const REFUSE_MSG = 'điều này đọc code là biết, không cần ghi'
// Thang đề xuất khi một lỗi lặp lại mà chưa có máy kiểm: rẻ → đắt.
export const THANG = [
  'luật có sẵn của linter/compiler (bật lên là xong)',
  'luật cấm tuỳ biến (no-restricted-*/depguard)',
  'ast-grep',
  'test',
  'hook',
  'lời dặn trong CLAUDE.md',
]

const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/
const FIELD_MAX = 8000
const lstatSafe = (p) => { try { return fs.lstatSync(p) } catch { return null } }
const today = (now) => vnTime(now).slice(0, 10)

// Nhãn ổn định: không dấu, chữ thường, nối bằng "-" (gõ khác hoa/thường/dấu vẫn ra cùng nhãn).
export function nhan(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
}

// ---------- định dạng ----------

const scalar = (v) => (/^[A-Za-z0-9_./-]+$/.test(v) ? v : JSON.stringify(v))
const unscalar = (v) => {
  const t = v.trim()
  if (t.startsWith('"')) { try { return JSON.parse(t) } catch { return t.replace(/^"|"$/g, '') } }
  return t
}
const cap = (s) => String(s ?? '').trim().slice(0, FIELD_MAX)

export function renderBaiHoc(b) {
  const fm = [
    '---',
    `dang_loi: ${scalar(b.dang_loi)}`,
    `tom_tat: ${JSON.stringify(b.tom_tat)}`,
    `tags: [${b.tags.join(', ')}]`,
    `lan: ${b.lan}`,
    `may_kiem: ${b.may_kiem}`,
    `nguon: ${scalar(b.nguon || '-')}`,
    `ngay: ${b.ngay}`,
    `ra_soat: ${b.ra_soat}`,
    `tai_phat: ${b.tai_phat}`,
    `vong_sua: ${b.vong_sua}`,
    `bao_nham: ${b.bao_nham}`,
    `vi_sao_khong_suy_ra: ${JSON.stringify(oneLine(b.vi_sao_khong_suy_ra, 500))}`,
    '---',
  ]
  return [
    ...fm, '',
    `# ${b.tom_tat}`, '',
    '## Chuyện gì', cap(b.chuyen_gi) || '(chưa ghi)', '',
    '## Vì sao không suy ra được từ code', cap(b.vi_sao_khong_suy_ra), '',
    '## Cách tránh', cap(b.cach_tranh) || '(chưa ghi)', '',
  ].join('\n')
}

// text → bài học | { loi }. `file` = đường dẫn tương đối so với docs/solutions.
export function parseBaiHoc(text, file = '') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { loi: 'thiếu front matter', file }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return { loi: 'front matter không đóng', file }
  const fm = {}
  for (const l of lines.slice(1, end)) {
    if (!l.trim() || l.trim().startsWith('#')) continue
    const m = /^([A-Za-z_]+)[ \t]*:[ \t]*(.*)$/.exec(l)
    if (!m) return { loi: `dòng front matter hỏng: ${oneLine(l, 40)}`, file }
    fm[m[1]] = m[2]
  }
  for (const k of ['dang_loi', 'tom_tat', 'lan', 'may_kiem', 'ngay']) {
    if (fm[k] === undefined || unscalar(fm[k]) === '') return { loi: `thiếu trường ${k}`, file }
  }
  const may_kiem = unscalar(fm.may_kiem)
  if (!MAY_KIEM.includes(may_kiem)) return { loi: `may_kiem không hợp lệ (${oneLine(may_kiem, 20)})`, file }
  const ngay = unscalar(fm.ngay)
  if (!NGAY_RE.test(ngay)) return { loi: 'ngay không đúng dạng YYYY-MM-DD', file }
  const lan = Number(unscalar(fm.lan))
  if (!Number.isInteger(lan) || lan < 1) return { loi: 'lan phải là số nguyên ≥ 1', file }
  const ra_soat = fm.ra_soat === undefined ? ngay : unscalar(fm.ra_soat)
  if (!NGAY_RE.test(ra_soat)) return { loi: 'ra_soat không đúng dạng YYYY-MM-DD', file }
  const num = (k) => { const n = Number(unscalar(fm[k] ?? '0')); return Number.isInteger(n) && n >= 0 ? n : 0 }
  const tags = fm.tags === undefined ? [] : fm.tags.replace(/^\s*\[|\]\s*$/g, '').split(',').map((s) => unscalar(s)).filter(Boolean)
  return {
    dang_loi: unscalar(fm.dang_loi), tom_tat: oneLine(unscalar(fm.tom_tat)), tags, lan, may_kiem,
    nguon: fm.nguon === undefined ? '' : unscalar(fm.nguon), ngay, ra_soat,
    tai_phat: num('tai_phat'), vong_sua: num('vong_sua'), bao_nham: num('bao_nham'),
    vi_sao_khong_suy_ra: fm.vi_sao_khong_suy_ra === undefined ? '' : unscalar(fm.vi_sao_khong_suy_ra),
    file, than: lines.slice(end + 1).join('\n').trim(),
  }
}

// Sửa/chèn một trường trong front matter (giữ kiểu xuống dòng của file).
function setFrontField(text, key, value) {
  const t = text.replace(/^﻿/, '')
  const eol = t.includes('\r\n') ? '\r\n' : '\n'
  const lines = t.split(/\r?\n/)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) throw new Error('front matter hỏng, không sửa được')
  const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}[ \\t]*:`).test(l))
  if (at >= 0) lines[at] = `${key}: ${value}`
  else lines.splice(end, 0, `${key}: ${value}`)
  return lines.join(eol)
}

// ---------- đĩa ----------

function atomicWrite(abs, content) {
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  fs.writeFileSync(tmp, content)
  try { fs.renameSync(tmp, abs) } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch {} ; throw e }
}

const realRootOf = (projectRoot) => fs.realpathSync.native(path.resolve(String(projectRoot)))

// Thư mục docs/solutions (an toàn, không symlink); tao=true ⇒ tạo nếu chưa có.
function dirOf(root, tao) {
  const abs = safePath(root, SOLUTIONS_REL)
  if (!abs) throw new Error(`${SOLUTIONS_REL} nằm ngoài thư mục dự án hoặc qua symlink/junction, không ghi`)
  if (tao) fs.mkdirSync(abs, { recursive: true })
  return abs
}

// { items: [bài học + abs], loi: [string] } — bỏ INDEX.md, symlink, file hỏng (ghi vào loi).
export function scan(projectRoot) {
  const root = realRootOf(projectRoot)
  const dir = dirOf(root, false)
  const items = []
  const loi = []
  if (!lstatSafe(dir)?.isDirectory()) return { items, loi }
  for (const n of fs.readdirSync(dir).sort()) {
    if (!n.toLowerCase().endsWith('.md') || n === 'INDEX.md') continue
    const abs = path.join(dir, n)
    if (!lstatSafe(abs)?.isFile()) continue
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch { loi.push(`không đọc được ${n}`); continue }
    const p = parseBaiHoc(text, n)
    if (p.loi) { loi.push(`${n}: ${p.loi}`); continue }
    items.push({ ...p, abs })
  }
  return { items, loi }
}

// ---------- lệnh ----------

// Ghi bài học mới. Thiếu vi_sao_khong_suy_ra ⇒ ném lỗi một câu đời thường. Trả { file, rel, dang_loi }.
export function ghi(projectRoot, input, opts = {}) {
  const a = input && typeof input === 'object' ? input : {}
  const vi = String(a.vi_sao_khong_suy_ra ?? '').trim()
  if (!vi) throw new Error(REFUSE_MSG)
  const dang_loi = nhan(a.dang_loi)
  if (!dang_loi) throw new Error('thiếu dang_loi (nhãn ngắn của loại lỗi, vd "quen-doi-env-example")')
  const tom_tat = oneLine(a.tom_tat, 200)
  if (!tom_tat) throw new Error('thiếu tom_tat')
  const may_kiem = a.may_kiem === undefined || a.may_kiem === '' ? 'none' : String(a.may_kiem)
  if (!MAY_KIEM.includes(may_kiem)) throw new Error(`may_kiem phải là một trong: ${MAY_KIEM.join(', ')}`)
  const ngay = a.ngay === undefined ? today(opts.now) : String(a.ngay)
  if (!NGAY_RE.test(ngay)) throw new Error('ngay phải có dạng YYYY-MM-DD')
  const count = (k, def) => {
    if (a[k] === undefined) return def
    const n = Number(a[k])
    if (!Number.isInteger(n) || n < def) throw new Error(`${k} phải là số nguyên ≥ ${def}`)
    return n
  }
  const tags = [...new Set((Array.isArray(a.tags) ? a.tags : String(a.tags ?? '').split(',')).map(nhan).filter(Boolean))]

  const root = realRootOf(projectRoot)
  const dir = dirOf(root, true)
  const cu = scan(root).items.find((b) => b.dang_loi === dang_loi)
  if (cu) throw new Error(`đã có bài học "${dang_loi}" (${cu.file}); gặp lại thì dùng: gap`)

  const base = `${ngay}-${slugOf(dang_loi)}`
  let name = `${base}.md`
  for (let i = 2; lstatSafe(path.join(dir, name)); i++) name = `${base}-${i}.md`
  const abs = path.join(dir, name)
  atomicWrite(abs, renderBaiHoc({
    dang_loi, tom_tat, tags, lan: count('lan', 1), may_kiem, nguon: oneLine(a.nguon ?? '', 120), ngay,
    ra_soat: a.ra_soat === undefined ? ngay : String(a.ra_soat),
    tai_phat: count('tai_phat', 0), vong_sua: count('vong_sua', 0), bao_nham: count('bao_nham', 0),
    vi_sao_khong_suy_ra: vi, chuyen_gi: a.chuyen_gi, cach_tranh: a.cach_tranh,
  }))
  return { file: name, rel: `${SOLUTIONS_REL}/${name}`, dang_loi }
}

// Gặp lại một loại lỗi: tăng lan + tai_phat, cập nhật ra_soat. lan ≥ 2 và may_kiem none ⇒ kèm đề xuất theo thang.
export function gap(projectRoot, dangLoi, opts = {}) {
  const key = nhan(dangLoi)
  if (!key) throw new Error('thiếu dang_loi')
  const b = scan(projectRoot).items.find((x) => x.dang_loi === key)
  if (!b) throw new Error(`không có bài học "${key}" (ghi mới bằng: ghi)`)
  const lan = b.lan + 1
  const tai_phat = b.tai_phat + 1
  let text = fs.readFileSync(b.abs, 'utf8')
  text = setFrontField(text, 'lan', String(lan))
  text = setFrontField(text, 'tai_phat', String(tai_phat))
  text = setFrontField(text, 'ra_soat', today(opts.now))
  atomicWrite(b.abs, text)
  const de_xuat = lan >= 2 && b.may_kiem === 'none'
    ? [
      `Lỗi "${key}" đã gặp ${lan} lần mà chưa có máy kiểm. Thử theo thang, dừng ở bậc đầu dùng được:`,
      ...THANG.map((t, i) => `${i + 1}. ${t}`),
      'Hỏi user trước khi thêm; thêm xong thì đổi may_kiem của bài học này.',
    ]
    : []
  return { file: b.file, dang_loi: key, lan, tai_phat, may_kiem: b.may_kiem, de_xuat }
}

const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000)

// Bài học quá hạn rà soát: ngày hôm nay − ra_soat (không có thì ngay) > days. Cũ nhất trước.
export function raSoat(projectRoot, { days = NGAY_QUA_HAN, now } = {}) {
  const n = Number(days)
  if (!Number.isFinite(n) || n < 0) throw new Error('--days phải là số ≥ 0')
  const homNay = dayNum(today(now))
  return scan(projectRoot).items
    .map((b) => ({ file: b.file, dang_loi: b.dang_loi, ra_soat: b.ra_soat, tuoi: homNay - dayNum(b.ra_soat), lan: b.lan, may_kiem: b.may_kiem }))
    .filter((b) => b.tuoi > n)
    .sort((x, y) => y.tuoi - x.tuoi || (x.file < y.file ? -1 : 1))
}

export function renderIndex(items) {
  const sorted = [...items].sort((a, b) => (a.ngay < b.ngay ? 1 : a.ngay > b.ngay ? -1 : a.file < b.file ? -1 : 1))
  const can = sorted.filter((b) => b.lan >= 2 && b.may_kiem === 'none')
  const line = (b) => `- [${b.dang_loi}](${b.file}) · ${b.ngay} · gặp ${b.lan} lần · máy kiểm: ${b.may_kiem} · ${b.tom_tat}`
  return [
    GEN_MARK, '# Bài học', '',
    ...(can.length ? [`## Lặp lại mà chưa có máy kiểm (${can.length})`, ...can.map(line), ''] : []),
    `## Tất cả (${sorted.length})`, ...(sorted.length ? sorted.map(line) : ['(chưa có)']), '',
  ].join('\n')
}

// Sinh docs/solutions/INDEX.md. File viết tay (không có dòng đánh dấu) ⇒ không ghi đè. Trả { ghi: bool, bo_qua?: string, rel }.
export function index(projectRoot) {
  const root = realRootOf(projectRoot)
  const { items } = scan(root)
  const content = renderIndex(items)
  const dir = dirOf(root, true)
  const abs = path.join(dir, 'INDEX.md')
  const st = lstatSafe(abs)
  let old = null
  if (st) {
    if (!st.isFile()) return { ghi: false, rel: INDEX_REL, bo_qua: 'INDEX.md không phải file thường' }
    old = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '')
    if (old.trim() !== '' && !old.includes(GEN_MARK)) return { ghi: false, rel: INDEX_REL, bo_qua: 'INDEX.md viết tay (không có dòng tự sinh): không ghi đè' }
  }
  if (old !== null && old.replace(/\r\n/g, '\n') === content) return { ghi: false, rel: INDEX_REL }
  atomicWrite(abs, content)
  return { ghi: true, rel: INDEX_REL }
}

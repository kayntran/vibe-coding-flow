// spec-codes: máy kiểm SPEC kiểu "Bạn duyệt" + mã trạng thái S-nn / mã quyền P-nn (ADR-0006). CLI: hooks/spec-check.mjs. Chỉ đọc file.
//
// Định dạng SPEC:
//   ## Bạn duyệt                        (tiêu đề cấp 2; "Phần bạn duyệt …" cũng nhận) rồi 6 mục `###`: Ai dùng · Các màn hình · Làm được gì · Để sau ·
//                                       Phí phát sinh · Ai thấy/sửa được dữ liệu gì. Phần kỹ thuật dưới `## Kỹ thuật` (hoặc `##` khác) — không xét.
//   Ai thấy/sửa được dữ liệu gì         mỗi dòng `- P-01: <ai> <thấy|sửa|xoá> <gì>`; hoặc một dòng `Không áp dụng — <lý do>`.
//   Các màn hình                        mỗi màn một `#### <tên màn>` + bảng `| mã | khi | thấy gì | làm được gì |`, mã `S-01`… duy nhất TOÀN DỰ ÁN (tiếp số sau mã lớn nhất trong docs/specs).
//                                       Cột "khi" nhận (so không dấu): có dữ liệu · trống · đang tải · lỗi — đủ cả bốn. Màn không tải dữ liệu ghi một dòng
//                                       `Không tải dữ liệu` dưới tiêu đề màn ⇒ chỉ cần ≥1 dòng trạng thái (tên gì cũng được).
//   App gắn mã vào phần tử gốc của trạng thái: data-s="S-01" (cũng data-s='S-01', data-s={"S-01"}); test nhắc mã trong tên test hoặc selector.
//
// Hàm xuất (hợp đồng cho flow-check, flow-gate, new-app):
//   parseSpec(text) → { hasApproval, sections:{<tên mục chuẩn>:string}, missing:string[], screens:[{name,line,loadsData,hasTable,states:[{code,when,line}]}],
//                      sCodes:[{code,screen,line}], pCodes:[{code,line,text}], pNotApplicable, dupes:string[] }
//        tên mục so không phân biệt hoa thường/dấu (NFC, bỏ dấu); `missing` = mục không có tiêu đề HOẶC để trống; mục đầu tiên thắng nếu tiêu đề lặp.
//        Bỏ qua tiêu đề/bảng nằm trong khối ``` . hasApproval=false (SPEC kiểu cũ) ⇒ missing là cả 6 mục.
//   specProblems(text) → [{ msg, fix }]     SPEC kiểu cũ ⇒ đúng một problem "SPEC chưa có phần Bạn duyệt".
//   openSpecs(dir) → string[]               đường dẫn TUYỆT ĐỐI của docs/specs/*/SPEC.md mà progress.md cùng thư mục không có `Trạng thái: xong` (không có progress ⇒ mở).
//   traceCodes(dir, specPaths) → { ok, problems:[{code,kind:'duplicate-code'|'missing-in-app'|'missing-test',file,line,msg,fix}], counts:{s,p} }
//        specPaths tuyệt đối hoặc tương đối với dir; `file` = SPEC (tương đối với dir, dấu /) nơi khai mã. Ném lỗi nếu không đọc được SPEC.
//        Mã S-nn/P-nn phải DUY NHẤT TOÀN DỰ ÁN (mọi docs/specs/*/SPEC.md, kể cả tính năng đã xong): mã của SPEC đang kiểm mà SPEC khác đã dùng ⇒ 'duplicate-code' kèm gợi ý
//        mã kế tiếp sau mã lớn nhất. Không có nó, SPEC mới đánh số lại từ S-01 sẽ "đạt giả" nhờ mã app/test của tính năng cũ. Mã lặp trong CÙNG một SPEC không tính.
//   dupeCodes(dir, specPaths) → [{ code, kind:'duplicate-code', file, line, msg, fix }]   riêng phần trùng mã toàn dự án (cho `spec-check spec`)
//        S-nn phải có trong file mã nguồn app VÀ trong ít nhất một file test; P-nn chỉ cần trong file test. "Có" = mã xuất hiện như một từ riêng (S-011 không tính cho S-01).
//        File xét: git ls-files -co --exclude-standard (bỏ thư mục git-ignore); không phải git ⇒ đi cây thư mục. Chỉ file đuôi mã nguồn (SRC_EXT) — .md/.json/.txt
//        (README, ui.json, AI_RULES…) không tính; bỏ thư mục SKIP_DIRS. File test = `*.test.*`, `*.spec.*`, hoặc nằm dưới tests/ e2e/ __tests__/.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const SECTIONS = ['Ai dùng', 'Các màn hình', 'Làm được gì', 'Để sau', 'Phí phát sinh', 'Ai thấy/sửa được dữ liệu gì']
const SCREENS = 'Các màn hình'
const DATA = 'Ai thấy/sửa được dữ liệu gì'
const HINT = {
  'Ai dùng': 'một hai câu: ai là người dùng app',
  [SCREENS]: 'mỗi màn một tiêu đề "#### Tên màn" kèm bảng trạng thái | mã | khi | thấy gì | làm được gì |',
  'Làm được gì': 'các việc người dùng làm được, mỗi việc một dòng',
  'Để sau': 'những gì chưa làm đợt này (không có thì ghi "Không có")',
  'Phí phát sinh': 'chi phí thêm cho người dùng/chủ app (không có thì ghi "Không")',
  [DATA]: 'mỗi dòng "- P-01: <ai> <thấy|sửa|xoá> <gì>", hoặc một dòng "Không áp dụng — <lý do>"',
}
const TABLE_HEAD = '| mã | khi | thấy gì | làm được gì |'

const SRC_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.html', '.htm', '.vue', '.svelte', '.astro', '.mdx', '.go', '.py', '.rb', '.php',
  '.erb', '.ejs', '.hbs', '.tmpl', '.gohtml', '.cshtml', '.java', '.kt', '.swift', '.dart', '.rs', '.cs', '.sql'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'docs', 'coverage', '.git', '.claude'])
const TEST_DIRS = new Set(['tests', 'e2e', '__tests__'])
const MAX_FILE = 2 * 1024 * 1024
const CODE_RE = /(?<![A-Za-z0-9_-])([SP]-\d+)(?![A-Za-z0-9_-])/g
const S_RE = /^S-\d+$/
// Dòng `Trạng thái: xong` (chấp nhận markdown bao quanh như `- **Trạng thái:** xong`), không phân biệt hoa thường. Giống flow-dispatch / session-start.
const DONE_RE = /^[ \t>*_#-]*Trạng thái[ \t]*[:：]?[ \t*_]*[:：]?[ \t*_]*xong[ \t*_.!]*$/imu

// --- tiện ích nhỏ -------------------------------------------------------------------------------------------------------------------

const slash = (p) => String(p).replace(/\\/g, '/')
const readText = (p, max = MAX_FILE) => {
  try { return fs.statSync(p).size > max ? null : fs.readFileSync(p, 'utf8').replace(/^﻿/, '') } catch { return null }
}
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
const plain = (s) => String(s).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
const headKey = (t) => fold(plain(t)).replace(/\s*\/\s*/g, '/').replace(/[\s:?.!]+$/, '')
const SECTION_BY_KEY = new Map(SECTIONS.map((n) => [headKey(n), n]))
const showPath = (root, abs) => { const r = slash(path.relative(root, abs)); return r === '' || r.startsWith('..') || path.isAbsolute(r) ? slash(abs) : r }

// --- đọc cấu trúc markdown ----------------------------------------------------------------------------------------------------------

// → { lines, heads:[{level,title,line}], fenced:boolean[] } ; line 1-based. Tiêu đề trong khối ``` / ~~~ không tính.
function scan(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').normalize('NFC').split(/\r?\n/)
  const heads = []
  const fenced = lines.map(() => false)
  let fence = null
  lines.forEach((ln, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(ln)
    if (fence) {
      fenced[i] = true
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null
      return
    }
    if (f) { fenced[i] = true; fence = f[1]; return }
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(ln)
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i + 1 })
  })
  return { lines, heads, fenced }
}

const cells = (ln) => ln.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
const isSep = (ln) => /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(ln)

// Bảng `| mã | khi | … |` trong lines[from,to) → { hasTable, states:[{code,when,line}] }. Bảng khác (cột đầu không phải "mã", cột hai không phải "khi") bị bỏ qua.
function stateTables(lines, fenced, from, to) {
  const res = { hasTable: false, states: [] }
  for (let i = from; i < to; i++) {
    if (fenced[i] || !lines[i].trim().startsWith('|')) continue
    let j = i
    while (j < to && !fenced[j] && lines[j].trim().startsWith('|')) j++
    const head = cells(lines[i])
    if (j - i >= 2 && isSep(lines[i + 1]) && fold(plain(head[0])) === 'ma' && fold(plain(head[1] ?? '')) === 'khi') {
      res.hasTable = true
      for (let k = i + 2; k < j; k++) {
        const c = cells(lines[k])
        if (c.every((x) => x === '')) continue
        res.states.push({ code: plain(c[0] ?? ''), when: plain(c[1] ?? ''), line: k + 1 })
      }
    }
    i = j - 1
  }
  return res
}

function parseScreens(lines, heads, fenced, { from, to }) {
  const inside = heads.filter((h) => h.line - 1 >= from && h.line - 1 < to)
  const screens = []
  inside.forEach((h, k) => {
    if (h.level !== 4) return
    const next = inside.slice(k + 1).find((x) => x.level <= 4)
    const end = next ? next.line - 1 : to
    // Cả dòng phải đúng câu "Không tải dữ liệu" (có thể kèm lý do sau gạch/hai chấm) — câu dài hơn ("…cũ khi lọc") không được miễn.
    const loadsData = !lines.slice(h.line, end).some((ln, i) => !fenced[h.line + i] && /^[\s>*_`+-]*khong tai du lieu[*_`.!\s]*(?:[—–:-].*)?$/.test(fold(ln)))
    screens.push({ name: plain(h.title), line: h.line, loadsData, ...stateTables(lines, fenced, h.line, end) })
  })
  return screens
}

const P_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*[*_`]*(P-\d+)[*_`\s]*[:：][*_`]*\s*(\S.*?)\s*$/
const P_NONE = /^[\s>*_`+-]*khong ap dung[*_`\s]*[—–:-]+[*_`\s]*\S/

function parseRights(lines, fenced, { from, to }) {
  const res = { pCodes: [], pNotApplicable: false }
  for (let i = from; i < to; i++) {
    if (fenced[i]) continue
    const m = P_LINE.exec(lines[i])
    if (m) res.pCodes.push({ code: m[1], line: i + 1, text: m[2] })
    else if (P_NONE.test(fold(lines[i]))) res.pNotApplicable = true
  }
  return res
}

export function parseSpec(text) {
  const { lines, heads, fenced } = scan(text)
  const res = { hasApproval: false, sections: {}, missing: [], screens: [], sCodes: [], pCodes: [], pNotApplicable: false, dupes: [] }
  const bi = heads.findIndex((h) => h.level === 2 && /^(phan )?ban duyet\b/.test(headKey(h.title)))
  if (bi < 0) { res.missing = [...SECTIONS]; return res }
  res.hasApproval = true
  // chỉ số dòng (0-based, loại trừ) nơi tiêu đề kế tiếp có cấp ≤ maxLevel bắt đầu
  const endOf = (i, maxLevel) => { const n = heads.slice(i + 1).find((h) => h.level <= maxLevel); return n ? n.line - 1 : lines.length }
  const blockEnd = endOf(bi, 2)
  const bodies = {}
  heads.forEach((h, i) => {
    const name = i > bi && h.line - 1 < blockEnd && h.level === 3 ? SECTION_BY_KEY.get(headKey(h.title)) : undefined
    if (name && !bodies[name]) bodies[name] = { from: h.line, to: endOf(i, 3) }
  })
  for (const name of SECTIONS) {
    const b = bodies[name]
    const body = b ? lines.slice(b.from, b.to).join('\n').trim() : null
    if (body !== null) res.sections[name] = body
    if (!body || body.replace(/<!--[\s\S]*?-->/g, '').trim() === '') res.missing.push(name)
  }
  if (bodies[SCREENS]) res.screens = parseScreens(lines, heads, fenced, bodies[SCREENS])
  if (bodies[DATA]) Object.assign(res, parseRights(lines, fenced, bodies[DATA]))
  for (const sc of res.screens) for (const st of sc.states) if (S_RE.test(st.code)) res.sCodes.push({ code: st.code, screen: sc.name, line: st.line })
  const count = new Map()
  for (const { code } of [...res.sCodes, ...res.pCodes]) count.set(code, (count.get(code) ?? 0) + 1)
  res.dupes = [...count].filter(([, n]) => n > 1).map(([code]) => code)
  return res
}

// --- vấn đề của SPEC ----------------------------------------------------------------------------------------------------------------

// "trống"/"lỗi" chỉ khác "trong"/"lời" ở dấu: ô có dấu ⇒ đúng chữ có dấu; ô không dấu hoàn toàn ⇒ nhận dạng không dấu.
function hasWord(cell, word) {
  const c = String(cell).toLowerCase()
  const w = fold(c) === c ? fold(word) : word
  return new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u').test(c)
}
const STATES = [
  { label: 'có dữ liệu', is: (c) => /\bco du lieu\b/.test(fold(c).replace(/\b(chua|khong) co du lieu\b/g, ' ')) },
  { label: 'trống', is: (c) => hasWord(c, 'trống') || hasWord(c, 'rỗng') || /\b(chua|khong) co (du lieu|muc|ket qua|dong|gi)\b/.test(fold(c)) },
  { label: 'đang tải', is: (c) => /\bdang tai\b/.test(fold(c)) },
  { label: 'lỗi', is: (c) => hasWord(c, 'lỗi') },
]

function screenProblems(sc) {
  const at = `Màn "${sc.name}" (dòng ${sc.line})`
  if (!sc.hasTable) {
    return [{ msg: `${at} chưa có bảng trạng thái.`, fix: `Thêm bảng "${TABLE_HEAD}" dưới tiêu đề màn, mỗi trạng thái một dòng, mã dạng S-01; màn không tải dữ liệu thì ghi thêm dòng "Không tải dữ liệu" dưới tiêu đề.` }]
  }
  const out = sc.states.filter((s) => !S_RE.test(s.code)).map((s) => ({
    msg: `${at}: dòng ${s.line} có mã "${s.code || '(trống)'}" không đúng dạng S-nn.`,
    fix: 'Sửa cột "mã" thành S-01, S-02… (chữ S hoa, gạch ngang, số).',
  }))
  if (!sc.loadsData) {
    if (!sc.states.length) out.push({ msg: `${at} có bảng nhưng chưa có dòng trạng thái nào.`, fix: 'Thêm ít nhất một dòng: mã S-nn, khi nào, thấy gì, làm được gì.' })
    return out
  }
  const lacking = STATES.filter((st) => !sc.states.some((s) => st.is(s.when))).map((st) => st.label)
  if (lacking.length) {
    out.push({
      msg: `${at} thiếu trạng thái: ${lacking.join(', ')}.`,
      fix: `Thêm mỗi trạng thái thiếu một dòng với mã S-nn mới, cột "khi" ghi đúng chữ: ${STATES.map((st) => st.label).join(' · ')}. Màn không tải dữ liệu thì ghi dòng "Không tải dữ liệu" dưới tiêu đề màn.`,
    })
  }
  return out
}

export function specProblems(text) {
  const s = parseSpec(text)
  if (!s.hasApproval) {
    return [{ msg: 'SPEC chưa có phần Bạn duyệt', fix: `Thêm "## Bạn duyệt" ở đầu SPEC với 6 mục "###": ${SECTIONS.join(' · ')}; phần kỹ thuật để dưới "## Kỹ thuật" (mẫu: skill flow-spec).` }]
  }
  const out = []
  for (const name of s.missing) {
    const empty = name in s.sections
    out.push({ msg: empty ? `Mục "${name}" trong phần Bạn duyệt đang để trống.` : `Phần Bạn duyệt thiếu mục "${name}".`, fix: `${empty ? 'Điền nội dung' : `Thêm "### ${name}" rồi viết`}: ${HINT[name]}.` })
  }
  for (const sc of s.screens) out.push(...screenProblems(sc))
  if (!s.missing.includes(DATA) && !s.pCodes.length && !s.pNotApplicable) {
    out.push({ msg: `Mục "${DATA}" chưa có dòng P-nn nào, cũng chưa ghi "Không áp dụng — <lý do>".`, fix: `Ghi ${HINT[DATA]}.` })
  }
  for (const code of s.dupes) {
    const lines = [...s.sCodes, ...s.pCodes].filter((c) => c.code === code).map((c) => c.line)
    out.push({ msg: `Mã ${code} bị dùng ${lines.length} lần (dòng ${lines.join(', ')}).`, fix: 'Mỗi mã chỉ dùng một lần trong SPEC — đổi các lần sau sang số chưa dùng.' })
  }
  return out
}

// --- SPEC đang mở -------------------------------------------------------------------------------------------------------------------

export function openSpecs(dir) {
  const base = path.join(path.resolve(dir), 'docs', 'specs')
  const out = []
  for (const e of readDir(base).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const spec = path.join(base, e.name, 'SPEC.md')
    if (!isFile(spec)) continue
    const prog = readText(path.join(base, e.name, 'progress.md'), 1024 * 1024)
    if (prog !== null && DONE_RE.test(prog.normalize('NFC'))) continue
    out.push(spec)
  }
  return out
}

// --- đối chiếu mã SPEC ↔ app ↔ test ----------------------------------------------------------------------------------------------

const isTestFile = (rel) => /\.(test|spec)\.[^/]+$/i.test(rel) || rel.split('/').slice(0, -1).some((s) => TEST_DIRS.has(s))

function walk(root) {
  const out = []
  const visit = (rel) => {
    for (const e of readDir(path.join(root, ...rel))) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit([...rel, e.name]) } else if (e.isFile()) out.push([...rel, e.name].join('/'))
    }
  }
  visit([])
  return out
}

function listFiles(dir) {
  const r = spawnSync('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  return !r.error && r.status === 0 ? [...new Set(r.stdout.split('\0').filter(Boolean))] : walk(dir)
}

// → { app:Set<mã>, test:Set<mã> } các mã S-nn/P-nn xuất hiện trong file mã nguồn app / file test.
function codesInFiles(dir) {
  const found = { app: new Set(), test: new Set() }
  for (const rel of listFiles(dir)) {
    const segs = rel.split('/')
    if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s)) || !SRC_EXT.has(path.extname(rel).toLowerCase())) continue
    const text = readText(path.join(dir, ...segs))
    if (text === null) continue
    const into = found[isTestFile(rel) ? 'test' : 'app']
    for (const m of text.matchAll(CODE_RE)) into.add(m[1])
  }
  return found
}

// --- mã duy nhất TOÀN DỰ ÁN ---------------------------------------------------------------------------------------------------------

const pathKey = (p) => {
  let r
  try { r = fs.realpathSync.native(p) } catch { r = path.resolve(p) }
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}
const pad2 = (n) => String(n).padStart(2, '0')

function loadSpecs(root, specPaths) {
  return specPaths.map((p) => {
    const abs = path.resolve(root, p)
    const text = readText(abs)
    if (text === null) throw new Error(`không đọc được SPEC: ${showPath(root, abs)}`)
    return { abs, file: showPath(root, abs), spec: parseSpec(text) }
  })
}

// Mã S-nn / P-nn của SPEC đang kiểm mà SPEC KHÁC trong dự án (mọi docs/specs/*/SPEC.md kể cả tính năng đã xong, và các SPEC đang kiểm dù nằm ngoài docs/specs) đã dùng.
// Không duy nhất thì SPEC mới đánh số lại từ S-01 sẽ "đạt giả" nhờ mã app/test của tính năng cũ. Cùng một mã lặp trong CÙNG một SPEC không tính (specProblems lo chuyện đó).
// Mỗi vấn đề kèm gợi ý mã kế tiếp sau mã lớn nhất đã dùng (mỗi mã trùng một số khác nhau).
function dupeProblems(root, checked) {
  const all = new Map() // khoá đường dẫn → { file, codes: Map<mã, dòng đầu> }
  const add = (abs, file, spec) => {
    const codes = new Map()
    for (const c of [...spec.sCodes, ...spec.pCodes]) if (!codes.has(c.code)) codes.set(c.code, c.line)
    all.set(pathKey(abs), { file, codes })
  }
  const base = path.join(root, 'docs', 'specs')
  for (const e of readDir(base).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(base, e.name, 'SPEC.md')
    const text = isFile(abs) ? readText(abs) : null
    if (text !== null) add(abs, showPath(root, abs), parseSpec(text))
  }
  for (const c of checked) add(c.abs, c.file, c.spec)
  const top = { S: 0, P: 0 }
  for (const { codes } of all.values()) for (const code of codes.keys()) top[code[0]] = Math.max(top[code[0]], Number(code.slice(2)))
  const problems = []
  const done = new Set()
  for (const c of checked) {
    const key = pathKey(c.abs)
    if (done.has(key)) continue
    done.add(key)
    for (const [code, line] of all.get(key).codes) {
      const others = [...all].filter(([k, o]) => k !== key && o.codes.has(code)).map(([, o]) => o)
      if (!others.length) continue
      const where = `${others[0].file} (dòng ${others[0].codes.get(code)})${others.length > 1 ? ` và ${others.length - 1} SPEC nữa` : ''}`
      top[code[0]] += 1
      problems.push({
        code, kind: 'duplicate-code', file: c.file, line,
        msg: `${code} (${c.file}:${line}) đã dùng ở ${where} — mã S-nn / P-nn phải khác nhau trong cả dự án (kể cả tính năng đã xong), không thì máy tưởng tính năng này đã có app và test nhờ tính năng cũ.`,
        fix: `Đổi sang mã chưa dùng, vd ${code[0]}-${pad2(top[code[0]])} (đổi cả trong app và test cho khớp).`,
      })
    }
  }
  return problems
}

// SPEC trong specPaths có dùng mã đã dùng ở SPEC khác của dự án không → [{ code, kind:'duplicate-code', file, line, msg, fix }]. Ném lỗi nếu không đọc được SPEC.
export function dupeCodes(dir, specPaths = []) {
  const root = path.resolve(dir)
  return dupeProblems(root, loadSpecs(root, specPaths))
}

export function traceCodes(dir, specPaths = []) {
  const root = path.resolve(dir)
  const specs = loadSpecs(root, specPaths)
  const counts = { s: 0, p: 0 }
  const wanted = specs.map(({ file, spec }) => {
    const s = [...new Map(spec.sCodes.map((c) => [c.code, c])).values()]
    const p = [...new Map(spec.pCodes.map((c) => [c.code, c])).values()]
    counts.s += s.length
    counts.p += p.length
    return { file, s, p }
  })
  const problems = []
  if (counts.s || counts.p) {
    problems.push(...dupeProblems(root, specs))
    const found = codesInFiles(root)
    const add = (file, c, kind, msg, fix) => problems.push({ code: c.code, kind, file, line: c.line, msg: `${c.code} (${file}:${c.line}) ${msg}`, fix })
    for (const { file, s, p } of wanted) {
      for (const c of s) {
        if (!found.app.has(c.code)) add(file, c, 'missing-in-app', 'chưa thấy trong mã app.', `Gắn data-s="${c.code}" vào phần tử gốc của trạng thái đó trong app (hoặc bỏ dòng ${c.code} khỏi bảng của SPEC nếu không còn trạng thái này).`)
        if (!found.test.has(c.code)) add(file, c, 'missing-test', 'chưa có test nào nhắc.', `Thêm bước kiểm trạng thái này vào test e2e và ghi mã "${c.code}" trong tên test hoặc selector [data-s="${c.code}"].`)
      }
      for (const c of p) {
        if (!found.test.has(c.code)) add(file, c, 'missing-test', 'chưa có test nào nhắc.', `Viết test chặn quyền cho ${c.code} (hai người dùng/phiên/trình duyệt thật) và ghi mã "${c.code}" trong tên test.`)
      }
    }
  }
  return { ok: problems.length === 0, problems, counts }
}

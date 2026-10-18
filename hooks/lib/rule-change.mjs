// rule-change: cổng gộp (flow-gate.mjs mergeGuards) phân biệt SIẾT với NỚI khi nhánh đổi file luật. Chỉ cho qua khi CHẮC là siết; không chắc ⇒ tính là nới (fail closed).
// Đây là chỗ AI có thể lách luật nên KHÔNG chạy code nào của nhánh: chỉ đọc chữ (git show) rồi so.
//   looseRuleChanges({ changes, read, list, log? }) → Map(file → lý do)   chỉ chứa file bị tính là nới; lý do '' = loại file chưa chấm được (chặn như trước).
//     changes: [{ st: 'A'|'M'|'D'|'T', file }] đã lọc là file luật · read(side, rel) → chữ | null (side 'base' = điểm tách nhánh, 'head' = đầu nhánh)
//     · list(side, roots) → [đường dẫn file nằm trong roots] | null.
//   eslintLoosening(before, after) → { line, why } | null   (null = chắc là siết hoặc không đổi luật)
// Từng loại file:
//   docs/arch.json  archLoosening của lib/arch.mjs (thêm module/luật cấm, hạ trần ⇒ qua; bỏ/nới ⇒ chặn). Xoá ⇒ chặn.
//   File kit sinh từ arch.json (.dependency-cruiser.mjs, bản cũ .dependency-cruiser.cjs, .go-arch-lint*.yml, .golangci.yml — dòng đầu có dấu "Sinh bởi"): sinh lại từ
//     arch.json của nhánh trong thư mục tạm dựng lại đúng phần cây gen đọc (arch.json, tsconfig.json, go.mod, thư mục Go) rồi so từng chữ. Khớp ⇒ không tính (đánh giá
//     nằm ở arch.json); lệch / không có dấu ⇒ nới. Xoá file kit sinh ⇒ chỉ qua khi kit không còn sinh tên đó và (depcruise) .dependency-cruiser.mjs của nhánh khớp.
//   eslint.config.* (sửa)  eslintLoosening. Còn lại (mốc vi phạm cũ, biome, .eslintrc, golangci viết tay, flow.json, kit/rules…) ⇒ nới như trước.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARCH_FILE, DEPCRUISE_FILE, GEN_MARK, archLoosening, genFiles, parseArch } from './arch.mjs'

const GENERATED = /^(?:\.dependency-cruiser\.[cm]js|\.go-arch-lint(?:\.[a-z0-9-]+)?\.yml|\.golangci\.yml)$/
// File kit sinh → file viết tay mà nó che khi cùng có mặt (kit chạy depcruise với .mjs trước .cjs; golangci-lint đọc .yml trước .yaml/.toml/.json)
const SHADOWS = { [DEPCRUISE_FILE]: ['.dependency-cruiser.cjs'], '.golangci.yml': ['.golangci.yaml', '.golangci.toml', '.golangci.json'] }
const ESLINT_FLAT = /(^|\/)eslint\.config\.[cm]?[jt]s$/
const oneLine = (s, max = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const lf = (t) => String(t).replace(/^﻿/, '').replace(/\r\n/g, '\n')
const kitMade = (t) => t !== null && lf(t).split('\n', 1)[0].includes(GEN_MARK)

export function looseRuleChanges({ changes, read, list, log = () => {} }) {
  const out = new Map()
  let regen = null
  const expected = () => (regen ??= regenerate(read, list, log))
  for (const { st, file } of changes) {
    const why = verdict(st, file, read, expected)
    if (why !== null) out.set(file, why)
  }
  return out
}

function verdict(st, file, read, expected) {
  if (file === ARCH_FILE) {
    if (st !== 'A' && st !== 'M') return ''
    const before = st === 'A' ? null : read('base', file)
    if (st === 'M' && before === null) return 'không đọc được bản cũ để so'
    const list = archLoosening(before, read('head', file))
    return list.length ? list.join('; ') : null
  }
  if (GENERATED.test(file)) return generatedVerdict(st, file, read, expected)
  if (ESLINT_FLAT.test(file) && st === 'M') {
    const before = read('base', file)
    const after = read('head', file)
    if (before === null || after === null) return 'không đọc được file để so'
    const r = eslintLoosening(before, after)
    return r && `dòng ${r.line}: ${r.why}`
  }
  return ''
}

function generatedVerdict(st, file, read, expected) {
  if (st === 'D') {
    if (!kitMade(read('base', file))) return ''
    const g = expected()
    if (g.error) return g.error
    if (g.files.has(file)) return 'kit vẫn sinh file này từ docs/arch.json nên không được xoá'
    if (file.startsWith('.dependency-cruiser.') && g.files.has(DEPCRUISE_FILE) && lf(read('head', DEPCRUISE_FILE) ?? '') !== g.files.get(DEPCRUISE_FILE)) {
      return `xoá bản cũ mà chưa có ${DEPCRUISE_FILE} sinh từ docs/arch.json thay thế`
    }
    return null
  }
  if (st !== 'A' && st !== 'M') return ''
  const text = read('head', file)
  if (!kitMade(text)) return ''
  if (st === 'M' && !kitMade(read('base', file))) return 'bản cũ viết tay (không có dòng "Sinh bởi"): thay bằng bản kit sinh có thể bỏ luật viết thêm trong đó'
  // File mới mà công cụ đọc trước file viết tay có sẵn ⇒ luật trong file viết tay hết hiệu lực (sửa file đã có thì chuyện che đã có từ trước).
  const hidden = st === 'A' && (SHADOWS[file] ?? []).find((n) => { const t = read('base', n); return t !== null && !kitMade(t) })
  if (hidden) return `che mất ${hidden} viết tay (công cụ sẽ đọc file mới thay cho nó, luật viết thêm trong đó hết hiệu lực)`
  const g = expected()
  if (g.error) return g.error
  const want = g.files.get(file) ?? g.legacy.get(file)
  if (want === undefined) return 'kit không sinh file này từ docs/arch.json của nhánh'
  return lf(text) === want ? null : 'khác bản kit sinh lại từ docs/arch.json (có chỗ bị sửa tay, hoặc chưa chạy lại arch.mjs gen)'
}

// Sinh lại các file kit sinh từ arch.json của nhánh: { files: Map, legacy: Map } | { error }. Dựng thư mục tạm chỉ gồm thứ genFiles đọc.
function regenerate(read, list, log) {
  const text = read('head', ARCH_FILE)
  if (text === null) return { error: `nhánh không có ${ARCH_FILE} để đối chiếu` }
  const { arch } = parseArch(text)
  if (!arch) return { error: `${ARCH_FILE} của nhánh không dùng được nên không đối chiếu được` }
  let dir = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-gate-gen-'))
    // Đường dẫn đọc từ cây của nhánh là dữ liệu không tin cậy: tên có "\" hay ":" (Windows hiểu là ngăn thư mục/ổ đĩa), "..", "." ⇒ không ghi, chặn.
    const put = (rel, body) => {
      const f = path.resolve(dir, ...rel.split('/'))
      if (/[\\:]/.test(rel) || rel.split('/').some((s) => s === '' || s === '.' || s === '..') || !f.startsWith(dir + path.sep)) throw new Error(`đường dẫn lạ trong cây của nhánh: ${oneLine(rel, 80)}`)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, body)
    }
    put(ARCH_FILE, text)
    for (const part of arch.parts.filter((p) => p.stack !== 'go')) {
      for (let d = part.root; ; d = path.posix.dirname(d)) {
        const rel = d === '.' ? 'tsconfig.json' : `${d}/tsconfig.json`
        const ts = read('head', rel)
        if (ts !== null) put(rel, ts)
        if (d === '.') break
      }
    }
    const goRoots = arch.parts.filter((p) => p.stack === 'go').map((p) => p.root)
    if (goRoots.length) {
      const mod = read('head', 'go.mod')
      if (mod !== null) put('go.mod', mod)
      const files = list('head', goRoots)
      if (files === null) return { error: 'không liệt kê được thư mục Go của nhánh nên không đối chiếu được' }
      // gen chỉ cần biết thư mục nào có file .go (không tính _test.go): mỗi thư mục một file rỗng
      for (const d of new Set(files.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).map((f) => path.posix.dirname(f)))) put(`${d}/x.go`, '')
    }
    const r = genFiles(dir)
    return { files: new Map(r.files.map((f) => [f.rel, f.text])), legacy: new Map(r.legacy.map((f) => [f.rel, f.text])) }
  } catch (e) {
    return { error: `không sinh lại được từ ${ARCH_FILE} (${oneLine(e?.message ?? e)})` }
  } finally {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch (e) { log(`rule-change: không xoá được thư mục tạm ${dir}: ${e?.message ?? e}`) } // kết quả đã có, chỉ sót rác tạm
  }
}

// --- eslint.config.*: chỉ cho qua khi chắc là siết ----------------------------------------------------------------------------------------
// Tách token (bỏ chú thích, khoảng trắng), so từng "dòng token" giữa hai bản (dòng khớp bỏ qua dấu phẩy cuối dòng). Mỗi khúc THÊM phải là: import gói (không phải file
// của dự án), khối cấu hình mới chỉ gồm name/files/ignores/plugins/rules mức "error" không tuỳ chọn (khối chỉ có ignores là bỏ qua file ⇒ không nhận), luật mức "error"
// thêm vào khối rules có sẵn mà khối đó chưa có luật cùng tên (trùng tên trong một khối là ghi đè cả tuỳ chọn cũ) và không có "..."/tên tính bằng code, plugin chưa có
// thêm vào khối plugins có sẵn. Mỗi khúc BỎ phải là: import gói mà tên không còn dùng ở bản mới, khối chỉ nới (tắt luật, ignores, languageOptions chỉ sourceType/globals,
// files chỉ .js/.cjs/.mjs), globalIgnores, luật đang tắt trong rules; ignores/globalIgnores có mẫu "!" thì không gỡ được.
// Mức "error" không kèm tuỳ chọn không bao giờ nới: ESLint giữ tuỳ chọn của khối trước khi khối sau chỉ ghi mức (rulesSchema.merge của eslint).
// Dòng biên giống nhau ("}," "{") làm khúc lệch vài dòng ⇒ thử dời khúc lên/xuống như git. Không đọc chắc được (regex, chuỗi `${}`, file quá dài) ⇒ nới.
const MAX_LINES = 2000
const CLOSE = new Set(['}', ']', ')'])
const STRICT = ['error', '2']
const OFF = ['off', '0']
const BARE = /^(?:(?:@[\w.-]+\/)?[\w-][\w.-]*(?:\/[\w.-]+)*|node:[\w/]+)$/
const STRICT_KEYS = 'chỉ nhận name, files, ignores, plugins, rules mức "error"'
const NEGATED = 'có mẫu "!" (đưa file trở lại vòng kiểm) — gỡ đi có thể làm ESLint thôi kiểm các file đó'

function tokenize(src) {
  const toks = []
  const WORD = /[A-Za-z_$][\w$]*|\d[\w.]*/y
  let line = 1
  const lines = (s) => s.split('\n').length - 1
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) return null; line += lines(src.slice(i, e)); i = e + 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\') j++
        else if (c === '`' ? src.startsWith('${', j) : src[j] === '\n') return null
      }
      if (j >= src.length) return null
      const t = src.slice(i, j + 1)
      toks.push({ k: 'str', t, v: t.slice(1, -1), line })
      line += lines(t)
      i = j + 1
      continue
    }
    WORD.lastIndex = i
    const m = WORD.exec(src)
    if (m) { toks.push({ k: /^\d/.test(m[0]) ? 'num' : 'id', t: m[0], line }); i += m[0].length; continue }
    if (src.startsWith('...', i)) { toks.push({ k: 'p', t: '...', line }); i += 3; continue }
    if (c === '/') return null // regex hoặc phép chia: không đọc chắc được
    toks.push({ k: 'p', t: c, line })
    i++
  }
  return toks
}

// Gom token theo dòng nguồn: [{ line, first (chỉ số token đầu), toks, key (để so; bỏ dấu phẩy cuối) }]
function tokenLines(toks) {
  const out = []
  toks.forEach((t, k) => {
    const last = out[out.length - 1]
    if (last && last.line === t.line) last.toks.push(t)
    else out.push({ line: t.line, first: k, toks: [t] })
  })
  for (const l of out) {
    const ts = l.toks.map((t) => t.t)
    if (ts[ts.length - 1] === ',') ts.pop()
    l.key = ts.join('\u0001')
  }
  return out
}

// Dãy con chung dài nhất của hai dãy khoá dòng: mo[i] = dòng mới khớp dòng cũ i (-1 = bị bỏ), mn[j] = dòng cũ khớp dòng mới j (-1 = thêm).
function align(a, b) {
  const W = b.length + 1
  const L = new Uint16Array((a.length + 1) * W)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
  const mo = new Array(a.length).fill(-1)
  const mn = new Array(b.length).fill(-1)
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { mo[i] = j; mn[j] = i; i++; j++ } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++
    else j++
  }
  return { mo, mn }
}

const runsOf = (match) => {
  const out = []
  for (let i = 0; i < match.length; i++) if (match[i] === -1 && (i === 0 || match[i - 1] !== -1)) { let d = i; while (d < match.length && match[d] === -1) d++; out.push([i, d]) }
  return out
}

// Hộp chứa của từng token: { open, key, keys, opaque } — key: tên thuộc tính đứng trước `{`/`[` (vd rules) hoặc tên hàm trước `(`; keys: tên thuộc tính trực tiếp
// trong hộp (kể cả viết tắt `{ react }`); opaque: hộp có "..." hoặc tên tính bằng code (`[x]:`) nên không biết hết tên bên trong.
const propName = (t) => (t?.k === 'str' ? t.v : t?.k === 'id' ? t.t : null)
function containers(toks) {
  const stack = [{ open: null, key: null, keys: [], opaque: false }]
  const at = []
  toks.forEach((t, k) => {
    const top = stack[stack.length - 1]
    at.push(top)
    if (t.k !== 'p') {
      if (top.open === '{' && t.k === 'id' && ['{', ','].includes(toks[k - 1]?.t) && [',', '}'].includes(toks[k + 1]?.t)) top.keys.push(t.t)
    } else if (t.t === '{' || t.t === '[' || t.t === '(') {
      const key = t.t === '(' ? (toks[k - 1]?.k === 'id' ? toks[k - 1].t : null) : toks[k - 1]?.t === ':' ? propName(toks[k - 2]) : null
      stack.push({ open: t.t, key, keys: [], opaque: false })
    } else if (CLOSE.has(t.t)) { if (stack.length > 1) stack.pop() } else if (t.t === '...') top.opaque = true
    else if (t.t === ':') { if (propName(toks[k - 1]) !== null) top.keys.push(propName(toks[k - 1])); else top.opaque = true }
  })
  return at
}

// --- đọc một khúc token theo ngữ pháp hẹp: mỗi hàm trả lý do (chữ) khi không đọc được, null khi đọc xong -----------------------------------
const at = (c, o = 0) => c.toks[c.p + o]
const eat = (c, t) => (at(c)?.t === t && at(c).k !== 'str' ? (c.p++, true) : false)
const str = (c) => (at(c)?.k === 'str' ? c.toks[c.p++].v : null)
const ident = (c) => (at(c)?.k === 'id' ? c.toks[c.p++].t : null)
function prop(c) {
  const name = propName(at(c))
  if (name === null || at(c, 1)?.t !== ':') return null
  c.p += 2
  return name
}

function strList(c) {
  if (!eat(c, '[')) return null
  const out = []
  while (!eat(c, ']')) {
    const s = str(c)
    if (s === null) return null
    out.push(s)
    if (!eat(c, ',') && at(c)?.t !== ']') return null
  }
  return out
}

// Giá trị bất kỳ cân ngoặc, tới dấu phẩy / ngoặc đóng ở mức ngoài cùng.
function skipValue(c) {
  const start = c.p
  let depth = 0
  for (; c.p < c.toks.length; c.p++) {
    const t = at(c)
    if (t.k === 'p' && depth === 0 && (t.t === ',' || CLOSE.has(t.t))) break
    if (t.k === 'p' && (t.t === '{' || t.t === '[' || t.t === '(')) depth++
    else if (t.k === 'p' && CLOSE.has(t.t)) depth--
  }
  return c.p > start && depth === 0
}

// Mức của luật: chữ/số trơn trong `ok`, hoặc mảng có mức đó đứng đầu (options = cho phép tuỳ chọn phía sau).
function severity(c, ok, { options = false } = {}) {
  const one = () => { const t = at(c); if (t && (t.k === 'str' || t.k === 'num') && ok.includes(t.k === 'str' ? t.v : t.t)) { c.p++; return true } return false }
  if (one()) return true
  if (!eat(c, '[') || !one()) return false
  if (options) { while (eat(c, ',')) { if (at(c)?.t === ']') break; if (!skipValue(c)) return false } } else eat(c, ',')
  return eat(c, ']')
}

// { phần tử, … } — entry(c) đọc một phần tử.
function block(c, entry) {
  if (!eat(c, '{')) return 'cú pháp lạ'
  while (!eat(c, '}')) {
    if (c.p >= c.toks.length) return 'cú pháp lạ'
    const why = entry(c)
    if (why) return why
    if (!eat(c, ',') && at(c)?.t !== '}') return 'cú pháp lạ'
  }
  return null
}

// Thuộc tính của một khối cấu hình: value(tên) đọc giá trị. Trùng tên trong một khối ⇒ không nhận (cái sau đè cái trước).
function configBlock(c, value) {
  const seen = []
  const why = block(c, (cc) => {
    const k = prop(cc)
    if (k === null) return at(cc)?.t === '...' ? 'có "..." (gộp cấu hình khác vào, không biết bên trong)' : 'cú pháp lạ'
    if (seen.includes(k)) return `"${k}" lặp hai lần trong cùng khối`
    seen.push(k)
    return value(k, cc)
  })
  return { why, seen }
}

function pluginEntry(c) {
  const t = at(c)
  if (t?.k === 'id' && (at(c, 1)?.t === ',' || at(c, 1)?.t === '}')) { c.p++; return null }
  if (prop(c) === null || ident(c) === null) return 'plugin viết kiểu lạ'
  while (eat(c, '.')) if (ident(c) === null) return 'plugin viết kiểu lạ'
  return null
}

function rulesBlock(c, sev, bad) {
  const seen = new Set()
  return block(c, (cc) => {
    const k = prop(cc)
    if (k === null) return at(cc)?.t === '...' ? 'rules có "..." (gộp luật khác vào, không biết bên trong)' : 'cú pháp lạ trong rules'
    if (seen.has(k)) return `luật "${k}" lặp hai lần trong cùng khối`
    seen.add(k)
    return sev(cc) ? null : bad(k)
  })
}

const strictRule = (k) => `luật "${k}" không ở mức "error" hoặc kèm tuỳ chọn`

function strictObject(c) {
  const { why, seen } = configBlock(c, (k, cc) => {
    if (k === 'name') return str(cc) === null ? '"name" phải là chữ' : null
    if (k === 'files' || k === 'ignores') return strList(cc) === null ? `"${k}" phải là danh sách chữ` : null
    if (k === 'plugins') return block(cc, pluginEntry)
    if (k === 'rules') return rulesBlock(cc, (c3) => severity(c3, STRICT), strictRule)
    return `khối mới có "${k}" (${STRICT_KEYS})`
  })
  if (why) return why
  return seen.includes('ignores') && seen.every((k) => k === 'ignores' || k === 'name') ? 'khối chỉ có ignores (bỏ qua file khỏi mọi luật)' : null
}

function looseObject(c) {
  return configBlock(c, (k, cc) => {
    if (k === 'name') return str(cc) === null ? '"name" phải là chữ' : null
    if (k === 'ignores') { const globs = strList(cc); return globs === null ? '"ignores" phải là danh sách chữ' : globs.some((g) => g.startsWith('!')) ? NEGATED : null }
    if (k === 'files') {
      const files = strList(cc)
      return files && files.every((f) => /\.[cm]?js$/.test(f)) ? null : 'khối bị gỡ có files ngoài .js/.cjs/.mjs (gỡ có thể làm ESLint thôi đọc loại file đó)'
    }
    if (k === 'languageOptions') {
      return block(cc, (c3) => {
        const lk = prop(c3)
        if (lk === 'sourceType') return str(c3) === null ? 'sourceType phải là chữ' : null
        if (lk === 'globals') return skipValue(c3) ? null : 'globals viết kiểu lạ'
        return `languageOptions có "${lk ?? '?'}" (chỉ gỡ được sourceType, globals)`
      })
    }
    if (k === 'rules') return rulesBlock(cc, (c3) => severity(c3, OFF, { options: true }), (r) => `gỡ luật "${r}" đang bật`)
    return `khối bị gỡ có "${k}" (chỉ gỡ được khối chỉ nới luật)`
  }).why
}

// names: nhận tên mà import đặt trong file (tên sau "as" nếu có).
function importDecl(c, names = []) {
  c.p++ // import
  const name = () => { const n = ident(c); if (n !== null) names.push(n); return n }
  if (at(c)?.k === 'id' && at(c).t !== 'from') { name(); eat(c, ',') }
  if (eat(c, '*')) {
    if (ident(c) !== 'as' || name() === null) return 'import viết kiểu lạ'
  } else if (eat(c, '{')) {
    while (!eat(c, '}')) {
      if (at(c, 1)?.t === 'as') { if (ident(c) === null) return 'import viết kiểu lạ'; c.p++ }
      if (name() === null) return 'import viết kiểu lạ'
      if (!eat(c, ',') && at(c)?.t !== '}') return 'import viết kiểu lạ'
    }
  }
  if (!names.length) return 'import không đặt tên (chỉ để chạy code của file khác)'
  if (ident(c) !== 'from') return 'import viết kiểu lạ'
  const src = str(c)
  if (src === null) return 'import viết kiểu lạ'
  if (!BARE.test(src)) return `import "${oneLine(src, 60)}" không phải gói (file của dự án hoặc nguồn lạ có thể đổi luật)`
  eat(c, ';')
  return null
}

function addItem(c, ctx) {
  const t = at(c)
  if (t.k === 'id' && t.t === 'import') return importDecl(c)
  if (t.k === 'p' && t.t === '{') return strictObject(c)
  if (ctx.open === '{' && ctx.key === 'rules') {
    if (ctx.opaque) return 'khối rules có "..." hoặc tên luật tính bằng code nên không biết luật nào đã có (thêm luật vào một khối mới riêng)'
    const k = prop(c)
    if (k === null) return 'cú pháp lạ trong rules'
    if (!severity(c, STRICT)) return strictRule(k)
    return ctx.keys.filter((x) => x === k).length > 1 ? `luật "${k}" đã có trong cùng khối (ghi đè làm mất tuỳ chọn cũ)` : null
  }
  if (ctx.open === '{' && ctx.key === 'plugins') {
    if (ctx.opaque) return 'khối plugins có "..." nên không biết plugin nào đã có'
    const name = propName(at(c))
    return pluginEntry(c) ?? (ctx.keys.filter((x) => x === name).length > 1 ? `plugin "${name}" đã có trong cùng khối (ghi đè plugin cũ)` : null)
  }
  return `chỉ nhận import gói, khối cấu hình mới hoặc luật mức "error" (gặp "${oneLine(t.k === 'str' ? t.v : t.t, 40)}")`
}

// usedAfter: tên còn xuất hiện trong bản mới (gỡ import mà tên vẫn dùng = đổi nguồn của tên đó).
function removeItem(c, ctx, usedAfter) {
  const t = at(c)
  if (t.k === 'id' && t.t === 'import') {
    const names = []
    const why = importDecl(c, names)
    if (why) return why
    const still = names.find((n) => usedAfter.has(n))
    return still ? `gỡ import của "${still}" mà bản mới vẫn dùng tên đó (đổi nguồn có thể đổi luật)` : null
  }
  if (t.k === 'p' && t.t === '{') return looseObject(c)
  if (t.k === 'id' && t.t === 'globalIgnores' && at(c, 1)?.t === '(') {
    c.p += 2
    const globs = strList(c)
    if (globs === null || (eat(c, ',') && str(c) === null) || !eat(c, ')')) return 'globalIgnores viết kiểu lạ'
    return globs.some((g) => g.startsWith('!')) ? NEGATED : null
  }
  if (ctx.open === '{' && ctx.key === 'rules') {
    const k = prop(c)
    if (k === null) return 'cú pháp lạ trong rules'
    return severity(c, OFF, { options: true }) ? null : `gỡ luật "${k}" đang bật`
  }
  return `chỉ gỡ được import, khối chỉ nới luật, globalIgnores hoặc luật đang tắt (gặp "${oneLine(t.k === 'str' ? t.v : t.t, 40)}")`
}

// Một khúc: [","] mục ("," mục)* [","]; import nối nhau không cần dấu phẩy.
function sequence(toks, item) {
  const c = { toks, p: 0 }
  eat(c, ',')
  if (c.p >= toks.length) return 'chỉ đổi dấu phẩy'
  while (c.p < toks.length) {
    const why = item(c)
    if (why) return why
    if (c.p >= toks.length) break
    if (!eat(c, ',') && !eat(c, ';') && !(at(c).k === 'id' && at(c).t === 'import')) return 'cú pháp lạ'
  }
  return null
}

const balanced = (toks) => {
  let d = 0
  for (const t of toks) {
    if (t.k !== 'p') continue
    if (t.t === '{' || t.t === '[' || t.t === '(') d++
    else if (CLOSE.has(t.t) && --d < 0) return false
  }
  return d === 0
}

function hintOf(toks) {
  const vals = new Set(toks.filter((t) => t.k === 'str').map((t) => t.v))
  const ids = new Set(toks.filter((t) => t.k === 'id').map((t) => t.t))
  if (vals.has('off')) return 'tắt luật — '
  if (vals.has('warn')) return 'hạ luật xuống mức cảnh báo — '
  if (ids.has('ignores') || vals.has('ignores') || ids.has('globalIgnores')) return 'bỏ qua file khỏi luật — '
  return ''
}

// Dời khúc [c, d) chưa khớp lên/xuống khi dòng biên giống nhau, tới vị trí judge(c', d') đọc được; giữ vị trí đó trong bảng khớp.
// → null (đọc được) | { why, at } của vị trí cân ngoặc đầu tiên (không có thì vị trí gốc).
function settle(lines, match, other, [c, d], judge) {
  const key = (i) => lines[i].key
  const shifts = [0]
  for (let s = 1; c - s >= 0 && match[c - s] !== -1 && key(c - s) === key(d - s); s++) shifts.push(-s)
  for (let s = 1; d + s - 1 < lines.length && match[d + s - 1] !== -1 && key(c + s - 1) === key(d + s - 1); s++) shifts.push(s)
  let best = null
  for (const s of shifts) {
    const r = judge(c + s, d + s)
    if (r.why === null) {
      for (let k = s; k < 0; k++, c--, d--) { const o = match[c - 1]; match[d - 1] = o; other[o] = d - 1; match[c - 1] = -1 }
      for (let k = s; k > 0; k--, c++, d++) { const o = match[d]; match[c] = o; other[o] = c; match[d] = -1 }
      return null
    }
    if (best === null || (!best.balanced && r.balanced)) best = { why: r.why, at: c + s, balanced: r.balanced }
  }
  return best
}

export function eslintLoosening(before, after) {
  const A = tokenize(lf(before))
  const B = tokenize(lf(after))
  if (!A || !B) return { line: 1, why: 'không đọc chắc được file (có regex hoặc chuỗi `${}`) nên không biết là siết hay nới' }
  const la = tokenLines(A)
  const lb = tokenLines(B)
  if (la.length > MAX_LINES || lb.length > MAX_LINES) return { line: 1, why: 'file quá dài để so từng dòng' }
  const { mo, mn } = align(la.map((l) => l.key), lb.map((l) => l.key))
  const cut = (toks, lines, c, d) => toks.slice(lines[c].first, lines[d - 1].first + lines[d - 1].toks.length)
  const usedAfter = new Set(B.filter((t) => t.k === 'id').map((t) => t.t))
  const sides = [
    { lines: lb, match: mn, other: mo, toks: B, ctx: containers(B), item: addItem, say: (why, run) => `${hintOf(run)}thêm phần không chắc là siết luật: ${why}` },
    { lines: la, match: mo, other: mn, toks: A, ctx: containers(A), item: removeItem, say: (why) => `bỏ phần đang siết luật hoặc không chắc là nới (bản cũ): ${why}` },
  ]
  for (const s of sides) {
    for (const run of runsOf(s.match)) {
      const bad = settle(s.lines, s.match, s.other, run, (c, d) => {
        const toks = cut(s.toks, s.lines, c, d)
        const ctx = s.ctx[s.lines[c].first]
        const why = sequence(toks, (cc) => s.item(cc, ctx, usedAfter))
        return { why: why && s.say(why, toks), balanced: balanced(toks) }
      })
      if (bad) return { line: s.lines[bad.at].line, why: bad.why }
    }
  }
  // dòng khớp chỉ khác dấu phẩy cuối: thêm phẩy ⇒ ngay sau phải là khúc thêm; bỏ phẩy ⇒ ngay sau là khúc bỏ, và bản mới tiếp theo là ngoặc đóng hoặc khúc thêm.
  for (let i = 0; i < la.length; i++) {
    const j = mo[i]
    if (j < 0 || la[i].toks.length === lb[j].toks.length) continue
    const added = lb[j].toks.length > la[i].toks.length
    const ok = added
      ? j + 1 < lb.length && mn[j + 1] === -1
      : i + 1 < la.length && mo[i + 1] === -1 && (j + 1 >= lb.length || mn[j + 1] === -1 || CLOSE.has(lb[j + 1].toks[0].t))
    if (!ok) return { line: lb[j].line, why: 'đổi dấu phẩy ở dòng có sẵn mà không kèm thêm/bỏ khối nào' }
  }
  return null
}

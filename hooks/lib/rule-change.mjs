// rule-change: cổng gộp (flow-gate.mjs mergeGuards) phân biệt SIẾT với NỚI khi nhánh đổi file luật. Chỉ cho qua khi CHẮC là siết; không chắc ⇒ tính là nới (fail closed).
// Đây là chỗ AI có thể lách luật nên KHÔNG chạy code nào của nhánh: chỉ đọc chữ (git show) rồi so.
//   looseRuleChanges({ changes, read, list, log? }) → Map(file → lý do)   chỉ chứa file bị tính là nới; lý do '' = loại file chưa chấm được (chặn như trước).
//     changes: [{ st: 'A'|'M'|'D'|'T', file }] đã lọc là file luật · read(side, rel) → chữ | null (side 'base' = điểm tách nhánh, 'head' = đầu nhánh, 'target' = đầu nhánh đích lúc gộp)
//     · list(side, roots) → [đường dẫn file nằm trong roots] | null.
//   eslintLoosening(before, after) → { line, why } | null   (null = chắc là siết hoặc không đổi luật)
// Từng loại file:
//   docs/arch.json  archLoosening của lib/arch.mjs (thêm module/luật cấm, hạ trần ⇒ qua; bỏ/nới ⇒ chặn). Xoá ⇒ chặn.
//   File kit sinh từ arch.json (.dependency-cruiser.mjs, bản cũ .dependency-cruiser.cjs, .go-arch-lint*.yml, .golangci.yml — dòng đầu có dấu "Sinh bởi"): sinh lại từ
//     arch.json của nhánh trong thư mục tạm dựng lại đúng phần cây gen đọc (arch.json, tsconfig.json, go.mod, thư mục Go) rồi so từng chữ. Khớp ⇒ không tính (đánh giá
//     nằm ở arch.json); lệch / không có dấu ⇒ nới. Xoá file kit sinh ⇒ chỉ qua khi kit không còn sinh tên đó và (depcruise) .dependency-cruiser.mjs của nhánh khớp.
//   eslint.config.* (sửa)  eslintLoosening. .claude/ui.json (sửa)  uiLoosening (thêm màn/trạng thái ⇒ qua; thêm nút miễn chữ, bỏ màn, đổi start/url… ⇒ nới).
//   .claude/ui.json (thêm)  chưa có file thì máy kiểm giao diện không chạy (checker ui-rules detect file này) ⇒ file mới chỉ thêm kiểm tra: qua khi đúng dạng và không có nút miễn chữ.
//   File miễn trừ / mốc (thêm, sửa, xoá): docs/arch-baseline.json, .dependency-cruiser-known-violations.json, eslint-suppressions.json ⇒ so thứ được miễn THẬT SỰ (theo cách
//     flow-check đọc chúng) giữa hai bản: bản mới chỉ miễn ít hơn hoặc bằng (rỗng, bớt mục, hạ số đếm, xoá file) ⇒ qua; thêm mục miễn, khoá lạ, JSON hỏng ⇒ nới. Xem exemptionVerdict.
//   eslint.config.* (thêm)  chỉ qua khi cả điểm tách nhánh lẫn nhánh đích chưa có cấu hình ESLint nào (firstEslintConfig): dự án lần đầu có lint.
//   kit/checkers.json (sửa)  checkersLoosening: chỉ đổi chữ dặn ($comment, title, hint, docs, install, skipWhy), bật exclusive ở checker đứng trước mọi checker exclusive có sẵn, thêm plan
//     trùng id checker và có trong PLANNERS của hooks/flow-check.mjs (đọc 'head', không chạy), thêm đúng một --noEmit vào args của checker tsc ⇒ qua; đổi thứ tự, bỏ/thêm checker,
//     bỏ exclusive, đổi required, detect, cmd… ⇒ nới. Chi tiết và chỗ còn hở: xem phần kit/checkers.json bên dưới.
//   Còn lại (biome, .eslintrc, golangci viết tay, flow.json, kit/rules, docs/ui-baseline.json…) ⇒ nới như trước.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ARCH_FILE, BASELINE_FILE, DEPCRUISE_FILE, GEN_MARK, KNOWN_FILE, archLoosening, genFiles, parseArch } from './arch.mjs'
import { fold } from './ui-rules.mjs'

const GENERATED = /^(?:\.dependency-cruiser\.[cm]js|\.go-arch-lint(?:\.[a-z0-9-]+)?\.yml|\.golangci\.yml)$/
// File kit sinh → file viết tay mà nó che khi cùng có mặt (kit chạy depcruise với .mjs trước .cjs; golangci-lint đọc .yml trước .yaml/.toml/.json)
const SHADOWS = { [DEPCRUISE_FILE]: ['.dependency-cruiser.cjs'], '.golangci.yml': ['.golangci.yaml', '.golangci.toml', '.golangci.json'] }
const ESLINT_FLAT = /(^|\/)eslint\.config\.[cm]?[jt]s$/
const oneLine = (s, max = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const lf = (t) => String(t).replace(/^﻿/, '').replace(/\r\n/g, '\n')
const kitMade = (t) => t !== null && lf(t).split('\n', 1)[0].includes(GEN_MARK)

export function looseRuleChanges({ changes, read, list, eslintAbove, log = () => {} }) {
  const out = new Map()
  let regen = null
  const expected = () => (regen ??= regenerate(read, list, log))
  for (const { st, file } of changes) {
    const why = verdict(st, file, read, expected, list, eslintAbove)
    if (why !== null) out.set(file, why)
  }
  return out
}

function verdict(st, file, read, expected, list, eslintAbove) {
  if (file === ARCH_FILE) {
    if (st !== 'A' && st !== 'M') return ''
    const before = st === 'A' ? null : read('base', file)
    if (st === 'M' && before === null) return 'không đọc được bản cũ để so'
    const list = archLoosening(before, read('head', file))
    return list.length ? list.join('; ') : null
  }
  if (GENERATED.test(file)) return generatedVerdict(st, file, read, expected)
  if (file === UI_FILE) return st === 'M' ? uiLoosening(read('base', file), read('head', file)) : st === 'A' ? uiLoosening(null, read('head', file), { added: true }) : ''
  if (file === BASELINE_FILE || file === KNOWN_FILE || SUPPRESSIONS.test(file)) return ['A', 'M', 'D'].includes(st) ? exemptionVerdict(file, read) : ''
  if (file === CHECKERS_FILE) return st === 'M' ? checkersLoosening(read('base', file), read('head', file), () => read('head', PLANNERS_FILE)) : ''
  if (ESLINT_FLAT.test(file) && st === 'M') {
    const before = read('base', file)
    const after = read('head', file)
    if (before === null || after === null) return 'không đọc được file để so'
    const r = eslintLoosening(before, after)
    return r && `dòng ${r.line}: ${r.why}`
  }
  if (ESLINT_FLAT.test(file) && st === 'A') return firstEslintConfig(file, read, list, eslintAbove)
  return ''
}

// Dự án lần đầu có lint: cả điểm tách nhánh lẫn đầu nhánh đích lúc gộp ('target' — main có thể đã thêm luật sau khi tách) đều không có cấu hình
// ESLint nào (file luật, khoá eslintConfig trong package.json) thì không có luật nào đang chạy (flow-check chỉ chạy ESLint khi dự án có cấu
// hình, kit không có cấu hình mặc định) ⇒ file mới chỉ thêm kiểm tra. Đã có cấu hình ở bất kỳ đâu (file mới có thể che file cũ) / không liệt
// kê, đọc hay parse được ⇒ nới như trước. package.json phải parse JSON: khoá viết bằng escape ("eslintConfig") vẫn là eslintConfig.
// ESLint còn tìm ngược ra ngoài repo tới gốc ổ đĩa ⇒ eslintAbove (eslintConfigAbove của gốc repo) phải đúng là false (review Grok).
// File mới vẫn phải kiểm thật (review Grok): bỏ qua mọi file, hay không import gói luật nào lẫn không có khối rules ⇒ bước eslint đang đỏ
// vì thiếu cấu hình thành xanh mà không kiểm gì ⇒ nới. Chạy file của nhánh để biết chắc thì không được (đầu file), nên chỉ chặn hai dạng rỗng này.
const ESLINT_ANY = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[^/]+)?|eslint-suppressions\.json)$/
const IGNORE_ALL = /(?:\bignores\s*:|\bglobalIgnores\s*\()\s*\[[^\]]*?['"`](?:\.\/)?\*\*(?:\/\*(?:\.\*)?)?['"`]/
function firstEslintConfig(file, read, list, eslintAbove) {
  if (eslintAbove !== false) return 'thư mục cha ngoài repo có cấu hình ESLint (hoặc không kiểm được), file mới có thể che nó'
  for (const side of ['base', 'target']) {
    const files = list(side, [])
    if (files === null) return ''
    if (files.some((f) => ESLINT_ANY.test(f))) return ''
    for (const f of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
      let pkg
      try { pkg = JSON.parse(read(side, f)) } catch { return '' }
      if (pkg === null || typeof pkg !== 'object' || Object.hasOwn(pkg, 'eslintConfig')) return ''
    }
  }
  const text = read('head', file)
  if (text === null) return 'không đọc được file để chấm'
  if (IGNORE_ALL.test(text)) return 'file luật đầu tiên bỏ qua mọi file'
  if (!/^\s*import\s/m.test(text) && !/\brules\s*:/.test(text)) return 'file luật đầu tiên không bật luật nào (không import gói luật, không có rules)'
  return null
}

// Thư mục cha của gốc repo (ra tới gốc ổ đĩa) có cấu hình ESLint không. Đọc đĩa máy này, không đọc nhánh. Không đọc được ⇒ true (chặn).
export function eslintConfigAbove(toplevel) {
  for (let d = path.dirname(path.resolve(toplevel)); ; d = path.dirname(d)) {
    let names
    try { names = fs.readdirSync(d) } catch { return true }
    if (names.some((n) => ESLINT_ANY.test(n))) return true
    if (names.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))
        if (pkg === null || typeof pkg !== 'object' || Object.hasOwn(pkg, 'eslintConfig')) return true
      } catch { return true }
    }
    if (path.dirname(d) === d) return false
  }
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

// --- .claude/ui.json (máy kiểm giao diện, ui-check.mjs): sửa chỉ qua khi màn/trạng thái cũ còn đủ, nút miễn chữ không thêm, mọi khoá khác giữ nguyên ---------------
// Thêm mới (added — theo loại thay đổi 'A', không suy từ bản cũ đọc ra rỗng): checker ui-rules chỉ chạy khi có file này (detect .claude/ui.json) nên trước đó không có
// kiểm tra giao diện nào để trỏ đi app khác — chấm như sửa từ {} nhưng không so start/url/khoá khác: chỉ cần đúng dạng và không có nút miễn chữ.
// Sửa mà không đọc được bản cũ ⇒ nới. Xoá ⇒ chấm như cũ ('', tắt hẳn máy kiểm).
const UI_FILE = '.claude/ui.json'
function uiLoosening(beforeText, afterText, { added = false } = {}) {
  const parse = (t) => { try { const j = JSON.parse(lf(t)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null } catch { return null } }
  const before = added ? {} : beforeText === null ? null : parse(beforeText)
  const after = afterText === null ? null : parse(afterText)
  if (!before || !after) return `không đọc được ${UI_FILE} (JSON hỏng) nên không so được`
  // Bản mới phải đúng dạng mà ui-check.mjs loadConfig nhận; sai ⇒ máy kiểm thoát mã 2, không kiểm màn nào.
  const isStr = (v) => typeof v === 'string' && v.trim() !== ''
  const badState = (s) => !s || typeof s !== 'object' || !isStr(s.route) || !s.route.startsWith('/') || !isStr(s.s) || (s.setup !== undefined && (!isStr(s.setup) || !/^[?#]/.test(s.setup)))
  if ((after.routes !== undefined && (!Array.isArray(after.routes) || after.routes.some((r) => !isStr(r) || !r.startsWith('/'))))
    || (after.states !== undefined && (!Array.isArray(after.states) || after.states.some(badState)))
    || (after.whitelistIcons !== undefined && (!Array.isArray(after.whitelistIcons) || after.whitelistIcons.some((w) => typeof w !== 'string')))) {
    return `${UI_FILE} mới sai dạng (routes/states/whitelistIcons) nên máy kiểm giao diện sẽ không chạy`
  }
  const list = (v) => (Array.isArray(v) ? v : [])
  const out = []
  const routes = new Set(list(after.routes))
  for (const r of list(before.routes)) if (!routes.has(r)) out.push(`bỏ màn "${oneLine(r, 60)}" khỏi routes`)
  const stateKey = (s) => JSON.stringify([s?.route, s?.setup ?? '', s?.s])
  const states = new Set(list(after.states).map(stateKey))
  for (const s of list(before.states)) if (!states.has(stateKey(s))) out.push(`bỏ trạng thái ${oneLine(s?.s, 20)} (${oneLine(`${s?.route ?? ''}${s?.setup ?? ''}`, 60)}) khỏi states`)
  const white = new Set(list(before.whitelistIcons).map(fold))
  for (const w of list(after.whitelistIcons)) if (!white.has(fold(w))) out.push(`thêm nút được để hình trơn không chữ "${oneLine(w, 40)}" (whitelistIcons)`)
  for (const k of added ? [] : new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'routes' || k === 'states' || k === 'whitelistIcons') continue
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`đổi "${oneLine(k, 30)}" (máy kiểm có thể mở app khác hoặc kiểm khác đi)`)
  }
  return out.length ? out.join('; ') : null
}

// --- file miễn trừ / mốc: so thứ được miễn THẬT SỰ ở hai bản (đúng cách flow-check, depcruise, ESLint đọc chúng); bản mới miễn không hơn bản cũ ⇒ không nới ----------
// Mốc (BASELINE_FILE) — flow-check đọc: size {file: số dòng} (arch-size chỉ miễn file có số nguyên; size có mục ⇒ chỉ xét file đổi so với nhánh chính), depcruise (đường dẫn
//   file vi phạm cũ ⇒ --ignore-known), go.newFromRev (golangci --new-from-rev), go.archLint (vi phạm go-arch-lint cũ). base, eslint chỉ để ghi nhận (không ai đọc).
//   Bản mới: mỗi file trong size phải có ở bản cũ với số không nhỏ hơn; depcruise chỉ được trỏ KNOWN_FILE (file khác cổng không theo dõi); newFromRev trùng bản cũ; archLint
//   nằm trong bản cũ; khoá lạ, JSON hỏng / không phải object ⇒ nới. Không có file (xoá) ⇒ không miễn gì.
// Vi phạm depcruise cũ: chỉ có hiệu lực qua con trỏ depcruise của mốc ở cùng phía ⇒ so danh sách hiệu lực hai phía (mỗi mục mới phải trùng hẳn một mục cũ).
// eslint-suppressions.json (ESLint ≥ 9.24 tự đọc ở thư mục chạy): { file: { luật: { count } } } — mỗi cặp file+luật ở bản mới phải có ở bản cũ với count không nhỏ hơn.
const SUPPRESSIONS = /(^|\/)eslint-suppressions\.json$/
const BASELINE_KEYS = new Set(['base', 'size', 'depcruise', 'go', 'eslint'])
const HEX = /^[0-9a-f]{7,64}$/
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// → { j } (j null = không có file) | { bad: lý do }
function jsonAt(read, side, rel) {
  const t = read(side, rel)
  if (t === null) return { j: null }
  try { return { j: JSON.parse(lf(t)) } } catch { return { bad: `${rel} không phải JSON đọc được` } }
}

function exemptionVerdict(file, read) {
  const out = SUPPRESSIONS.test(file) ? [suppressionsLoosening(file, read)] : [baselineLoosening(read), knownLoosening(read)]
  const list = out.filter(Boolean)
  return list.length ? list.join('; ') : null
}

function baselineLoosening(read) {
  const head = jsonAt(read, 'head', BASELINE_FILE)
  if (head.bad) return head.bad
  const h = head.j
  if (h === null) return null
  if (!plainObject(h)) return `${BASELINE_FILE} phải là một object JSON`
  const base = jsonAt(read, 'base', BASELINE_FILE)
  const b = plainObject(base.j) ? base.j : {} // bản cũ hỏng: flow-check coi như không có mốc
  const out = []
  for (const k of Object.keys(h)) if (!BASELINE_KEYS.has(k)) out.push(`khoá lạ "${oneLine(k, 30)}" trong mốc`)
  if (h.size !== undefined && h.size !== null && !plainObject(h.size)) out.push('"size" phải là object { file: số dòng }')
  const was = plainObject(b.size) ? b.size : {}
  for (const [f, n] of Object.entries(plainObject(h.size) ? h.size : {})) {
    if (Number.isInteger(n) && !(Number.isInteger(was[f]) && n <= was[f])) out.push(`miễn trần dòng cho ${oneLine(f, 60)} (${n} dòng)`)
  }
  if (h.depcruise !== undefined && h.depcruise !== null && h.depcruise !== KNOWN_FILE) out.push(`"depcruise" trỏ tới file khác ${KNOWN_FILE} (cổng không theo dõi được file đó)`)
  if (h.go !== undefined && h.go !== null) {
    if (!plainObject(h.go)) out.push('"go" phải là object hoặc null')
    else {
      const rev = h.go.newFromRev
      if (typeof rev === 'string' && HEX.test(rev) && rev !== b.go?.newFromRev) out.push(`golangci chỉ báo lỗi mới từ commit ${rev.slice(0, 12)} (lỗi cũ hơn được bỏ qua)`)
      const old = new Set(Array.isArray(b.go?.archLint) ? b.go.archLint : [])
      if (h.go.archLint !== undefined && !Array.isArray(h.go.archLint)) out.push('"go.archLint" phải là danh sách')
      const fresh = (Array.isArray(h.go.archLint) ? h.go.archLint : []).filter((k) => !old.has(k))
      if (fresh.length) out.push(`thêm ${fresh.length} vi phạm go-arch-lint cũ được bỏ qua`)
    }
  }
  return out.length ? out.join('; ') : null
}

// Danh sách vi phạm depcruise được bỏ qua ở một phía: theo con trỏ depcruise của mốc phía đó (không có mốc / không trỏ / file không có ⇒ []). → mảng | { bad }
function knownAt(read, side) {
  const m = jsonAt(read, side, BASELINE_FILE)
  const p = plainObject(m.j) ? m.j.depcruise : null
  if (typeof p !== 'string' || !p.trim()) return []
  const k = jsonAt(read, side, p.replace(/^\.\//, ''))
  if (k.bad) return side === 'head' ? k : []
  return k.j === null ? [] : Array.isArray(k.j) ? k.j : side === 'head' ? { bad: `${p} phải là danh sách JSON` } : []
}

function knownLoosening(read) {
  const now = knownAt(read, 'head')
  if (now.bad) return now.bad
  const left = [...knownAt(read, 'base')]
  let fresh = 0
  for (const v of now) {
    const i = left.findIndex((w) => isDeepStrictEqual(w, v))
    if (i < 0) fresh++
    else left.splice(i, 1)
  }
  return fresh ? `thêm ${fresh} vi phạm import cũ được bỏ qua (${KNOWN_FILE})` : null
}

function suppressionsLoosening(file, read) {
  const now = jsonAt(read, 'head', file)
  if (now.bad) return now.bad
  if (now.j !== null && !plainObject(now.j)) return `${file} phải là object JSON`
  const before = jsonAt(read, 'base', file)
  const was = plainObject(before.j) ? before.j : {}
  const out = []
  for (const [f, rules] of Object.entries(now.j ?? {})) {
    if (!plainObject(rules)) { out.push(`mục "${oneLine(f, 60)}" viết kiểu lạ`); continue }
    for (const [r, v] of Object.entries(rules)) {
      const n = plainObject(v) ? v.count : undefined
      const old = was[f]?.[r]?.count
      if (!Number.isInteger(n) || n < 0) out.push(`"${oneLine(f, 60)}" luật ${oneLine(r, 40)}: count viết kiểu lạ`)
      else if (!(Number.isInteger(old) && n <= old)) out.push(`bỏ qua ${n} lỗi ${oneLine(r, 40)} ở ${oneLine(f, 60)}`)
    }
  }
  if (!out.length) return null
  return `thêm chỗ ESLint bỏ qua lỗi: ${out.slice(0, MAX_WHY).join('; ')}${out.length > MAX_WHY ? `; …và ${out.length - MAX_WHY} chỗ nữa` : ''}`
}

// --- kit/checkers.json (bảng checker của flow-check.mjs): sửa chỉ qua khi chắc là siết ([tbpn]; cổng tự chấm siết/nới, không có nút duyệt) ----------------------------
// Thêm mới / xoá ⇒ chấm như cũ (''). Sửa: đọc JSON của điểm tách nhánh và của đầu nhánh (hỏng/không đọc được ⇒ nới), chỉ qua khi
//   · cùng `version`, khoá ngoài cùng giống nhau (trừ `$comment`, chữ tự do); cùng dãy `id` checker, ĐÚNG thứ tự cũ (không thêm, bỏ, trùng, đổi chỗ): checker chạy theo thứ tự
//     trong danh sách, exclusive nối tiếp theo thứ tự đó (log-secrets phải sau axe/ui-rules thì mới có log để quét)
//   · mỗi checker mọi khoá giống nhau (so sâu) TRỪ: chữ dặn người dùng (title, hint, docs, install, skipWhy);
//     `exclusive` chỉ từ không/false lên true, và chỉ ở checker đứng TRƯỚC mọi checker đang exclusive trong bảng cũ (nó chạy trước chúng nên không đổi lúc log-secrets chạy); bỏ/hạ ⇒ nới;
//     `plan` chỉ khi THÊM MỚI, đúng bằng id của checker đó (planner viết riêng cho nó; planner của checker khác có thể trả "bỏ qua", vd oasdiff khi không có OpenAPI ⇒ checker không
//     chạy mà vẫn tính đạt) và tên có trong PLANNERS của hooks/flow-check.mjs ở đầu nhánh (đọc chữ, không chạy module);
//     `args` chỉ khi cmd là "tsc" và args mới = args cũ thêm đúng một "--noEmit" (các phần tử còn lại giữ nguyên thứ tự).
//   Còn hở (chủ ý): thân planner nằm trong hooks/flow-check.mjs là CODE, không phải file luật nên cổng này không soi; sửa thân planner `tsc-build` để nó bỏ qua tsc thì lọt qua đây.
const CHECKERS_FILE = 'kit/checkers.json'
const PLANNERS_FILE = 'hooks/flow-check.mjs'
const FREE_TEXT = new Set(['title', 'hint', 'docs', 'install', 'skipWhy'])
const MAX_WHY = 6

// Tên các planner: khoá mức 2 dấu cách trong `export const PLANNERS = {` … `}` (có/không dấu nháy), bỏ chú thích khối. Không tìm được ⇒ tập rỗng (plan nào cũng bị nới).
function plannerNames(text) {
  const src = text === null ? '' : lf(text).replace(/\/\*[\s\S]*?\*\//g, '')
  const start = src.search(/^export const PLANNERS = \{/m)
  if (start < 0) return new Set()
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end < 0 ? src.length : end)
  return new Set([...body.matchAll(/^ {2}(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:async\s+)?\(/gm)].map((m) => m[1] ?? m[2] ?? m[3]))
}

// args mới = args cũ + đúng một "--noEmit" (ở đâu cũng được), phần còn lại giữ nguyên thứ tự.
const addsNoEmit = (was, now) => Array.isArray(was) && Array.isArray(now) && now.length === was.length + 1
  && now.some((x, i) => x === '--noEmit' && isDeepStrictEqual(now.filter((_, j) => j !== i), was))

// Một khoá của checker đã đổi (ngoài chữ tự do): null = chắc là siết, chữ = lý do nới. ctx: { hasPlanner(tên), index (chỗ của checker trong bảng cũ), firstExclusive (chỗ của checker exclusive đầu tiên trong bảng cũ, Infinity nếu chưa có) }
function checkerKeyLoosening(k, was, now, ctx) {
  if (k === 'plan') {
    if (was.plan !== undefined) return 'đổi "plan" đã có (plan quyết định lần này chạy gì)'
    if (typeof now.plan !== 'string') return '"plan" phải là tên planner (chữ)'
    // planner của checker khác có thể trả "bỏ qua" (oasdiff khi không có OpenAPI) ⇒ checker này không chạy mà vẫn tính đạt
    if (now.plan !== now.id) return `plan "${oneLine(now.plan, 40)}" khác id checker (chỉ nhận planner viết riêng cho checker này; planner của checker khác có thể bỏ qua nó)`
    return ctx.hasPlanner(now.plan) ? null : `plan "${oneLine(now.plan, 40)}" không có trong PLANNERS của ${PLANNERS_FILE} (nhánh)`
  }
  if (k === 'exclusive') {
    const bool = (v) => v === undefined || typeof v === 'boolean'
    const ok = bool(was.exclusive) && bool(now.exclusive)
    if (ok && (was.exclusive === true) === (now.exclusive === true)) return null // không ↔ false: không đổi gì
    if (ok && now.exclusive === true && ctx.index < ctx.firstExclusive) return null
    return 'đổi "exclusive" (chỉ được bật ở checker đứng trước mọi checker exclusive có sẵn; bỏ hoặc hạ exclusive làm log-secrets có thể chạy trước khi axe/ui-rules sinh log)'
  }
  if (k === 'args') return now.cmd === 'tsc' && addsNoEmit(was.args ?? [], now.args) ? null : 'đổi "args" (chỉ cho thêm đúng một --noEmit vào checker tsc)'
  return `đổi "${oneLine(k, 30)}"`
}

function checkersLoosening(beforeText, afterText, readPlanners) {
  const parse = (t) => { try { const j = t === null ? null : JSON.parse(lf(t)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null } catch { return null } }
  const before = parse(beforeText)
  const after = parse(afterText)
  if (!before || !after) return `không đọc được ${CHECKERS_FILE} (JSON hỏng hoặc thiếu bản cũ/mới) nên không so được`
  const table = (j) => {
    const list = j.checkers
    if (!Array.isArray(list) || list.some((c) => !c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string')) return null
    const byId = new Map()
    for (const c of list) { if (byId.has(c.id)) return { dup: c.id }; byId.set(c.id, c) }
    return { byId }
  }
  const was = table(before)
  const now = table(after)
  if (!was || !now) return 'không đọc được danh sách checkers (không phải mảng object có id) nên không so được'
  const dup = was.dup ?? now.dup
  if (dup !== undefined) return `id checker "${oneLine(dup, 40)}" trùng nhau nên không so được`
  const out = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k !== '$comment' && k !== 'checkers' && !isDeepStrictEqual(before[k], after[k])) out.push(`đổi "${oneLine(k, 30)}" ở mức ngoài cùng`)
  }
  for (const id of was.byId.keys()) if (!now.byId.has(id)) out.push(`bỏ checker "${oneLine(id, 40)}"`)
  for (const id of now.byId.keys()) if (!was.byId.has(id)) out.push(`thêm checker "${oneLine(id, 40)}"`)
  // Thứ tự là luật: checker chạy theo thứ tự trong danh sách, exclusive nối tiếp theo đúng thứ tự đó (log-secrets sau axe/ui-rules mới có log để quét).
  const common = (a, b) => [...a.keys()].filter((id) => b.has(id))
  if (!isDeepStrictEqual(common(was.byId, now.byId), common(now.byId, was.byId))) out.push('đổi thứ tự checker (checker chạy theo thứ tự trong danh sách; log-secrets phải chạy sau axe và ui-rules)')
  let planners = null
  const ids = [...was.byId.keys()]
  const first = ids.findIndex((id) => was.byId.get(id).exclusive === true)
  const ctx = { hasPlanner: (name) => (planners ??= plannerNames(readPlanners())).has(name), firstExclusive: first < 0 ? Infinity : first }
  for (const [id, old] of was.byId) {
    const cur = now.byId.get(id)
    if (!cur) continue
    for (const k of new Set([...Object.keys(old), ...Object.keys(cur)])) {
      if (FREE_TEXT.has(k) || isDeepStrictEqual(old[k], cur[k])) continue
      const why = checkerKeyLoosening(k, old, cur, { ...ctx, index: ids.indexOf(id) })
      if (why) out.push(`checker "${oneLine(id, 40)}": ${why}`)
    }
  }
  if (!out.length) return null
  return out.slice(0, MAX_WHY).join('; ') + (out.length > MAX_WHY ? `; …và ${out.length - MAX_WHY} chỗ nữa` : '')
}

// --- eslint.config.*: chỉ cho qua khi chắc là siết ----------------------------------------------------------------------------------------
// Tách token (bỏ chú thích, khoảng trắng), so từng "dòng token" giữa hai bản (dòng khớp bỏ qua dấu phẩy cuối dòng). Mỗi khúc THÊM phải là: import gói (không phải file
// của dự án), khối cấu hình mới chỉ gồm name/files/ignores/plugins/rules mức "error" không tuỳ chọn (khối chỉ có ignores là bỏ qua file ⇒ không nhận), luật mức "error"
// thêm vào khối rules có sẵn mà khối đó chưa có luật cùng tên (trùng tên trong một khối là ghi đè cả tuỳ chọn cũ) và không có "..."/tên tính bằng code, plugin chưa có
// thêm vào khối plugins có sẵn. Mỗi khúc BỎ phải là: import gói mà tên không còn dùng ở bản mới, khối chỉ nới (tắt luật, ignores, languageOptions chỉ sourceType/globals,
// files chỉ .js/.cjs/.mjs), globalIgnores, luật đang tắt trong rules; ignores/globalIgnores có mẫu "!" thì không gỡ được.
// Ngoại lệ bỏ qua file: globalIgnores mới, khối mới chỉ có ignores, mẫu thêm vào ignores/globalIgnores có sẵn ⇒ nhận khi MỌI mẫu là thư mục máy/công cụ sinh (GEN_DIRS).
// Mức "error" không kèm tuỳ chọn không bao giờ nới: ESLint giữ tuỳ chọn của khối trước khi khối sau chỉ ghi mức (rulesSchema.merge của eslint).
// Dòng biên giống nhau ("}," "{") làm khúc lệch vài dòng ⇒ thử dời khúc lên/xuống như git. Không đọc chắc được (regex, chuỗi `${}`, file quá dài) ⇒ nới.
//
// Luật MỚI HOÀN TOÀN (không thể đang bật ở bản cũ cho file nào) thì đặt gì cũng không nới so với bản cũ: "error" kèm tuỳ chọn bất kỳ, "warn", hay "off" cho một phần file.
//   Biết chắc "không thể đang bật" chỉ khi bản cũ đọc được hết (profileOf): mọi import là gói trong KNOWN_PKGS (đã soát preset của nó đăng ký namespace nào), file chỉ có
//   chữ/mảng/object, tên import, lời gọi defineConfig/globalIgnores/x.config — không biến, hàm, phép tính, chuỗi có mã thoát. Khi đó luật R mới khi:
//   · R không xuất hiện ở đâu trong bản cũ (chữ hay tên), và
//   · R của plugin (có "/"): không preset nào ở bản cũ bật được nó — namespace của R không thuộc namespace mà preset của các gói đã import đăng ký (KNOWN_PKGS).
//     Khai plugin (plugins: { ns: x }) không bật luật; luật tắt thì ESLint không cần plugin (bỏ qua kiểm luật mức 0), nên phải chắc từ phía preset: gói lạ như
//     eslint-plugin-astro có preset đăng ký thêm jsx-a11y ⇒ nằm ngoài KNOWN_PKGS, tức là chặn;
//   · R lõi (không "/"): chỉ nhận luật đo cỡ (METRIC — complexity, max-lines-per-function…: theo chính sách của ESLint không preset "recommended" nào bật) và
//     @eslint/js ở bản cũ chỉ dùng configs.recommended (configs.all bật mọi luật lõi). Luật lõi khác có thể đang bật qua preset (no-unused-vars…) ⇒ như cũ.
//   Còn lại: chỉ "error" không tuỳ chọn như trước.
// Thêm "plugins"/"rules"/"name" vào một khối cấu hình có sẵn (không có sẵn khoá đó, không có "..."): plugins chỉ khai namespace (không bật luật; trùng tên khác plugin
//   thì ESLint báo lỗi), rules chấm từng luật như trên. Khối cấu hình = object nằm thẳng trong mảng export / defineConfig(…) / x.config(…) / extends (containers: cfg).
// Hằng luật kiểu mẫu web của kit — const X = { 'luật': mức, … } rồi `...X` trong rules và rules: Object.fromEntries(Object.keys(X).map((r) => [r, 'off'])) — được thay
//   bằng luật viết thẳng ở từng chỗ dùng trước khi so (expandConsts); X dùng kiểu khác, khai lại, sửa sau khi khai ⇒ không thay, gặp code ⇒ nới.
// Bỏ qua file thêm (globalIgnores, khối chỉ có ignores, mẫu thêm vào ignores): chỉ tính mẫu chưa có trong globalIgnores của bản cũ (lời gọi nằm thẳng trong danh sách cấu
//   hình, bản cũ đọc được hết, không có mẫu "!"), mẫu tính phải là thư mục máy sinh (GEN_DIRS). Bản mới có chuỗi "!" (đưa file trở lại vòng kiểm — mẫu thêm sau che lại),
//   chuỗi có mã thoát / template, hay dựng bằng code / nạp file ngoài gói (literalProblem) ⇒ thêm mẫu bỏ qua nào cũng là nới (theo review Codex/Gemini nhánh 30/10).
const MAX_LINES = 2000
const CLOSE = new Set(['}', ']', ')'])
const STRICT = ['error', '2']
const OFF = ['off', '0']
const BARE = /^(?:(?:@[\w.-]+\/)?[\w-][\w.-]*(?:\/[\w.-]+)*|node:[\w/]+)$/
const STRICT_KEYS = 'chỉ nhận name, files, ignores, plugins, rules mức "error"'
const NEGATED = 'có mẫu "!" (đưa file trở lại vòng kiểm) — gỡ đi có thể làm ESLint thôi kiểm các file đó'
// Thư mục do máy/công cụ sinh (bản build, kiểu route tự sinh, báo cáo test, skill/worktree của AI) — bỏ qua không bớt kiểm code thật của app.
// Nhận cả dạng có "./", "/", "**/" ở đầu và "/", "/*", "/**", "/**/*" ở cuối; còn lại (src, **/*.tsx, "!…") vẫn là nới.
// (Ghép 31/10 với 69bf413 làm trên Mac cùng lỗi: giữ cách này — nhận cả "**/build" của dự án nhiều gói — và thêm blob-report của Playwright.)
// .astro (kiểu do Astro sinh), wailsjs (Wails), .wxt (WXT): mẫu của kit/templates bỏ qua sẵn.
const GEN_DIRS = new Set(['dist', 'build', 'out', '.next', '.react-router', '.svelte-kit', '.output', '.nuxt', '.vercel', '.wrangler', 'coverage', 'test-results', 'playwright-report', 'blob-report', '.claude', '.turbo', '.cache', '.astro', 'wailsjs', '.wxt'])
const genDir = (g) => GEN_DIRS.has(g.replace(/^(?:\.?\/)?(?:\*\*\/)?/, '').replace(/\/(?:\*\*(?:\/\*)?|\*)?$/, ''))
// globs: mẫu bỏ qua MỚI (đã trừ mẫu bản cũ bỏ qua sẵn) · veto: lý do bản mới không chắc (có "!", mã thoát, code) — chỉ tính khi có mẫu mới
const notGen = (globs, veto = null) => {
  const g = globs.find((x) => !genDir(x))
  if (g !== undefined) return `mẫu "${oneLine(g, 40)}" không phải thư mục máy sinh (dist, build, .next, coverage…)`
  return globs.length && veto ? veto : null
}
// Mẫu bỏ qua bị gỡ có "!" hoặc mã thoát (vd '\x21build' = '!build') ⇒ có thể là mẫu đưa file trở lại vòng kiểm (review Gemini nhánh 30/10).
const negated = (globs) => globs.some((g) => g.startsWith('!') || g.includes('\\'))

// Gói luật đã soát (2026-11-05, node_modules của gonsheets-web: @eslint/js 10.0.1, typescript-eslint 8.72.0, eslint-plugin-react-hooks 7.1.1, eslint-plugin-react-refresh,
// @shadcn/lint 0.2.1): ns = mọi namespace plugin mà export/preset của gói có thể đăng ký; không preset nào của chúng bật luật đo cỡ (METRIC), trừ @eslint/js configs.all
// (nên @eslint/js ở bản cũ chỉ được dùng qua configs.recommended). Gói ngoài bảng ⇒ không biết preset của nó bật gì ⇒ không nhận luật mới kèm tuỳ chọn / tắt luật.
// Thêm gói vào bảng: soát MỌI preset của nó (plugins, rules) rồi ghi namespace; preset bật luật lõi đo cỡ ⇒ không thêm.
const KNOWN_PKGS = new Map([
  ['@eslint/js', []], ['typescript-eslint', ['@typescript-eslint']], ['eslint-plugin-react-hooks', ['react-hooks']], ['eslint-plugin-react-refresh', ['react-refresh']],
  ['@shadcn/lint', []], ['globals', []], ['eslint/config', []], // @shadcn/lint: default === plugin, không có configs (namespace do dự án tự đặt trong plugins)
])
const METRIC = new Set(['complexity', 'max-depth', 'max-lines', 'max-lines-per-function', 'max-nested-callbacks', 'max-params', 'max-statements', 'max-classes-per-file'])
// Gói đọc/chạy code hoặc nạp mẫu bỏ qua từ file ngoài (includeIgnoreFile của @eslint/compat)
const CODE_LOADERS = /^(?:(?:node:)?(?:fs|fs\/promises|child_process|vm|module|worker_threads)|@eslint\/compat(?:\/.*)?)$/
const CONFIG_CALLS = new Set(['defineConfig', 'globalIgnores'])
const LITERALS = new Set(['true', 'false', 'null', 'undefined'])
// namespace của luật theo parseRuleId của ESLint: "@scope/x/luật" → "@scope/x", "@scope/luật" → "@scope", "ns/luật" → "ns", lõi → null
const ruleNs = (r) => (!r.includes('/') ? null : r.startsWith('@') ? r.slice(0, r.lastIndexOf('/')) : r.slice(0, r.indexOf('/')))

// File chỉ có cấu hình viết thẳng không? → lý do (chữ) hoặc null; binds nhận tên import → gói. Cho phép: import gói (không phải file dự án / CODE_LOADERS), export default,
// chữ, số, true/false/null, object, mảng, "...", tên import (kể cả x.y.z), lời gọi defineConfig / globalIgnores / x.config. Còn lại (biến, hàm, mũi tên, phép tính, ?:, gán,
// chuỗi có mã thoát / template, tên lạ như process, Object) ⇒ không chắc.
function literalProblem(toks, binds = new Map(), imp = new Set()) {
  for (let i = 0; i < toks.length;) {
    const t = toks[i]
    if (t.k === 'id' && t.t === 'import' && toks[i + 1]?.t !== '(' && toks[i + 1]?.t !== '.') {
      const c = { toks, p: i }
      const names = []
      const out = {}
      const why = importDecl(c, names, out)
      if (why) return why
      if (CODE_LOADERS.test(out.src)) return `import "${oneLine(out.src, 40)}" (đọc/chạy code hoặc nạp mẫu từ file ngoài)`
      for (const n of names) binds.set(n, out.src)
      for (; i < c.p; i++) imp.add(i)
      continue
    }
    const prev = toks[i - 1]
    const next = toks[i + 1]
    if (t.k === 'str') {
      if (t.t[0] === '`' || t.v.includes('\\')) return 'chuỗi viết bằng mã thoát hoặc template'
    } else if (t.k === 'id') {
      const member = prev?.t === '.' && prev.k === 'p'
      const key = next?.t === ':' && ['{', ','].includes(prev?.t)
      if (next?.t === '(' && !(CONFIG_CALLS.has(t.t) && !member && binds.get(t.t) === 'eslint/config') && !(member && t.t === 'config')) return `gọi hàm ${oneLine(t.t, 30)}(…)`
      if (!member && !key && !LITERALS.has(t.t) && !binds.has(t.t) && !(t.t === 'export' && next?.t === 'default') && !(t.t === 'default' && prev?.t === 'export')) return `tên "${oneLine(t.t, 30)}" không phải import (biến, hàm hay tên dựng sẵn)`
    } else if (t.k === 'p') {
      if (!['{', '}', '[', ']', '(', ')', ',', ':', ';', '.', '...'].includes(t.t) && !(t.t === '-' && next?.k === 'num')) return `phép tính hoặc ký hiệu "${t.t}"`
      if (t.t === ':' && prev?.t === ']') return 'tên thuộc tính tính bằng code ([…]: …)'
      if (t.t === '(' && prev?.k !== 'id') return 'gọi hàm hoặc biểu thức trong ngoặc'
    }
    i++
  }
  return null
}

// Bản cũ đọc được tới đâu: { problem, mentions (mọi chữ và tên), ns (namespace có thể đã đăng ký), metricOk (@eslint/js chỉ qua configs.recommended), ignored (mẫu globalIgnores) }
function profileOf(toks, ctx) {
  const binds = new Map()
  const imp = new Set() // chỉ số token thuộc câu import
  let problem = literalProblem(toks, binds, imp)
  const ns = new Set()
  for (const pkg of binds.values()) {
    if (!KNOWN_PKGS.has(pkg)) { problem ??= `import gói "${oneLine(pkg, 40)}" chưa có trong danh sách gói luật kit đã soát (không biết preset của nó bật luật gì)`; continue }
    for (const n of KNOWN_PKGS.get(pkg)) ns.add(n)
  }
  const mentions = new Set(toks.filter((t) => t.k === 'str' || t.k === 'id').map((t) => (t.k === 'str' ? t.v : t.t)))
  // tên import của @eslint/js chỉ được dùng là <tên>.configs.recommended… (configs.all bật mọi luật lõi, kể cả luật đo cỡ)
  const js = new Set([...binds].filter(([, pkg]) => pkg === '@eslint/js').map(([n]) => n))
  const metricOk = toks.every((t, k) => imp.has(k) || t.k !== 'id' || !js.has(t.t) || toks[k - 1]?.t === '.'
    || (toks[k + 1]?.t === '.' && toks[k + 2]?.t === 'configs' && toks[k + 3]?.t === '.' && toks[k + 4]?.t === 'recommended'))
  const ignored = new Set()
  const bang = toks.some((t) => t.k === 'str' && t.v.startsWith('!'))
  if (!problem && !bang) {
    toks.forEach((t, k) => {
      if (t.k === 'id' && t.t === 'globalIgnores' && toks[k + 1]?.t === '(' && ctx[k].cfgList) { const globs = strList({ toks, p: k + 2 }); for (const g of globs ?? []) ignored.add(g) }
    })
  }
  return { problem, mentions, ns, metricOk, ignored }
}

// Luật r có thể đang bật ở bản cũ (cho một file nào đó) không — xem khối chú thích đầu mục. Bản cũ đọc được hết thì luật chỉ bật được bằng một trong hai đường:
// nêu thẳng tên luật (mentions), hoặc preset của gói đã import (luật plugin: namespace thuộc ns của gói; luật lõi: mọi luật trừ METRIC khi @eslint/js chỉ qua recommended).
// Khai plugin (plugins: { ns: x }) không bật luật nào.
function canBeOn(p, r) {
  if (p.problem || p.mentions.has(r)) return true
  const ns = ruleNs(r)
  return ns === null ? !(METRIC.has(r) && p.metricOk) : p.ns.has(ns)
}

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

// Gom token theo dòng nguồn: [{ line, first (chỉ số token đầu), toks, key (để so; bỏ dấu phẩy cuối; chuỗi so theo chữ bên trong nên 'a' khớp "a") }]
function tokenLines(toks) {
  const out = []
  toks.forEach((t, k) => {
    const last = out[out.length - 1]
    if (last && last.line === t.line) last.toks.push(t)
    else out.push({ line: t.line, first: k, toks: [t] })
  })
  for (const l of out) {
    const ts = l.toks.map((t) => (t.k === 'str' ? `\u0002${t.v}` : t.t))
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
// cfgList: hộp là danh sách khối cấu hình (mảng sau export default, ngoặc của defineConfig(…) / x.config(…), mảng extends của khối cấu hình, mảng lồng trong danh sách);
// cfg: object nằm thẳng trong danh sách đó (hoặc sau export default) — khối cấu hình thật, không phải tuỳ chọn của luật hay đối số của hàm khác.
const propName = (t) => (t?.k === 'str' ? t.v : t?.k === 'id' ? t.t : null)
function containers(toks) {
  const root = { open: null, key: null, keys: [], opaque: false }
  const stack = [root]
  const at = []
  toks.forEach((t, k) => {
    const top = stack[stack.length - 1]
    at.push(top)
    if (t.k !== 'p') {
      if (top.open === '{' && t.k === 'id' && ['{', ','].includes(toks[k - 1]?.t) && [',', '}'].includes(toks[k + 1]?.t)) top.keys.push(t.t)
    } else if (t.t === '{' || t.t === '[' || t.t === '(') {
      // mảng là đối số đầu của globalIgnores([…]) mang tên globalIgnores (hàm khác thì không — có thể là hàm tự viết trùng tên ignores)
      const key = t.t === '(' ? (toks[k - 1]?.k === 'id' ? toks[k - 1].t : null) : toks[k - 1]?.t === ':' ? propName(toks[k - 2])
        : t.t === '[' && toks[k - 1]?.t === '(' && top.key === 'globalIgnores' ? 'globalIgnores' : null
      const node = { open: t.t, key, keys: [], opaque: false }
      const exported = top === root && toks[k - 1]?.t === 'default'
      if (t.t === '(') node.cfgList = key === 'defineConfig' || (key === 'config' && toks[k - 2]?.t === '.')
      else if (t.t === '[') node.cfgList = exported || (key === null && !!top.cfgList) || (key === 'extends' && !!top.cfg)
      else node.cfg = key === null && (exported || !!top.cfgList)
      stack.push(node)
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

// rules viết thẳng { "luật": giá trị, … }; judge(c, tên) đọc giá trị → lý do | null. Giá trị không phải object (hàm, biến) ⇒ báo cách viết lại.
const RULES_LITERAL = 'rules tính bằng hàm/biến (cổng không chạy code nên không biết bật/tắt luật nào) — viết thẳng từng luật: rules: { "luật": "error", … }'
function rulesBlock(c, judge) {
  if (at(c)?.t !== '{') return RULES_LITERAL
  const seen = new Set()
  return block(c, (cc) => {
    const k = prop(cc)
    if (k === null) return at(cc)?.t === '...' ? `rules có "..." (gộp luật khác vào, không biết bên trong) — ${RULES_LITERAL.split(' — ')[1]}` : 'cú pháp lạ trong rules'
    if (seen.has(k)) return `luật "${k}" lặp hai lần trong cùng khối`
    seen.add(k)
    return judge(cc, k)
  })
}

// Giá trị viết thẳng (chữ, số, true/false/null, mảng, object có tên thuộc tính thường) tới dấu phẩy / ngoặc đóng ngoài cùng — không tên biến, lời gọi, phép tính
// (một lời gọi trong tuỳ chọn như Object.assign(preset.rules, …) có thể sửa ngầm luật khác).
function literalValue(c) {
  const start = c.p
  if (!skipValue(c)) return false
  return c.toks.slice(start, c.p).every((t, i, a) => t.k === 'str' || t.k === 'num' || (t.k === 'id' && (LITERALS.has(t.t) || (a[i + 1]?.t === ':' && ['{', ','].includes(a[i - 1]?.t))))
    || (t.k === 'p' && ['{', '}', '[', ']', ',', ':'].includes(t.t)) || (t.k === 'p' && t.t === '-' && a[i + 1]?.k === 'num'))
}

// Giá trị của luật r ở phần THÊM: luật mới hoàn toàn (canBeOn false) ⇒ mức/tuỳ chọn gì cũng được (viết thẳng); còn lại chỉ "error" không tuỳ chọn.
function ruleValue(c, r, profile) {
  if (!canBeOn(profile, r)) return literalValue(c) ? null : `giá trị của luật "${r}" phải viết thẳng (chữ, số, mảng, object) — không tên biến, lời gọi hay phép tính`
  if (severity(c, STRICT)) return null
  const why = profile.problem ? `bản cũ ${profile.problem} nên cổng không chứng minh được luật này chưa bật ở đó`
    : 'luật này có thể đang bật ở bản cũ (preset hoặc plugin có sẵn), đặt mức/tuỳ chọn khác có thể là nới'
  return `luật "${r}" không ở mức "error" hoặc kèm tuỳ chọn (${why})`
}

function strictObject(c, env) {
  let ignores = []
  const { why, seen } = configBlock(c, (k, cc) => {
    if (k === 'name') return str(cc) === null ? '"name" phải là chữ' : null
    if (k === 'files' || k === 'ignores') {
      const globs = strList(cc)
      if (k === 'ignores') ignores = globs ?? []
      return globs === null ? `"${k}" phải là danh sách chữ` : null
    }
    if (k === 'plugins') return block(cc, pluginEntry)
    if (k === 'rules') return rulesBlock(cc, (c3, r) => ruleValue(c3, r, env.profile))
    return `khối mới có "${k}" (${STRICT_KEYS})`
  })
  if (why) return why
  if (!seen.includes('ignores') || !seen.every((k) => k === 'ignores' || k === 'name')) return null
  const gen = notGen(ignores.filter((g) => !env.profile.ignored.has(g)), env.veto)
  return gen && `khối chỉ có ignores (bỏ qua file khỏi mọi luật): ${gen}`
}

// Thêm một thuộc tính vào khối cấu hình có sẵn (ctx.cfg): plugins (chỉ khai namespace), rules (chấm từng luật), name. Khối đã có khoá đó / có "..." ⇒ ghi đè cái cũ.
function configProp(c, ctx, env) {
  const k = prop(c)
  if (k === null) return at(c)?.t === '...' ? 'thêm "..." vào khối cấu hình (gộp cấu hình khác vào, không biết bên trong)' : 'cú pháp lạ trong khối cấu hình'
  if (k !== 'plugins' && k !== 'rules' && k !== 'name') {
    return `thêm "${oneLine(k, 30)}" vào khối có sẵn (chỉ nhận plugins, rules, name${k === 'files' || k === 'ignores' ? '; files/ignores thu hẹp những file khối này kiểm' : ''})`
  }
  if (ctx.opaque) return `khối có "..." nên không biết đã có "${k}" chưa (thêm vào sẽ ghi đè cái cũ)`
  if (ctx.keys.filter((x) => x === k).length > 1) return `khối đã có "${k}" (thêm lần nữa sẽ ghi đè cái cũ)`
  if (k === 'name') return str(c) === null ? '"name" phải là chữ' : null
  if (k === 'plugins') return block(c, pluginEntry)
  return rulesBlock(c, (c3, r) => ruleValue(c3, r, env.profile))
}

// globalIgnores([mẫu, …], 'tên'?) → danh sách mẫu; null khi viết kiểu lạ.
function globalIgnoresCall(c) {
  c.p += 2
  const globs = strList(c)
  return globs === null || (eat(c, ',') && str(c) === null) || !eat(c, ')') ? null : globs
}

function looseObject(c) {
  return configBlock(c, (k, cc) => {
    if (k === 'name') return str(cc) === null ? '"name" phải là chữ' : null
    if (k === 'ignores') { const globs = strList(cc); return globs === null ? '"ignores" phải là danh sách chữ' : negated(globs) ? NEGATED : null }
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
    if (k === 'rules') return rulesBlock(cc, (c3, r) => (severity(c3, OFF, { options: true }) ? null : `gỡ luật "${r}" đang bật`))
    return `khối bị gỡ có "${k}" (chỉ gỡ được khối chỉ nới luật)`
  }).why
}

// names: nhận tên mà import đặt trong file (tên sau "as" nếu có); out.src: tên gói.
function importDecl(c, names = [], out = {}) {
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
  out.src = src
  eat(c, ';')
  return null
}

// env: { profile (bản cũ — profileOf), veto (lý do bản mới không chắc về mẫu bỏ qua, hoặc null) }
function addItem(c, ctx, env) {
  const t = at(c)
  const fresh = (globs) => globs.filter((g) => !env.profile.ignored.has(g)) // mẫu bản cũ chưa bỏ qua
  if (t.k === 'id' && t.t === 'import') return importDecl(c)
  if (t.k === 'p' && t.t === '{') return ctx.cfgList ? strictObject(c, env) : 'thêm object ngoài danh sách khối cấu hình (vd vào tuỳ chọn của một luật) — không chắc là siết'
  if (ctx.open === '{' && ctx.key === 'rules') {
    if (ctx.opaque) return 'khối rules có "..." hoặc tên luật tính bằng code nên không biết luật nào đã có (thêm luật vào một khối mới riêng)'
    const k = prop(c)
    if (k === null) return 'cú pháp lạ trong rules'
    const why = ruleValue(c, k, env.profile)
    if (why) return why
    return ctx.keys.filter((x) => x === k).length > 1 ? `luật "${k}" đã có trong cùng khối (ghi đè làm mất tuỳ chọn cũ)` : null
  }
  if (ctx.open === '{' && ctx.key === 'plugins') {
    if (ctx.opaque) return 'khối plugins có "..." nên không biết plugin nào đã có'
    const name = propName(at(c))
    return pluginEntry(c) ?? (ctx.keys.filter((x) => x === name).length > 1 ? `plugin "${name}" đã có trong cùng khối (ghi đè plugin cũ)` : null)
  }
  if (ctx.cfg && t.k !== 'p') return configProp(c, ctx, env)
  if (t.k === 'id' && t.t === 'globalIgnores' && at(c, 1)?.t === '(') {
    const globs = globalIgnoresCall(c)
    return globs === null ? 'globalIgnores viết kiểu lạ' : notGen(fresh(globs), env.veto)
  }
  if (t.k === 'str' && ctx.open === '[' && (ctx.key === 'ignores' || ctx.key === 'globalIgnores')) return notGen(fresh([str(c)]), env.veto)
  if (t.k === 'id' && ['const', 'let', 'var', 'function'].includes(t.t)) return `khai biến/hàm (${t.t} …) — cổng chỉ đọc được cấu hình viết thẳng; viết thẳng giá trị vào chỗ dùng`
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
    const globs = globalIgnoresCall(c)
    if (globs === null) return 'globalIgnores viết kiểu lạ'
    return negated(globs) ? NEGATED : null
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

// Hằng luật của mẫu web (kit/templates/web): `const X = { 'luật': giá trị, … }` ở mức ngoài cùng, chỉ dùng làm `...X` ngay trong rules: { … } và/hoặc
// `rules: Object.fromEntries(Object.keys(X).map((r) => [r, MỨC]))` ⇒ thay bằng luật viết thẳng (đúng nghĩa JavaScript: spread chép từng mục; Object.keys lấy đủ tên chữ),
// bỏ câu khai. Mục viết thẳng giữ số dòng của nó trong câu khai nên sửa một luật của X chỉ lệch đúng dòng đó (ở mọi chỗ dùng). Không thay (để phần so gặp code ⇒ nới) khi:
// X khai lại, khai không phải object chữ (có "...", tên tính bằng code, "__proto__", rỗng), X dùng kiểu khác (gán, truyền vào hàm, x.y, viết tắt { X }), hoặc tên Object
// xuất hiện ngoài đúng mẫu trên (Object bị đặt lại / sửa thì Object.keys không còn là hàm dựng sẵn).
function expandConsts(toks) {
  const ctx = containers(toks)
  const decls = new Map() // tên → { from, to, entries: [{ key, value: [token…] }], uses: [] } | null (không thay được)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!(t.k === 'id' && t.t === 'const' && ctx[i].open === null && toks[i + 1]?.k === 'id' && toks[i + 2]?.t === '=' && toks[i + 3]?.t === '{')) continue
    const name = toks[i + 1].t
    const c = { toks, p: i + 4 }
    const entries = []
    let ok = true
    while (ok && !eat(c, '}')) {
      const key = at(c)
      const k = prop(c)
      const start = c.p
      if (k === null || k === '__proto__' || !skipValue(c)) { ok = false; break }
      entries.push({ key, value: toks.slice(start, c.p) })
      if (!eat(c, ',') && at(c)?.t !== '}') ok = false
    }
    if (ok) eat(c, ';')
    decls.set(name, ok && entries.length && !decls.has(name) ? { from: i, to: c.p, entries, uses: [] } : null)
    if (ok) i = c.p - 1
  }
  if (![...decls.values()].some(Boolean)) return toks
  const inDecl = (k) => [...decls.values()].some((d) => d && k >= d.from && k < d.to)
  const ids = (s, list) => list.every((x, j) => (x === null ? true : toks[s + j]?.t === x && toks[s + j]?.k !== 'str'))
  const idioms = new Set() // chỉ số token Object thuộc mẫu
  // Object . fromEntries ( Object . keys ( X ) . map ( ( P ) => [ P , MỨC ] ) )  — hoặc  P => …  không ngoặc. → chỉ số sau ")" cuối | -1
  const idiomEnd = (s) => {
    if (!ids(s, ['Object', '.', 'fromEntries', '(', 'Object', '.', 'keys', '(', null, ')', '.', 'map', '('])) return -1
    let p = s + 13
    const paren = toks[p]?.t === '('
    if (paren) p++
    const param = toks[p]
    if (param?.k !== 'id') return -1
    p++
    if (paren && toks[p++]?.t !== ')') return -1
    if (!ids(p, ['=', '>', '[']) || toks[p + 3]?.t !== param.t || toks[p + 3]?.k !== 'id' || toks[p + 4]?.t !== ',') return -1
    const sev = toks[p + 5]
    if (!sev || (sev.k !== 'str' && sev.k !== 'num') || !ids(p + 6, [']', ')', ')'])) return -1
    return toks[s - 1]?.t === ':' && propName(toks[s - 2]) === 'rules' ? p + 9 : -1
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.k !== 'id' || inDecl(k) || toks[k - 1]?.t === '.') continue
    if (t.t === 'Object' && idiomEnd(k) > 0) { idioms.add(k); idioms.add(k + 4); continue }
    const d = decls.get(t.t)
    if (!d) continue
    if (toks[k + 1]?.t === ':' && ['{', ','].includes(toks[k - 1]?.t)) continue // tên thuộc tính trùng tên hằng, không phải dùng hằng
    // dấu phẩy sau `...X` đi theo mục cuối (cùng dòng) để bản viết thẳng `'luật': mức,` khớp từng dòng
    if (toks[k - 1]?.t === '...' && ctx[k - 1].open === '{' && ctx[k - 1].key === 'rules' && [',', '}'].includes(toks[k + 1]?.t)) d.uses.push({ kind: 'spread', from: k - 1, to: toks[k + 1].t === ',' ? k + 2 : k + 1, comma: toks[k + 1].t === ',' })
    else if (idiomEnd(k - 8) > 0) d.uses.push({ kind: 'idiom', from: k - 8, to: idiomEnd(k - 8), sev: toks[idiomEnd(k - 8) - 4] })
    else decls.set(t.t, null)
  }
  const strayObject = toks.some((t, k) => t.k === 'id' && t.t === 'Object' && toks[k - 1]?.t !== '.' && !idioms.has(k))
  for (const [name, d] of decls) if (d && strayObject && d.uses.some((u) => u.kind === 'idiom')) decls.set(name, null)
  const good = [...decls.values()].filter(Boolean)
  // mở ra quá nhiều chữ (hằng to dùng nhiều chỗ) ⇒ không mở, để phần so chặn — cổng không được chạy quá lâu
  const size = good.reduce((n, d) => n + d.uses.length * d.entries.reduce((m, e) => m + e.value.length + 3, 0), 0)
  if (!good.length || size > 20000) return toks
  const skip = new Map() // chỉ số bắt đầu → { to, emit: () => token[] }
  const comma = (line) => ({ k: 'p', t: ',', line })
  for (const d of good) {
    skip.set(d.from, { to: d.to, emit: () => [] })
    for (const u of d.uses) {
      skip.set(u.from, {
        to: u.to,
        emit: () => {
          const out = u.kind === 'idiom' ? [{ k: 'p', t: '{', line: toks[u.from].line }] : []
          d.entries.forEach(({ key, value }, j) => {
            if (j) out.push(comma(out[out.length - 1].line))
            if (u.kind === 'spread') out.push({ ...key }, { k: 'p', t: ':', line: key.line }, ...value.map((v) => ({ ...v })))
            else out.push({ ...key }, { k: 'p', t: ':', line: key.line }, { ...u.sev, line: key.line })
          })
          if (u.kind === 'idiom') out.push({ k: 'p', t: '}', line: toks[u.to - 1].line })
          if (u.comma) out.push(comma(out[out.length - 1].line))
          return out
        },
      })
    }
  }
  const out = []
  for (let k = 0; k < toks.length;) {
    const s = skip.get(k)
    if (s) { out.push(...s.emit()); k = s.to } else out.push(toks[k++])
  }
  return out
}

export function eslintLoosening(before, after) {
  const A0 = tokenize(lf(before))
  const B0 = tokenize(lf(after))
  if (!A0 || !B0) return { line: 1, why: 'không đọc chắc được file (có regex hoặc chuỗi `${}`) nên không biết là siết hay nới' }
  const A = expandConsts(A0)
  const B = expandConsts(B0)
  const la = tokenLines(A)
  const lb = tokenLines(B)
  if (la.length > MAX_LINES || lb.length > MAX_LINES) return { line: 1, why: 'file quá dài để so từng dòng' }
  const { mo, mn } = align(la.map((l) => l.key), lb.map((l) => l.key))
  const cut = (toks, lines, c, d) => toks.slice(lines[c].first, lines[d - 1].first + lines[d - 1].toks.length)
  const usedAfter = new Set(B.filter((t) => t.k === 'id').map((t) => t.t))
  const ctxA = containers(A)
  const code = literalProblem(B)
  const veto = code ? `bản mới ${code} nên không chắc mẫu bỏ qua thêm vào có che lại file nào không`
    : B.some((t) => t.k === 'str' && t.v.startsWith('!')) ? 'cấu hình có mẫu "!" (đưa file trở lại vòng kiểm): thêm mẫu bỏ qua có thể che lại chúng' : null
  const env = { profile: profileOf(A, ctxA), veto }
  // arg: tham số thứ ba của item — addItem cần biết bản cũ (env), removeItem cần tên còn dùng ở bản mới.
  const sides = [
    { lines: lb, match: mn, other: mo, toks: B, ctx: containers(B), item: addItem, arg: env, say: (why, run) => `${hintOf(run)}thêm phần không chắc là siết luật: ${why}` },
    { lines: la, match: mo, other: mn, toks: A, ctx: ctxA, item: removeItem, arg: usedAfter, say: (why) => `bỏ phần đang siết luật hoặc không chắc là nới (bản cũ): ${why}` },
  ]
  for (const s of sides) {
    for (const run of runsOf(s.match)) {
      const bad = settle(s.lines, s.match, s.other, run, (c, d) => {
        const toks = cut(s.toks, s.lines, c, d)
        const ctx = s.ctx[s.lines[c].first]
        const why = sequence(toks, (cc) => s.item(cc, ctx, s.arg))
        return { why: why && s.say(why, toks), balanced: balanced(toks) }
      })
      if (bad) return { line: s.lines[bad.at].line, why: bad.why }
    }
  }
  // dòng khớp chỉ khác dấu phẩy cuối: thêm phẩy ⇒ ngay sau phải là khúc thêm; bỏ phẩy ⇒ ngay sau là khúc bỏ, và bản mới tiếp theo là ngoặc đóng hoặc khúc thêm.
  // Phẩy cuối đứng ngay trước ngoặc đóng (ở cả hai bản) là phẩy thừa, JavaScript bỏ qua ⇒ không tính.
  const closes = (lines, k) => k < lines.length && CLOSE.has(lines[k].toks[0].t)
  for (let i = 0; i < la.length; i++) {
    const j = mo[i]
    if (j < 0 || la[i].toks.length === lb[j].toks.length) continue
    if (closes(la, i + 1) && closes(lb, j + 1)) continue
    const added = lb[j].toks.length > la[i].toks.length
    const ok = added
      ? j + 1 < lb.length && mn[j + 1] === -1
      : i + 1 < la.length && mo[i + 1] === -1 && (j + 1 >= lb.length || mn[j + 1] === -1 || CLOSE.has(lb[j + 1].toks[0].t))
    if (!ok) return { line: lb[j].line, why: 'đổi dấu phẩy ở dòng có sẵn mà không kèm thêm/bỏ khối nào' }
  }
  return null
}

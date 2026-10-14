// arch: kiến trúc máy đọc. MỘT nguồn `docs/arch.json` (ADR-0005) → cấu hình cho công cụ có sẵn (dependency-cruiser, go-arch-lint,
// golangci-lint, ESLint). Kit chỉ viết phần keo; máy kiểm thật là công cụ ngoài. CLI: hooks/arch.mjs. Mẫu: kit/arch/.
//
// docs/arch.json = { version:1, parts:[{ name, stack:'web'|'go'|'extension', root, modules:[{ name, path, desc, mayDependOn:[name…] }],
//   shared:[path…], limits:{ fileLines:400, fnLines:60, complexity:15 }, forbidden:[{ from, to, reason, fix }] }] }
//   - NHIỀU PHẦN: Wails = một phần web (frontend/src) + một phần go; dự án một stack = một phần. path/root/glob tính từ thư mục dự án.
//   - Đơn vị module: web/extension = mỗi root/features/* một module + mọi thư mục cấp 1 khác của root (kể cả shared); go = mỗi root/* một miền.
//     Thư mục không có file code (chỉ ảnh/css/.gitkeep) không phải module.
//   - forbidden.from/to là glob (* một cấp, ** nhiều cấp, {a,b}); to có thể là gói ngoài (web: node_modules/<gói>/**; go: đường dẫn import).
//
// Hàm xuất cho flow-check (làn B) và cổng gộp (làn C):
//   loadArch(dir) → { arch|null, errors[] }              syncCheck(dir) → { ok, problems:[{file,msg,fix}], notes[] }
//   sizeCheck(dir, { changedOnly?: string[] }) → { ok, problems }
//   ruleFiles(dir) → string[]  (file luật thực có)         isRuleFile(rel) → boolean  (soi tên file trong diff, kể cả file chưa tồn tại)
//   depcruiseArgs(dir, { ignoreKnown?, outputType? }) → { cwd, args }|null   (option trước rồi `--` rồi các root; outputType mặc định err-long; ignoreKnown = bỏ vi phạm cũ đã chốt)
//   pathProblem(p) → lý do|null  (đường dẫn từ docs/arch.json không tin cậy: chỉ nhận tương đối, trong dự án, không "-" đầu, không ký tự điều khiển)
//   usesTypeScript(dir) → boolean  (phần web có .ts/.tsx — depcruise cần TypeScript của dự án để đọc)
//   goArchLintRuns(dir) → [{ part, file, exists, cwd, args }]     newGoArchViolations(dir, output) → string[]  (vi phạm go-arch-lint không có trong mốc)
//   loadBaseline(dir) → { base, size, depcruise, go:{newFromRev, archLint}|null, eslint }|null   (golangci: --new-from-rev=<go.newFromRev>)
//   nodeEngineProblem(text) → { version }|null · nodeEngineMessage(version) → câu đời thường   (công cụ từ chối chạy vì Node ngoài "engines" ⇒ THIẾU, không phải KHÔNG ĐẠT)
// Hàm cho CLI: init(dir,{stack}) · gen(dir) · baseline(dir,{run}). Công cụ ngoài chạy qua `run(cmd, args, {cwd, timeoutMs})` →
//   { status, stdout, stderr, error:{code,message}|null } — mặc định defaultRun; test tiêm bản giả. Thiếu công cụ ⇒ error.code 'ENOENT'.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, matches, roots as stackRoots } from './stack.mjs'

export const ARCH_FILE = 'docs/arch.json'
export const BASELINE_FILE = 'docs/arch-baseline.json'
export const KNOWN_FILE = '.dependency-cruiser-known-violations.json'
const KIT_ARCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit', 'arch')
const DEFAULT_LIMITS = { fileLines: 400, fnLines: 60, complexity: 15 }
const PART_STACKS = ['web', 'go', 'extension']
const MARK = 'Sinh bởi: node ~/.claude/hooks/arch.mjs gen (từ docs/arch.json) — sửa docs/arch.json rồi chạy lại, đừng sửa tay file này.'
const PLACEHOLDER = '(điền: làm gì; KHÔNG làm gì)'
// Gói cài cho máy kiểm ranh giới web — MỘT chỗ duy nhất cho mọi lời dặn cài (arch.mjs baseline, flow-check). typescript phải dưới 7: dependency-cruiser 18 khai báo hỗ trợ
// ">=2.0.0 <7.0.0" (src/meta.cjs của nó), `typescript` không ghim sẽ kéo bản 7 mà depcruise không đọc được. Lệnh in ra bằng dấu ^ vẫn chạy trong cmd.exe (^ bị bỏ, còn @18 và @6).
export const DEPCRUISE_PKGS = 'dependency-cruiser@^18 typescript@^6'
export const DEPCRUISE_WHERE = 'chạy trong thư mục có package.json của phần web, vd frontend/ của Wails'
const INSTALL = {
  depcruise: `npm i -D ${DEPCRUISE_PKGS}`,
  eslint: 'npm i -D eslint@latest',
  'go-arch-lint': 'go install github.com/fe3dback/go-arch-lint@latest',
}

// --- tiện ích nhỏ -------------------------------------------------------------------------------------------------------------------

const slash = (p) => String(p).replace(/\\/g, '/')
const normRel = (p) => slash(p).replace(/^\.\//, '').replace(/\/+$/, '')
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`)
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').replace(BOM, '') } catch { return null } }
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const oneLine = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const esc = (s) => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
const MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g')
const slug = (s) => s.normalize('NFD').replace(MARKS, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const sentence = (s) => { const t = String(s).trim(); return /[.!?…]$/.test(t) ? t : `${t}.` }
const advice = (f) => `${sentence(f.reason)} Cách sửa: ${f.fix}`
const related = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

function writeText(dir, rel, text) {
  const f = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}

// --- glob ---------------------------------------------------------------------------------------------------------------------------

export function expandBraces(s) {
  const m = /\{([^{}]*)\}/.exec(s)
  if (!m) return [s]
  return m[1].split(',').flatMap((alt) => expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)))
}

// Regex sinh ra phải qua được kiểm "an toàn" của dependency-cruiser (safe-regex: nhóm có lặp bên trong nhóm lặp bị coi là nguy hiểm và depcruise DỪNG HẲN):
// `(?:.*/)?` và `(?:/.*)?$` bị từ chối, `(?:.*/|)` và `(?:/|$)` thì qua và khớp y hệt.
function globBody(g) {
  let out = ''
  for (let i = 0; i < g.length;) {
    if (g.startsWith('**/', i)) { out += '(?:.*/|)'; i += 3 } else if (g.startsWith('**', i)) { out += '.*'; i += 2 } else if (g[i] === '*') { out += '[^/]*'; i++ } else if (g[i] === '?') { out += '[^/]'; i++ } else { out += g[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++ }
  }
  return out
}

// Regex (chuỗi) khớp đường dẫn glob VÀ mọi thứ bên dưới nó. anywhere: không neo đầu (gói trong node_modules, kể cả đường dẫn pnpm).
export function globToRegex(glob, { anywhere = false } = {}) {
  const alts = expandBraces(String(glob)).map((g) => globBody(g.replace(/\/\*\*$/, '')))
  return `${anywhere ? '(?:^|/)' : '^'}(?:${alts.join('|')})(?:/|$)`
}

// --- đọc và kiểm docs/arch.json ---------------------------------------------------------------------------------------------------------

// Mọi đường dẫn / glob đọc từ docs/arch.json (root, modules[].path, shared, forbidden.from/to) là dữ liệu KHÔNG tin cậy: file nằm trong repo nên nhánh nào cũng sửa được,
// và chúng thành đối số lệnh (depcruise…), thành luật sinh ra, thành chữ trong khối ESLint. Chỉ nhận đường dẫn tương đối nằm trong dự án.
// → lý do không dùng được, hoặc null. p đã qua normRel; glob {a,b} xét từng nhánh.
const CTRL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`)

export function pathProblem(p) {
  if (CTRL.test(p)) return 'có ký tự điều khiển (xuống dòng…)'
  for (const alt of expandBraces(p)) {
    if (alt.startsWith('-')) return 'bắt đầu bằng "-" (công cụ sẽ hiểu là cờ lệnh)'
    if (path.posix.isAbsolute(alt) || path.win32.isAbsolute(alt) || /^[A-Za-z]:/.test(alt)) return 'là đường dẫn tuyệt đối'
    if (alt.split('/').includes('..')) return 'có ".." (thoát ra ngoài thư mục dự án)'
  }
  return null
}

const shown = (v) => JSON.stringify(String(v).slice(0, 80))

function checkPart(raw, i, seen, errors) {
  const label = `parts[${i}]${nonEmpty(raw?.name) ? ` (${raw.name})` : ''}`
  const err = (m) => errors.push(`${label}: ${m}`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('phải là một object'); return null }
  if (!nonEmpty(raw.name)) err('thiếu "name"')
  else if (seen.has(raw.name)) err(`trùng tên phần "${raw.name}"`)
  else seen.add(raw.name)
  if (!PART_STACKS.includes(raw.stack)) err(`"stack" phải là ${PART_STACKS.join(' | ')}`)
  const root = nonEmpty(raw.root) ? normRel(raw.root) : ''
  const rootWhy = !root || root === '.' ? 'thiếu, hoặc là chính thư mục dự án' : pathProblem(root)
  if (rootWhy) err(`"root"${root ? ` ${shown(root)}` : ''} không dùng được: ${rootWhy}. Phải là thư mục con của dự án, vd "src" hoặc "internal" (tương đối, không "..", không bắt đầu bằng "-").`)
  const bad = (what, v) => { const why = pathProblem(v); if (why) err(`${what} ${shown(v)} không dùng được: ${why}. Dùng đường dẫn tương đối nằm trong dự án.`); return !!why }
  const part = { ...raw, root, modules: [], shared: [], forbidden: [], limits: { ...DEFAULT_LIMITS } }
  const mods = raw.modules ?? []
  if (!Array.isArray(mods)) err('"modules" phải là mảng')
  else {
    const names = new Set()
    mods.forEach((m, j) => {
      const at = `modules[${j}]`
      if (!m || !nonEmpty(m.name) || !nonEmpty(m.path)) { err(`${at} cần "name" và "path"`); return }
      if (names.has(m.name)) err(`${at}: trùng tên module "${m.name}"`)
      names.add(m.name)
      const p = normRel(m.path)
      if (bad(`${at} "${oneLine(m.name, 60)}": path`, p)) return
      if (root && p !== root && !p.startsWith(`${root}/`)) err(`${at} "${oneLine(m.name, 60)}": path "${oneLine(m.path, 80)}" nằm ngoài root "${root}"`)
      if (m.mayDependOn !== undefined && !(Array.isArray(m.mayDependOn) && m.mayDependOn.every(nonEmpty))) err(`${at} "${m.name}": "mayDependOn" phải là mảng tên module`)
      part.modules.push({ ...m, path: p, mayDependOn: [...(m.mayDependOn ?? [])] })
    })
    for (const m of part.modules) for (const n of m.mayDependOn) {
      if (n === m.name) err(`module "${m.name}": mayDependOn trỏ vào chính nó`)
      else if (!names.has(n)) err(`module "${m.name}": mayDependOn có "${n}" nhưng không có module nào tên vậy`)
    }
  }
  if (raw.shared !== undefined) {
    if (Array.isArray(raw.shared) && raw.shared.every(nonEmpty)) {
      part.shared = raw.shared.map(normRel)
      for (const s of part.shared) bad('shared', s)
    } else err('"shared" phải là mảng đường dẫn')
  }
  if (raw.limits !== undefined) {
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const v = raw.limits?.[k]
      if (v === undefined) continue
      if (Number.isInteger(v) && v > 0) part.limits[k] = v
      else err(`limits.${k} phải là số nguyên dương`)
    }
  }
  const fb = raw.forbidden ?? []
  if (!Array.isArray(fb)) err('"forbidden" phải là mảng')
  else fb.forEach((f, j) => {
    const at = `forbidden[${j}]`
    if (!f || typeof f !== 'object') { err(`${at} phải là object { from, to, reason, fix }`); return }
    for (const k of ['from', 'to']) if (!nonEmpty(f[k])) err(`${at} thiếu "${k}"`)
    for (const [k, what] of [['reason', 'vì sao cấm'], ['fix', 'cách sửa cho AI']]) if (!nonEmpty(f[k])) err(`${at} thiếu "${k}" (${what}) — luật không có lời dặn sửa thì không hợp lệ`)
    const from = normRel(f.from ?? '')
    const to = normRel(f.to ?? '')
    if (nonEmpty(f.from)) bad(`${at} "from"`, from)
    if (nonEmpty(f.to)) bad(`${at} "to"`, to)
    part.forbidden.push({ ...f, from, to })
  })
  return part
}

export function loadArch(dir) {
  const text = readText(path.join(dir, ARCH_FILE))
  if (text === null) return { arch: null, errors: [`Chưa có ${ARCH_FILE}. Chạy: node ~/.claude/hooks/arch.mjs init --stack web|go|extension|wails --dir <thư mục dự án>`] }
  let raw
  try { raw = JSON.parse(text) } catch { return { arch: null, errors: [`${ARCH_FILE} không đọc được (sai cú pháp JSON: thiếu dấu phẩy, ngoặc hoặc nháy). Sửa lại cho đúng.`] } }
  const errors = []
  if (!raw || typeof raw !== 'object' || raw.version !== 1) errors.push(`${ARCH_FILE}: "version" phải là 1`)
  if (!Array.isArray(raw?.parts) || !raw.parts.length) errors.push(`${ARCH_FILE}: thiếu "parts" (ít nhất một phần: web, go hoặc extension)`)
  const seen = new Set()
  const parts = (Array.isArray(raw?.parts) ? raw.parts : []).map((p, i) => checkPart(p, i, seen, errors))
  return errors.length ? { arch: null, errors } : { arch: { ...raw, parts }, errors: [] }
}

export function loadBaseline(dir) {
  const t = readText(path.join(dir, BASELINE_FILE))
  if (t === null) return null
  try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null } catch { return null }
}

// --- đọc thư mục thật ---------------------------------------------------------------------------------------------------------------

const SRC_EXT = { web: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'], go: ['.go'] }
SRC_EXT.extension = SRC_EXT.web
const IGNORE_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'testdata', '__tests__', '__mocks__', 'wailsjs', 'generated', '__generated__', 'storybook-static'])
const TEST_FILE = [/\.(test|spec)\.[cm]?[jt]sx?$/, /_test\.go$/]
const GEN_FILE = [/\.d\.ts$/, /\.(gen|generated)\.[cm]?[jt]sx?$/, /_gen\.go$/, /_generated\.go$/, /\.pb\.go$/, /\.min\.js$/]
const GEN_HEAD = /(DO NOT EDIT|Code generated|@generated|auto-?generated)/i
const skipDir = (n) => n.startsWith('.') || IGNORE_DIR.has(n)
const isSource = (name, exts) => exts.includes(path.extname(name)) && !TEST_FILE.some((re) => re.test(name)) && !GEN_FILE.some((re) => re.test(name))

function hasSource(abs, exts) {
  for (const e of readDir(abs)) {
    if (e.isDirectory() ? !skipDir(e.name) && hasSource(path.join(abs, e.name), exts) : e.isFile() && isSource(e.name, exts)) return true
  }
  return false
}

function sourceFiles(dir, part) {
  const exts = SRC_EXT[part.stack]
  const out = []
  const rec = (abs) => {
    for (const e of readDir(abs)) {
      if (e.isDirectory()) { if (!skipDir(e.name)) rec(path.join(abs, e.name)) } else if (e.isFile() && isSource(e.name, exts)) out.push(slash(path.relative(dir, path.join(abs, e.name))))
    }
  }
  rec(path.join(dir, part.root))
  return out.sort()
}

// Tên module thật (tính từ root) theo quy tắc đơn vị của stack; null nếu root chưa có.
function realUnits(dir, part) {
  const rootAbs = path.join(dir, part.root)
  if (!isDir(rootAbs)) return null
  const exts = SRC_EXT[part.stack]
  const units = []
  for (const e of readDir(rootAbs)) {
    if (!e.isDirectory() || skipDir(e.name)) continue
    if (part.stack !== 'go' && e.name === 'features') {
      for (const c of readDir(path.join(rootAbs, 'features'))) if (c.isDirectory() && !skipDir(c.name) && hasSource(path.join(rootAbs, 'features', c.name), exts)) units.push(`features/${c.name}`)
    } else if (hasSource(path.join(rootAbs, e.name), exts)) units.push(e.name)
  }
  return units.sort()
}

// Thư mục chứa package.json gần nhất tính từ root của phần, không vượt quá dir (ESLint, tsconfig chạy ở đó).
function packageDir(dir, part) {
  const top = path.resolve(dir)
  for (let d = path.resolve(dir, part.root); ; d = path.dirname(d)) {
    if (isFile(path.join(d, 'package.json'))) return d
    if (d === top || path.dirname(d) === d) return top
  }
}

const webParts = (arch) => arch.parts.filter((p) => p.stack !== 'go')
const goParts = (arch) => arch.parts.filter((p) => p.stack === 'go')
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
const archLintFile = (i, part) => (i === 0 ? '.go-arch-lint.yml' : `.go-arch-lint.${slug(part.name)}.yml`)

// --- syncCheck: arch.json ↔ thư mục ↔ codemap ----------------------------------------------------------------------------------------

function parseCodemap(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^#{1,6}\s.*codemap/i.test(l))
  if (at < 0) return null
  const level = /^#+/.exec(lines[at])[0].length
  const set = new Set()
  for (const l of lines.slice(at + 1)) {
    const h = /^(#+)\s/.exec(l)
    if (h && h[1].length <= level) break
    const m = /^\s*[-*]\s+`([^`]+)`/.exec(l)
    if (m) set.add(normRel(m[1]))
  }
  return set
}

const archMdRel = (dir) => ['docs/ARCHITECTURE.md', 'ARCHITECTURE.md'].find((r) => isFile(path.join(dir, r))) ?? null
const brokenArch = (errors) => errors.map((msg) => ({ file: ARCH_FILE, msg, fix: 'Sửa docs/arch.json theo lời báo rồi chạy lại (chưa có file thì chạy arch.mjs init).' }))

export function syncCheck(dir) {
  const { arch, errors } = loadArch(dir)
  if (!arch) return { ok: false, problems: brokenArch(errors), notes: [] }
  const problems = []
  const notes = []
  for (const part of arch.parts) {
    const units = realUnits(dir, part)
    if (units === null) { notes.push(`Chưa có thư mục "${part.root}" (phần ${part.name}) nên chưa có code để đối chiếu với module.`); continue }
    const known = [...part.modules.map((m) => m.path), ...part.shared]
    for (const u of units) {
      const p = `${part.root}/${u}`
      if (known.some((k) => related(k, p))) continue
      problems.push({
        file: p,
        msg: `Thư mục ${p} có code nhưng chưa có trong docs/arch.json (phần ${part.name}).`,
        fix: `Thêm vào "modules" của phần ${part.name} mục { "name": "${u}", "path": "${p}", "mayDependOn": [...] } và một dòng vào Codemap của docs/ARCHITECTURE.md; nếu đó không phải code của dự án thì chuyển ra ngoài ${part.root}.`,
      })
    }
    for (const m of part.modules) {
      if (!isDir(path.join(dir, m.path))) problems.push({ file: ARCH_FILE, msg: `Module "${m.name}" (${m.path}) có trong docs/arch.json nhưng không còn thư mục.`, fix: 'Xoá module khỏi docs/arch.json và dòng của nó trong Codemap, hoặc tạo lại thư mục nếu lỡ xoá/đổi tên.' })
    }
  }
  const md = archMdRel(dir)
  if (!md) problems.push({ file: 'docs/ARCHITECTURE.md', msg: 'Chưa có docs/ARCHITECTURE.md (bản đồ kiến trúc).', fix: 'Chạy node ~/.claude/hooks/arch.mjs init để lấy bản mẫu, rồi điền Codemap.' })
  else {
    const map = parseCodemap(readText(path.join(dir, md)) ?? '')
    if (!map) problems.push({ file: md, msg: `${md} chưa có mục Codemap.`, fix: 'Thêm mục "## Codemap" và mỗi module một dòng: - `đường/dẫn` — làm gì; KHÔNG làm gì.' })
    else {
      const paths = arch.parts.flatMap((p) => p.modules.map((m) => m.path))
      for (const p of paths) if (!map.has(p)) problems.push({ file: md, msg: `Codemap thiếu dòng của module ${p}.`, fix: `Thêm vào mục Codemap một dòng: - \`${p}\` — làm gì; KHÔNG làm gì.` })
      for (const p of map) if (!paths.includes(p)) problems.push({ file: md, msg: `Codemap nhắc ${p} nhưng docs/arch.json không có module này.`, fix: 'Xoá dòng đó khỏi Codemap, hoặc thêm module vào docs/arch.json nếu nó là module thật.' })
    }
  }
  return { ok: problems.length === 0, problems, notes }
}

// --- sizeCheck: trần dòng của file ---------------------------------------------------------------------------------------------------

// Số dòng của file nếu file quá trần `limit` và không phải file sinh; ngược lại null.
function overLimit(abs, limit) {
  const text = readText(abs)
  if (text === null) return null
  const n = lineCount(text)
  return n > limit && !GEN_HEAD.test(text.split('\n', 6).join('\n')) ? n : null
}

export function sizeCheck(dir, { changedOnly } = {}) {
  const { arch, errors } = loadArch(dir)
  if (!arch) return { ok: false, problems: brokenArch(errors) }
  const old = loadBaseline(dir)?.size ?? {}
  const only = Array.isArray(changedOnly) ? new Set(changedOnly.map(normRel)) : null
  const problems = []
  for (const part of arch.parts) {
    const limit = part.limits.fileLines
    for (const rel of sourceFiles(dir, part)) {
      if (only && !only.has(rel)) continue
      const n = overLimit(path.join(dir, rel), limit)
      if (n === null) continue
      const was = old[rel]
      if (Number.isInteger(was) && n <= was) continue
      problems.push({
        file: rel,
        msg: Number.isInteger(was) ? `${rel} đã quá trần từ lúc chốt mốc (${was} dòng) và đang dài thêm thành ${n} dòng (trần ${limit}).` : `${rel} dài ${n} dòng, trần là ${limit} dòng.`,
        fix: 'Hãy tách file này thành các file nhỏ, mỗi file một việc, rồi import lại. Đừng tự nâng limits.fileLines trong docs/arch.json — nới luật phải hỏi người dùng.',
      })
    }
  }
  return { ok: problems.length === 0, problems }
}

// --- file luật của dự án ---------------------------------------------------------------------------------------------------------------

const RULE_PATHS = [ARCH_FILE, BASELINE_FILE]
const RULE_NAMES = [/^\.dependency-cruiser.*$/, /^\.go-arch-lint.*\.ya?ml$/, /^\.golangci\.[a-z]+$/, /^eslint\.config\.[cm]?[jt]s$/, /^\.eslintrc(\.[a-z]+)?$/, /^eslint-suppressions\.json$/, /^biome\.jsonc?$/, /^sgconfig\.ya?ml$/]

export function isRuleFile(rel) {
  const r = normRel(rel)
  return RULE_PATHS.includes(r) || RULE_NAMES.some((re) => re.test(r.split('/').pop()))
}

export function ruleFiles(dir) {
  const dirs = new Set([path.resolve(dir)])
  const { arch } = loadArch(dir)
  for (const part of arch?.parts ?? []) if (part.stack !== 'go') dirs.add(packageDir(dir, part))
  const out = new Set(RULE_PATHS.filter((r) => isFile(path.join(dir, r))))
  for (const d of dirs) for (const e of readDir(d)) if (e.isFile() && RULE_NAMES.some((re) => re.test(e.name))) out.add(slash(path.relative(dir, path.join(d, e.name))))
  return [...out].sort()
}

// --- chạy công cụ ngoài (tiêm được) ------------------------------------------------------------------------------------------------------

// Tìm file chạy được: node_modules/.bin của thư mục chạy và các thư mục cha → PATH. Windows nhận .exe/.cmd/.bat/.com.
export function findBin(name, cwd = process.cwd(), env = process.env) {
  const win = process.platform === 'win32'
  const exts = win ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  if (/[\\/]/.test(name)) return isFile(name) ? name : null
  const inDir = (d) => { for (const e of exts) { const p = path.join(d, name + e); if (isFile(p)) return p } return null }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const hit = inDir(path.join(d, 'node_modules', '.bin'))
    if (hit) return hit
    if (path.dirname(d) === d) break
  }
  for (const d of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const hit = d ? inDir(d.replace(/^"(.*)"$/, '$1')) : null
    if (hit) return hit
  }
  return null
}

const SAFE_ARG = /^[\w.:=/@-]+$/

// from: các thư mục tìm công cụ TRƯỚC cwd (node_modules/.bin của chúng và thư mục cha) — vd thư mục phần web `frontend/` của Wails, nơi dự án cài riêng depcruise + typescript:
// bản cài trong dự án thắng bản global ở PATH (bản global không thấy typescript của dự án).
export function defaultRun(cmd, args = [], { cwd = process.cwd(), timeoutMs = 180_000, env = process.env, from = [] } = {}) {
  const file = [...from, cwd].reduce((hit, d) => hit ?? findBin(cmd, d, env), null)
  if (!file) return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: `không thấy ${cmd}` } }
  let exe = file
  let argv = args
  const opts = { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    if (!args.every((a) => SAFE_ARG.test(a)) || /["%!]/.test(file)) return { status: null, stdout: '', stderr: '', error: { code: 'EUNSAFE', message: 'đối số hoặc đường dẫn không an toàn để chạy qua cmd.exe' } }
    exe = env.ComSpec || env.COMSPEC || 'cmd.exe'
    argv = ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`]
    opts.windowsVerbatimArguments = true
  }
  const r = spawnSync(exe, argv, opts)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? { code: r.error.code ?? 'ESPAWN', message: r.error.message } : null }
}

// --- init ---------------------------------------------------------------------------------------------------------------------------

const COMPOSITION = new Set(['app', 'pages', 'routes', 'router', 'main'])
const GENERIC_NOTE = 'Kiến trúc máy đọc. Thêm module: thêm một mục vào modules + một dòng Codemap trong docs/ARCHITECTURE.md (kiểm bằng: node ~/.claude/hooks/arch.mjs sync). Mỗi forbidden bắt buộc có reason + fix. Sửa xong chạy: node ~/.claude/hooks/arch.mjs gen'

function stackList(dir, stack) {
  if (stack === 'wails') return { kinds: ['web', 'go'], wails: true }
  if (stack !== undefined && stack !== null && stack !== '') {
    if (!PART_STACKS.includes(stack)) throw new Error(`stack phải là web, go, extension hoặc wails (nhận được "${stack}")`)
    return { kinds: [stack], wails: false }
  }
  const found = detect(dir)
  if (found.includes('wails')) return { kinds: ['web', 'go'], wails: true }
  const kinds = found.includes('extension') ? found.filter((s) => s !== 'web') : found
  if (!kinds.length) throw new Error('Không nhận ra loại dự án. Thêm --stack web|go|extension|wails.')
  return { kinds, wails: false }
}

function retarget(part, to) {
  const from = part.root
  const move = (s) => (s === from || s.startsWith(`${from}/`) ? to + s.slice(from.length) : s)
  return { ...part, root: to, modules: part.modules.map((m) => ({ ...m, path: move(m.path) })), shared: part.shared.map(move), forbidden: part.forbidden.map((f) => ({ ...f, from: move(f.from), to: move(f.to) })) }
}

// Tiện ích trình duyệt: mỗi "môi trường chạy" (background, content script, popup…) là một đơn vị như "tính năng" của web — chỉ nói chuyện với nhau bằng message,
// KHÔNG import nhau; chỉ được dùng lớp chung (shared…). Lớp chung không biết môi trường nào.
const EXT_ENTRY = new Set(['background', 'content', 'popup', 'options', 'sidepanel', 'devtools', 'newtab', 'offscreen', 'sandbox', 'entrypoints'])
const webFeature = (m) => m.name.startsWith('features/')
const extFeature = (m) => webFeature(m) || EXT_ENTRY.has(m.name)

function inferDeps(modules, feature = webFeature) {
  const top = (m) => COMPOSITION.has(m.name)
  const layer = modules.filter((m) => !feature(m) && !top(m)).map((m) => m.name)
  for (const m of modules) m.mayDependOn = top(m) ? modules.filter((x) => x !== m).map((x) => x.name) : layer.filter((n) => n !== m.name)
}

function buildPart(dir, kind, wails, info) {
  const tpl = JSON.parse(readText(path.join(KIT_ARCH, `${kind}.arch.json`))).parts[0]
  const base = { ...tpl, modules: tpl.modules.map((m) => ({ ...m })), shared: [...(tpl.shared ?? [])], forbidden: tpl.forbidden.map((f) => ({ ...f })) }
  const webRoot = stackRoots(dir).web
  const pkg = kind === 'go' ? '' : webRoot ? slash(path.relative(dir, webRoot)) : wails ? 'frontend' : ''
  const candidates = kind === 'go' ? ['internal', 'backend', 'pkg'] : kind === 'extension' ? ['src', 'entrypoints'] : ['src', 'app']
  const join = (c) => normRel(pkg ? `${pkg}/${c}` : c)
  const found = candidates.map(join).find((c) => hasSource(path.join(dir, c), SRC_EXT[kind]))
  const part = retarget(base, found ?? join(candidates[0]))
  const units = realUnits(dir, part)
  if (!units) return part
  const tplDesc = new Map(tpl.modules.map((m) => [m.name, m.desc]))
  part.modules = units.map((u) => ({ name: u, path: `${part.root}/${u}`, desc: tplDesc.get(u) ?? PLACEHOLDER, mayDependOn: [] }))
  part.shared = units.includes('shared') && kind !== 'go' ? [`${part.root}/shared`] : []
  if (kind !== 'go') inferDeps(part.modules, kind === 'extension' ? extFeature : webFeature)
  if (units.length) info.push(`Phần ${part.name}: đã suy ${units.length} module từ thư mục — soát lại mô tả và mayDependOn trong docs/arch.json.`)
  return part
}

function archMarkdown(arch) {
  const lines = arch.parts.flatMap((p) => p.modules.map((m) => `- \`${m.path}\` — ${m.desc || PLACEHOLDER}`))
  const tpl = readText(path.join(KIT_ARCH, 'ARCHITECTURE.md'))
  const body = lines.length ? lines.join('\n') : '<!-- chưa có module: thêm mỗi module một dòng ở đây -->'
  return tpl.replace(/<!-- codemap:start -->[\s\S]*?<!-- codemap:end -->/, () => `<!-- codemap:start -->\n${body}\n<!-- codemap:end -->`)
}

export function init(dir, { stack } = {}) {
  const written = []
  const kept = []
  const notes = []
  let arch
  if (isFile(path.join(dir, ARCH_FILE))) {
    kept.push({ file: ARCH_FILE, why: `${ARCH_FILE} đã có — giữ nguyên, không ghi đè.` })
    arch = loadArch(dir).arch
  } else {
    const { kinds, wails } = stackList(dir, stack)
    const parts = kinds.map((k) => buildPart(dir, k, wails, notes))
    arch = { $comment: GENERIC_NOTE, version: 1, parts }
    writeText(dir, ARCH_FILE, `${JSON.stringify(arch, null, 2)}\n`)
    written.push(ARCH_FILE)
  }
  const md = archMdRel(dir)
  if (md) kept.push({ file: md, why: `${md} đã có — giữ nguyên, không ghi đè.` })
  else if (arch) { writeText(dir, 'docs/ARCHITECTURE.md', archMarkdown(arch)); written.push('docs/ARCHITECTURE.md') }
  return { written, kept, notes, arch }
}

// --- gen: sinh cấu hình công cụ ----------------------------------------------------------------------------------------------------------

function genWrite(dir, rel, text, res, mark) {
  const old = readText(path.join(dir, rel))
  if (old !== null && !old.includes('Sinh bởi: node ~/.claude/hooks/arch.mjs gen')) {
    res.kept.push({ file: rel, why: `${rel} đã có và không phải do kit sinh — giữ nguyên (muốn dùng luật của kit: xoá file rồi chạy lại gen).` })
    return false
  }
  writeText(dir, rel, `${mark} ${MARK}\n${text}`)
  res.written.push(rel)
  return true
}

function nearestTsconfig(dir, parts) {
  for (const part of parts) {
    for (let d = path.resolve(dir, part.root); ; d = path.dirname(d)) {
      if (isFile(path.join(d, 'tsconfig.json'))) return slash(path.relative(dir, path.join(d, 'tsconfig.json')))
      if (d === path.resolve(dir) || path.dirname(d) === d) break
    }
  }
  return null
}

function depcruiseConfig(dir, parts) {
  const forbidden = [
    { name: 'no-circular', severity: 'error', comment: 'Hai file import vòng tròn nhau. Cách sửa: tách phần dùng chung của chúng ra file thứ ba, rồi cả hai cùng import file đó.', from: {}, to: { circular: true } },
    { name: 'not-to-unresolvable', severity: 'error', comment: 'Import một file hoặc gói không tìm thấy. Cách sửa: sửa lại đường dẫn import, hoặc cài gói còn thiếu bằng npm i.', from: {}, to: { couldNotResolve: true, pathNot: ['^virtual:', '^cloudflare:', '^astro:', '^node:', '^bun:', '\\?(raw|url|inline|worker)$'] } },
  ]
  for (const part of parts) {
    const byName = new Map(part.modules.map((m) => [m.name, m]))
    const sharedMods = part.modules.filter((m) => part.shared.includes(m.path))
    for (const m of part.modules) {
      const okPaths = new Set([m.path, ...m.mayDependOn.map((n) => byName.get(n).path), ...part.shared])
      const others = part.modules.filter((x) => !okPaths.has(x.path))
      if (!others.length) continue
      const allowed = [...new Set([...m.mayDependOn, ...sharedMods.map((x) => x.name)])].filter((n) => n !== m.name)
      forbidden.push({
        name: `arch-${slug(part.name)}-${slug(m.name)}`,
        severity: 'error',
        comment: `Module "${m.name}" (${m.path}) không được import ${others.map((x) => `"${x.name}"`).join(', ')}. Chỉ được dùng: ${allowed.length ? allowed.join(', ') : 'chính nó'} (docs/arch.json: mayDependOn). Cách sửa: chuyển phần dùng chung xuống shared, hoặc đi qua hàm/sự kiện của module kia thay vì import thẳng; nếu quan hệ này thật sự cần thì sửa mayDependOn trong docs/arch.json — phải hỏi người dùng trước.`,
        from: { path: `^${esc(m.path)}/` },
        to: { path: `^(${others.map((x) => esc(x.path)).join('|')})/` },
      })
    }
    part.forbidden.forEach((f, i) => forbidden.push({
      name: `arch-${slug(part.name)}-cam-${i + 1}`,
      severity: 'error',
      comment: advice(f),
      from: { path: globToRegex(f.from) },
      to: { path: globToRegex(f.to, { anywhere: f.to.startsWith('node_modules/') }) },
    }))
  }
  const options = { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true, enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'] } }
  const ts = nearestTsconfig(dir, parts)
  if (ts) options.tsConfig = { fileName: ts }
  return { forbidden, options }
}

// Mã JS của cấu hình depcruise. tsConfig.fileName dựng từ __dirname (thư mục chứa file cấu hình = gốc dự án) thành đường dẫn tuyệt đối LÚC CHẠY: lệnh chạy ở gốc dự án mà tsconfig
// nằm trong thư mục của phần (Wails: frontend/tsconfig.json) thì đường dẫn tương đối làm depcruise cài riêng trong frontend/ báo TS18003 "No inputs were found"; đường dẫn tuyệt đối thì đúng,
// mà file commit lên git vẫn không dính đường dẫn của máy nào.
function depcruiseSource(cfg) {
  const ts = cfg.options.tsConfig?.fileName
  if (!ts) return JSON.stringify(cfg, null, 2)
  const marked = { ...cfg, options: { ...cfg.options, tsConfig: { fileName: '__TSCONFIG__' } } }
  return JSON.stringify(marked, null, 2).replace('"__TSCONFIG__"', () => `require('node:path').join(__dirname, ${JSON.stringify(ts)})`)
}

const yq = (s) => JSON.stringify(s)
const yKey = (s) => (/^[A-Za-z0-9_.-]+$/.test(s) ? s : yq(s))

// Thư mục con có file .go (không tính _test.go) của một miền, đường dẫn tính từ workdir, sắp xếp.
function goPackageDirs(dir, rel, workdir) {
  const out = []
  const rec = (relDir) => {
    for (const e of readDir(path.join(dir, workdir, relDir))) {
      if (!e.isDirectory() || skipDir(e.name)) continue
      const sub = `${relDir}/${e.name}`
      if (readDir(path.join(dir, workdir, sub)).some((f) => f.isFile() && f.name.endsWith('.go') && !f.name.endsWith('_test.go'))) out.push(sub)
      rec(sub)
    }
  }
  rec(rel)
  return out.sort()
}

// `in` liệt kê thư mục con có code RÕ RÀNG ngoài `<miền>/**`: go-arch-lint trên Windows ghép đường dẫn import của thư mục con do `**` sinh ra bằng dấu \ nên
// mayDependOn không khớp (báo sai "shouldn't depend"); thư mục liệt kê rõ thì đúng ở mọi hệ điều hành. `**` vẫn giữ để gói mới thêm sau không thành "file chưa thuộc module nào".
// deps: công cụ bắt buộc có khối này, mỗi mục phải có ít nhất một mục trong mayDependOn, và import giữa các gói của CÙNG một miền (store → domain…) cũng chỉ
// được phép khi miền có tên mình trong mayDependOn ⇒ mỗi miền luôn tự liệt kê chính nó (đã kiểm với go-arch-lint 1.19.0).
function goArchLintYaml(dir, part) {
  const rel = (p) => (p === part.root ? '.' : p.slice(part.root.length + 1))
  const L = ['# Vi phạm = sửa code cho đúng hướng phụ thuộc; muốn cho phép thì sửa mayDependOn trong docs/arch.json (phải hỏi người dùng).', '# Thêm/đổi tên/xoá thư mục Go trong một miền ⇒ chạy lại: node ~/.claude/hooks/arch.mjs gen', 'version: 3', `workdir: ${/^[\w./-]+$/.test(part.root) ? part.root : yq(part.root)}`, 'allow:', '  depOnAnyVendor: true', 'excludeFiles:', "  - '^.*_test\\.go$'", 'components:']
  for (const m of part.modules) {
    const base = rel(m.path)
    L.push(`  ${yKey(m.name)}:`, '    in:', ...[base, ...goPackageDirs(dir, base, part.root), `${base}/**`].map((g) => `      - ${/^[\w./-]+$/.test(g) ? g : yq(g)}`))
  }
  const common = part.modules.filter((m) => part.shared.includes(m.path)).map((m) => m.name)
  if (common.length) L.push('commonComponents:', ...common.map((n) => `  - ${yKey(n)}`))
  L.push('deps:')
  for (const m of part.modules) L.push(`  ${yKey(m.name)}:`, '    mayDependOn:', ...[m.name, ...m.mayDependOn].map((n) => `      - ${yKey(n)}`))
  return `${L.join('\n')}\n`
}

function goModule(dir) {
  const m = /^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod')) ?? '')
  return m ? m[1].replace(/^"|"$/g, '') : null
}

// Mở rộng `to` của luật Go thành các tiền tố import (depguard chỉ so tiền tố): {a,b} tách ra, `<root>/*` thành từng miền, đường dẫn trong dự án nối tên module go.mod.
function depguardTargets(part, to, modPath) {
  const out = []
  for (const g of expandBraces(to.replace(/\/\*\*$/, ''))) {
    const local = g === part.root || g.startsWith(`${part.root}/`)
    const list = local && g.startsWith(`${part.root}/*`) ? part.modules.filter((m) => m.path.split('/').length === part.root.split('/').length + 1).map((m) => g.replace(`${part.root}/*`, m.path)) : [g]
    for (const p of list) if (!/[*?]/.test(p)) out.push(local ? (modPath ? `${modPath}/${p}` : null) : p)
  }
  return out
}

function golangciYaml(dir, parts, notes) {
  const modPath = goModule(dir)
  const rules = []
  for (const part of parts) {
    part.forbidden.forEach((f, i) => {
      const deny = [...new Set(depguardTargets(part, f.to, modPath))]
      if (deny.includes(null)) notes.push(`Phần ${part.name}: chưa có go.mod nên chưa sinh được luật depguard cho "${f.to}" — chạy go mod init rồi gen lại.`)
      const ok = deny.filter((d) => d !== null)
      if (!ok.length) { if (!deny.length) notes.push(`Phần ${part.name}: luật cấm "${f.from}" → "${f.to}" chưa áp dụng cho miền nào (chưa có module khớp) nên chưa sinh depguard.`); return }
      rules.push(`        arch-${slug(part.name)}-${i + 1}:`, '          files:', ...expandBraces(f.from).map((g) => `            - ${yq(`**/${g}`)}`), '          deny:')
      for (const d of ok) rules.push(`            - pkg: ${yq(d)}`, `              desc: ${yq(advice(f))}`)
    })
  }
  const lines = Math.min(...parts.map((p) => p.limits.fnLines))
  const cx = Math.min(...parts.map((p) => p.limits.complexity))
  const L = ['version: "2"', 'linters:', '  enable:', '    - depguard', '    - funlen', '    - gocyclo', '  settings:']
  if (rules.length) L.push('    depguard:', '      rules:', ...rules)
  L.push('    funlen:', `      lines: ${lines}`, '      statements: -1', '    gocyclo:', `      min-complexity: ${cx}`, '  exclusions:', '    rules:', "      - path: '_test\\.go$'", '        linters:', '          - funlen', '          - gocyclo')
  return `${L.join('\n')}\n`
}

// Chuỗi JS nháy đơn (root đọc từ docs/arch.json không được phá được chuỗi của khối cấu hình mà AI sẽ ghép vào dự án).
const sq = (s) => `'${s.replace(/[\\']/g, '\\$&')}'`

// `ignores` đầu tiên: .dependency-cruiser.cjs do kit sinh dùng `module.exports` nên cấu hình ESLint của dự án (sourceType module) báo 'module' is not defined (no-undef);
// file đó do máy sinh, không phải code của dự án. (`/* global module */` không dùng được: cấu hình commonjs mặc định lại báo no-redeclare.)
function eslintBlock(parts) {
  const cfg = ['  { ignores: [\'.dependency-cruiser.cjs\'] },', ...parts.map((p) => `  {
    files: [${sq(`${p.root}/**/*.{ts,tsx,js,jsx,mjs,cjs}`)}],
    ignores: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: ${p.limits.fnLines}, skipBlankLines: true, skipComments: true }],
      complexity: ['error', ${p.limits.complexity}],
    },
  },`)].join('\n')
  return `// Ghép các mục này vào mảng export của eslint.config.* (kit không ghi đè file có sẵn).\n// Dự án có sẵn: sau khi ghép, chạy arch.mjs baseline để chốt hàm dài/phức tạp cũ (eslint --suppress-rule, cần ESLint >= 9.24).\n${cfg}\n`
}

export function gen(dir) {
  const { arch, errors } = loadArch(dir)
  if (!arch) throw new Error(`${ARCH_FILE} chưa dùng được: ${errors.join(' · ')}`)
  const res = { written: [], kept: [], blocks: [], notes: [] }
  const web = webParts(arch)
  if (web.length) {
    const body = `/** @type {import('dependency-cruiser').IConfiguration} */\nmodule.exports = ${depcruiseSource(depcruiseConfig(dir, web))}\n`
    genWrite(dir, '.dependency-cruiser.cjs', body, res, '//')
    res.blocks.push({ title: 'ESLint (ghép vào eslint.config.*)', text: eslintBlock(web) })
  }
  const go = goParts(arch)
  go.forEach((part, i) => {
    if (!part.modules.length) { res.notes.push(`Phần ${part.name}: chưa có miền nào nên chưa sinh ${archLintFile(i, part)} (thêm miền vào docs/arch.json rồi chạy lại gen).`); return }
    genWrite(dir, archLintFile(i, part), goArchLintYaml(dir, part), res, '#')
  })
  if (go.length) {
    const text = golangciYaml(dir, go, res.notes)
    const existing = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'].find((n) => isFile(path.join(dir, n)))
    if (existing && !(existing === '.golangci.yml' && readText(path.join(dir, existing)).includes('Sinh bởi: node ~/.claude/hooks/arch.mjs gen'))) {
      res.kept.push({ file: existing, why: `${existing} đã có — kit không ghi đè; ghép khối bên dưới vào file này.` })
      res.blocks.push({ title: `golangci-lint (ghép vào ${existing})`, text })
    } else genWrite(dir, '.golangci.yml', text, res, '#')
  }
  return res
}

// --- baseline: chốt mốc cho dự án có sẵn ----------------------------------------------------------------------------------------------------

const needArch = (dir) => {
  const { arch, errors } = loadArch(dir)
  if (!arch) throw new Error(`${ARCH_FILE} chưa dùng được: ${errors.join(' · ')}`)
  return arch
}

// Đối số depcruise (chạy ở cwd): option trước, rồi `--`, rồi mới tới các root quét — root đọc từ docs/arch.json (dữ liệu không tin cậy), sau `--` thì dù có dạng
// "--exclude" cũng chỉ là tên thư mục (commander của depcruise coi mọi thứ sau `--` là đối số vị trí). outputType: err-long (flow-check) | baseline (chốt mốc).
// ignoreKnown: bỏ qua vi phạm cũ đã chốt (KHÔNG dùng khi chốt mốc); đường dẫn mốc đọc từ docs/arch-baseline.json cũng bị kiểm như root.
export function depcruiseArgs(dir, { ignoreKnown = false, outputType = 'err-long' } = {}) {
  const web = webParts(needArch(dir))
  if (!web.length) return null
  const args = ['--config', '.dependency-cruiser.cjs']
  const known = loadBaseline(dir)?.depcruise
  if (ignoreKnown && typeof known === 'string' && nonEmpty(known) && !pathProblem(normRel(known)) && isFile(path.join(dir, known))) args.push('--ignore-known', normRel(known))
  args.push('--output-type', outputType, '--', ...web.map((p) => p.root))
  return { cwd: dir, args }
}

// Phần web có file TypeScript không: depcruise chỉ đọc được .ts/.tsx khi tìm thấy TypeScript của DỰ ÁN (depcruise cài global thì không thấy ⇒ "0 modules cruised").
export function usesTypeScript(dir) {
  const { arch } = loadArch(dir)
  return webParts(arch ?? { parts: [] }).some((p) => sourceFiles(dir, p).some((f) => /\.(?:[cm]?ts|tsx)$/.test(f)))
}

// Lệnh go-arch-lint cho flow-check (mỗi phần Go có miền một lệnh): lọc kết quả bằng newGoArchViolations. exists=false ⇒ chưa gen.
export function goArchLintRuns(dir) {
  return goParts(needArch(dir)).map((part, i) => ({ part, file: archLintFile(i, part), i })).filter((r) => r.part.modules.length)
    .map(({ part, file, i }) => ({ part: part.name, file, exists: isFile(path.join(dir, file)), cwd: dir, args: ['check', '--json', ...(i ? ['--arch-file', file] : [])] }))
}

// Khoá ổn định của vi phạm go-arch-lint, giống nhau giữa các máy: bỏ số dòng/cột (đổi dòng không thành "vi phạm mới"), dấu \ của Windows đổi thành /,
// đầu ra chữ thì bỏ phần đường dẫn tuyệt đối của máy (cắt từ gốc phần Go trở đi). Nhận --json hoặc chữ thường.
const toSlash = (s) => String(s).replace(/\\/g, '/')

function goArchNorm(dir) {
  const roots = goParts(loadArch(dir).arch ?? { parts: [] }).map((p) => p.root)
  const abs = roots.length ? new RegExp(`(?<=^|[\\s'"\`(])(?:[A-Za-z]:)?/(?:[^\\s'"\`]*?/)?(?=(?:${roots.map(esc).join('|')})/)`, 'g') : null
  // khoá dạng JSON (ArchWarnings… | …) chỉ cần đổi dấu \; dòng chữ còn bỏ thêm đường dẫn tuyệt đối và số dòng
  return (k) => {
    const s = toSlash(k).trim()
    return /^ArchWarnings/i.test(s) ? s : (abs ? s.replace(abs, '') : s).replace(/:\d+(?::\d+)*(?=[\s'"`)\]]|$)/g, '').trim()
  }
}

function goArchKeys(output, dir) {
  const norm = goArchNorm(dir)
  const text = String(output ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  const keys = []
  try {
    const j = JSON.parse(text)
    const payload = j?.Payload ?? j
    if (payload && typeof payload === 'object') {
      for (const [k, v] of Object.entries(payload)) {
        if (!/^ArchWarnings/i.test(k) || !Array.isArray(v)) continue
        for (const it of v) {
          const parts = [it?.ComponentName, it?.FileRelativePath, it?.ResolvedImportName].filter((x) => x !== undefined)
          keys.push(norm(`${k} | ${parts.length ? parts.join(' | ') : JSON.stringify(it, (n, x) => (n === 'Reference' ? undefined : x))}`))
        }
      }
      return [...new Set(keys)].sort()
    }
  } catch { /* không phải JSON: đọc chữ thường */ }
  for (const l of text.split('\n')) if (/(shouldn'?t|should not|not (?:match|allowed)|depend)/i.test(l)) keys.push(norm(l))
  return [...new Set(keys)].sort()
}

// Công cụ (dependency-cruiser…) tự từ chối chạy vì phiên bản Node không nằm trong "engines" của nó ⇒ đó là THIẾU môi trường, không phải code sai.
export const nodeEngineMessage = (version) => `Máy kiểm kiến trúc web cần Node 22, Node 24 LTS hoặc Node 26 trở lên; máy đang dùng Node ${version}.`

export function nodeEngineProblem(text) {
  const t = String(text ?? '')
  const m = /your node version \(([^)]+)\) is not supported/i.exec(t)
  if (m) return { version: m[1] }
  return /unsupported engine|ebadengine/i.test(t) ? { version: process.versions.node } : null
}

export function newGoArchViolations(dir, output) {
  const norm = goArchNorm(dir)
  const old = new Set((loadBaseline(dir)?.go?.archLint ?? []).map(norm))
  return goArchKeys(output, dir).filter((k) => !old.has(k))
}

export function baseline(dir, { run = defaultRun } = {}) {
  const arch = needArch(dir)
  const notes = []
  const missing = []
  const miss = (tool) => { if (!missing.some((m) => m.tool === tool)) missing.push({ tool, install: INSTALL[tool] }) }
  const g = run('git', ['rev-parse', 'HEAD'], { cwd: dir })
  const base = g.status === 0 && /^[0-9a-f]{7,64}$/.test(String(g.stdout).trim()) ? String(g.stdout).trim() : null
  if (!base) notes.push('Chưa lấy được commit hiện tại (dự án chưa là repo git hoặc chưa commit): mốc "base"/"newFromRev" để trống. Commit xong chạy lại arch.mjs baseline.')
  const over = []
  for (const part of arch.parts) for (const rel of sourceFiles(dir, part)) { const n = overLimit(path.join(dir, rel), part.limits.fileLines); if (n !== null) over.push([rel, n]) }
  const size = Object.fromEntries(over.sort(([a], [b]) => (a < b ? -1 : 1)))

  let depcruise = null
  const web = webParts(arch)
  if (web.length) {
    if (!isFile(path.join(dir, '.dependency-cruiser.cjs'))) notes.push('Chưa có .dependency-cruiser.cjs — chạy arch.mjs gen trước rồi chạy lại baseline.')
    else {
      const r = run('depcruise', depcruiseArgs(dir, { outputType: 'baseline' }).args, { cwd: dir, timeoutMs: 300_000, from: [...new Set(web.map((p) => packageDir(dir, p)))] })
      const engine = r.error ? null : nodeEngineProblem(`${r.stdout}\n${r.stderr}`)
      if (r.error?.code === 'ENOENT') miss('depcruise')
      else if (engine) missing.push({ tool: 'depcruise', install: null, why: nodeEngineMessage(engine.version) })
      else {
        let list = null
        try { list = JSON.parse(r.stdout) } catch { /* báo bên dưới */ }
        if (Array.isArray(list)) { writeText(dir, KNOWN_FILE, `${JSON.stringify(list, null, 2)}\n`); depcruise = KNOWN_FILE } else notes.push(`depcruise không xuất được danh sách vi phạm cũ: ${oneLine(r.stderr || r.stdout || r.error?.message) || `mã thoát ${r.status}`}`)
      }
    }
  }

  let eslint = false
  for (const pd of new Set(web.map((p) => packageDir(dir, p)))) {
    if (!matches({ any: [{ files: ['eslint.config.*', '.eslintrc*'] }, { deps: ['eslint'] }, { pkgKeys: ['eslintConfig'] }] }, pd)) continue
    const r = run('eslint', ['--suppress-rule', 'max-lines-per-function', '--suppress-rule', 'complexity', '--', '.'], { cwd: pd, timeoutMs: 600_000 })
    if (r.error?.code === 'ENOENT') miss('eslint')
    else if (isFile(path.join(pd, 'eslint-suppressions.json'))) eslint = true
    else if (/invalid option|unknown option|unrecognized|unexpected/i.test(`${r.stderr}${r.stdout}`)) notes.push('ESLint quá cũ để chốt mốc (cần bản >= 9.24 có --suppress-rule): nâng cấp bằng npm i -D eslint@latest rồi chạy lại baseline.')
  }

  let go = null
  if (goParts(arch).length) {
    go = { newFromRev: base, archLint: [] }
    for (const lintRun of goArchLintRuns(dir)) {
      if (!lintRun.exists) { notes.push(`Chưa có ${lintRun.file} — chạy arch.mjs gen trước rồi chạy lại baseline.`); continue }
      const r = run('go-arch-lint', lintRun.args, { cwd: lintRun.cwd, timeoutMs: 300_000 })
      if (r.error?.code === 'ENOENT') miss('go-arch-lint')
      else go.archLint.push(...goArchKeys(r.stdout || r.stderr, dir))
    }
    go.archLint = [...new Set(go.archLint)].sort()
  }

  const data = { base, size, depcruise, go, eslint }
  writeText(dir, BASELINE_FILE, `${JSON.stringify(data, null, 2)}\n`)
  return { file: BASELINE_FILE, data, notes, missing }
}

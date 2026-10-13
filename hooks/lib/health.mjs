// health: lõi cho hooks/health.mjs — "khám sức khoẻ" một dự án app (SPEC AC-50; research.md §6; PLAN làn F).
//
//   const report = await collect({ dir, run, which, now?, platform? })   // chạy các máy kiểm, KHÔNG ghi gì vào dự án
//   const saved  = recordHealth(dir, report, { write? })                  // docs/HEALTH.md + health.lastAt (qua lib/release-state)
//   Lõi thuần: compare · renderHealth · parseSnapshot · summarize · todoList · docFiles · scanDebt · docPathProblems
//
// Công cụ ngoài đi qua hai hàm tiêm được (test dùng bản giả; lib không tự spawn):
//   run(file, args, { cwd?, timeoutMs }) → { code, stdout, stderr, timedOut, error }   (đồng bộ hoặc Promise)
//   which(name, { cwd, platform })       → đường dẫn | null
//
// Mỗi mục khám = { id, title, level: 'red'|'yellow'|'green'|'unchecked', summary, detail: [dòng], todo?: việc nên làm, why?: lý do chưa kiểm, n?: số lượng }.
//   - Máy kiểm sẵn có của flow-check: chạy MỘT lần `flow-check --json` với danh sách checker rút gọn (kit/checkers.json lọc theo FLOW_IDS,
//     ghi vào file tạm) ⇒ dùng đúng bộ máy/bản cài/planner của flow-check, không viết lại. Lỗ hổng thư viện + kiến trúc lệch ⇒ ĐỎ; còn lại không đạt ⇒ VÀNG.
//   - Thêm: npm-check-updates (thư viện lỗi thời), lychee (liên kết hỏng trong docs), scc + git log (điểm nóng), đếm nợ kỹ thuật, tài liệu nhắc file không còn.
//   - Thiếu công cụ ⇒ 'unchecked' kèm "chưa kiểm được: <công cụ> (<lệnh cài>)" — KHÔNG đỏ, KHÔNG cài ngầm. Không công cụ nào ở đây tốn tiền.
//
// docs/HEALTH.md do máy ghi lại mỗi lần khám; cuối file có một dòng <!-- flow-health {…} --> để lần sau so (tốt lên / tệ đi).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateState } from './release-state.mjs'

export const HEALTH_REL = 'docs/HEALTH.md'
export const FLOW_IDS = ['jscpd', 'knip', 'depcruise', 'go-arch-lint', 'arch-sync', 'arch-size', 'size-limit', 'osv-scanner', 'govulncheck']
const RED_IDS = new Set(['osv-scanner', 'govulncheck', 'depcruise', 'go-arch-lint', 'arch-sync'])
const FLOW_TODO = {
  jscpd: 'Gộp các đoạn code trùng lặp thành một hàm dùng chung',
  knip: 'Xoá file, export hoặc thư viện không dùng mà knip liệt kê',
  depcruise: 'Sửa import lệch ranh giới module theo lời dặn của máy kiểm',
  'go-arch-lint': 'Sửa import Go lệch ranh giới module theo lời dặn của máy kiểm',
  'arch-sync': 'Cập nhật docs/arch.json và Codemap cho khớp thư mục code',
  'arch-size': 'Tách các file quá dài thành file nhỏ, mỗi file một việc',
  'size-limit': 'Giảm dung lượng bản build (bỏ thư viện nặng, nạp trễ) hoặc đặt ngưỡng size-limit',
  'osv-scanner': 'Nâng thư viện có lỗ hổng lên bản đã vá (hỏi bạn trước khi cập nhật, không tự cập nhật)',
  govulncheck: 'Nâng thư viện hoặc bản Go có lỗ hổng lên bản đã vá (hỏi bạn trước khi cập nhật)',
}
const INSTALL = {
  ncu: 'npm i -g npm-check-updates',
  lychee: { win32: 'scoop install lychee', posix: 'brew install lychee' },
  scc: { win32: 'scoop install scc', posix: 'brew install scc' },
}
const KIT_DIR = fileURLToPath(new URL('../../kit', import.meta.url))
const FLOW_CHECK = fileURLToPath(new URL('../flow-check.mjs', import.meta.url))

const FLOW_TIMEOUT_MS = 20 * 60 * 1000
const NCU_TIMEOUT_MS = 3 * 60 * 1000
const LYCHEE_TIMEOUT_MS = 5 * 60 * 1000
const SCC_TIMEOUT_MS = 2 * 60 * 1000
const GIT_TIMEOUT_MS = 30 * 1000
const HOT_DAYS = 90 // điểm nóng: số lần sửa trong chừng này ngày gần nhất
const HOT_CHURN = 5 // sửa ≥ chừng này lần …
const HOT_COMPLEXITY = 40 // … và độ phức tạp (scc) ≥ chừng này ⇒ điểm nóng (vàng)
const TODO_YELLOW = 20 // ≥ chừng này chỗ TODO/FIXME/HACK ⇒ vàng
const MAX_LISTED = 6 // số dòng chi tiết tối đa mỗi mục
const MAX_DOC_FILES = 150
const MAX_WALK = 20000
const MAX_FILE_BYTES = 512 * 1024
const WALK_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'worktrees', '__pycache__'])
const GENERATED_ROOTS = new Set(['dist', 'build', 'out', 'coverage', 'node_modules', 'vendor', 'target'])
const CODE_RE = /\.(?:[cm]?[jt]sx?|go|py|vue|svelte)$/i
const JS_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[^/]+$|_test\.go$|(?:^|\/)(?:__tests__|tests?|e2e)\/)/i
const TODO_RE = /(?:\/\/|#|\/\*|^\s*\*|<!--).*\b(?:TODO|FIXME|HACK)\b/
const SKIP_RE = /\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|\bt\.Skip(?:f|Now)?\s*\(|\bskip\s*:\s*true\b|@(?:pytest\.mark|unittest)\.skip/
const TSIGNORE_RE = /@ts-(?:ignore|nocheck)\b/
const LEVEL_VI = { red: 'đỏ', yellow: 'vàng', green: 'xanh', unchecked: 'chưa kiểm được' }
const RANK = { green: 0, yellow: 1, red: 2 }

// ---------- tiện ích nhỏ ----------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const posix = (p) => p.split(path.sep).join('/')
const exists = (p) => { try { fs.statSync(p); return true } catch { return false } }
const oneLine = (s, max = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const installFor = (spec, platform) => (typeof spec === 'string' ? spec : spec[platform] ?? (platform === 'win32' ? spec.win32 : spec.posix))

// JSON có thể kèm chữ thừa quanh (cảnh báo của công cụ): thử từ ký tự mở xuất hiện sớm hơn (mảng hay object).
function parseJson(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim()
  const cands = [['{', '}'], ['[', ']']].map(([o, c]) => [t.indexOf(o), t.lastIndexOf(c)]).filter(([a, b]) => a >= 0 && b > a).sort((x, y) => x[0] - y[0])
  for (const [a, b] of cands) {
    try { return JSON.parse(t.slice(a, b + 1)) } catch { /* thử kiểu kế */ }
  }
  return null
}

const whyFailed = (r) => (r.timedOut ? 'quá thời gian chờ' : r.error ? oneLine(r.error.message || r.error.code || 'không chạy được', 100) : oneLine(firstLine(r.stderr) || firstLine(r.stdout) || `mã thoát ${r.code}`, 100))

function item(id, title, level, extra = {}) {
  return { id, title, level, summary: '', detail: [], ...extra }
}

function missingTool(id, title, tool, install) {
  return item(id, title, 'unchecked', { why: `chưa kiểm được: ${tool}${install ? ` (${install})` : ''}` })
}

function notRun(id, title, tool, r) {
  return item(id, title, 'unchecked', { why: `chưa kiểm được: ${tool} chạy lỗi (${whyFailed(r)})` })
}

// Một mục khám không bao giờ làm hỏng cả lần khám.
async function guard(id, title, fn) {
  try {
    return await fn()
  } catch (e) {
    return [item(id, title, 'unchecked', { why: `chưa kiểm được: lỗi nội bộ khi chạy (${oneLine(e?.message, 100)})` })]
  }
}

// ---------- duyệt file ----------

// Bỏ thư mục bắt đầu bằng "." và các thư mục sinh ra (node_modules, dist…); không đi theo symlink.
function walk(root, visit) {
  let seen = 0
  const rec = (dir) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      if (seen >= MAX_WALK) return
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !WALK_SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name))
      } else if (e.isFile()) {
        seen++
        visit(path.join(dir, e.name))
      }
    }
  }
  rec(root)
}

function readText(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}

// Tài liệu để kiểm liên kết + đường dẫn: README/CLAUDE/AGENTS ở gốc và docs/**/*.md. Bỏ docs/specs (spec/plan nhắc cả file CHƯA tồn tại vì đang lên kế hoạch),
// docs/adr (ghi lại lịch sử, đường dẫn cũ là bình thường) và chính HEALTH.md. Trả đường dẫn tương đối dùng dấu "/".
export function docFiles(root) {
  const out = ['README.md', 'CLAUDE.md', 'AGENTS.md'].filter((f) => exists(path.join(root, f)))
  const docs = path.join(root, 'docs')
  const rec = (dir) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      const abs = path.join(dir, e.name)
      const rel = posix(path.relative(root, abs))
      if (e.isDirectory()) {
        if (!['specs', 'adr', 'node_modules'].includes(e.name)) rec(abs)
      } else if (e.isFile() && /\.md$/i.test(e.name) && rel !== HEALTH_REL) out.push(rel)
    }
  }
  rec(docs)
  return out.slice(0, MAX_DOC_FILES)
}

// ---------- máy kiểm của flow-check ----------

// flow-check ghi lệnh cài kiểu "Cài: <lệnh> (<link>)" (có thể nhiều cách nối bằng "|") ⇒ chỉ giữ lệnh.
const cleanFix = (fix) => String(fix ?? '').split('|').map((p) => p.replace(/^\s*Cài:\s*/i, '').replace(/\s*\(https?:\/\/[^)]*\)\s*$/, '').trim()).filter(Boolean).join(' | ')

// osv-scanner thoát 128 = không thấy file khoá nào (chưa soát được, KHÔNG phải có lỗ hổng); 127 = lỗi chung của công cụ ⇒ không được báo đỏ.
function osvSpecial(r, title) {
  const msg = String(r.message ?? '')
  if (/mã thoát 128\b/.test(msg) || (Array.isArray(r.detail) && r.detail.some((d) => /No package sources found/i.test(String(d))))) {
    return item(r.id, title, 'yellow', {
      summary: 'chưa soát được lỗ hổng vì dự án thiếu file khoá (package-lock.json, pnpm-lock.yaml hoặc yarn.lock)',
      todo: 'Tạo file khoá thư viện (vd chạy npm install) rồi khám lại để soát lỗ hổng',
    })
  }
  if (/mã thoát 127\b/.test(msg)) return item(r.id, title, 'unchecked', { why: 'chưa kiểm được: osv-scanner chạy lỗi (mã thoát 127)' })
  return null
}

function fromFlowResult(r) {
  if (!isObj(r) || !FLOW_IDS.includes(r.id)) return null
  const title = String(r.title || r.id)
  if (r.status === 'pass') return item(r.id, title, 'green', { summary: oneLine(r.message) || 'đạt' })
  if (r.status === 'missing') {
    const tool = oneLine(String(r.message ?? '').replace(/^Chưa cài\s+/i, ''), 80) || r.id
    return missingTool(r.id, title, tool, oneLine(cleanFix(r.fix), 160))
  }
  if (r.status !== 'fail') return null // skip (không áp dụng cho dự án này) hoặc lạ ⇒ không đưa vào báo cáo
  if (r.id === 'osv-scanner') { const s = osvSpecial(r, title); if (s) return s }
  return item(r.id, title, RED_IDS.has(r.id) ? 'red' : 'yellow', {
    summary: oneLine(r.message),
    detail: (Array.isArray(r.detail) ? r.detail : []).slice(0, 4).map((d) => oneLine(d, 200)),
    todo: FLOW_TODO[r.id] ?? `Sửa theo lời dặn của "${title}"`,
  })
}

async function checkFlow(c, { kitDir, flowCheck, nodeBin }) {
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(path.join(kitDir, 'checkers.json'), 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    return [item('flow-check', 'Máy kiểm chung của kit', 'unchecked', { why: `chưa kiểm được: không đọc được kit/checkers.json (${oneLine(e.message, 80)})` })]
  }
  const checkers = (Array.isArray(registry?.checkers) ? registry.checkers : []).filter((x) => FLOW_IDS.includes(x?.id))
  const file = path.join(c.tmp, 'checkers.health.json')
  fs.writeFileSync(file, JSON.stringify({ version: registry.version ?? 1, checkers }))
  const r = await c.run(nodeBin, [flowCheck, '--dir', c.root, '--checkers', file, '--json'], { timeoutMs: FLOW_TIMEOUT_MS })
  const rep = parseJson(r.stdout)
  if (!isObj(rep) || !Array.isArray(rep.results)) return [notRun('flow-check', 'Máy kiểm chung của kit', 'flow-check', r)]
  return rep.results.map(fromFlowResult).filter(Boolean)
}

// ---------- thư viện lỗi thời (npm-check-updates) ----------

const majorOf = (v) => {
  const m = /\d+/.exec(String(v ?? ''))
  return m ? Number(m[0]) : null
}

async function checkOutdated(c) {
  const where = [c.root, path.join(c.root, 'frontend')].find((d) => exists(path.join(d, 'package.json')))
  if (!where) return []
  const title = 'Thư viện đã lỗi thời (npm-check-updates)'
  const tool = (await c.which('ncu', { cwd: where, platform: c.platform })) ?? (await c.which('npm-check-updates', { cwd: where, platform: c.platform }))
  if (!tool) return [missingTool('outdated', title, 'npm-check-updates', INSTALL.ncu)]
  const r = await c.run(tool, ['--jsonUpgraded'], { cwd: where, timeoutMs: NCU_TIMEOUT_MS })
  const up = parseJson(r.stdout) ?? (!r.error && !r.timedOut && r.code === 0 && !r.stdout.trim() ? {} : null)
  if (!isObj(up)) return [notRun('outdated', title, 'npm-check-updates', r)]
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(where, 'package.json'), 'utf8').replace(/^﻿/, '')) } catch { /* không đọc được: bỏ phần so bản lớn */ }
  const have = { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  const rows = Object.entries(up).map(([name, next]) => {
    const cur = have[name]
    const major = majorOf(cur) !== null && majorOf(next) !== null && majorOf(next) > majorOf(cur)
    return { name, cur, next, major }
  }).sort((a, b) => Number(b.major) - Number(a.major) || (a.name < b.name ? -1 : 1))
  if (!rows.length) return [item('outdated', title, 'green', { n: 0, summary: 'mọi thư viện đều là bản mới nhất' })]
  const big = rows.filter((x) => x.major).length
  return [item('outdated', title, 'yellow', {
    n: rows.length,
    summary: `${rows.length} thư viện có bản mới${big ? ` (${big} bản lớn)` : ''}`,
    detail: rows.slice(0, MAX_LISTED).map((x) => `${x.name} ${x.cur ?? '?'} → ${x.next}${x.major ? ' (bản lớn)' : ''}`),
    todo: `Cập nhật ${rows.length} thư viện lỗi thời${big ? ` (${big} bản lớn: thử riêng từng cái)` : ''} — hỏi bạn trước khi cập nhật`,
  })]
}

// ---------- liên kết hỏng trong tài liệu (lychee) ----------

async function checkLinks(c) {
  const files = docFiles(c.root)
  if (!files.length) return []
  const title = 'Liên kết hỏng trong tài liệu (lychee)'
  const tool = await c.which('lychee', { cwd: c.root, platform: c.platform })
  if (!tool) return [missingTool('links', title, 'lychee', installFor(INSTALL.lychee, c.platform))]
  const out = path.join(c.tmp, 'lychee.json')
  const r = await c.run(tool, ['--no-progress', '--max-retries', '1', '--timeout', '15', '--format', 'json', '--output', out, ...files], { cwd: c.root, timeoutMs: LYCHEE_TIMEOUT_MS })
  if (r.error || r.timedOut || (r.code !== 0 && r.code !== 2)) return [notRun('links', title, 'lychee', r)]
  const rep = parseJson(readText(out) ?? r.stdout)
  const map = isObj(rep) ? (rep.fail_map ?? rep.error_map ?? {}) : {}
  const rows = []
  for (const [file, list] of Object.entries(isObj(map) ? map : {})) {
    for (const l of Array.isArray(list) ? list : []) rows.push(`${posix(String(file))}: ${oneLine(l?.url, 120)}${l?.status?.text ? ` (${oneLine(l.status.text, 40)})` : ''}`)
  }
  const n = rows.length || (r.code === 2 ? Number(rep?.errors) || 1 : 0)
  if (!n) return [item('links', title, 'green', { n: 0, summary: `không thấy liên kết hỏng (${files.length} file tài liệu)` })]
  return [item('links', title, 'yellow', { n, summary: `${n} liên kết hỏng`, detail: rows.slice(0, MAX_LISTED), todo: `Sửa hoặc bỏ ${n} liên kết hỏng trong tài liệu` })]
}

// ---------- điểm nóng (scc + git log) ----------

async function checkHotspots(c) {
  if (!exists(path.join(c.root, '.git'))) return []
  const title = 'Điểm nóng: file hay sửa mà phức tạp (scc + git)'
  const tool = await c.which('scc', { cwd: c.root, platform: c.platform })
  if (!tool) return [missingTool('hotspots', title, 'scc', installFor(INSTALL.scc, c.platform))]
  const g = await c.run('git', ['-c', 'core.quotepath=false', '-C', c.root, 'log', `--since=${HOT_DAYS}.days`, '--no-merges', '-n', '400', '--name-only', '--pretty=format:'], { timeoutMs: GIT_TIMEOUT_MS })
  if (g.error || g.timedOut || g.code !== 0) return [notRun('hotspots', title, 'git log', g)]
  const churn = new Map()
  for (const l of String(g.stdout).split(/\r?\n/)) {
    const f = l.trim()
    if (f) churn.set(f, (churn.get(f) ?? 0) + 1)
  }
  const out = path.join(c.tmp, 'scc.json')
  const r = await c.run(tool, ['--by-file', '-f', 'json', '--exclude-dir', '.git,.hg,.svn,node_modules,dist,build,.output,vendor,worktrees', '--output', out, '.'], { cwd: c.root, timeoutMs: SCC_TIMEOUT_MS })
  if (r.error || r.timedOut || r.code !== 0) return [notRun('hotspots', title, 'scc', r)]
  const rep = parseJson(readText(out) ?? r.stdout)
  if (!Array.isArray(rep)) return [notRun('hotspots', title, 'scc', { ...r, stderr: 'không đọc được kết quả JSON' })]
  const rows = []
  for (const lang of rep) {
    for (const f of Array.isArray(lang?.Files) ? lang.Files : []) {
      const loc = String(f.Location ?? f.Filename ?? '')
      const rel = (c.platform === 'win32' ? loc.replace(/\\/g, '/') : loc).replace(/^\.\//, '') // theo máy đang khám, không theo máy chạy test
      const times = churn.get(rel) ?? 0
      const cx = Number(f.Complexity) || 0
      if (rel && times >= 2 && cx > 0 && !TEST_FILE_RE.test(rel)) rows.push({ rel, times, cx, score: times * cx })
    }
  }
  rows.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1))
  const top = rows.slice(0, MAX_LISTED).map((x) => `${x.rel} — sửa ${x.times} lần trong ${HOT_DAYS} ngày, độ phức tạp ${x.cx}`)
  const hot = rows.filter((x) => x.times >= HOT_CHURN && x.cx >= HOT_COMPLEXITY)
  if (!hot.length) return [item('hotspots', title, 'green', { n: 0, summary: 'không có file nào vừa hay sửa vừa phức tạp', detail: top })]
  return [item('hotspots', title, 'yellow', {
    n: hot.length,
    summary: `${hot.length} file hay sửa mà phức tạp`,
    detail: top,
    todo: `Tách nhỏ hoặc viết test cho ${hot.length} file hay sửa mà phức tạp (đỉnh: ${hot[0].rel})`,
  })]
}

// ---------- nợ kỹ thuật + tài liệu cũ (không cần công cụ ngoài) ----------

// Đếm theo dòng: TODO/FIXME/HACK trong ghi chú, test bị tắt (.skip — chỉ xét file test), @ts-ignore/@ts-nocheck (chỉ file JS/TS).
export function scanDebt(root) {
  const kinds = { todo: { n: 0, at: [] }, skipped: { n: 0, at: [] }, tsIgnore: { n: 0, at: [] } }
  let codeFiles = 0
  let jsFiles = 0
  const hit = (k, rel, line) => { kinds[k].n++; if (kinds[k].at.length < MAX_LISTED) kinds[k].at.push(`${rel}:${line}`) }
  walk(root, (abs) => {
    if (!CODE_RE.test(abs) || /\.min\.|\.d\.ts$/i.test(abs)) return
    const text = readText(abs)
    if (text === null) return
    const rel = posix(path.relative(root, abs))
    const isTest = TEST_FILE_RE.test(rel)
    const isJs = JS_RE.test(abs)
    codeFiles++
    if (isJs) jsFiles++
    text.split(/\r?\n/).forEach((line, i) => {
      if (TODO_RE.test(line)) hit('todo', rel, i + 1)
      if (isTest && SKIP_RE.test(line)) hit('skipped', rel, i + 1)
      if (isJs && TSIGNORE_RE.test(line)) hit('tsIgnore', rel, i + 1)
    })
  })
  return { codeFiles, jsFiles, ...kinds }
}

function checkDebt(root) {
  const d = scanDebt(root)
  if (!d.codeFiles) return []
  // Dưới ngưỡng vàng vẫn có chỗ ⇒ xanh nhưng nói rõ là chưa cần làm (không để người đọc tưởng mục này vô tình nằm ở "ổn").
  const mk = (id, title, k, yellowAt, noun, todo) => item(id, title, k.n >= yellowAt ? 'yellow' : 'green', {
    n: k.n,
    summary: !k.n ? `không có ${noun}` : k.n >= yellowAt ? `${k.n} ${noun}` : `${k.n} ${noun}, dưới ngưỡng ${yellowAt} nên chưa cần làm`,
    detail: k.at,
    todo: k.n >= yellowAt ? `${todo} (${k.n} chỗ)` : undefined,
  })
  const out = [
    mk('todo', 'Ghi chú việc dở (TODO/FIXME/HACK)', d.todo, TODO_YELLOW, 'chỗ ghi việc dở', 'Làm hoặc xoá bớt các ghi chú việc dở'),
    mk('skipped-tests', 'Test đang bị tắt (.skip)', d.skipped, 1, 'test bị tắt', 'Bật lại hoặc xoá các test đang bị tắt'),
  ]
  if (d.jsFiles) out.push(mk('ts-ignore', 'Chỗ tắt kiểm kiểu (@ts-ignore)', d.tsIgnore, 1, 'chỗ tắt kiểm kiểu', 'Sửa đúng kiểu dữ liệu thay cho việc tắt kiểm kiểu'))
  return out
}

// Chuỗi trong dấu `…` trông như đường dẫn file của dự án (có "/", đuôi file hoặc kết thúc "/", không chứa ký tự lạ) → đường dẫn đã bỏ :dòng và #neo; không phải thì null.
export function pathCandidate(raw) {
  const s = String(raw).trim().replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)?$/, '')
  if (!/^[\w@.\-/]+$/.test(s) || !s.includes('/') || s.startsWith('/') || s.includes('//')) return null
  if (!/\.[A-Za-z0-9]{1,8}$/.test(s) && !s.endsWith('/')) return null
  const head = s.replace(/^\.\//, '').split('/')[0]
  if (GENERATED_ROOTS.has(head) || head.startsWith('.')) return null // thư mục sinh ra / ẩn (.output, .claude…): có thể chưa có vì chưa build
  return s
}

// Tài liệu nhắc file/thư mục (trong dấu `…`) mà dự án không còn → [{ doc, ref }] (mỗi cặp một lần).
export function docPathProblems(root) {
  const out = []
  for (const doc of docFiles(root)) {
    const text = readText(path.join(root, doc))
    if (text === null) continue
    const seen = new Set()
    for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) {
      const ref = pathCandidate(m[1])
      if (!ref || seen.has(ref)) continue
      seen.add(ref)
      if (!exists(path.join(root, ref)) && !exists(path.join(root, path.dirname(doc), ref))) out.push({ doc, ref })
    }
  }
  return out
}

function checkDocPaths(root) {
  if (!docFiles(root).length) return []
  const bad = docPathProblems(root)
  const title = 'Tài liệu nhắc file không còn tồn tại'
  if (!bad.length) return [item('docs-paths', title, 'green', { n: 0, summary: 'mọi đường dẫn tài liệu nhắc đều còn' })]
  return [item('docs-paths', title, 'yellow', {
    n: bad.length,
    summary: `${bad.length} chỗ nhắc file không còn`,
    detail: bad.slice(0, MAX_LISTED).map((b) => `${b.doc} nhắc ${b.ref}`),
    todo: `Sửa ${bad.length} chỗ trong tài liệu nhắc file không còn tồn tại`,
  })]
}

// ---------- gom lại ----------

export async function collect({ dir, run, which, now = new Date(), platform = process.platform, kitDir = KIT_DIR, flowCheck = FLOW_CHECK, nodeBin = process.execPath } = {}) {
  const root = path.resolve(dir)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-health-'))
  try {
    // Chuẩn hoá kết quả của run (bản giả trong test có thể thiếu trường).
    const safeRun = async (file, args, o) => {
      const r = (await run(file, args, o)) ?? {}
      return { code: r.code ?? null, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), timedOut: !!r.timedOut, error: r.error ?? null }
    }
    const c = { root, run: safeRun, which, platform, tmp }
    const [flow, outdated, links, hot] = await Promise.all([
      guard('flow-check', 'Máy kiểm chung của kit', () => checkFlow(c, { kitDir, flowCheck, nodeBin })),
      guard('outdated', 'Thư viện đã lỗi thời (npm-check-updates)', () => checkOutdated(c)),
      guard('links', 'Liên kết hỏng trong tài liệu (lychee)', () => checkLinks(c)),
      guard('hotspots', 'Điểm nóng: file hay sửa mà phức tạp (scc + git)', () => checkHotspots(c)),
    ])
    const debt = await guard('debt', 'Nợ kỹ thuật', () => checkDebt(root))
    const docs = await guard('docs-paths', 'Tài liệu nhắc file không còn tồn tại', () => checkDocPaths(root))
    return { dir: root, date: ymd(now), at: now.toISOString(), items: [...flow, ...outdated, ...links, ...hot, ...debt, ...docs] }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* thư mục tạm dọn không được thì thôi */ }
  }
}

export function summarize(items) {
  const n = (lv) => items.filter((i) => i.level === lv).length
  return { red: n('red'), yellow: n('yellow'), green: n('green'), unchecked: n('unchecked') }
}

// Việc nên làm: đỏ trước rồi vàng, mỗi việc một dòng, bỏ trùng.
export function todoList(items) {
  const out = []
  for (const lv of ['red', 'yellow']) {
    for (const i of items) if (i.level === lv) out.push(i.todo || i.title)
  }
  return [...new Set(out)]
}

// ---------- so với lần trước ----------

const SNAP_RE = /<!--\s*flow-health\s+(\{[^\n]*?\})\s*-->/

export function snapshotOf(report) {
  return { date: report.date, items: report.items.map((i) => [i.id, i.level, Number.isFinite(i.n) ? i.n : null]) }
}

// Đọc lại dòng <!-- flow-health … --> của HEALTH.md cũ → { date, items:[{id,level,n}] } | null (không có / hỏng).
export function parseSnapshot(markdown) {
  const m = SNAP_RE.exec(String(markdown ?? ''))
  if (!m) return null
  try {
    const j = JSON.parse(m[1])
    if (typeof j.date !== 'string' || !Array.isArray(j.items)) return null
    const items = j.items.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string' && Object.hasOwn(LEVEL_VI, x[1])).map(([id, level, n]) => ({ id, level, n: Number.isFinite(n) ? n : null }))
    return { date: j.date, items }
  } catch { return null }
}

// → { verdict: 'first'|'better'|'worse'|'mixed'|'same', since, better:[…], worse:[…] }. Mục "chưa kiểm được" không tính tốt hay xấu.
export function compare(prev, report) {
  if (!prev) return { verdict: 'first', since: null, better: [], worse: [] }
  const before = new Map(prev.items.map((i) => [i.id, i]))
  const better = []
  const worse = []
  for (const cur of report.items) {
    if (cur.level === 'unchecked') continue
    const old = before.get(cur.id)
    if (!old) {
      if (cur.level !== 'green') worse.push(`${cur.title}: mục mới, ${LEVEL_VI[cur.level]}`)
      continue
    }
    if (old.level === 'unchecked') continue
    const d = RANK[cur.level] - RANK[old.level]
    if (d !== 0) (d > 0 ? worse : better).push(`${cur.title}: ${LEVEL_VI[old.level]} → ${LEVEL_VI[cur.level]}`)
    else if (cur.level !== 'green' && old.n !== null && Number.isFinite(cur.n) && cur.n !== old.n) (cur.n > old.n ? worse : better).push(`${cur.title}: ${old.n} → ${cur.n}`)
  }
  const verdict = better.length && worse.length ? 'mixed' : better.length ? 'better' : worse.length ? 'worse' : 'same'
  return { verdict, since: prev.date, better, worse }
}

const VERDICT_VI = { first: 'lần khám đầu tiên', better: 'tốt lên', worse: 'tệ đi', mixed: 'có mục tốt lên, có mục tệ đi', same: 'không đổi' }

// ---------- HEALTH.md ----------

export function renderHealth(report, cmp = compare(null, report)) {
  const c = summarize(report.items)
  const L = ['# Sức khoẻ ứng dụng', '', '_Máy tự ghi lại mỗi lần khám; đừng sửa tay._', '']
  L.push(`Khám ngày ${report.date} · đỏ ${c.red} · vàng ${c.yellow} · xanh ${c.green}${c.unchecked ? ` · chưa kiểm được ${c.unchecked}` : ''}`, '')
  L.push(`So với lần trước${cmp.since ? ` (${cmp.since})` : ''}: ${VERDICT_VI[cmp.verdict]}`)
  if (cmp.worse.length) L.push(...cmp.worse.map((x) => `- tệ đi — ${x}`))
  if (cmp.better.length) L.push(...cmp.better.map((x) => `- tốt lên — ${x}`))
  L.push('')
  const section = (lv, head) => {
    const rows = report.items.filter((i) => i.level === lv)
    if (!rows.length) return
    L.push(`## ${head}`, '')
    for (const i of rows) {
      if (lv === 'unchecked') { L.push(`- ${i.why}`); continue }
      L.push(`- **${i.title}** — ${i.summary || (lv === 'green' ? 'ổn' : '')}`.replace(/ — $/, ''))
      if (lv !== 'green') for (const d of i.detail) L.push(`  - ${d}`)
    }
    L.push('')
  }
  section('red', 'Đỏ — nên làm ngay')
  section('yellow', 'Vàng — nên làm')
  section('green', 'Xanh — ổn')
  section('unchecked', 'Chưa kiểm được')
  const todos = todoList(report.items)
  L.push('## Việc nên làm', '')
  if (todos.length) L.push(...todos.map((t, k) => `${k + 1}. ${t}`))
  else L.push('Không có việc gấp.')
  L.push('', `<!-- flow-health ${JSON.stringify(snapshotOf(report))} -->`, '')
  return L.join('\n')
}

// ---------- ghi ----------

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* bỏ qua */ }
    return false
  }
}

// health.lastAt vào .claude/release.json (giữ nguyên mọi trường khác; đọc lại file ngay trước khi ghi nên mốc phát hành/sao lưu ghi trong lúc khám không mất).
// File đang có mà hỏng ⇒ KHÔNG ghi đè. → 'ok'|'corrupt'|'failed'
function markChecked(root, at, stateOpts) {
  const r = updateState(root, (cur) => ({ ...cur, health: { ...(isObj(cur.health) ? cur.health : {}), lastAt: at } }), stateOpts)
  return r.ok ? 'ok' : r.reason === 'corrupt' ? 'corrupt' : 'failed'
}

// Ghi docs/HEALTH.md (so với bản cũ nếu có) + mốc khám. write=false ⇒ chỉ tính, không ghi gì.
// → { file, markdown, cmp, counts, wrote, state: 'ok'|'corrupt'|'failed'|'off' }
export function recordHealth(dir, report, { write = true, stateOpts } = {}) {
  const root = path.resolve(dir)
  const file = path.join(root, ...HEALTH_REL.split('/'))
  const prev = parseSnapshot(readText(file))
  const cmp = compare(prev, report)
  const markdown = renderHealth(report, cmp)
  const out = { file, markdown, cmp, counts: summarize(report.items), wrote: false, state: 'off' }
  if (!write) return out
  out.wrote = writeAtomic(file, markdown)
  out.state = markChecked(root, report.at, stateOpts)
  return out
}

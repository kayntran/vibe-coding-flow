#!/usr/bin/env node
// flow-check: MỘT lệnh máy kiểm theo loại dự án (web / Go / Wails / extension + SAST chung). Spec: docs/specs/2026-10-11-flow-v7-nocode (AC-11, AC-43).
//   node hooks/flow-check.mjs [--dir <thư mục dự án>] [--json] [--checkers <file>] [--base <nhánh chính>]
//   ra bảng ĐẠT / KHÔNG / THIẾU / BỎ QUA + lời dặn sửa tiếng Việt. Exit 0 = đạt · 1 = có checker không đạt hoặc thiếu công cụ BẮT BUỘC · 2 = dùng sai / cấu hình hỏng.
//
// Danh sách checker nằm ở kit/checkers.json (mỗi checker { id, stack, title, cmd|internal, args, detect, requires, passOn, timeoutMs, hint, required, install, plan, quietSkip }).
// Đợt 2 (kiến trúc + chất lượng, hooks/lib/arch.mjs):
//   - `internal` gọi hàm của arch.mjs (arch-sync, arch-size). `plan` (đi với `cmd`) = tên hàm trong PLANNERS quyết định LẦN NÀY chạy gì: bỏ qua có lý do,
//     báo không đạt ngay (thiếu cấu hình), hay chạy một/nhiều lệnh với đối số tính từ docs/arch.json, git, baseline (depcruise, go-arch-lint, oasdiff, squawk, golangci-lint).
//   - `quietSkip: true` = không áp dụng (không có docs/arch.json / openapi / migration) thì KHÔNG hiện dòng BỎ QUA nào (bảng của dự án thường giữ nguyên).
//   - `base` = nhánh chính (--base, mặc định main rồi master): resolveBase() → { ref, sha, fork }; file đổi / bản cũ của openapi tính từ `fork` (điểm tách khỏi nhánh chính).
//     Không xác định được base ⇒ checker cần so thì BỎ QUA kèm lời dặn --base; arch-size xét toàn bộ file (không bỏ sót).
// Hợp đồng:
//   - THIẾU công cụ ⇒ status 'missing' kèm lệnh cài chính thức; KHÔNG cài ngầm, KHÔNG tính là đạt; chỉ chặn (exit 1) khi checker required.
//   - Mỗi checker chạy có timeout (Node, diệt cả cây tiến trình); trên Windows .cmd chạy qua runCommand của lib/clis.mjs (đối số lạ bị từ chối).
//   - Output của công cụ chỉ chép vài dòng đầu, bỏ mã màu; có dấu hiệu khoá bí mật ⇒ không in lại.
//   - Quét khoá trong bản build dùng lib/secrets.mjs (scanDir build:true).
//
// runCommand của lib/clis.mjs không có tuỳ chọn cwd ⇒ execIn() đổi cwd của tiến trình đúng lúc spawn (spawn chạy đồng bộ trong executor
// của Promise) rồi trả lại ngay; vì vậy chạy song song vẫn đúng thư mục. resolveBin của clis.mjs chỉ biết 6 CLI cố định ⇒ findTool() riêng ở đây.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEPCRUISE_PKGS, DEPCRUISE_WHERE, goArchLintRuns, depcruiseArgs, loadArch, loadBaseline, newGoArchViolations, nodeEngineMessage, nodeEngineProblem, sizeCheck, syncCheck, usesTypeScript } from './lib/arch.mjs'
import { runCommand } from './lib/clis.mjs'
import { BUILD_DIRS, scanDir, scanText } from './lib/secrets.mjs'
import { COND_KEYS, STACKS, detect, findManifest, hasDep, matches, readPackageJson, roots } from './lib/stack.mjs'

export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit')
export const DEFAULT_CHECKERS = path.join(KIT_DIR, 'checkers.json')
const KIT_SLASH = KIT_DIR.replace(/\\/g, '/') // dấu / để qua bộ lọc đối số của .cmd trên Windows

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 900_000
const VERSION_TIMEOUT_MS = 15_000
const DETAIL_LINES = 8
const DETAIL_WIDTH = 200
const ADVICE_HEAD = 60
const ADVICE_REASON = 160
const ADVICE_WIDTH = 400
const STACK_LABEL = { web: 'web', extension: 'tiện ích trình duyệt', go: 'Go', wails: 'Wails' }

// --- kiểm cấu hình checkers.json ---------------------------------------------------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9-]*$/
const isStr = (v) => typeof v === 'string' && v.trim() !== ''
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const badRegex = (s) => { try { new RegExp(s); return false } catch { return true } }

function condProblems(cond, p) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return [`${p}: phải là object`]
  const out = []
  for (const [k, v] of Object.entries(cond)) {
    if (!COND_KEYS.includes(k)) out.push(`${p}: khoá lạ "${k}" (hợp lệ: ${COND_KEYS.join(', ')})`)
    else if (['files', 'deps', 'pkgKeys'].includes(k)) { if (!isStrArr(v) || !v.length) out.push(`${p}.${k}: phải là mảng chuỗi không rỗng`) }
    else if (k === 'grep') { if (!v || !isStr(v.file) || !isStr(v.re) || badRegex(v.re)) out.push(`${p}.grep: cần {file, re} với re là regex hợp lệ`) }
    else if (k === 'not') out.push(...condProblems(v, `${p}.not`))
    else if (!Array.isArray(v) || !v.length) out.push(`${p}.${k}: phải là mảng không rỗng`)
    else v.forEach((c, i) => out.push(...condProblems(c, `${p}.${k}[${i}]`)))
  }
  return out
}

// → mảng lỗi (rỗng = hợp lệ). Mỗi lỗi mở đầu bằng id của checker.
export function validateCheckers(obj) {
  if (!obj || !Array.isArray(obj.checkers) || !obj.checkers.length) return ['checkers: phải là mảng không rỗng']
  const out = []
  const seen = new Set()
  obj.checkers.forEach((c, i) => {
    if (!c || typeof c !== 'object') { out.push(`#${i}: không phải object`); return }
    const w = (m) => out.push(`${isStr(c.id) ? c.id : `#${i}`}: ${m}`)
    if (!isStr(c.id) || !ID_RE.test(c.id)) w('id phải là chữ thường, số, gạch ngang')
    else if (seen.has(c.id)) w('id trùng')
    else seen.add(c.id)
    if (![...STACKS, 'all'].includes(c.stack)) w(`stack phải là một trong ${[...STACKS, 'all'].join(', ')}`)
    if (!isStr(c.title)) w('thiếu title')
    if (!isStr(c.hint)) w('thiếu hint (lời dặn sửa)')
    if (typeof c.required !== 'boolean') w('required phải là true hoặc false')
    if ((c.cmd === undefined) === (c.internal === undefined)) w('cần đúng một trong cmd hoặc internal')
    if (c.internal !== undefined && !isStr(c.internal)) w('internal phải là chuỗi')
    if (c.plan !== undefined && (!isStr(c.plan) || c.cmd === undefined)) w('plan phải là chuỗi (tên trong PLANNERS) và chỉ đi với cmd')
    if (c.quietSkip !== undefined && typeof c.quietSkip !== 'boolean') w('quietSkip phải là true hoặc false')
    if (c.cmd !== undefined) {
      if (!(isStr(c.cmd) || (isStrArr(c.cmd) && c.cmd.length && c.cmd.every(isStr)))) w('cmd phải là chuỗi hoặc mảng chuỗi')
      if (c.args !== undefined && !isStrArr(c.args)) w('args phải là mảng chuỗi')
      const inst = c.install
      if (!(isStr(inst) || (inst && typeof inst === 'object' && (isStr(inst.win32) || isStr(inst.posix))))) w('thiếu install (lệnh cài chính thức: chuỗi hoặc {win32, posix})')
    }
    if (c.detect !== undefined) out.push(...condProblems(c.detect, `${isStr(c.id) ? c.id : `#${i}`}: detect`))
    if (c.requires !== undefined && !(c.requires && isStrArr(c.requires.pkgs) && c.requires.pkgs.length && isStr(c.requires.install))) w('requires cần {pkgs:[…], install}')
    if (c.passOn !== undefined) {
      const p = c.passOn
      const okExit = p && Array.isArray(p.exit) && p.exit.length && p.exit.every(Number.isInteger)
      if (!p || typeof p !== 'object' || (p.exit !== undefined && !okExit) || (p.match !== undefined && (!isStr(p.match) || badRegex(p.match)))) w('passOn cần {exit:[số…], match?: regex hợp lệ}')
    }
    if (c.identify !== undefined && (!isStr(c.identify) || badRegex(c.identify))) w('identify phải là regex hợp lệ')
    if (c.timeoutMs !== undefined && !(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= MAX_TIMEOUT_MS)) w(`timeoutMs phải là số nguyên 1..${MAX_TIMEOUT_MS}`)
    for (const k of ['skipWhy', 'docs']) if (c[k] !== undefined && !isStr(c[k])) w(`${k} phải là chuỗi`)
  })
  return out
}

// Đọc + kiểm kit/checkers.json (hoặc file khác). Không đọc/parse được ⇒ ném lỗi; sai cấu hình ⇒ errors[].
export function loadCheckers(file = DEFAULT_CHECKERS) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  return { checkers: Array.isArray(obj?.checkers) ? obj.checkers : [], errors: validateCheckers(obj) }
}

// --- tìm công cụ + chạy ----------------------------------------------------------------------------------------------------------------

function defaultExists(win) {
  return (p) => {
    try {
      if (!fs.statSync(p).isFile()) return false
      if (!win) fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}

function envGet(env, key, win) {
  if (env[key] !== undefined) return env[key]
  if (!win) return undefined
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase())
  return k === undefined ? undefined : env[k]
}

// Thư mục cài hay bị thiếu trong PATH của hook/app mở từ GUI: `go install` (GOBIN, GOPATH/bin, ~/go/bin), cargo, Homebrew, npm global.
function extraDirs(P, win, env, home) {
  const dirs = []
  const add = (...parts) => { if (parts.every(Boolean)) dirs.push(P.join(...parts)) }
  const gobin = envGet(env, 'GOBIN', win)
  if (gobin) dirs.push(gobin)
  for (const g of (envGet(env, 'GOPATH', win) ?? '').split(win ? ';' : ':').filter(Boolean)) add(g, 'bin')
  add(home, 'go', 'bin')
  add(home, '.cargo', 'bin')
  add(home, '.local', 'bin')
  if (win) add(envGet(env, 'APPDATA', win), 'npm')
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

// Đường dẫn tuyệt đối của file chạy được, hoặc null. Thứ tự: node_modules/.bin của thư mục chạy và các thư mục cha (như npm) → PATH → thư mục cài quen thuộc.
// Windows: chỉ nhận .exe/.com/.cmd/.bat theo PATHEXT (file sh không đuôi của npm không chạy được). `name` có dấu / hoặc \ ⇒ dùng thẳng nếu tồn tại.
export function findTool(name, o = {}) {
  const platform = o.platform ?? process.platform
  const win = platform === 'win32'
  const P = win ? path.win32 : path.posix
  const env = o.env ?? process.env
  const exists = o.exists ?? defaultExists(win)
  if (/[\\/]/.test(name)) return exists(name) ? name : null
  const exts = win
    ? (envGet(env, 'PATHEXT', win) || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => ['.exe', '.com', '.cmd', '.bat'].includes(e))
    : ['']
  const inDir = (dir) => {
    for (const e of exts) {
      const p = P.join(dir, name + e)
      if (exists(p)) return p
    }
    return null
  }
  for (let d = P.resolve(o.cwd ?? process.cwd()); ; ) {
    const hit = inDir(P.join(d, 'node_modules', '.bin'))
    if (hit) return hit
    const up = P.dirname(d)
    if (up === d) break
    d = up
  }
  const onPath = (envGet(env, 'PATH', win) ?? '').split(win ? ';' : ':').map((x) => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  for (const dir of [...onPath, ...extraDirs(P, win, env, o.home ?? os.homedir())]) {
    const hit = inDir(dir)
    if (hit) return hit
  }
  return null
}

// Chạy `file args…` với cwd = o.cwd bằng runCommand của lib/clis.mjs (xem ghi chú đầu file về cwd).
function execIn(file, args, o) {
  const prev = process.cwd()
  try {
    process.chdir(o.cwd)
    return runCommand(file, args, { timeoutMs: o.timeoutMs, env: o.env, platform: o.platform })
  } finally {
    process.chdir(prev)
  }
}

// --- rút gọn output ------------------------------------------------------------------------------------------------------------------

// Bỏ mã màu (CSI) và liên kết bấm được (OSC 8, vd squawk in kèm URL dù đã đặt NO_COLOR) để bảng chữ đọc được.
const clean = (s) => String(s ?? '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/﻿/g, '').replace(/\r/g, '')

// Vài dòng đầu của output, bỏ mã màu, cắt dòng dài. Có dấu hiệu khoá bí mật ⇒ không in lại gì cả.
function tail(text) {
  const lines = clean(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  if (!lines.length) return []
  if (scanText(lines.join('\n')).length) return ['(output có thể chứa khoá bí mật nên không in lại)']
  const cut = (l) => {
    if (l.length <= DETAIL_WIDTH) return l
    // Dòng có lời dặn "Cách sửa: …" (luật kiến trúc của kit): vì sao cấm + cách sửa là phần người dùng cần nhất ⇒ giữ nguyên (lời dặn tới ADVICE_WIDTH), vị trí lỗi giữ ADVICE_HEAD
    // ký tự đầu, phần giữa dài thì cắt — thay vì cắt mất lời dặn.
    const at = l.indexOf('Cách sửa:')
    if (at > 0) {
      const middle = at > ADVICE_HEAD + ADVICE_REASON ? `${l.slice(0, ADVICE_HEAD).trimEnd()}… ${l.slice(at - ADVICE_REASON, at)}` : l.slice(0, at)
      return `${middle}${l.slice(at, at + ADVICE_WIDTH)}${l.length > at + ADVICE_WIDTH ? '…' : ''}`
    }
    return `${l.slice(0, DETAIL_WIDTH - 1)}…`
  }
  const shown = lines.slice(0, DETAIL_LINES).map(cut)
  if (lines.length > DETAIL_LINES) shown.push(`… còn ${lines.length - DETAIL_LINES} dòng nữa`)
  return shown
}

// --- nhánh chính (base) + file đổi -------------------------------------------------------------------------------------------------------

const HEX = /^[0-9a-f]{7,64}$/i
const BASE_REF_RE = /^[A-Za-z0-9_][\w./@^~-]*$/ // không cho bắt đầu bằng "-" (git sẽ hiểu là cờ)
const DEFAULT_BASES = ['main', 'master', 'origin/main', 'origin/master']
const NO_BASE = 'Chưa tìm thấy nhánh chính (main hoặc master) để so sánh: truyền --base <tên nhánh chính> hoặc đặt tên nhánh chính là main.'

// Chạy git (đồng bộ). args là mảng, không qua shell. → { code, stdout, stderr }. Tiêm được bản giả: git(args, { cwd }).
function defaultGit(args, { cwd } = {}) {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k] // đang chạy trong hook của git thì các biến này trỏ sai repo
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  return { code: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// Nhánh chính để so: ref tự chọn (--base) hoặc main → master → origin/main → origin/master (nhánh nào không chung lịch sử với HEAD thì bỏ qua, thử tiếp). → { ref, sha, fork } | null.
// fork = điểm nhánh hiện tại tách khỏi nhánh chính (nhánh chính đã đi tiếp thì không bị tính là "mình xoá").
export function resolveBase(dir, { git = defaultGit, ref } = {}) {
  const at = { cwd: dir }
  const inside = git(['rev-parse', '--is-inside-work-tree'], at)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  for (const name of ref == null ? DEFAULT_BASES : [ref]) {
    if (typeof name !== 'string' || !BASE_REF_RE.test(name)) continue
    const tip = git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], at)
    const sha = tip.stdout.trim()
    if (tip.code !== 0 || !HEX.test(sha)) continue
    const mb = git(['merge-base', sha, 'HEAD'], at)
    const fork = mb.stdout.trim()
    if (mb.code === 0 && HEX.test(fork)) return { ref: name, sha, fork }
    // nhánh này có nhưng KHÔNG chung lịch sử với HEAD (merge-base thất bại) ⇒ không dùng được làm điểm so; thử nhánh kế tiếp (không dừng ở đây rồi coi như không có nhánh chính)
  }
  return null
}

// File (đường dẫn tính từ `dir`, dấu /) đổi so với điểm tách khỏi nhánh chính: đã commit + đã stage + sửa chưa stage + file mới chưa theo dõi. Bỏ file đã xoá. Không hỏi được git ⇒ null.
export function changedFiles(dir, base, git = defaultGit) {
  if (!base?.fork) return null
  const at = { cwd: dir }
  const diff = git(['diff', '--name-only', '-z', '--relative', '--no-renames', '--diff-filter=d', base.fork], at)
  const fresh = git(['ls-files', '--others', '--exclude-standard', '-z'], at)
  if (diff.code !== 0 || fresh.code !== 0) return null
  const list = (s) => s.split('\0').filter(Boolean)
  return [...new Set([...list(diff.stdout), ...list(fresh.stdout)])].map((p) => p.replace(/\\/g, '/'))
}

// --- checker nội bộ (không cần công cụ ngoài) ------------------------------------------------------------------------------------------

const SKIP_WALK = new Set(['node_modules', '.git'])

function hasBuildDir(dir, depth = 3) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_WALK.has(e.name)) continue
    if (BUILD_DIRS.includes(e.name)) return true
    if (depth > 1 && hasBuildDir(path.join(dir, e.name), depth - 1)) return true
  }
  return false
}

const BROAD_HOSTS = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', 'file:///*']
const RISKY_PERMS = ['debugger', 'proxy', 'management', 'nativeMessaging', 'webRequestBlocking']
const CSP_SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem', 'object-src', 'default-src']
const asArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// Kiểm MV3 của kit (manifest_version 3, quyền tối thiểu, không unsafe-eval, không nạp mã từ xa qua CSP) → mảng lời báo (rỗng = đạt).
export function mv3Problems(manifest) {
  const out = []
  if (manifest.manifest_version !== 3) out.push(`manifest_version phải là 3 (đang là ${manifest.manifest_version})`)
  const perms = [...new Set([...asArr(manifest.permissions), ...asArr(manifest.host_permissions)])]
  for (const p of perms) {
    if (BROAD_HOSTS.includes(p)) out.push(`quyền quá rộng: ${p} (chỉ xin đúng các trang cần dùng)`)
    else if (RISKY_PERMS.includes(p)) out.push(`quyền nhạy cảm: ${p} (bỏ nếu không thật cần)`)
  }
  const csp = manifest.content_security_policy
  const policies = typeof csp === 'string' ? [csp] : csp && typeof csp === 'object' ? Object.values(csp).filter((v) => typeof v === 'string') : []
  for (const policy of policies) {
    if (/'unsafe-eval'/.test(policy)) out.push("CSP có 'unsafe-eval' (không được chạy mã sinh từ chuỗi)")
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      if (!CSP_SCRIPT_DIRECTIVES.includes(name)) continue
      for (const s of sources) if (/^https?:\/\/(?!localhost\b|127\.0\.0\.1\b)/i.test(s)) out.push(`CSP cho tải mã từ xa: ${s} (${name})`)
    }
  }
  return out
}

const REMOTE_CODE = [
  [/<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\//i, 'thẻ <script> tải mã từ xa'],
  [/\bimportScripts\s*\(\s*["'`]https?:\/\//, 'importScripts tải mã từ xa'],
  [/\bimport\s*\(\s*["'`]https?:\/\//, 'import() tải mã từ xa'],
  [/\bfrom\s+["']https?:\/\//, 'import từ URL từ xa'],
]
const CODE_FILE = /\.(?:html?|js|mjs|cjs|jsx|ts|tsx)$/i

function remoteCodeProblems(root, { maxFiles = 3000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const out = []
  let count = 0
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_WALK.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (e.isFile() && CODE_FILE.test(e.name) && ++count <= maxFiles) {
        const f = path.join(dir, e.name)
        if (fs.statSync(f).size > maxBytes) continue
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          for (const [re, what] of REMOTE_CODE) if (re.test(line)) out.push(`${r}:${i + 1} ${what}`)
        })
      }
    }
  }
  walk(root, '')
  return out
}

const ESLINT_CONFIG = /^(?:eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc(?:\..+)?)$/

export const INTERNALS = {
  // Bản build (dist/ build/ .next/ out/) không được lộ khoá bí mật. Chưa build ⇒ chưa kiểm được ⇒ 'missing', không phải đạt.
  'secret-scan-build': async ({ dir, checker }) => {
    if (!hasBuildDir(dir)) return { status: 'missing', message: 'Chưa có thư mục build (dist/, build/, .next/, out/) để quét khoá', fix: 'Chạy lệnh build của dự án (vd npm run build) rồi chạy lại.' }
    const found = scanDir(dir, { build: true })
    if (!found.length) return { status: 'pass', message: 'bản build không lộ khoá bí mật' }
    return {
      status: 'fail',
      message: `${found.length} chỗ nghi lộ khoá hoặc không quét được trong bản build`,
      detail: found.slice(0, 20).map((f) => `${f.file}${f.line ? `:${f.line}` : ''} ${f.name}${f.value ? ` (${f.value})` : ''}`),
      fix: checker.hint,
    }
  },

  'mv3-manifest': async ({ dir, root, checker }) => {
    const m = findManifest(root) ?? findManifest(dir)
    if (!m) return { status: 'missing', message: 'Không thấy manifest.json (có manifest_version) để kiểm', fix: 'Build extension rồi chạy lại, hoặc đặt manifest.json ở gốc dự án hay thư mục public/.' }
    const problems = [...mv3Problems(m.manifest), ...remoteCodeProblems(m.dir)]
    if (!problems.length) return { status: 'pass', message: 'manifest đạt chuẩn MV3 của kit' }
    return { status: 'fail', message: `${problems.length} điểm chưa đạt chuẩn MV3`, detail: problems.slice(0, 20), fix: checker.hint }
  },

  // @shadcn/lint là plugin ESLint: luật chạy trong bước `eslint`; ở đây chỉ kiểm plugin đã được bật trong cấu hình.
  'shadcn-lint': async ({ root, checker }) => {
    const pkg = readPackageJson(root)
    let text = pkg && Object.hasOwn(pkg, 'eslintConfig') ? JSON.stringify(pkg.eslintConfig) : ''
    for (const f of fs.readdirSync(root)) if (ESLINT_CONFIG.test(f)) text += `\n${fs.readFileSync(path.join(root, f), 'utf8')}`
    if (text.includes('@shadcn/lint')) return { status: 'pass', message: 'luật shadcn đã bật trong ESLint (chạy ở bước eslint)' }
    return { status: 'fail', message: 'Đã cài @shadcn/lint nhưng cấu hình ESLint chưa bật plugin', fix: checker.hint }
  },

  // docs/arch.json ↔ thư mục thật ↔ Codemap (hooks/lib/arch.mjs syncCheck). arch.json hỏng ⇒ KHÔNG ĐẠT kèm cách sửa, không bao giờ bỏ qua.
  'arch-sync': async ({ dir, checker, ctx }) => {
    const { arch, errors } = loadArch(dir)
    if (!arch) return archBroken(errors, checker, ctx)
    const r = syncCheck(dir)
    if (r.ok) return { status: 'pass', message: r.notes.length ? r.notes.join(' ') : 'docs/arch.json, thư mục code và Codemap khớp nhau' }
    return { status: 'fail', message: `${r.problems.length} chỗ lệch giữa docs/arch.json, thư mục code và Codemap`, detail: r.problems.map((p) => p.msg), fix: joinFixes(r.problems.map((p) => p.fix)) || checker.hint }
  },

  // Trần dòng của file (sizeCheck). Có docs/arch-baseline.json và hỏi được git ⇒ chỉ file đổi so với nhánh chính; còn lại xét toàn bộ (không bỏ sót).
  'arch-size': async ({ dir, checker, ctx }) => {
    const { arch, errors } = loadArch(dir)
    if (!arch) return archBroken(errors, checker, ctx)
    const changed = loadBaseline(dir) !== null ? ctx.changed() : null
    const r = sizeCheck(dir, changed ? { changedOnly: changed } : {})
    if (r.ok) return { status: 'pass', message: changed ? `file đổi so với ${ctx.getBase().ref} đều trong trần dòng` : 'mọi file code trong trần dòng' }
    return { status: 'fail', message: `${r.problems.length} file vượt trần dòng`, detail: r.problems.map((p) => p.msg), fix: joinFixes(r.problems.map((p) => p.fix)) || checker.hint }
  },
}

const ARCH_FIX = 'Sửa docs/arch.json theo từng dòng báo lỗi (mỗi luật forbidden cần "reason" và "fix"); chưa có file thì chạy: node ~/.claude/hooks/arch.mjs init --stack web|go|extension|wails --dir <thư mục dự án>'
// Bốn checker đọc docs/arch.json (arch-sync, arch-size, depcruise, go-arch-lint). File hỏng ⇒ báo MỘT lần ở checker đầu tiên trong lần chạy (ctx.archOwner);
// các checker kia BỎ QUA kèm lý do, không lặp cùng khối lỗi bốn lần. Chạy riêng một checker (không có owner nào khác) thì nó tự báo.
const ARCH_CHECKS = new Set(['arch-sync', 'arch-size', 'depcruise', 'go-arch-lint'])
const archBroken = (errors, checker, ctx) => (ctx?.archOwner && ctx.archOwner !== checker?.id
  ? { status: 'skip', message: `docs/arch.json chưa dùng được — lỗi đã báo ở dòng ${ctx.archOwner}` }
  : { status: 'fail', message: `docs/arch.json chưa dùng được (${errors.length} lỗi)`, detail: errors, fix: ARCH_FIX })
const planBroken = (errors, checker, ctx) => { const b = archBroken(errors, checker, ctx); return b.status === 'skip' ? { skip: b.message } : { fail: b } }
const GEN_FIX = 'Chạy: node ~/.claude/hooks/arch.mjs gen --dir <thư mục dự án> rồi chạy lại.'

// Các lời dặn giống nhau gộp một; tối đa 3 cách sửa khác nhau.
function joinFixes(fixes) {
  const uniq = [...new Set(fixes.filter(Boolean))]
  return `${uniq.slice(0, 3).join('  |  ')}${uniq.length > 3 ? `  |  (còn ${uniq.length - 3} cách sửa khác, xem từng dòng báo)` : ''}`
}

// --- planner: quyết định LẦN NÀY chạy gì (checker có `plan`) -------------------------------------------------------------------------------
// planner({ dir, root, checker, ctx }) → null (chạy như cấu hình: c.args ở root)
//   | { skip, quiet? }       không chạy (quiet ⇒ không hiện dòng BỎ QUA)
//   | { fail: {message, detail?, fix?} }   không đạt ngay (vd chưa sinh cấu hình)
//   | { runs: [{ args, cwd?, label?, judge? }], toolDirs?, cleanup? }   chạy lần lượt; judge(r, out) → {status,message,detail?,fix?} thay cho luật mã thoát
// ctx.getBase() → { ref, sha, fork }|null · ctx.changed() → string[]|null · ctx.git(args, {cwd}) → {code,stdout,stderr}.

export const OPENAPI_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml', 'docs/openapi.yml', 'docs/openapi.json', 'api/openapi.yaml', 'api/openapi.yml', 'api/openapi.json']
const MIGRATION_RE = /(?:^|\/)migrations\/[^/]+\.sql$/i
const WALK_SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.next', '.venv'])
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const lf = (s) => String(s).replace(/\r\n/g, '\n')

// Dự án có thư mục migrations/ chứa file .sql không (duyệt có giới hạn, bỏ thư mục nặng).
function hasMigrations(dir, depth = 6, budget = { dirs: 3000 }) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory() || WALK_SKIP.has(e.name) || budget.dirs-- <= 0) continue
    const sub = path.join(dir, e.name)
    if (e.name === 'migrations') {
      try { if (fs.readdirSync(sub).some((f) => /\.sql$/i.test(f))) return true } catch { /* không đọc được thì coi như không có */ }
    }
    if (depth > 1 && hasMigrations(sub, depth - 1, budget)) return true
  }
  return false
}

// squawk mặc định đỏ cả migration an toàn (thêm cột) vì đòi `set lock_timeout`, `set statement_timeout`, `IF NOT EXISTS`: đó là luật hình thức, không phải khoá bảng/mất dữ liệu.
// Bỏ đúng ba luật đó; giữ nguyên mọi luật nguy hiểm (ban-drop-column, adding-required-field, require-concurrent-index-creation, change-column-type…). Mỗi luật một cờ riêng
// (không gộp bằng dấu phẩy: bộ lọc đối số của .cmd trên Windows không nhận dấu phẩy).
const SQUAWK_EXCLUDE = ['require-lock-timeout', 'require-statement-timeout', 'prefer-robust-stmts'].map((r) => `--exclude=${r}`)

const GAL_KIND = { ArchWarningsDeps: 'import không được phép', ArchWarningsNotMatched: 'file chưa thuộc module nào', ArchWarningsDeepScan: 'gọi sâu qua module khác' }
const prettyViolation = (key) => { const [kind, ...rest] = key.split(' | '); return `${GAL_KIND[kind] ?? kind}: ${rest.join(' · ')}` }

// Đọc output --json của go-arch-lint → { count: số vi phạm kiến trúc, errors: lỗi cấu hình/chạy (ExecutionWarnings) } hoặc null nếu không phải kết quả đọc được.
function parseGoArch(text) {
  try {
    const j = JSON.parse(clean(text).trim())
    const payload = j?.Payload ?? j
    if (!payload || typeof payload !== 'object') return null
    const count = Object.entries(payload).reduce((n, [k, v]) => (/^ArchWarnings/i.test(k) && Array.isArray(v) ? n + v.length : n), 0)
    const errors = (Array.isArray(payload.ExecutionWarnings) ? payload.ExecutionWarnings : []).map((w) => String(w?.Text ?? '').trim()).filter(Boolean)
    return { count, errors }
  } catch { return null }
}

// go-arch-lint thoát khác 0 vì có vi phạm: chỉ vi phạm KHÔNG có trong mốc (docs/arch-baseline.json) mới tính.
// Không đọc được kết quả hoặc công cụ từ chối cấu hình ⇒ không đạt (không đoán là "toàn vi phạm cũ").
function judgeGoArch(dir, r, out, hint) {
  const text = r.stdout?.trim() ? r.stdout : r.stderr
  const fresh = newGoArchViolations(dir, text)
  if (fresh.length) return { status: 'fail', message: `${fresh.length} vi phạm hướng phụ thuộc mới`, detail: tail(fresh.map(prettyViolation).join('\n')), fix: hint }
  if (r.code === 0) return { status: 'pass', message: '' }
  const parsed = parseGoArch(text)
  if (parsed?.errors.length) return { status: 'fail', message: `go-arch-lint không đọc được cấu hình (${parsed.errors.length} lỗi)`, detail: tail(parsed.errors.join('\n')), fix: `Cấu hình .go-arch-lint.yml bị công cụ từ chối: sửa docs/arch.json rồi chạy lại node ~/.claude/hooks/arch.mjs gen (file do kit sinh thì xoá file cũ trước khi gen).` }
  if (parsed && parsed.count > 0) return { status: 'pass', message: `${parsed.count} vi phạm cũ đã chốt trong docs/arch-baseline.json (không tính)` }
  return { status: 'fail', message: `go-arch-lint báo lỗi (mã thoát ${r.code}) nhưng không đọc được vi phạm nào`, detail: tail(out), fix: hint }
}

// dependency-cruiser tự thoát với "Your node version (x) is not supported" khi Node của máy ngoài "engines" của nó: đó là máy chưa đủ điều kiện (THIẾU), không phải code sai.
// Ngoài ra giữ luật mã thoát mặc định (0 = đạt).
// depcruise cài global không thấy TypeScript của dự án ⇒ in "0 modules cruised" (hoặc cảnh báo missing-typescript-transpiler) mà vẫn thoát 0: dự án có .ts/.tsx mà không file nào được đọc
// thì KHÔNG phải "không có vi phạm" ⇒ THIẾU (kèm cách cài đúng chỗ), tuyệt đối không tính ĐẠT.
const TS_FIX = `Cài dependency-cruiser và typescript NGAY TRONG dự án (không cài global; ${DEPCRUISE_WHERE}): pnpm add -D ${DEPCRUISE_PKGS} (hoặc npm i -D ${DEPCRUISE_PKGS}), rồi chạy lại flow check. (depcruise 18 chỉ đọc được typescript dưới 7: gõ trơn "typescript" sẽ kéo bản 7 mà nó không đọc được.)`

function judgeDepcruise(checker, { ts = false } = {}) {
  return (r, out) => {
    const engine = r.code === 0 ? null : nodeEngineProblem(out)
    if (engine) return { status: 'missing', message: nodeEngineMessage(engine.version), fix: 'Cài Node 22, Node 24 LTS (tải ở nodejs.org, hoặc dùng fnm/nvm) hoặc Node 26 trở lên, mở lại cửa sổ dòng lệnh rồi chạy lại flow check.' }
    if (r.code === 0 && ts && (/\(0 modules\b/.test(out) || /missing-typescript-transpiler/i.test(out))) return { status: 'missing', message: 'dependency-cruiser không đọc được file TypeScript của dự án (không thấy typescript đi kèm), nên chưa kiểm được ranh giới module', fix: TS_FIX }
    if (r.code === 0) return { status: 'pass', message: '' }
    return { status: 'fail', message: `depcruise báo lỗi (mã thoát ${r.code})`, fix: checker.hint, detail: tail(out) }
  }
}

export const PLANNERS = {
  // depcruise --config .dependency-cruiser.cjs [--ignore-known <mốc>] --output-type err-long -- <root…>, chạy ở gốc dự án (đối số do arch.mjs dựng từ docs/arch.json; root đứng sau `--`).
  depcruise: ({ dir, checker, ctx }) => {
    const { arch, errors } = loadArch(dir)
    if (!arch) return planBroken(errors, checker, ctx)
    const plan = depcruiseArgs(dir, { ignoreKnown: loadBaseline(dir) !== null })
    if (!plan) return { skip: 'docs/arch.json không có phần web hay tiện ích trình duyệt', quiet: true }
    if (!isFile(path.join(dir, '.dependency-cruiser.cjs'))) return { fail: { message: 'Chưa có .dependency-cruiser.cjs (cấu hình sinh từ docs/arch.json)', fix: GEN_FIX } }
    const rt = roots(dir)
    return { runs: [{ args: plan.args, cwd: plan.cwd, judge: judgeDepcruise(checker, { ts: usesTypeScript(dir) }) }], toolDirs: [...new Set([rt.web, rt.extension].filter(Boolean))], install: `npm i -D ${DEPCRUISE_PKGS} (${DEPCRUISE_WHERE})` }
  },

  // go-arch-lint check --json cho từng phần Go; vi phạm cũ trong docs/arch-baseline.json không tính.
  'go-arch-lint': ({ dir, checker, ctx }) => {
    const { arch, errors } = loadArch(dir)
    if (!arch) return planBroken(errors, checker, ctx)
    const lint = goArchLintRuns(dir)
    if (!lint.length) return { skip: 'docs/arch.json không có phần Go nào có miền', quiet: true }
    const ungen = lint.find((r) => !r.exists)
    if (ungen) return { fail: { message: `Chưa có ${ungen.file} (cấu hình sinh từ docs/arch.json)`, fix: GEN_FIX } }
    return { runs: lint.map((r) => ({ label: lint.length > 1 ? r.part : undefined, args: r.args, cwd: r.cwd, judge: (res, out) => judgeGoArch(dir, res, out, checker.hint) })) }
  },

  // golangci-lint: có mốc go.newFromRev trong docs/arch-baseline.json ⇒ thêm --new-from-rev=<commit> (lỗi cũ lúc chốt mốc không tính). Không có mốc ⇒ như cũ.
  'golangci-baseline': ({ dir, checker }) => {
    const rev = loadBaseline(dir)?.go?.newFromRev
    if (typeof rev !== 'string' || !HEX.test(rev)) return null
    // option trước, `--`, rồi mới tới đích quét (./...): đích bắt đầu từ './...' trở đi trong args của checker
    const base = checker.args ?? []
    const at = base.indexOf('./...')
    const head = at < 0 ? base : base.slice(0, at)
    return { runs: [{ args: [...head, `--new-from-rev=${rev}`, ...(at < 0 ? [] : ['--', ...base.slice(at)])] }] }
  },

  // oasdiff breaking --fail-on ERR <bản ở nhánh chính (file tạm)> <bản hiện tại>, mỗi file openapi đổi một lệnh. Không đổi / file mới / chưa có nhánh chính ⇒ bỏ qua có lý do.
  oasdiff: ({ dir, ctx }) => {
    const files = OPENAPI_FILES.filter((f) => isFile(path.join(dir, f)))
    if (!files.length) return { skip: 'dự án không có file openapi', quiet: true }
    const base = ctx.getBase()
    if (!base) return { skip: NO_BASE }
    const runs = []
    const notes = []
    let tmp = null
    // Xoá từng file rồi thư mục: Node trên Windows có lúc để rmSync lặng lẽ không xoá được đường dẫn có chữ có dấu (vd tên người dùng tiếng Việt) mà không báo lỗi.
    const cleanup = () => {
      if (!tmp) return
      for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f))
      fs.rmdirSync(tmp)
    }
    try {
      for (const f of files) {
        const old = ctx.git(['show', `${base.fork}:./${f}`], { cwd: dir })
        if (old.code !== 0) { notes.push(`${f} là file mới, chưa có ở ${base.ref} nên chưa có gì để so`); continue }
        if (lf(old.stdout) === lf(fs.readFileSync(path.join(dir, f), 'utf8'))) { notes.push(`${f} không đổi so với ${base.ref}`); continue }
        tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'flow-check-oas-'))
        const oldFile = path.join(tmp, `${base.ref.replace(/[^\w.-]/g, '_')}-${runs.length}${path.extname(f)}`)
        fs.writeFileSync(oldFile, old.stdout)
        runs.push({ label: files.length > 1 ? f : undefined, args: ['breaking', '--fail-on', 'ERR', '--', oldFile, f], cwd: dir, alias: [[oldFile, `${base.ref}:${f}`]] })
      }
    } catch (e) { cleanup(); throw e }
    return runs.length ? { runs, cleanup } : { skip: notes.join('; ') }
  },

  // squawk <các file migration .sql đổi so với nhánh chính>.
  squawk: ({ dir, ctx }) => {
    if (!hasMigrations(dir)) return { skip: 'dự án không có migration SQL', quiet: true }
    const base = ctx.getBase()
    if (!base) return { skip: NO_BASE }
    const changed = ctx.changed()
    if (!changed) return { skip: 'Không hỏi được git file nào đã đổi nên chưa kiểm migration.' }
    const files = changed.filter((f) => MIGRATION_RE.test(f) && isFile(path.join(dir, f))).sort()
    return files.length ? { runs: [{ args: [...SQUAWK_EXCLUDE, '--', ...files] }] } : { skip: `không có migration SQL nào đổi so với ${base.ref}` }
  },
}

// --- chạy checker ----------------------------------------------------------------------------------------------------------------------

const installText = (inst, platform) => (typeof inst === 'string' ? inst : platform === 'win32' ? inst.win32 ?? inst.posix : inst.posix ?? inst.win32)

async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i) }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Tìm công cụ của checker trong các ứng viên `cmd`; có `identify` thì --version phải khớp (vd `sg` của hệ điều hành không phải ast-grep).
async function resolveTool(c, cwd, ctx) {
  for (const name of [].concat(c.cmd)) {
    const file = ctx.which(name, { cwd, env: ctx.env, platform: ctx.platform })
    if (!file) continue
    if (c.identify) {
      const v = await ctx.exec(file, ['--version'], { cwd, timeoutMs: VERSION_TIMEOUT_MS, env: ctx.env, platform: ctx.platform })
      if (!new RegExp(c.identify, 'i').test(clean(`${v.stdout}\n${v.stderr}`))) continue
    }
    return { name, file }
  }
  return null
}

// Chạy MỘT lệnh của checker → { status, message, fix?, detail? }. Lệnh không chạy được / quá giờ / mã thoát lạ ⇒ không bao giờ pass im lặng.
async function execRun(c, tool, run, root, ctx) {
  const args = run.args.map((a) => a.replaceAll('{kit}', KIT_SLASH))
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const r = await ctx.exec(tool.file, args, { cwd: run.cwd ?? root, timeoutMs, env: ctx.env, platform: ctx.platform })
  if (r.error) {
    if (r.error.code === 'ENOENT') return { status: 'missing', message: `Chưa cài ${tool.name}`, fix: `Cài: ${installText(c.install, ctx.platform)}` }
    if (r.error.code === 'EUNSAFE') return { status: 'fail', message: `Không chạy được ${tool.name}: ${r.error.message}`, fix: 'Đường dẫn có dấu cách hoặc ký tự lạ nên không chạy được qua shim .cmd: cài bản .exe của công cụ (không qua npm) hoặc dùng đường dẫn không có dấu cách.' }
    return { status: 'fail', message: `Không chạy được ${tool.name}: ${r.error.message}`, fix: c.hint }
  }
  if (r.timedOut) return { status: 'fail', message: `Quá thời gian ${Math.round(timeoutMs / 1000)} giây, đã dừng ${tool.name}`, fix: c.hint }
  let out = clean(`${r.stdout}\n${r.stderr}`)
  for (const [from, to] of run.alias ?? []) out = out.replaceAll(from, to) // vd đường dẫn file tạm của bản cũ ⇒ "main:openapi.yaml" cho dễ đọc
  if (run.judge) return run.judge(r, out)
  const exitOk = (c.passOn?.exit ?? [0]).includes(r.code)
  const matchOk = !c.passOn?.match || new RegExp(c.passOn.match, 'i').test(out)
  if (exitOk && matchOk) return { status: 'pass', message: '' }
  return {
    status: 'fail',
    message: exitOk ? `${tool.name} chạy xong nhưng không thấy dòng xác nhận đạt` : `${tool.name} báo lỗi (mã thoát ${r.code})`,
    fix: c.hint,
    detail: tail(out),
  }
}

// Gộp kết quả của nhiều lệnh (vd mỗi phần Go / mỗi file openapi một lệnh): có lệnh không đạt ⇒ không đạt, ghi rõ lệnh nào.
function mergeOutcomes(runs, outcomes, c) {
  if (outcomes.length === 1) return outcomes[0]
  const tag = (i) => (runs[i].label ? `[${runs[i].label}] ` : '')
  const bad = outcomes.map((o, i) => ({ o, i })).filter(({ o }) => o.status !== 'pass')
  if (!bad.length) return { status: 'pass', message: outcomes.map((o) => o.message).filter(Boolean).join('; ') }
  return {
    status: 'fail',
    message: bad.map(({ o, i }) => `${tag(i)}${o.message}`).join(' · '),
    detail: bad.flatMap(({ o, i }) => (o.detail ?? []).map((d) => `${tag(i)}${d}`)).slice(0, DETAIL_LINES * 2),
    fix: [...new Set(bad.map(({ o }) => o.fix).filter(Boolean))].join('  |  ') || c.hint,
  }
}

async function runOne(c, root, ctx) {
  const t0 = Date.now()
  const res = (patch) => ({ id: c.id, title: c.title, stack: c.stack, required: c.required, status: 'skip', message: '', fix: null, detail: [], ...patch, ms: Date.now() - t0 })
  let cleanup = null
  try {
    if (!matches(c.detect, root)) return c.quietSkip ? null : res({ status: 'skip', message: c.skipWhy ?? 'không áp dụng cho dự án này' })

    let plan = null
    if (c.plan) {
      const planner = ctx.planners[c.plan]
      if (!planner) return res({ status: 'fail', message: `bộ lập kế hoạch "${c.plan}" không tồn tại`, fix: 'Cập nhật kit (hooks/flow-check.mjs).' })
      plan = await planner({ dir: ctx.dir, root, checker: c, ctx })
      cleanup = plan?.cleanup ?? null
      if (plan?.skip) return plan.quiet ? null : res({ status: 'skip', message: plan.skip })
      if (plan?.fail) return res({ status: 'fail', message: plan.fail.message, detail: plan.fail.detail ? tail(plan.fail.detail.join('\n')) : [], fix: plan.fail.fix ?? c.hint })
    }

    const missing = []
    const fixes = []
    let tool = null
    if (c.cmd !== undefined) {
      // Thư mục planner chỉ định (vd frontend/ của Wails) TRƯỚC, rồi gốc dự án: findTool đi từ thư mục đó lên node_modules/.bin của các thư mục cha rồi mới tới PATH, nên bản cài
      // trong dự án thắng bản global (bản global không thấy typescript của dự án).
      for (const where of [...new Set([...(plan?.toolDirs ?? []), root])]) {
        tool = await resolveTool(c, where, ctx)
        if (tool) break
      }
      if (!tool) {
        missing.push([].concat(c.cmd)[0])
        fixes.push(`Cài: ${plan?.install ?? installText(c.install, ctx.platform)}${c.docs ? ` (${c.docs})` : ''}`)
      }
    }
    if (c.requires) {
      const pkg = readPackageJson(root)
      const lacking = c.requires.pkgs.filter((p) => !hasDep(pkg, [p]))
      if (lacking.length) {
        missing.push(...lacking)
        fixes.push(`Cài: ${c.requires.install}`)
      }
    }
    if (missing.length) return res({ status: 'missing', message: `Chưa cài ${missing.join(', ')}`, fix: [...new Set(fixes)].join('  |  ') })

    if (c.internal) {
      const fn = ctx.internals[c.internal]
      if (!fn) return res({ status: 'fail', message: `checker nội bộ "${c.internal}" không tồn tại`, fix: 'Cập nhật kit (hooks/flow-check.mjs).' })
      const r = await fn({ dir: ctx.dir, root, checker: c, ctx })
      return res({ ...r, detail: r.detail ? tail(r.detail.join('\n')) : [] })
    }

    const runs = plan?.runs ?? [{ args: c.args ?? [] }]
    const outcomes = []
    for (const run of runs) {
      const o = await execRun(c, tool, run, root, ctx)
      if (o.status === 'missing') return res(o)
      outcomes.push(o)
    }
    return res(mergeOutcomes(runs, outcomes, c))
  } catch (e) {
    return res({ status: 'fail', message: `Không chạy được: ${e.message}`, fix: c.hint })
  } finally {
    try { cleanup?.() } catch { /* dọn file tạm không được thì thôi, không làm đổi kết quả */ }
  }
}

// Chạy mọi checker áp dụng cho dự án. Checker có stack 'all' luôn chạy ở gốc; còn lại chỉ khi stack có mặt, chạy ở root của stack (xem lib/stack.mjs roots).
// deps tiêm để test: which(name,{cwd,env,platform}) → đường dẫn|null · exec(file,args,{cwd,timeoutMs,env,platform}) → {code,stdout,stderr,timedOut,error} · internals · planners ·
// git(args,{cwd}) → {code,stdout,stderr} · concurrency. base = nhánh chính để so (mặc định main rồi master; xem resolveBase). Checker `quietSkip` không áp dụng ⇒ không có dòng nào trong results.
export async function runChecks({ dir, checkers, env, platform, which, exec, internals, planners, git, base, concurrency = 4 } = {}) {
  const abs = path.resolve(dir)
  const stacks = detect(abs)
  const rt = roots(abs)
  const gitFn = git ?? defaultGit
  const memo = {}
  const ctx = {
    dir: abs,
    env: env ?? { ...process.env, NO_COLOR: '1' },
    platform: platform ?? process.platform,
    which: which ?? ((name, o) => findTool(name, o)),
    exec: exec ?? execIn,
    internals: { ...INTERNALS, ...internals },
    planners: { ...PLANNERS, ...planners },
    git: (args, o = {}) => gitFn(args, { cwd: o.cwd ?? abs }),
    getBase: () => (memo.base !== undefined ? memo.base : (memo.base = resolveBase(abs, { git: gitFn, ref: base ?? undefined }))),
    changed: () => (memo.changed !== undefined ? memo.changed : (memo.changed = changedFiles(abs, ctx.getBase(), gitFn))),
  }
  const items = checkers.filter((c) => c.stack === 'all' || stacks.includes(c.stack))
  ctx.archOwner = items.find((c) => ARCH_CHECKS.has(c.internal ?? c.plan))?.id
  const results = (await mapPool(items, concurrency, (c) => runOne(c, c.stack === 'all' ? abs : rt[c.stack], ctx))).filter(Boolean)
  const count = (s) => results.filter((r) => r.status === s).length
  const summary = { pass: count('pass'), fail: count('fail'), missing: count('missing'), skip: count('skip'), missingRequired: results.filter((r) => r.status === 'missing' && r.required).length }
  return { dir: abs, stacks, results, summary, ok: summary.fail === 0 && summary.missingRequired === 0 }
}

export const exitCode = (report) => (report.ok ? 0 : 1)

// --- bảng chữ ---------------------------------------------------------------------------------------------------------------------------

const LABEL = { pass: 'ĐẠT', fail: 'KHÔNG', missing: 'THIẾU', skip: 'BỎ QUA' }

export function formatReport(report) {
  const { summary: s } = report
  const lines = [
    `flow-check — ${report.dir}`,
    `Loại dự án: ${report.stacks.map((x) => STACK_LABEL[x] ?? x).join(', ') || 'chưa nhận ra (chỉ chạy kiểm chung)'}`,
    '',
  ]
  for (const r of report.results) {
    const head = `${LABEL[r.status].padEnd(7)} ${r.id.padEnd(16)} ${r.title}`
    if (r.status === 'skip') { lines.push(`${head} — ${r.message}`); continue }
    lines.push(r.status === 'missing' && r.required ? `${head} (bắt buộc)` : head)
    if (r.status === 'pass') continue
    if (r.message) lines.push(`          ! ${r.message}`)
    for (const d of r.detail) lines.push(`          | ${d}`)
    if (r.fix) lines.push(`          -> ${r.fix}`)
  }
  const parts = [`${s.pass} đạt`, `${s.fail} không đạt`, `${s.missing} thiếu công cụ${s.missing ? ` (${s.missingRequired} bắt buộc)` : ''}`, `${s.skip} bỏ qua`]
  lines.push('', `Kết quả: ${report.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'} — ${parts.join(' · ')}`)
  return `${lines.join('\n')}\n`
}

// --- CLI -------------------------------------------------------------------------------------------------------------------------------

const USAGE = `flow-check.mjs — máy kiểm theo loại dự án
  --dir <thư mục>      dự án cần kiểm (mặc định: thư mục hiện tại)
  --json               in JSON thay cho bảng
  --checkers <file>    dùng danh sách checker khác (mặc định kit/checkers.json)
  --base <nhánh>       nhánh chính để so file đổi / openapi / migration (mặc định: main, không có thì master)
exit: 0 đạt · 1 không đạt hoặc thiếu công cụ bắt buộc · 2 dùng sai / cấu hình hỏng`

function parseArgs(argv) {
  const o = { dir: process.cwd(), json: false, checkers: DEFAULT_CHECKERS, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--dir' || a === '--checkers' || a === '--base') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) return { usage: `${a} cần một giá trị` }
      if (a === '--dir') o.dir = v
      else if (a === '--base') o.base = v
      else o.checkers = v
    } else return { usage: `cờ lạ ${a}` }
  }
  return o
}

// deps tiêm để test: { stdout, stderr, which, exec, internals, planners, git, env, platform }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const err = deps.stderr ?? process.stderr
  const o = parseArgs(argv)
  if (o.usage) { err.write(`flow-check: ${o.usage}\n${USAGE}\n`); return 2 }
  if (o.help) { out.write(`${USAGE}\n`); return 0 }
  const dir = path.resolve(o.dir)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { err.write(`flow-check: không thấy thư mục dự án: ${dir}\n`); return 2 }
  let loaded
  try {
    loaded = loadCheckers(o.checkers)
  } catch (e) {
    err.write(`flow-check: không đọc được ${o.checkers} (${e.message})\n`)
    return 2
  }
  if (loaded.errors.length) {
    err.write(`flow-check: ${o.checkers} không hợp lệ:\n${loaded.errors.map((e) => `  - ${e}`).join('\n')}\n`)
    return 2
  }
  if (o.base !== undefined && !resolveBase(dir, { git: deps.git, ref: o.base })) {
    err.write(`flow-check: --base ${o.base}: không thấy nhánh này trong repo git của dự án (hoặc nó không có điểm chung với nhánh đang đứng). Kiểm tên nhánh bằng: git branch --list\n`)
    return 2
  }
  const report = await runChecks({ dir, checkers: loaded.checkers, which: deps.which, exec: deps.exec, internals: deps.internals, planners: deps.planners, git: deps.git, base: o.base, env: deps.env, platform: deps.platform })
  out.write(o.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  return exitCode(report)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}

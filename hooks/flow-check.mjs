#!/usr/bin/env node
// flow-check: MỘT lệnh máy kiểm theo loại dự án (web / Go / Wails / extension + SAST chung). Spec: docs/specs/2026-10-11-flow-v7-nocode (AC-11, AC-43).
//   node hooks/flow-check.mjs [--dir <thư mục dự án>] [--json] [--checkers <file>]
//   ra bảng ĐẠT / KHÔNG / THIẾU / BỎ QUA + lời dặn sửa tiếng Việt. Exit 0 = đạt · 1 = có checker không đạt hoặc thiếu công cụ BẮT BUỘC · 2 = dùng sai / cấu hình hỏng.
//
// Danh sách checker nằm ở kit/checkers.json (mỗi checker { id, stack, title, cmd|internal, args, detect, requires, passOn, timeoutMs, hint, required, install }).
// Hợp đồng:
//   - THIẾU công cụ ⇒ status 'missing' kèm lệnh cài chính thức; KHÔNG cài ngầm, KHÔNG tính là đạt; chỉ chặn (exit 1) khi checker required.
//   - Mỗi checker chạy có timeout (Node, diệt cả cây tiến trình); trên Windows .cmd chạy qua runCommand của lib/clis.mjs (đối số lạ bị từ chối).
//   - Output của công cụ chỉ chép vài dòng đầu, bỏ mã màu; có dấu hiệu khoá bí mật ⇒ không in lại.
//   - Quét khoá trong bản build dùng lib/secrets.mjs (scanDir build:true).
//
// runCommand của lib/clis.mjs không có tuỳ chọn cwd ⇒ execIn() đổi cwd của tiến trình đúng lúc spawn (spawn chạy đồng bộ trong executor
// của Promise) rồi trả lại ngay; vì vậy chạy song song vẫn đúng thư mục. resolveBin của clis.mjs chỉ biết 6 CLI cố định ⇒ findTool() riêng ở đây.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const clean = (s) => String(s ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/﻿/g, '').replace(/\r/g, '')

// Vài dòng đầu của output, bỏ mã màu, cắt dòng dài. Có dấu hiệu khoá bí mật ⇒ không in lại gì cả.
function tail(text) {
  const lines = clean(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  if (!lines.length) return []
  if (scanText(lines.join('\n')).length) return ['(output có thể chứa khoá bí mật nên không in lại)']
  const cut = (l) => (l.length > DETAIL_WIDTH ? `${l.slice(0, DETAIL_WIDTH - 1)}…` : l)
  const shown = lines.slice(0, DETAIL_LINES).map(cut)
  if (lines.length > DETAIL_LINES) shown.push(`… còn ${lines.length - DETAIL_LINES} dòng nữa`)
  return shown
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

async function runOne(c, root, ctx) {
  const t0 = Date.now()
  const res = (patch) => ({ id: c.id, title: c.title, stack: c.stack, required: c.required, status: 'skip', message: '', fix: null, detail: [], ...patch, ms: Date.now() - t0 })
  try {
    if (!matches(c.detect, root)) return res({ status: 'skip', message: c.skipWhy ?? 'không áp dụng cho dự án này' })

    const missing = []
    const fixes = []
    let tool = null
    if (c.cmd !== undefined) {
      tool = await resolveTool(c, root, ctx)
      if (!tool) {
        missing.push([].concat(c.cmd)[0])
        fixes.push(`Cài: ${installText(c.install, ctx.platform)}${c.docs ? ` (${c.docs})` : ''}`)
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
      const r = await fn({ dir: ctx.dir, root, checker: c })
      return res({ ...r, detail: r.detail ? tail(r.detail.join('\n')) : [] })
    }

    const args = (c.args ?? []).map((a) => a.replaceAll('{kit}', KIT_SLASH))
    const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const r = await ctx.exec(tool.file, args, { cwd: root, timeoutMs, env: ctx.env, platform: ctx.platform })
    if (r.error) {
      if (r.error.code === 'ENOENT') return res({ status: 'missing', message: `Chưa cài ${tool.name}`, fix: `Cài: ${installText(c.install, ctx.platform)}` })
      if (r.error.code === 'EUNSAFE') return res({ status: 'fail', message: `Không chạy được ${tool.name}: ${r.error.message}`, fix: 'Đường dẫn có dấu cách hoặc ký tự lạ nên không chạy được qua shim .cmd: cài bản .exe của công cụ (không qua npm) hoặc dùng đường dẫn không có dấu cách.' })
      return res({ status: 'fail', message: `Không chạy được ${tool.name}: ${r.error.message}`, fix: c.hint })
    }
    if (r.timedOut) return res({ status: 'fail', message: `Quá thời gian ${Math.round(timeoutMs / 1000)} giây, đã dừng ${tool.name}`, fix: c.hint })
    const out = clean(`${r.stdout}\n${r.stderr}`)
    const exitOk = (c.passOn?.exit ?? [0]).includes(r.code)
    const matchOk = !c.passOn?.match || new RegExp(c.passOn.match, 'i').test(out)
    if (exitOk && matchOk) return res({ status: 'pass', message: '' })
    return res({
      status: 'fail',
      message: exitOk ? `${tool.name} chạy xong nhưng không thấy dòng xác nhận đạt` : `${tool.name} báo lỗi (mã thoát ${r.code})`,
      fix: c.hint,
      detail: tail(out),
    })
  } catch (e) {
    return res({ status: 'fail', message: `Không chạy được: ${e.message}`, fix: c.hint })
  }
}

// Chạy mọi checker áp dụng cho dự án. Checker có stack 'all' luôn chạy ở gốc; còn lại chỉ khi stack có mặt, chạy ở root của stack (xem lib/stack.mjs roots).
// deps tiêm để test: which(name,{cwd,env,platform}) → đường dẫn|null · exec(file,args,{cwd,timeoutMs,env,platform}) → {code,stdout,stderr,timedOut,error} · internals · concurrency.
export async function runChecks({ dir, checkers, env, platform, which, exec, internals, concurrency = 4 } = {}) {
  const abs = path.resolve(dir)
  const stacks = detect(abs)
  const rt = roots(abs)
  const ctx = {
    dir: abs,
    env: env ?? { ...process.env, NO_COLOR: '1' },
    platform: platform ?? process.platform,
    which: which ?? ((name, o) => findTool(name, o)),
    exec: exec ?? execIn,
    internals: { ...INTERNALS, ...internals },
  }
  const items = checkers.filter((c) => c.stack === 'all' || stacks.includes(c.stack))
  const results = await mapPool(items, concurrency, (c) => runOne(c, c.stack === 'all' ? abs : rt[c.stack], ctx))
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
exit: 0 đạt · 1 không đạt hoặc thiếu công cụ bắt buộc · 2 dùng sai / cấu hình hỏng`

function parseArgs(argv) {
  const o = { dir: process.cwd(), json: false, checkers: DEFAULT_CHECKERS, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--dir' || a === '--checkers') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) return { usage: `${a} cần một giá trị` }
      if (a === '--dir') o.dir = v
      else o.checkers = v
    } else return { usage: `cờ lạ ${a}` }
  }
  return o
}

// deps tiêm để test: { stdout, stderr, which, exec, internals, env, platform }. Trả mã thoát.
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
  const report = await runChecks({ dir, checkers: loaded.checkers, which: deps.which, exec: deps.exec, internals: deps.internals, env: deps.env, platform: deps.platform })
  out.write(o.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  return exitCode(report)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}

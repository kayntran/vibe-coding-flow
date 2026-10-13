// new-app: tạo app mới từ số 0 bằng LỆNH TẠO CHÍNH HÃNG (ghim bản) + lớp phủ của kit. Spec: docs/specs/2026-10-12-flow-v7-dot3 (AC-15, AC-29, PLAN mục 6).
// CLI: hooks/new-app.mjs (doctor, create). Lời nói với user nằm ở CLI; thư viện trả dữ liệu hoặc ném NewAppError (exit 1 lỗi/từ chối · 2 dùng sai · 3 thiếu phần mềm).
//
//   TYPES                              ['web','desktop','extension']
//   validateName(name)                 → null | lời báo       tên chỉ gồm a-z, 0-9, gạch ngang (đặt tên thư mục và tên gói)
//   loadVersions(kit?) · loadTemplate(type, kit?)             kit/templates/versions.json · kit/templates/<type>/template.json (kiểm dạng, chặn đường dẫn lạ)
//   doctor({ type, io })               → { ok, missing:[{tool, why, install:{win, mac}}], found:{…}, pm }   KHÔNG cài gì
//   generatorCommand(template, { name, pm, versions })        → { cmd, args }   lệnh tạo chính hãng (đã ghim bản)
//   classifyFailure(r)                 → { kind, say, detail }   phân loại lỗi một lệnh ngoài: mạng · quyền · ổ đĩa · diệt virus/khoá file · đổi cờ · thiếu phần mềm · quá giờ
//   applyOverlay({ template, overlayDir, appDir, tokens }) → { added, replaced, kept, removed, moved }   phủ kit/templates/<type>/overlay/**
//   create({ type, name, parent, pm, io }) → { dir, pm, steps, overlay, luu, notes, next }
//                                       các bước: kiểm máy → tạo → điểm lưu → lớp phủ → cài thư viện → công cụ kiểm (devDeps) → trình duyệt → bản đồ kiến trúc (arch init + gen) → dựng thử (build) → lưu
//                                       ⇒ app mới chạy `flow-check` được ngay (template.json: devDeps, build; còn lại nằm trong overlay).
//   installLines(install, platform)   → dòng lệnh cài của hệ điều hành đang chạy (doctor/create chỉ in Windows trên Windows, Mac trên Mac)
//
// io (tiêm khi test): run(cmd, args, { cwd, env, timeoutMs }) → { status, stdout, stderr, error }   (mặc định defaultRun: stdin đóng, CI=1, không TTY)
//                     platform · env · nodeVersion · log(lời) gọi TRƯỚC mỗi bước · kit (thư mục kit) · now (Date, đặt tên điểm lưu)
//
// Ranh giới an toàn:
//   - Thư mục đích đã có và không rỗng (hoặc là file) ⇒ từ chối, KHÔNG đè, KHÔNG xoá gì. Thư mục rỗng được dùng lại (chỉ rmdir thư mục rỗng).
//   - Lệnh ngoài luôn chạy với stdin đóng (không hỏi). Tên, đường dẫn cha đi qua cwd, không ghép vào dòng lệnh; Windows .cmd chỉ nhận đối số an toàn.
//   - Lớp phủ không đè file lệnh tạo sinh ra, trừ danh sách `replace` trong template.json.
//   - Lỗi giữa chừng: thư mục đã tạo giữ nguyên (không tự xoá), lời báo nói rõ.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gen as archGen, init as archInit } from './arch.mjs'
import { bat as luuBat, tao as luuTao } from './luu.mjs'

export const TYPES = ['web', 'desktop', 'extension']
// Mọi {{TOKEN}} mà overlay được phép dùng (create điền hết; test quét overlay để token gõ sai không lọt).
export const TOKEN_NAMES = ['APP_NAME', 'PORT', 'GO_MODULE', 'PM', 'PM_RUN', 'PM_DEV', 'PM_EXEC', 'PM_DLX', 'V_SHADCN', 'V_WXT', 'V_PLAYWRIGHT', 'V_AXE', 'V_WAILS']
export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit')
// Bản ghim bắt buộc có trong kit/templates/versions.json (công cụ tạo + kiểm thử + công cụ của máy kiểm flow-check).
const PINNED = ['shadcn', 'wxt', 'playwright', 'axe', 'shadcnLint', 'knip', 'jscpd', 'sizeLimit', 'depcruise', 'eslint', 'eslintJs', 'tsEslint', 'reactHooks', 'globals', 'vite', 'pluginReact', 'typescript', 'typesNode']
const NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/
const SAFE_ARG = /^[\w.:=/@+-]+$/
const GENERATE_TIMEOUT_MS = 10 * 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
const QUIET_ENV = {
  CI: '1', NO_COLOR: '1', npm_config_yes: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', DO_NOT_TRACK: '1', ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1', GIT_TERMINAL_PROMPT: '0',
}

export class NewAppError extends Error {
  constructor(message, { exit = 1, lines = [], kind = 'error' } = {}) {
    super(message)
    this.name = 'NewAppError'
    this.exit = exit
    this.lines = lines
    this.kind = kind
  }
}

// ---------- tiện ích nhỏ ----------

const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const exists = (p) => { try { fs.lstatSync(p); return true } catch { return false } }
const slash = (p) => String(p).replace(/\\/g, '/')
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, '') } catch { return null } }
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const tidy = (s) => String(s ?? '').replace(ANSI, '').replace(/\r/g, '')
const lastLines = (s, n = 3, max = 300) => tidy(s).split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ').slice(0, max)

function versionOf(text) {
  const m = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(tidy(text))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}
const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const showVer = (v) => v.join('.')

export function validateName(name) {
  if (typeof name !== 'string' || !name) return 'Thiếu tên app (--name).'
  if (!NAME_RE.test(name)) return `Tên app "${tidy(name).slice(0, 60)}" chưa dùng được: chỉ chữ thường không dấu, số và gạch ngang, bắt đầu bằng chữ, dài 3-40 ký tự (vd "quan-ly-don-hang").`
  return null
}

// ---------- cấu hình kit ----------

function readJsonFile(file, what) {
  const text = readText(file)
  if (text === null) throw new NewAppError(`Không đọc được ${what} (${slash(file)}). Kit chưa đủ file — cài lại kit.`)
  try { return JSON.parse(text) } catch { throw new NewAppError(`${what} sai cú pháp JSON (${slash(file)}).`) }
}

export function loadVersions(kit = KIT_DIR) {
  const v = readJsonFile(path.join(kit, 'templates', 'versions.json'), 'bảng phiên bản kit/templates/versions.json')
  for (const k of ['node', 'git', 'go', 'wails']) if (!v?.[k]?.min || !versionOf(v[k].min)) throw new NewAppError(`kit/templates/versions.json thiếu "${k}.min".`)
  for (const k of PINNED) if (!versionOf(v[k] ?? '')) throw new NewAppError(`kit/templates/versions.json thiếu bản ghim "${k}".`)
  return v
}

const safeRel = (p) => typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !slash(p).split('/').includes('..') && !/[\u0000-\u001f]/.test(p)

export function loadTemplate(type, kit = KIT_DIR) {
  if (!TYPES.includes(type)) throw new NewAppError(`Loại app "${tidy(type).slice(0, 40)}" chưa có mẫu. Chọn: ${TYPES.join(', ')}.`, { exit: 2 })
  const root = path.join(kit, 'templates', type)
  const t = readJsonFile(path.join(root, 'template.json'), `mẫu ${type}`)
  const bad = (what) => new NewAppError(`kit/templates/${type}/template.json: ${what}`)
  if (t.type !== type) throw bad(`"type" phải là "${type}"`)
  const g = t.generate
  if (!g || !Array.isArray(g.args) || g.args.some((a) => typeof a !== 'string')) throw bad('thiếu generate.args')
  if (g.runner === 'bin' ? typeof g.bin !== 'string' : g.runner !== 'pm-exec' || typeof g.package !== 'string') throw bad('generate.runner phải là "bin" (kèm bin) hoặc "pm-exec" (kèm package)')
  for (const key of ['replace', 'gitignore', 'gitignoreRemove', 'markers']) if (t[key] !== undefined && (!Array.isArray(t[key]) || t[key].some((x) => typeof x !== 'string'))) throw bad(`"${key}" phải là danh sách chữ`)
  for (const p of [...(t.replace ?? []), ...(t.markers ?? []), ...(t.remove ?? []).map((r) => r?.path), ...(t.move ?? []).flatMap((m) => [m?.from, m?.to]), ...(t.patch ?? []).map((x) => x?.file), t.pkgDir ?? '.']) {
    if (p !== '.' && !safeRel(p)) throw bad(`đường dẫn không hợp lệ: ${JSON.stringify(p)}`)
  }
  if (t.archDeps !== undefined && (!t.archDeps || typeof t.archDeps !== 'object' || Array.isArray(t.archDeps) || Object.values(t.archDeps).some((d) => !Array.isArray(d) || d.some((n) => typeof n !== 'string')))) throw bad('"archDeps" phải là các cặp đường dẫn module → danh sách tên module')
  const plainJson = (v) => typeof v === 'string' || (Array.isArray(v) ? v.every(plainJson) : Boolean(v) && typeof v === 'object' && Object.values(v).every(plainJson))
  for (const x of t.patch ?? []) {
    if (!x.set || typeof x.set !== 'object' || Array.isArray(x.set) || !Object.values(x.set).every(plainJson)) throw bad(`patch ${JSON.stringify(x.file)}: "set" phải là các cặp khoá → chữ (hoặc danh sách / object chỉ gồm chữ)`)
    if (x.pm !== undefined && !['pnpm', 'npm'].includes(x.pm)) throw bad(`patch ${JSON.stringify(x.file)}: "pm" chỉ nhận pnpm hoặc npm`)
  }
  if (!safeRel(t.overlay ?? 'overlay')) throw bad('"overlay" không hợp lệ')
  if (!t.stack || !['web', 'wails', 'extension', 'go'].includes(t.stack)) throw bad('"stack" phải là web|wails|extension|go')
  const overlayDir = path.join(root, t.overlay ?? 'overlay')
  if (!isDir(overlayDir)) throw bad(`thiếu thư mục ${t.overlay ?? 'overlay'}`)
  if (!t.next || typeof t.next.dev !== 'string' || typeof t.next.url !== 'string') throw bad('thiếu next.dev và next.url (lệnh chạy thử và địa chỉ mở app)')
  return { replace: [], gitignore: [], gitignoreRemove: [], markers: ['package.json'], remove: [], move: [], devDeps: [], scripts: {}, needs: [], patch: [], install: false, browser: false, build: false, ...t, overlayDir }
}

// ---------- chạy lệnh ngoài ----------

function which(cmd, env, platform = process.platform) {
  const win = platform === 'win32'
  if (/[\\/]/.test(cmd)) return isFile(cmd) ? cmd : null
  const exts = win ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  const pathVar = env.PATH ?? env.Path ?? env.path ?? ''
  for (const d of pathVar.split(path.delimiter)) {
    if (!d) continue
    for (const e of exts) {
      const p = path.join(d.replace(/^"(.*)"$/, '$1'), cmd + e)
      if (isFile(p)) return p
    }
  }
  return null
}

// Chạy một lệnh ngoài, đồng bộ, stdin ĐÓNG (lệnh không thể hỏi). Windows .cmd/.bat (npm, pnpm, npx) chạy qua cmd.exe, chỉ nhận đối số an toàn.
export function defaultRun(cmd, args = [], { cwd, env = {}, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  const penv = { ...process.env, ...QUIET_ENV, ...env }
  const file = which(cmd, penv)
  if (!file) return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: `không thấy ${cmd}` } }
  let exe = file
  let argv = args
  const opts = { cwd, env: penv, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    if (!args.every((a) => SAFE_ARG.test(a)) || /["%!^&|<>]/.test(file)) return { status: null, stdout: '', stderr: '', error: { code: 'EUNSAFE', message: 'đối số hoặc đường dẫn không an toàn để chạy qua cmd.exe' } }
    exe = penv.ComSpec || penv.COMSPEC || 'cmd.exe'
    argv = ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`]
    opts.windowsVerbatimArguments = true
  }
  const r = spawnSync(exe, argv, opts)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? { code: r.error.code ?? 'ESPAWN', message: r.error.message } : null }
}

const ioOf = (io = {}) => ({
  run: io.run ?? defaultRun,
  platform: io.platform ?? process.platform,
  env: io.env ?? process.env,
  nodeVersion: io.nodeVersion ?? process.versions.node,
  log: io.log ?? (() => {}),
  kit: io.kit ?? KIT_DIR,
  now: io.now ?? new Date(),
})

// ---------- phân loại lỗi ----------

const RE_DISK = /ENOSPC|no space left|not enough space|disk (?:is )?full|EDQUOT|insufficient disk space/i
const RE_AV = /virus|malware|quarantin|defender|applocker|app control|0x800700E1|blocked by (?:your )?(?:antivirus|security|policy)|EBUSY|resource busy or locked|being used by another process|EPERM[^\n]*\b(?:rename|unlink|rmdir|scandir|lstat|open|copyfile)\b/i
const RE_PERM = /EACCES|EPERM|EROFS|permission denied|access is denied|operation not permitted|read-only file system/i
const RE_NET = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|network|fetch failed|getaddrinfo|socket hang up|unable to (?:get|resolve|connect)|could not resolve|dial tcp|i\/o timeout|connection (?:refused|reset|timed out)|ERR_PNPM_(?:META_)?FETCH|ERR_SOCKET|self[- ]signed|certificate|\bproxy\b|\b(?:TLS|SSL)\b|\btunnel/i
const RE_FLAGS = /unknown (?:option|argument|flag|command)|unrecognized (?:option|argument)|invalid (?:option|argument|template|flag)|unexpected argument|too many arguments|flag provided but not defined|no such (?:template|option)|template .{0,40}not found|did you mean|required (?:argument|option) .{0,40}missing|missing required/i

// pnpm ≥ 10 trong chế độ CI báo LỖI khi một thư viện có bước cài phụ (postinstall) chưa được cho phép trong pnpm-workspace.yaml (allowBuilds).
const RE_BUILDS = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts|approve-builds/i

export function classifyFailure(r = {}, what = 'lệnh') {
  const text = `${tidy(r.stderr)}\n${tidy(r.stdout)}`
  const detail = lastLines(tidy(r.stderr).trim() ? r.stderr : r.stdout) || (r.error?.message ? tidy(r.error.message).slice(0, 200) : '')
  const code = r.error?.code
  if (code === 'ENOENT') return { kind: 'missing-tool', say: `Máy chưa có phần mềm "${what}" (hoặc chưa nằm trong PATH). Chạy lại: new-app.mjs doctor để xem lệnh cài.`, detail }
  if (code === 'EUNSAFE') return { kind: 'unsafe', say: `Từ chối chạy "${what}" vì đối số hoặc đường dẫn có ký tự không an toàn.`, detail }
  if (code === 'ETIMEDOUT' && r.status == null) return { kind: 'timeout', say: `"${what}" chạy quá lâu nên đã dừng — thường do mạng chậm hoặc bị chặn. Kiểm tra mạng rồi chạy lại.`, detail }
  if (RE_DISK.test(text)) return { kind: 'disk', say: 'Ổ đĩa đã đầy hoặc gần đầy. Dọn bớt chỗ trống (cần vài trăm MB) rồi chạy lại.', detail }
  if (RE_AV.test(text)) return { kind: 'antivirus', say: 'Có file đang bị khoá hoặc bị chặn, thường do phần mềm diệt virus đang quét hoặc một chương trình khác đang mở thư mục. Đợi một lúc (hoặc tạm loại thư mục này khỏi quét), đóng chương trình đang mở nó rồi chạy lại.', detail }
  if (RE_PERM.test(text)) return { kind: 'permission', say: 'Không có quyền ghi vào thư mục này. Chọn thư mục bạn có quyền (vd trong Documents) hoặc chạy lại với quyền cao hơn.', detail }
  if (RE_NET.test(text)) return { kind: 'network', say: 'Không tải được thư viện từ mạng. Kiểm tra kết nối internet (hoặc proxy/VPN của công ty) rồi chạy lại.', detail }
  if (RE_BUILDS.test(text)) return { kind: 'build-scripts', say: `${what} từ chối chạy bước cài phụ của một thư viện vì mẫu của kit chưa cho phép nó (pnpm-workspace.yaml, mục allowBuilds). Đây là lỗi của kit — báo người bảo trì; đừng tự chạy "pnpm approve-builds".`, detail }
  if (RE_FLAGS.test(text)) return { kind: 'flags', say: `Công cụ tạo dự án ("${what}") đã đổi cách dùng so với bản kit ghim, nên kit chưa tạo được app. Đây là lỗi của kit, không phải của bạn — báo người bảo trì kit; đừng thử lách.`, detail }
  return { kind: 'error', say: `"${what}" báo lỗi${r.status == null ? '' : ` (mã ${r.status})`} nên chưa tạo xong app.`, detail }
}

function failure(r, what, extra = '') {
  const c = classifyFailure(r, what)
  return new NewAppError(`${c.say}${extra ? ` ${extra}` : ''}`, { kind: c.kind, lines: c.detail ? [`Chi tiết: ${c.detail}`] : [] })
}

// ---------- doctor ----------

const INSTALL = (v) => ({
  node: { win: 'winget install OpenJS.NodeJS.LTS', mac: 'brew install node' },
  git: { win: 'winget install Git.Git', mac: 'brew install git' },
  go: { win: 'winget install GoLang.Go', mac: 'brew install go' },
  wails: { win: `go install github.com/wailsapp/wails/v2/cmd/wails@v${v.wails.pin ?? v.wails.min}`, mac: `go install github.com/wailsapp/wails/v2/cmd/wails@v${v.wails.pin ?? v.wails.min}` },
  webview2: { win: 'winget install Microsoft.EdgeWebView2Runtime', mac: null },
  xcode: { win: null, mac: 'xcode-select --install' },
})

// Dòng lệnh cài của hệ điều hành ĐANG CHẠY: Windows ⇒ chỉ dòng Windows, Mac ⇒ chỉ dòng Mac; hệ khác (Linux…) ⇒ cả hai (không đoán).
export function installLines(install = {}, platform = process.platform) {
  const win = platform === 'win32'
  const mac = platform === 'darwin'
  return [
    ...(install.win && (win || !mac) ? [`    Windows: ${install.win}`] : []),
    ...(install.mac && (mac || !win) ? [`    Mac: ${install.mac}`] : []),
  ]
}

const WEBVIEW2_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
]

function probe(io, cmd, args) {
  const r = io.run(cmd, args, { timeoutMs: 30_000 })
  if (r.error || r.status !== 0) return null
  return `${r.stdout}\n${r.stderr}`
}

export function doctor({ type, io: rawIo, pm: wantPm } = {}) {
  const io = ioOf(rawIo)
  const template = loadTemplate(type, io.kit)
  const v = loadVersions(io.kit)
  const inst = INSTALL(v)
  const missing = []
  const found = {}
  const need = (tool, why, install) => missing.push({ tool, why, install })
  const old = (name, have, min) => `${name} ${showVer(have)} cũ hơn bản cần (${min}).`

  const node = versionOf(io.nodeVersion)
  found.node = node ? showVer(node) : null
  if (!node || cmpVer(node, versionOf(v.node.min)) < 0) need('node', node ? old('Node', node, v.node.min) : 'Chưa thấy Node.', inst.node)

  const gitOut = probe(io, 'git', ['--version'])
  const git = gitOut && versionOf(gitOut)
  found.git = git ? showVer(git) : null
  if (!git) need('git', 'Chưa có git (dùng để lưu các lần sửa của app).', inst.git)
  else if (cmpVer(git, versionOf(v.git.min)) < 0) need('git', old('Git', git, v.git.min), inst.git)

  const pnpmOut = probe(io, 'pnpm', ['--version'])
  const npmOut = probe(io, 'npm', ['--version'])
  found.pnpm = pnpmOut && versionOf(pnpmOut) ? showVer(versionOf(pnpmOut)) : null
  found.npm = npmOut && versionOf(npmOut) ? showVer(versionOf(npmOut)) : null
  if (wantPm && !['pnpm', 'npm'].includes(wantPm)) throw new NewAppError(`--pm chỉ nhận pnpm hoặc npm (nhận "${tidy(wantPm).slice(0, 20)}").`, { exit: 2 })
  const pm = wantPm ?? (found.pnpm ? 'pnpm' : 'npm')
  if (pm === 'pnpm' && !found.pnpm) need('pnpm', 'Chọn pnpm nhưng máy chưa có pnpm.', { win: 'npm install -g pnpm', mac: 'npm install -g pnpm' })
  if (pm === 'npm' && !found.npm) need('npm', 'Chưa có npm (đi kèm Node).', inst.node)

  if (template.needs.includes('go')) {
    const go = probe(io, 'go', ['version'])
    const gv = go && versionOf(go.replace(/^.*?go version/i, ''))
    found.go = gv ? showVer(gv) : null
    if (!gv) need('go', 'Chưa có Go (ngôn ngữ của phần lõi app máy tính).', inst.go)
    else if (cmpVer(gv, versionOf(v.go.min)) < 0) need('go', old('Go', gv, v.go.min), inst.go)
  }
  if (template.needs.includes('wails')) {
    const out = probe(io, 'wails', ['version'])
    const m = out && /\bv(\d+\.\d+\.\d+)/.exec(tidy(out))
    const wv = m ? versionOf(m[1]) : out ? versionOf(out) : null
    found.wails = wv ? showVer(wv) : null
    if (!wv) need('wails', 'Chưa có công cụ Wails (khung làm app máy tính). Cần Go trước.', inst.wails)
    else if (wv[0] !== 2 || cmpVer(wv, versionOf(v.wails.min)) < 0) need('wails', `Wails ${showVer(wv)} không phải dòng 2 từ ${v.wails.min} trở lên mà mẫu này dùng.`, inst.wails)
  }
  if (template.needs.includes('webview2') && io.platform === 'win32') {
    const ok = WEBVIEW2_KEYS.some((key) => {
      const out = probe(io, 'reg', ['query', key, '/v', 'pv'])
      const m = out && /\bpv\s+REG_SZ\s+(\S+)/i.exec(out)
      return Boolean(m && m[1] !== '0.0.0.0')
    })
    found.webview2 = ok
    if (!ok) need('webview2', 'Chưa có WebView2 (phần hiển thị cửa sổ app của Windows; Windows 11 thường có sẵn).', inst.webview2)
  }
  if (template.needs.includes('xcode') && io.platform === 'darwin') {
    const ok = probe(io, 'xcode-select', ['-p']) !== null
    found.xcode = ok
    if (!ok) need('xcode', 'Chưa có công cụ dòng lệnh của Apple (cần để dựng app máy tính trên Mac).', inst.xcode)
  }
  return { ok: missing.length === 0, missing, found, pm, platform: io.platform }
}

// ---------- lệnh tạo ----------

export function generatorCommand(template, { name, pm, versions }) {
  const g = template.generate
  const sub = (s) => s.replaceAll('{{name}}', name).replaceAll('{{pm}}', pm)
  const args = g.args.map(sub)
  if (g.runner === 'bin') return { cmd: g.bin, args }
  const ver = versions[g.package]
  if (!ver) throw new NewAppError(`kit/templates/versions.json chưa ghim bản cho "${g.package}".`)
  const spec = `${g.package}@${ver}`
  return pm === 'pnpm' ? { cmd: 'pnpm', args: ['dlx', spec, ...args] } : { cmd: 'npx', args: ['--yes', spec, ...args] }
}

// ---------- lớp phủ ----------

function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else if (e.isFile()) out.push(slash(path.relative(base, p)))
  }
  return out
}

const fillTokens = (text, tokens) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(tokens, k) ? tokens[k] : m))
const fillDeep = (v, tokens) => (typeof v === 'string' ? fillTokens(v, tokens) : Array.isArray(v) ? v.map((x) => fillDeep(x, tokens)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, tokens)])) : v)

function writeJson(file, obj, indent) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, indent)}\n`)
}

function addGitignore(appDir, lines) {
  if (!lines.length) return
  const file = path.join(appDir, '.gitignore')
  const cur = readText(file) ?? ''
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()))
  const add = lines.filter((l) => !have.has(l.trim()))
  if (!add.length) return
  fs.writeFileSync(file, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}${cur === '' ? '' : '\n'}# kit: khoá bí mật, kết quả kiểm thử\n${add.join('\n')}\n`)
}

function dropGitignore(appDir, lines) {
  if (!lines.length) return
  const file = path.join(appDir, '.gitignore')
  const cur = readText(file)
  if (cur === null) return
  const drop = new Set(lines.map((l) => l.trim()))
  const next = cur.split('\n').filter((l) => !drop.has(l.trim())).join('\n')
  if (next !== cur) fs.writeFileSync(file, next)
}

function mergeScripts(appDir, pkgDir, scripts) {
  const entries = Object.entries(scripts ?? {})
  if (!entries.length) return []
  const file = path.join(appDir, pkgDir, 'package.json')
  const text = readText(file)
  if (text === null) return []
  const pkg = JSON.parse(text)
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? 2
  pkg.scripts ??= {}
  const added = []
  for (const [k, v] of entries) if (!Object.hasOwn(pkg.scripts, k)) { pkg.scripts[k] = v; added.push(k) }
  if (added.length) writeJson(file, pkg, indent)
  return added
}

// Phủ overlay/** lên appDir. File đã có (do lệnh tạo sinh) chỉ bị đè khi nằm trong template.replace; còn lại giữ nguyên.
export function applyOverlay({ template, overlayDir = template.overlayDir, appDir, tokens = {} }) {
  const res = { added: [], replaced: [], kept: [], removed: [], moved: [], scripts: [], patched: [] }
  const root = path.resolve(appDir)
  const within = (rel) => {
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new NewAppError(`Đường dẫn lớp phủ chạy ra ngoài thư mục app: ${rel}`)
    return abs
  }
  for (const m of template.move) {
    const from = within(m.from)
    const to = within(m.to)
    if (!exists(from)) continue
    if (exists(to)) { res.kept.push(slash(m.to)); continue }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    res.moved.push(`${slash(m.from)} → ${slash(m.to)}`)
  }
  for (const r of template.remove) {
    const abs = within(r.path)
    const text = isFile(abs) ? readText(abs) : null
    if (text === null) continue
    if (r.contains && !text.includes(r.contains)) { res.kept.push(slash(r.path)); continue }
    fs.unlinkSync(abs)
    res.removed.push(slash(r.path))
  }
  const replace = new Set(template.replace.map(slash))
  for (const rel of walk(overlayDir)) {
    const target = within(rel)
    const had = exists(target)
    if (had && !replace.has(rel)) { res.kept.push(rel); continue }
    const text = fillTokens(readText(path.join(overlayDir, ...rel.split('/'))).replace(/\r\n/g, '\n'), tokens)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    ;(had ? res.replaced : res.added).push(rel)
  }
  res.scripts = mergeScripts(root, template.pkgDir ?? '.', template.scripts)
  // patch: đặt giá trị cho khoá cấp cao nhất của file JSON do lệnh tạo sinh (vd wails.json: đổi npm → pnpm). Khác overlay: đè khoá có sẵn có chủ đích.
  // Giá trị có thể là chữ, danh sách hoặc object (vd "overrides" của npm); token {{…}} điền ở mọi chữ bên trong. Mục có "pm" chỉ áp khi đúng trình quản lý gói (tokens.PM).
  for (const p of template.patch) {
    if (p.pm && tokens.PM && p.pm !== tokens.PM) continue
    const file = within(p.file)
    const text = readText(file)
    let obj
    try { obj = text === null ? null : JSON.parse(text) } catch { obj = null }
    if (!obj || typeof obj !== 'object') continue
    let changed = false
    for (const [k, v] of Object.entries(p.set)) {
      const val = fillDeep(v, tokens)
      if (JSON.stringify(obj[k]) !== JSON.stringify(val)) { obj[k] = val; changed = true }
    }
    if (changed) { writeJson(file, obj, /^(\s+)"/m.exec(text)?.[1] ?? 2); res.patched.push(slash(p.file)) }
  }
  return res
}

// docs/arch.json do `arch init` suy từ thư mục thật có mô tả "(điền…)": điền lời mô tả của mẫu cho các module đã biết.
function fillArch(appDir, template) {
  const descs = template.archDescs ?? {}
  const file = path.join(appDir, 'docs', 'arch.json')
  const text = readText(file)
  if (text === null) return
  let arch
  try { arch = JSON.parse(text) } catch { return }
  const md = path.join(appDir, 'docs', 'ARCHITECTURE.md')
  let doc = readText(md)
  let changed = false
  for (const part of arch.parts ?? []) {
    const names = new Set((part.modules ?? []).map((m) => m.name))
    for (const m of part.modules ?? []) {
      // archDeps: mẫu khai module nào được import module nào (vd popup của extension ráp màn từ features/home); chỉ nhận tên module có thật.
      const deps = template.archDeps?.[m.path]
      if (deps) {
        const want = deps.filter((n) => names.has(n) && n !== m.name)
        if (want.join() !== (m.mayDependOn ?? []).join()) { m.mayDependOn = want; changed = true }
      }
      const d = descs[m.path]
      if (!d || !/^\(điền/.test(m.desc ?? '')) continue
      if (doc !== null) doc = doc.split('\n').map((l) => (l.startsWith(`- \`${m.path}\` — (điền`) ? `- \`${m.path}\` — ${d}` : l)).join('\n')
      m.desc = d
      changed = true
    }
  }
  if (changed) writeJson(file, arch, 2)
  if (doc !== null && template.archProblem) doc = doc.replace(/\(Một đoạn:[^)]*\)/, () => template.archProblem)
  if (doc !== null) fs.writeFileSync(md, doc)
}

// ---------- git ----------

function gitIn(io, dir, args) {
  const r = io.run('git', args, { cwd: dir, timeoutMs: 120_000 })
  if (r.error || r.status !== 0) throw failure(r, 'git')
  return r
}

function ensureOwnRepo(io, appDir) {
  if (exists(path.join(appDir, '.git'))) return
  const r = io.run('git', ['init', '-q', '-b', 'main'], { cwd: appDir })
  if (r.error || r.status !== 0) {
    gitIn(io, appDir, ['init', '-q'])
    gitIn(io, appDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }
}

function commitAll(io, appDir, message) {
  gitIn(io, appDir, ['add', '-A'])
  const dirty = gitIn(io, appDir, ['status', '--porcelain']).stdout.trim()
  if (!dirty) return false
  const who = io.run('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: appDir }).status === 0 && io.run('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: appDir }).status === 0 ? [] : ['-c', 'user.name=Flow', '-c', 'user.email=flow@localhost']
  gitIn(io, appDir, ['-c', 'commit.gpgsign=false', ...who, 'commit', '--no-verify', '-q', '-m', message])
  return true
}

// ---------- tạo ----------

function prepareTarget(parent, name) {
  const parentAbs = path.resolve(parent)
  if (exists(parentAbs) && !isDir(parentAbs)) throw new NewAppError(`"${parentAbs}" là một file, không phải thư mục. Chọn thư mục khác để đặt app.`)
  const target = path.join(parentAbs, name)
  if (exists(target)) {
    if (!isDir(target)) throw new NewAppError(`Đã có một file tên "${name}" trong ${parentAbs}. Chọn tên khác.`)
    if (fs.readdirSync(target).length) throw new NewAppError(`Thư mục ${target} đã có đồ bên trong nên không tạo app vào đó (tránh đè mất việc của bạn). Chọn tên khác hoặc thư mục cha khác.`)
    return { parentAbs, target, empty: true }
  }
  return { parentAbs, target, empty: false }
}

function pmCommands(pm) {
  return pm === 'pnpm'
    ? { install: ['pnpm', ['install']], add: (pkgs) => ['pnpm', ['add', '-D', ...pkgs]], run: (script) => ['pnpm', ['run', script]], exec: (args) => ['pnpm', ['exec', ...args]], tokens: { PM: 'pnpm', PM_RUN: 'pnpm', PM_DEV: 'pnpm dev', PM_EXEC: 'pnpm exec', PM_DLX: 'pnpm dlx' } }
    : { install: ['npm', ['install']], add: (pkgs) => ['npm', ['install', '-D', ...pkgs]], run: (script) => ['npm', ['run', script]], exec: (args) => ['npx', ['--yes', ...args]], tokens: { PM: 'npm', PM_RUN: 'npm run', PM_DEV: 'npm run dev --', PM_EXEC: 'npx', PM_DLX: 'npx --yes' } }
}

export function create({ type, name, parent = '.', pm: wantPm, io: rawIo } = {}) {
  const io = ioOf(rawIo)
  if (!TYPES.includes(type)) throw new NewAppError(`Loại app "${tidy(type).slice(0, 40)}" chưa có mẫu. Chọn: ${TYPES.join(', ')}.`, { exit: 2 })
  const nameProblem = validateName(name)
  if (nameProblem) throw new NewAppError(nameProblem, { exit: 2 })
  const template = loadTemplate(type, io.kit)
  const versions = loadVersions(io.kit)
  const { parentAbs, target, empty } = prepareTarget(parent, name)

  const steps = []
  const notes = []
  const step = (id, say) => { steps.push({ id, say }); io.log(say) }

  step('doctor', 'Kiểm máy có đủ phần mềm…')
  const dr = doctor({ type, io: rawIo, pm: wantPm })
  if (!dr.ok) {
    throw new NewAppError('Máy còn thiếu phần mềm nên chưa tạo app. Cài rồi chạy lại.', {
      exit: 3,
      lines: dr.missing.flatMap((m) => [`- ${m.tool}: ${m.why}`, ...installLines(m.install, dr.platform)]),
    })
  }
  const pm = dr.pm
  const cmds = pmCommands(pm)

  fs.mkdirSync(parentAbs, { recursive: true })
  if (empty) {
    try { fs.rmdirSync(target) } catch (e) { throw new NewAppError(`Không dùng được thư mục rỗng ${target} (${e.code ?? e.message}). Đóng chương trình đang mở nó hoặc chọn tên khác.`) }
  }

  step('generate', `Tạo dự án bằng công cụ chính hãng (${template.label ?? type}) — có thể mất vài phút…`)
  const gen = generatorCommand(template, { name, pm, versions })
  const g = io.run(gen.cmd, gen.args, { cwd: parentAbs, timeoutMs: GENERATE_TIMEOUT_MS })
  if (g.error || g.status !== 0) throw failure(g, gen.cmd, `Thư mục ${target} có thể đã tạo dở — xoá nó (nếu có) rồi chạy lại.`)
  if (!isDir(target) || !template.markers.every((m) => exists(path.join(target, m)))) {
    throw new NewAppError(`Công cụ tạo dự án chạy xong nhưng không thấy kết quả như kit mong đợi (thiếu ${template.markers.join(', ')} trong ${target}). Đây thường là do công cụ đổi cách làm — báo người bảo trì kit.`, { kind: 'flags', lines: [`Chi tiết: ${lastLines(g.stdout)}`] })
  }

  step('luu', 'Bật điểm lưu…')
  ensureOwnRepo(io, target)
  const bat = luuBat(target, { now: io.now })
  if (!bat.created && !bat.nested) notes.push('Công cụ tạo dự án đã lập git sẵn; kit dùng tiếp.')

  step('overlay', 'Phủ lớp phủ của kit (luật AI, cấu hình kiểm giao diện, màn đầu trống, test mẫu)…')
  const goMod = /^module\s+(\S+)/m.exec(readText(path.join(target, 'go.mod')) ?? '')?.[1]
  const tokens = {
    ...cmds.tokens, APP_NAME: name, PORT: String(template.port ?? ''), GO_MODULE: goMod ?? name,
    V_SHADCN: versions.shadcn, V_WXT: versions.wxt, V_PLAYWRIGHT: versions.playwright, V_AXE: versions.axe, V_WAILS: versions.wails.pin ?? versions.wails.min,
  }
  const overlay = applyOverlay({ template, appDir: target, tokens })
  addGitignore(target, template.gitignore)
  dropGitignore(target, template.gitignoreRemove)

  const pkgDir = path.join(target, template.pkgDir ?? '.')
  if (template.install && isFile(path.join(pkgDir, 'package.json'))) {
    step('install', 'Cài thư viện…')
    const [c, a] = cmds.install
    const r = io.run(c, a, { cwd: pkgDir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (r.error || r.status !== 0) throw failure(r, `${pm} install`, `App đã tạo ở ${target}; chạy lại "${pm} install" trong ${slash(path.relative(parentAbs, pkgDir)) || name} khi mạng ổn.`)
  }
  if (template.devDeps.length) {
    step('devdeps', 'Thêm công cụ kiểm thử và máy kiểm (Playwright, axe, knip, size-limit…)…')
    const pkgs = template.devDeps.map((d) => {
      if (!versions[d.version]) throw new NewAppError(`kit/templates/${type}/template.json: devDeps "${d.name}" trỏ tới bản ghim "${d.version}" mà kit/templates/versions.json không có.`)
      return `${d.name}@${versions[d.version]}`
    })
    const [c, a] = cmds.add(pkgs)
    const r = io.run(c, a, { cwd: pkgDir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (r.error || r.status !== 0) throw failure(r, `${pm} add`, `App đã tạo ở ${target}; chạy lại "${pm} add -D ${pkgs.join(' ')}" khi mạng ổn.`)
  }
  if (template.browser) {
    step('browser', 'Tải trình duyệt để kiểm thử (Chromium)…')
    const [c, a] = cmds.exec(['playwright', 'install', 'chromium'])
    const r = io.run(c, a, { cwd: pkgDir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (r.error || r.status !== 0) notes.push(`Chưa tải được trình duyệt kiểm thử (${classifyFailure(r, 'playwright').kind}). Khi mạng ổn chạy: ${[c, ...a].join(' ')} (trong thư mục ${slash(path.relative(parentAbs, pkgDir)) || name}).`)
  }

  step('arch', 'Lập bản đồ kiến trúc (docs/arch.json)…')
  const arch = archInit(target, { stack: template.stack })
  fillArch(target, template)
  for (const n of arch.notes) notes.push(n)
  // Sinh cấu hình công cụ kiểm kiến trúc (.dependency-cruiser.cjs, .go-arch-lint.yml…) để máy kiểm chạy được ngay, không phải gõ thêm lệnh.
  try { archGen(target) } catch (e) {
    throw new NewAppError(`Chưa sinh được cấu hình kiểm kiến trúc: ${tidy(e.message).slice(0, 300)}. App đã tạo ở ${target}; chạy: node ~/.claude/hooks/arch.mjs gen --dir "${target}"`)
  }

  if (template.build && isFile(path.join(pkgDir, 'package.json'))) {
    // Dựng một lần: máy kiểm quét khoá bí mật và đo dung lượng trên BẢN BUILD (dist/), chưa dựng thì báo THIẾU; test trợ năng của extension chạy trên bản đã dựng.
    step('build', 'Dựng thử một lần (để máy kiểm có bản build)…')
    const [c, a] = cmds.run('build')
    const r = io.run(c, a, { cwd: pkgDir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (r.error || r.status !== 0) throw failure(r, `${pm} run build`, `App đã tạo ở ${target}; chạy lại "${pm} run build" trong ${slash(path.relative(parentAbs, pkgDir)) || name} để xem lỗi.`)
  }

  step('save', 'Lưu thành điểm "Tạo app"…')
  commitAll(io, target, 'Tạo app từ mẫu của kit')
  const point = luuTao(target, 'Tạo app', { now: io.now })

  const next = { cwd: target, dev: template.next.dev.replaceAll('{{PM_DEV}}', cmds.tokens.PM_DEV), url: template.next.url, open: template.next.open ?? null }
  return { type, name, dir: target, pm, steps, overlay, luu: { tag: point.tag, name: point.name, created: point.created }, notes, next }
}

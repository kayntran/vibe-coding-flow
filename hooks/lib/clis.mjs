// clis: kiểm CLI ngoài (claude, codex, cursor-agent, agy, grok, devin) TRƯỚC khi gọi — cài chưa, bản nào, đã đăng nhập chưa, vì sao không dùng được.
// Bằng chứng từng lệnh/bẫy: docs/specs/2026-10-11-flow-v7-nocode/research.md §3 và notes/research-devin.md (nhãn [KIỂM] = đã chạy thật).
//
//   await check(name, opts) → { name, installed, path, version, auth:'ok'|'none'|'unknown', reason, message, ready, loginCmd, installHint }
//   await checkAll(names?, opts) → { [name]: kết quả }              (song song; mặc định cả 6)
//   classifyFailure(name, {code, stdout, stderr, timedOut, error}) → { reason, message, loginCmd }   (xét TỪNG LẦN GỌI, không cache)
//
// reason: ok · not-installed · not-logged-in · quota · network · permission · timeout · error · unrecognized ·
//         no-status-command (agy: không có lệnh kiểm đăng nhập) · in-claude-session (claude: không dùng được `auth status` trong phiên Claude)
// ready = có thể gọi thử: đã cài và (auth ok, hoặc unknown do thiết kế = no-status-command / in-claude-session).
// loginCmd chỉ có khi auth='none' (hết hạn mức/mạng/quyền thì KHÔNG gợi ý login); installHint chỉ có khi chưa cài.
//
// Hợp đồng an toàn:
//   - Không bao giờ đưa output thô của CLI vào kết quả (output `status` có email, `devin auth status` có đường dẫn credentials): chỉ trích phiên bản + cờ.
//   - Không truyền chuỗi của user vào shell: đối số là hằng trong bảng CLIS (kiểm lại ở runCommand); Windows .cmd chạy qua cmd.exe với dòng lệnh dựng từ hằng.
//   - Không login/logout/cài. Mỗi lệnh ≤ 20 giây (timeout bằng Node, diệt cả cây tiến trình; macOS không có `timeout`).
//   - Cache 10 phút ở ~/.claude/cache/clis.json CHỈ cho kết quả ok (user vừa login/cài xong không bị kết quả cũ chặn).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CLI_NAMES = ['claude', 'codex', 'cursor-agent', 'agy', 'grok', 'devin']
export const CACHE_TTL_MS = 10 * 60 * 1000
export const MAX_TIMEOUT_MS = 20_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT = 256 * 1024

// --- bảng CLI --------------------------------------------------------------------------------------------------------------------------

const NOT_LOGGED_RE = /not (?:logged|signed) in|not authenticated|unauthenticated|logged out|(?:log|sign) ?in (?:is )?required|please (?:log ?in|sign ?in)|(?:log|sign) in again|access token could not be refreshed/i
const LOGGED_RE = /logged in|signed in/i
const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }

// text = stdout + stderr đã làm sạch; trả 'ok' | 'none' | null (không đọc được).
const textAuth = (okRe) => ({ code, text }) => (NOT_LOGGED_RE.test(text) ? 'none' : code === 0 && okRe.test(text) ? 'ok' : null)

const CLIS = {
  // `claude auth status` in JSON ({"loggedIn":bool,…}, có email ⇒ chỉ lấy cờ). Chưa login: exit 1 [KIỂM]. Trong phiên Claude báo sai ⇒ bỏ qua ở probe().
  claude: {
    status: ['auth', 'status'],
    parse: ({ code, text }) => {
      const j = tryJson(text.trim())
      const m = /"loggedIn"\s*:\s*(true|false)/.exec(text)
      const flag = typeof j?.loggedIn === 'boolean' ? j.loggedIn : m ? m[1] === 'true' : null
      if (flag !== null) return flag ? 'ok' : 'none'
      return textAuth(LOGGED_RE)({ code, text })
    },
    login: 'claude auth login',
    install: { win32: 'irm https://claude.ai/install.ps1 | iex', posix: 'curl -fsSL https://claude.ai/install.sh | bash' },
  },
  // `codex login status`: "Logged in using ChatGPT" exit 0; "Not logged in" exit 1 [KIỂM].
  codex: { status: ['login', 'status'], parse: textAuth(LOGGED_RE), login: 'codex login', install: 'npm i -g @openai/codex' },
  // `cursor-agent status`: "✓ Logged in as <email>" exit 0 [KIỂM]; trạng thái chưa login chưa kiểm ⇒ nhận theo chuỗi chung. Tên `agent` trên PATH có thể là grok ⇒ chỉ dùng `cursor-agent`.
  'cursor-agent': {
    status: ['status'],
    parse: textAuth(LOGGED_RE),
    login: 'cursor-agent login',
    install: { win32: "irm 'https://cursor.com/install?win32=true' | iex", posix: 'curl https://cursor.com/install -fsS | bash' },
  },
  // agy không có lệnh trạng thái [KIỂM `agy --help`]; `agy models` cần mạng và hành vi khi chưa login chưa biết (có thể mở trình duyệt) ⇒ không thăm dò.
  // Lệnh login và lệnh cài của agy: CHƯA xác minh bằng trang chính thức của Google (chỉ blog bên thứ ba).
  agy: {
    status: null,
    login: 'agy',
    install: { win32: 'irm https://antigravity.google/cli/install.ps1 | iex', posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  },
  // `grok models`: "You are logged in with grok.com." exit 0 [KIỂM].
  grok: {
    status: ['models'],
    parse: textAuth(LOGGED_RE),
    login: 'grok login',
    install: { win32: 'irm https://x.ai/cli/install.ps1 | iex', posix: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  },
  // `devin auth status` chưa login: in "Not logged in." nhưng exit 0 [KIỂM] ⇒ phải xét chữ trước mã thoát. Đã login: exit 0 + có thông tin (dạng chữ chưa kiểm).
  // Lệnh cài Windows chỉ chạy trong PowerShell (hỏng ở Git Bash/CMD) [research-devin §0].
  devin: {
    status: ['auth', 'status'],
    parse: textAuth(/\S/),
    login: 'devin auth login',
    install: { win32: 'irm https://static.devin.ai/cli/setup.ps1 | iex', posix: 'curl -fsSL https://cli.devin.ai/install.sh | bash' },
  },
}
for (const spec of Object.values(CLIS)) spec.version = ['--version']

const MESSAGES = {
  ok: () => 'sẵn sàng',
  'not-installed': (n) => `${n} chưa cài`,
  'not-logged-in': (n) => `${n} chưa đăng nhập`,
  quota: (n) => `${n} hết hạn mức tạm thời (không cần đăng nhập lại)`,
  network: (n) => `${n} không kết nối được mạng`,
  permission: (n) => `${n} thiếu quyền`,
  timeout: (n) => `${n} không trả lời kịp`,
  error: (n) => `${n} báo lỗi chưa rõ`,
  unrecognized: (n) => `${n} trả lời lạ, không đọc được trạng thái đăng nhập`,
  'no-status-command': (n) => `${n} không có lệnh kiểm đăng nhập; cứ gọi thử, lỗi thì báo nguyên nhân`,
  'in-claude-session': (n) => `đang chạy trong phiên Claude nên không kiểm được đăng nhập của ${n}; cứ gọi thử`,
}

function assertName(name) {
  if (!Object.hasOwn(CLIS, name)) throw new RangeError(`CLI không có trong danh sách (${CLI_NAMES.join(', ')}): ${name}`)
}

// --- tìm file chạy ---------------------------------------------------------------------------------------------------------------------

function norm(o = {}) {
  const platform = o.platform ?? process.platform
  const win = platform === 'win32'
  return {
    platform,
    win,
    env: o.env ?? process.env,
    home: o.home ?? os.homedir(),
    exists: o.exists ?? defaultExists(win),
    P: win ? path.win32 : path.posix,
  }
}

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

// Windows: tên biến môi trường không phân biệt hoa/thường (Path = PATH).
function envGet(c, key) {
  if (c.env[key] !== undefined) return c.env[key]
  if (!c.win) return undefined
  const k = Object.keys(c.env).find((x) => x.toLowerCase() === key.toLowerCase())
  return k === undefined ? undefined : c.env[k]
}

// Đuôi chạy được trực tiếp (.exe/.com) hoặc qua cmd.exe (.cmd/.bat), theo thứ tự PATHEXT. File không đuôi (script sh của npm) KHÔNG chạy được trên Windows.
function winExts(c) {
  const raw = envGet(c, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').map((e) => e.trim().toLowerCase()).filter((e) => ['.exe', '.com', '.cmd', '.bat'].includes(e))
}

// Thư mục hay đặt CLI mà PATH của app mở từ GUI / ssh không đăng nhập có thể thiếu (Homebrew, npm global, trình cài của từng hãng).
function extraDirs(c) {
  const { P, home } = c
  const dirs = []
  const add = (...parts) => { if (parts.every(Boolean)) dirs.push(P.join(...parts)) }
  if (c.win) {
    add(envGet(c, 'APPDATA'), 'npm')
    add(envGet(c, 'LOCALAPPDATA'), 'cursor-agent')
    add(envGet(c, 'LOCALAPPDATA'), 'agy', 'bin')
    add(home, '.grok', 'bin')
    add(home, '.local', 'bin')
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin')
    add(home, '.local', 'bin')
    add(home, '.grok', 'bin')
    add(home, '.npm-global', 'bin')
    add(home, '.claude', 'local')
  }
  return dirs
}

function pathDirs(c) {
  const raw = envGet(c, 'PATH') ?? ''
  return raw.split(c.win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
}

const DEVIN_TAIL = ['resources', 'app', 'extensions', 'windsurf', 'devin', 'bin']

// devin.exe nằm trong thư mục cài của Devin Desktop, không có trên PATH hệ thống [research-devin §6–7].
function devinCandidates(c, dirs) {
  const { P } = c
  if (c.platform === 'darwin') {
    const rel = ['Devin.app', 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin']
    return ['/Applications', P.join(c.home, 'Applications')].map((root) => P.join(root, ...rel))
  }
  if (!c.win) return []
  const roots = []
  for (const d of dirs) if (P.basename(d).toLowerCase() === 'bin') roots.push(P.dirname(d)) // PATH của Devin có <cài>\bin (devin-desktop)
  const lad = envGet(c, 'LOCALAPPDATA')
  if (lad) roots.push(P.join(lad, 'Programs', 'Devin'))
  for (const k of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const v = envGet(c, k)
    if (v) roots.push(P.join(v, 'Devin'))
  }
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') roots.push(`${L}:\\Program Files\\Devin`) // user chọn cài ổ khác (máy này: D:\Program Files\Devin)
  return [...new Set(roots)].map((r) => P.join(r, ...DEVIN_TAIL, 'devin.exe'))
}

// Đường dẫn tuyệt đối của file chạy được, hoặc null. Thứ tự: PATH → thư mục quen → (devin) thư mục cài Desktop.
export function resolveBin(name, ctx) {
  assertName(name)
  const c = norm(ctx)
  const dirs = pathDirs(c)
  const files = c.win ? winExts(c).map((e) => name + e) : [name]
  for (const dir of [...dirs, ...extraDirs(c)]) {
    for (const f of files) {
      const p = c.P.join(dir, f)
      if (c.exists(p)) return p
    }
  }
  if (name === 'devin') for (const p of devinCandidates(c, dirs)) if (c.exists(p)) return p
  return null
}

// --- chạy lệnh -------------------------------------------------------------------------------------------------------------------------

const SAFE_ARG = /^[\w.:=/-]+$/

function killTree(child, win, env) {
  try {
    if (win) {
      const root = env.SystemRoot || env.windir
      const exe = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill'
      spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } else {
      process.kill(-child.pid, 'SIGKILL') // cả nhóm tiến trình (child chạy detached ⇒ làm trưởng nhóm)
    }
  } catch {
    try { child.kill('SIGKILL') } catch { /* tiến trình đã thoát */ }
  }
}

// Chạy `file args…` với giờ chờ cứng. Không bao giờ reject: {code, stdout, stderr, timedOut, error:{code,message}|null}.
// Windows .cmd/.bat: Node không cho spawn thẳng (EINVAL) ⇒ cmd.exe /d /s /c "<dòng lệnh dựng từ hằng>"; đối số lạ hoặc đường dẫn có % " ! bị từ chối.
export function runCommand(file, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const win = platform === 'win32'
    let out = ''
    let err = ''
    let timedOut = false
    let done = false
    let timer = null
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: null, stdout: out, stderr: err, timedOut, error: null, ...extra })
    }

    let cmd = file
    let argv = args
    const opts = { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !win }
    if (win && /\.(?:cmd|bat)$/i.test(file)) {
      if (!args.every((a) => SAFE_ARG.test(a)) || /["%!]/.test(file)) {
        return finish({ error: { code: 'EUNSAFE', message: 'đối số hoặc đường dẫn không an toàn để chạy qua cmd.exe' } })
      }
      cmd = env.ComSpec || env.COMSPEC || 'cmd.exe'
      argv = ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`] // cmd /s bỏ cặp nháy ngoài cùng, giữ nháy quanh đường dẫn có dấu cách
      opts.windowsVerbatimArguments = true
    }

    let child
    try {
      child = spawn(cmd, argv, opts)
    } catch (e) {
      return finish({ error: { code: e.code ?? 'ESPAWN', message: e.message } })
    }
    child.on('error', (e) => finish({ error: { code: e.code ?? 'ESPAWN', message: e.message } }))
    child.on('close', (code) => finish({ code }))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d })
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d })
    timer = setTimeout(() => {
      timedOut = true
      killTree(child, win, env)
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      finish({})
    }, timeoutMs)
  })
}

// --- phân loại lỗi ---------------------------------------------------------------------------------------------------------------------

// Hết hạn mức: Grok "usage limit" (exit 1, stderr) [KIỂM]; Codex usage_limit_reached / rate_limit_exceeded / "hit your usage limit" (chuỗi trong binary, exit code chưa kiểm);
// Claude/Cursor/agy: mẫu chung (chưa kiểm).
const QUOTA_RE = /usage[ _]limit|rate[ _]limit|quota (?:exceeded|exhausted|reached)|insufficient[ _]quota|out of (?:credits|usage)|hit your (?:usage )?limit|limit reached|too many requests/i
const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network (?:is )?(?:unreachable|error)|fetch failed|stream disconnected|socket hang up|could not resolve host|connection (?:refused|reset|timed out)|\boffline\b/i
const PERMISSION_RE = /EACCES|EPERM|permission denied|operation not permitted|forbidden|\b403\b/i

const clean = (s) => String(s ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\ufeff/g, '').replace(/\r/g, '')

function verdict(name, reason) {
  return { reason, message: MESSAGES[reason](name), loginCmd: reason === 'not-logged-in' ? CLIS[name].login : null }
}

// Dùng cho MỘT lần gọi đã lỗi hoặc không ra kết quả (exit 0 ⇒ ok, không xét chữ trong câu trả lời của model).
// Chỉ xét stderr + 2.000 ký tự cuối của stdout. Hết hạn mức thắng "đăng nhập" ⇒ không đòi login lại.
export function classifyFailure(name, res = {}) {
  assertName(name)
  if (res.error) return verdict(name, res.error.code === 'ENOENT' ? 'not-installed' : 'error')
  if (res.timedOut) return verdict(name, 'timeout')
  if (res.code === 0) return verdict(name, 'ok')
  const text = `${clean(res.stderr)}\n${clean(res.stdout).slice(-2000)}`
  if (QUOTA_RE.test(text)) return verdict(name, 'quota')
  if (NETWORK_RE.test(text)) return verdict(name, 'network')
  if (NOT_LOGGED_RE.test(text)) return verdict(name, 'not-logged-in')
  if (PERMISSION_RE.test(text)) return verdict(name, 'permission')
  return verdict(name, 'error')
}

// --- kiểm ------------------------------------------------------------------------------------------------------------------------------

const BY_DESIGN_UNKNOWN = new Set(['no-status-command', 'in-claude-session'])

function build(name, c, base) {
  const spec = CLIS[name]
  const installed = base.installed ?? true
  const auth = base.auth ?? 'unknown'
  const reason = base.reason
  const hint = typeof spec.install === 'string' ? spec.install : c.win ? spec.install.win32 : spec.install.posix
  return {
    name,
    installed,
    path: installed ? (base.path ?? null) : null,
    version: installed ? (base.version ?? null) : null,
    auth,
    reason,
    message: MESSAGES[reason](name),
    ready: installed && (auth === 'ok' || (auth === 'unknown' && BY_DESIGN_UNKNOWN.has(reason))),
    loginCmd: installed && auth === 'none' ? spec.login : null,
    installHint: installed ? null : hint,
  }
}

function parseVersion(...texts) {
  for (const t of texts) {
    const m = /(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/.exec(clean(t))
    if (m) return m[1]
  }
  return null
}

// Phiên Claude tiêm token qua host nên `claude auth status` báo sai (loggedIn:false) [KIỂM]. CLAUDECODE là dấu chính; gỡ riêng nó mà còn các biến CLAUDE_CODE_* khác
// của host thì vẫn báo sai [KIỂM] ⇒ nhận cả CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_SESSION_ID.
const inClaudeSession = (env) => Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID)

async function probe(name, c, opts) {
  const spec = CLIS[name]
  const bin = resolveBin(name, c)
  if (!bin) return build(name, c, { installed: false, reason: 'not-installed' })

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS)
  const runOpts = { timeoutMs, env: { ...c.env, NO_COLOR: '1', NO_OPEN_BROWSER: '1' }, platform: c.platform }
  const run = opts.run ?? runCommand
  const skip = spec.status === null ? 'no-status-command' : name === 'claude' && inClaudeSession(c.env) ? 'in-claude-session' : null

  const [ver, st] = await Promise.all([run(bin, spec.version, runOpts), skip ? null : run(bin, spec.status, runOpts)])
  const found = { path: bin }
  if (ver.error) {
    return ver.error.code === 'ENOENT'
      ? build(name, c, { installed: false, reason: 'not-installed' })
      : build(name, c, { ...found, reason: 'error' })
  }
  if (ver.timedOut) return build(name, c, { ...found, reason: 'timeout' })
  found.version = parseVersion(ver.stdout, ver.stderr)

  if (skip) return build(name, c, { ...found, auth: 'unknown', reason: skip })
  if (st.error || st.timedOut) return build(name, c, { ...found, auth: 'unknown', reason: classifyFailure(name, st).reason })

  const text = `${clean(st.stdout)}\n${clean(st.stderr)}`
  const auth = spec.parse({ code: st.code, text })
  if (auth === 'ok') return build(name, c, { ...found, auth: 'ok', reason: 'ok' })
  if (auth === 'none') return build(name, c, { ...found, auth: 'none', reason: 'not-logged-in' })
  const v = st.code === 0 ? { reason: 'unrecognized' } : classifyFailure(name, st)
  return v.reason === 'not-logged-in'
    ? build(name, c, { ...found, auth: 'none', reason: 'not-logged-in' })
    : build(name, c, { ...found, auth: 'unknown', reason: v.reason })
}

// --- cache -----------------------------------------------------------------------------------------------------------------------------

export function cachePath(home = os.homedir()) {
  return path.join(home, '.claude', 'cache', 'clis.json')
}

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') return j
  } catch { /* chưa có hoặc hỏng ⇒ coi như trống */ }
  return { entries: {} }
}

// Cache chỉ là tối ưu: không ghi được (ổ chỉ đọc, hết chỗ) thì bỏ qua, lần sau kiểm lại.
function writeCache(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* không dọn được thì thôi */ }
  }
}

function fromCache(name, c, file, now, ttlMs) {
  const e = readCache(file).entries[name]
  const r = e?.result
  if (!e || typeof e.at !== 'number' || now - e.at >= ttlMs || e.at > now + 60_000) return null
  if (!r || r.installed !== true || r.auth !== 'ok' || typeof r.path !== 'string' || !c.exists(r.path)) return null
  const version = typeof r.version === 'string' ? r.version : null
  return { ...build(name, c, { path: r.path, version, auth: 'ok', reason: 'ok' }), cached: true }
}

function toCache(name, result, file, now) {
  const j = readCache(file)
  j.entries[name] = { at: now, result: { name, installed: true, path: result.path, version: result.version, auth: 'ok', reason: 'ok' } }
  writeCache(file, j)
}

// --- API -------------------------------------------------------------------------------------------------------------------------------

// opts (tất cả tuỳ chọn; test tiêm giả): run(file,args,{timeoutMs,env,platform}) · exists(path) · platform · env · home · now (số ms hoặc hàm trả số) · timeoutMs (≤20.000) ·
// fresh (bỏ qua cache đọc) · cache:false (không đụng đĩa) · cacheFile · ttlMs
export async function check(name, opts = {}) {
  assertName(name)
  const c = norm(opts)
  const useCache = opts.cache !== false
  const file = opts.cacheFile ?? cachePath(c.home)
  const now = typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()) // số (ms) hoặc hàm trả số — như models/deps
  if (useCache && !opts.fresh) {
    const hit = fromCache(name, c, file, now, opts.ttlMs ?? CACHE_TTL_MS)
    if (hit) return hit
  }
  const result = await probe(name, c, opts)
  if (useCache && result.installed && result.auth === 'ok') toCache(name, result, file, now)
  return result
}

export async function checkAll(names = CLI_NAMES, opts = {}) {
  for (const n of names) assertName(n)
  const results = await Promise.all(names.map((n) => check(n, opts)))
  return Object.fromEntries(names.map((n, i) => [n, results[i]]))
}

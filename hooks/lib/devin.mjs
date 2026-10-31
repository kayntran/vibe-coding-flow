// devin: lõi công cụ máy ảo Devin (chạy thử app trên máy ảo của Devin thay vì máy user). Spec: docs/specs/2026-10-31-may-ao-devin (SPEC + PLAN).
// CLI: hooks/devin-vm.mjs gọi lõi này; hooks/mac-check.mjs cũng gọi. Lõi KHÔNG gọi ngược ai.
//
// Mọi phụ thuộc ngoài (mạng, tiến trình, giờ, đường dẫn trạng thái) nằm trong `ctx` do makeCtx() dựng — test tiêm giả, không gọi Devin thật:
//   ctx = { env, home, platform, fetch, spawn(cmd,args,{cwd,env,input,timeout}) → {code,stdout,stderr,timedOut,error}, sleep(ms), now(),
//           stateDir, logFile, devinBin (undefined = tự dò, null = chưa cài), startBackground, kill, cmdline, probePort, freePort, runLocal,
//           pid, pidAlive, setInterval, clearInterval, cliPath }
//
// Sự thật đã đo (31/10, PLAN "Sự thật đã đo"): REST v3 tạo/xem/xoá máy, ngủ qua MCP (REST /archive KHÔNG làm máy ngủ), `devin ssh` trả đúng mã thoát,
// stdin của `devin ssh` bị TREO ⇒ không bao giờ gửi gì qua stdin (script đi trong đối số, mã base64); chép file bằng tệp đính kèm Devin + curl link ký sẵn.
//
// An toàn: khoá Devin và link ký sẵn KHÔNG bao giờ ra stdout/stderr/log (login.key không liệt kê được; thông báo lỗi qua scrub(); giá trị --env bị che trong đầu ra).
// Lỗi Devin (chưa đăng nhập, 401/402/403/429/5xx, mạng, quá giờ) ⇒ DevinUnavailable ⇒ CLI exit 3 ⇒ người gọi quay về máy user (AC-11).
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { resolveBin } from './clis.mjs'

export const OSES = ['linux', 'windows', 'macos']
export const OS_LABEL = { linux: 'Ubuntu', windows: 'Windows', macos: 'macOS' }
export const LOGIN_CMD = 'devin auth login'
export const MARK = '@@DEVINVM@@'
const API = 'https://api.devin.ai/v3/organizations'
const MCP_URL = 'https://mcp.devin.ai/mcp'
const NODE_MAJOR = 24 // Node LTS cài lên máy linux/mac (nodejs.org/dist/latest-v24.x)
const MAX_UPLOAD = 500 * 1024 * 1024
const MAX_PULL = 500 * 1024 * 1024 // `get` đi qua cổng chuyển (không qua stdout) nên cùng trần với chép lên
// Lời nhắn tạo máy: SWE-2 miễn phí và KHÔNG giao việc gì (AC-06).
const CREATE_PROMPT = 'Do not run any tools or commands. Reply with the single word: ready'
// status_detail của máy `suspended` mà đánh thức không được vì hết hạn mức/thanh toán (khác inactivity/user_request).
const QUOTA_DETAILS = new Set(['usage_limit_exceeded', 'out_of_credits', 'out_of_quota', 'no_quota_allocation', 'payment_declined', 'org_usage_limit_exceeded', 'user_usage_limit_exceeded', 'total_session_limit_exceeded', 'contract_expired'])
const ID_RE = /^devin-[A-Za-z0-9]{6,64}$/
const ORG_RE = /^[\w-]{4,80}$/
const KEY_RE = /^[\x21\x23-\x5b\x5d-\x7e]{8,}$/ // ASCII in được, không khoảng trắng/nháy kép/gạch chéo ngược (khoá thật có cả `$` và `-`)
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 60_000

// ---------- lỗi ----------
export class UsageError extends Error {}
export class ToolError extends Error {}
// kind: not-logged-in · not-installed · quota · service · network · timeout. Người gọi quay về máy user.
export class DevinUnavailable extends Error {
  constructor(kind, message, loginCmd = null) {
    super(message)
    this.kind = kind
    this.loginCmd = loginCmd
  }
}

// ---------- chuỗi ----------
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`
export const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/g
// Đầu ra `devin ssh` lẫn mã ANSI/CR ⇒ lọc (đo 31/10).
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
// Dòng đầu có chữ, đã che link — dùng cho MỌI thông báo lấy từ đầu ra của máy ảo/Devin (curl lỗi có thể in lại link ký sẵn).
const firstLine = (s, max = 200) => scrub(stripAnsi(s).split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, max)
// Xoá link http(s) (link ký sẵn có chữ ký) và các giá trị bí mật khỏi một đoạn chữ sắp in/ghi.
export function scrub(text, secrets = []) {
  let t = String(text ?? '').replace(/https?:\/\/[^\s'"<>]+/g, '<link>')
  for (const s of secrets) if (s && String(s).length >= 4) t = t.split(String(s)).join('***')
  return t
}
// Che giá trị bí mật (dạng gốc và dạng base64) trong đầu ra của máy ảo. ConPTY (devin.exe → ssh) bẻ dòng dài và chèn mã ESC GIỮA chuỗi
// ⇒ so khớp chuỗi nguyên không bắt được. Nên cho phép "khe" (mã CSI, OSC, CR, LF) giữa MỌI cặp ký tự của khoá. Chạy trên đầu ra THÔ, trước stripAnsi.
const REDACT_GAP = '(?:\\u001b\\[[0-?]*[ -/]*[@-~]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\r|\\n)*'
const reEscape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Bỏ qua ĐÚNG những mã lỗi mong đợi (vd ESRCH: tiến trình đã thoát; ENOENT: file chưa có). Lỗi khác KHÔNG được nuốt: ghi một dòng ra stderr
// (việc đang làm + mã/lời; đã che link). Dùng ở chỗ không thể ném tiếp được (dọn dẹp, hàm gọi từ hẹn giờ, ghi log).
function ignoreOnly(what, e, ...codes) {
  if (codes.includes(e?.code)) return
  process.stderr.write(`devin-vm: ${what}: ${firstLine(String(e?.code ?? e?.message ?? e))}\n`)
}
function redact(text, secrets) {
  let t = String(text ?? '')
  for (const s of secrets ?? []) {
    if (!s || String(s).length < 4) continue
    for (const form of [String(s), b64(s)]) {
      if (form.length > 4000) t = t.split(form).join('***') // quá dài để dựng regex từng ký tự: chỉ che được dạng nguyên
      else t = t.replace(new RegExp(Array.from(form, reEscape).join(REDACT_GAP), 'g'), '***')
    }
  }
  return t
}

// ---------- chạy tiến trình ----------
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.windir
      const exe = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill'
      spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } else process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch (e) { ignoreOnly('diệt tiến trình con', e, 'ESRCH') } // ESRCH: đã thoát
  }
}

// Chạy `cmd args…` (không qua shell). Không bao giờ reject: { code, signal, stdout, stderr, timedOut, error:{code,message}|null }.
// Không có `input` ⇒ stdin đóng (không treo). Quá `timeout` ms ⇒ diệt cả cây tiến trình.
export function runProc(cmd, args = [], o = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const cap = o.maxOutput ?? 256 * 1024 * 1024
    let out = ''
    let err = ''
    let timedOut = false
    let done = false
    let timer = null
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout: out, stderr: err, timedOut, error: null, ...extra })
    }
    let child
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: [o.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: !win })
    } catch (e) {
      return finish({ error: { code: e.code ?? 'ESPAWN', message: e.message } })
    }
    child.on('error', (e) => finish({ error: { code: e.code ?? 'ESPAWN', message: e.message } }))
    child.on('close', (code, signal) => finish({ code, signal }))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { if (out.length < cap) out += d })
    child.stderr.on('data', (d) => { if (err.length < cap) err += d })
    if (o.input != null) {
      child.stdin.on('error', () => {})
      child.stdin.end(o.input)
    }
    if (o.timeout) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish({})
      }, o.timeout)
    }
  })
}

// Việc nền cho `devin forward`: tách khỏi tiến trình này, chạy tới khi bị diệt. exited() cho biết đã thoát chưa.
function startBackground(cmd, args, o = {}) {
  const child = spawn(cmd, args, { env: o.env ?? process.env, stdio: 'ignore', windowsHide: true, detached: true })
  let exited = false
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  child.unref()
  return { pid: child.pid ?? 0, exited: () => exited }
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.windir
      const exe = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill'
      spawn(exe, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch { process.kill(pid, 'SIGTERM') }
    }
    return true
  } catch {
    return false
  }
}

// Dòng lệnh của một pid (để chắc pid trong sổ vẫn là `devin forward`, không phải tiến trình khác mượn lại số). Không đọc được ⇒ null.
async function cmdlineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const win = process.platform === 'win32'
  const r = win
    ? await runProc('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 15_000 })
    : await runProc('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 })
  const t = String(r.stdout ?? '').trim()
  return r.code === 0 && t ? t : null
}

// Một cổng máy bạn đang trống (bind thử cổng 0 rồi nhả).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const end = (v) => { s.destroy(); resolve(v) }
    s.setTimeout(1500, () => end(false))
    s.once('connect', () => end(true))
    s.once('error', () => end(false))
  })
}

// Lệnh phía máy user của `job`. onChild nhận { kill } để job chuyển tín hiệu. Trả mã thoát.
function runLocal(command, { env, cwd, onChild } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', env: env ?? process.env, cwd, windowsHide: true })
    onChild?.({ kill: () => { killTree(child) } })
    child.on('error', () => resolve(127))
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}

const here = path.dirname(fileURLToPath(import.meta.url))

export function makeCtx(over = {}) {
  const env = over.env ?? process.env
  const home = over.home ?? os.homedir()
  const ctx = {
    env,
    home,
    platform: over.platform ?? process.platform,
    fetch: (...a) => globalThis.fetch(...a),
    spawn: runProc,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    stateDir: env.FLOW_STATE_DIR ? path.resolve(env.FLOW_STATE_DIR) : path.join(home, '.claude', 'state'),
    logFile: path.join(here, '..', 'devin-vm.log'),
    devinBin: undefined,
    startBackground,
    kill: killPid,
    cmdline: cmdlineOf,
    probePort,
    freePort,
    runLocal,
    proc: process,
    pid: process.pid,
    pidAlive: (pid) => pidAlive(pid),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
    cliPath: path.join(here, '..', 'devin-vm.mjs'), // tiến trình nền `keepalive` của forward chạy lại chính CLI này
    warn: (s) => process.stderr.write(`devin-vm: ${s}\n`), // một dòng cảnh báo không chặn việc (vd không đọc được hạn mức)
  }
  return Object.assign(ctx, over)
}

// ---------- đăng nhập Devin ----------
export const parseCredentials = (text) => /^\s*windsurf_api_key\s*=\s*["']([^"'\r\n]+)["']/m.exec(String(text ?? ''))?.[1] ?? null
export const parseApiServer = (text) => /^\s*api_server_url\s*=\s*["']([^"'\r\n]+)["']/m.exec(String(text ?? ''))?.[1] ?? null
export function parseOrgId(text) {
  const t = String(text ?? '')
  try {
    const j = JSON.parse(t)
    const v = j?.org_id ?? j?.devin?.org_id
    if (typeof v === 'string' && v) return v
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e // không phải JSON (SyntaxError) thì thử tìm chữ; lỗi khác là lỗi thật
  }
  return /"?org_id"?\s*[:=]\s*"([^"]+)"/.exec(t)?.[1] ?? null
}

export function resolveDevin(ctx) {
  if (ctx.devinBin !== undefined) return ctx.devinBin
  return resolveBin('devin', { env: ctx.env, platform: ctx.platform, home: ctx.home })
}

async function credentialsFile(ctx) {
  if (ctx.env.DEVIN_CREDENTIALS) return ctx.env.DEVIN_CREDENTIALS
  if (ctx.platform === 'win32') return ctx.env.APPDATA ? path.join(ctx.env.APPDATA, 'devin', 'credentials.toml') : null
  for (const d of [path.join(ctx.home, '.config', 'devin'), path.join(ctx.home, 'Library', 'Application Support', 'devin'), path.join(ctx.home, '.devin')]) {
    if (fs.existsSync(path.join(d, 'credentials.toml'))) return path.join(d, 'credentials.toml')
  }
  const bin = resolveDevin(ctx)
  if (!bin) return null
  const r = await ctx.spawn(bin, ['auth', 'status'], { timeout: 15_000, env: ctx.env })
  return /Credentials path:\s*(.+)/i.exec(stripAnsi(`${r.stdout}\n${r.stderr}`))?.[1]?.trim() ?? null
}

// Đọc khoá + org của Devin CLI. login.key KHÔNG liệt kê được (JSON.stringify / console.log không thấy).
export async function loadLogin(ctx) {
  if (ctx.loginMemo) return ctx.loginMemo
  const bad = () => new DevinUnavailable('not-logged-in', 'Devin chưa đăng nhập (hoặc file đăng nhập hỏng)', LOGIN_CMD)
  const file = await credentialsFile(ctx)
  if (!file) throw bad()
  let key
  let org
  let server
  try {
    const cred = fs.readFileSync(file, 'utf8')
    key = parseCredentials(cred)
    server = parseApiServer(cred)
    org = parseOrgId(fs.readFileSync(path.join(path.dirname(file), 'config.json'), 'utf8'))
  } catch {
    throw bad()
  }
  if (!key || !org || !KEY_RE.test(key) || !ORG_RE.test(org)) throw bad()
  const login = { org }
  Object.defineProperty(login, 'key', { value: key })
  Object.defineProperty(login, 'server', { value: server }) // địa chỉ máy chủ Devin CLI (không bí mật nhưng cũng không liệt kê: JSON login vẫn chỉ có org)
  ctx.loginMemo = login
  return login
}

// ---------- gọi Devin (REST / MCP) ----------
const sessionUrl = (login, id, tail = '') => `${API}/${login.org}/sessions/${id}${tail}`
const fullId = (s) => (/^devin-/.test(String(s)) ? String(s) : `devin-${s}`)

// Một lời gọi HTTP. Lỗi mạng/quá giờ/401/402/403/429/5xx ⇒ DevinUnavailable. 404 ⇒ trả { status: 404 }. Lỗi 4xx khác ⇒ ToolError.
async function http(ctx, login, method, url, { body, headers = {}, timeout = 30_000, manual = false } = {}) {
  let res
  try {
    res = await ctx.fetch(url, { method, headers: { Authorization: `Bearer ${login.key}`, ...headers }, body, redirect: manual ? 'manual' : 'follow', signal: AbortSignal.timeout(timeout) })
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new DevinUnavailable(slow ? 'timeout' : 'network', slow ? 'Devin không trả lời kịp' : 'Không nối được tới Devin (mạng)')
  }
  const s = res.status
  if (s === 404) return { status: 404, res }
  if (manual && s >= 300 && s < 400) return { status: s, res }
  if (s === 403) {
    // Hết hạn mức cũng trả 403 (đo 31/10: error_code billing_restricted, detail "…billing error. Error: out_of_quota") ⇒ không bảo đăng nhập lại
    const text = await res.text().catch((e) => { ignoreOnly('đọc thân lỗi 403', e); return '' })
    if (/billing_restricted|out_of_quota/.test(text)) throw new DevinUnavailable('quota', 'Devin báo tài khoản hết hạn mức (out_of_quota) — máy ảo chưa bật được tới khi hạn mức hồi lại')
  }
  if (s === 401 || s === 403) throw new DevinUnavailable('not-logged-in', 'Devin từ chối đăng nhập (chưa đăng nhập hoặc đã hết hạn)', LOGIN_CMD)
  if (s === 402) throw new DevinUnavailable('quota', 'Devin báo hết hạn mức (402)')
  if (s === 429) throw new DevinUnavailable('quota', 'Devin báo quá tải hoặc hết hạn mức (429)')
  if (s >= 500) throw new DevinUnavailable('service', `Devin đang lỗi (${s})`)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new ToolError(`Devin báo lỗi ${s}: ${firstLine(t, 160)}`)
  }
  return { status: s, res }
}
// Đọc thân phản hồi; đứt giữa chừng / quá giờ khi đang đọc cũng là "Devin không dùng được", không phải lỗi lạ.
async function textOf(res) {
  try {
    return await res.text()
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new DevinUnavailable(slow ? 'timeout' : 'network', slow ? 'Devin không trả lời kịp' : 'Mất kết nối với Devin giữa chừng')
  }
}
async function jsonOf(res) {
  const t = await textOf(res)
  try { return t ? JSON.parse(t) : {} } catch { throw new ToolError('Devin trả dữ liệu không đọc được') }
}

// ---------- phanh hạn mức (sổ chốt h18z) ----------
// Máy thức trừ hạn mức NGÀY của Devin (đo 31/10: một ngày dựng/thử ≈ 100% ngày, 53% tuần). Dưới ngưỡng (mặc định 20%, đổi bằng DEVIN_VM_MIN_DAILY) thì không bật máy:
// `where` trả máy user, `up` ném DevinUnavailable('quota') TRƯỚC khi tạo/đánh thức (không cờ touched ⇒ job chạy máy user, mã thoát theo lệnh).
// Số lấy đúng cách Devin CLI lấy cho /usage: Connect-RPC GetUserStatus của api_server_url (thiếu ⇒ server.codeium.com). Khoá nằm trong THÂN yêu cầu.
// Chỉ gửi khi https + host thuộc codeium.com / windsurf.com / devin.ai (khoá chỉ tới Devin); lỗi mạng / 401 / sai dạng / quá 5 giây ⇒ "chưa biết" ⇒ KHÔNG chặn.
const QUOTA_HOST_RE = /(^|\.)(codeium\.com|windsurf\.com|devin\.ai)$/i
const QUOTA_DEFAULT_SERVER = 'https://server.codeium.com'
const QUOTA_RPC = '/exa.seat_management_pb.SeatManagementService/GetUserStatus'
const QUOTA_TIMEOUT_MS = 5000
const QUOTA_MIN_DAILY = 20
const QUOTA_FIELDS = ['dailyQuotaRemainingPercent', 'weeklyQuotaRemainingPercent', 'dailyQuotaResetAtUnix', 'weeklyQuotaResetAtUnix']
const noQuota = () => ({ known: false, daily: null, weekly: null, resetAt: null })

function minDaily(ctx) {
  const raw = String(ctx.env.DEVIN_VM_MIN_DAILY ?? '').trim()
  const v = Number(raw)
  return raw !== '' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : QUOTA_MIN_DAILY
}
// proto3 bỏ trường bằng 0 ⇒ planStatus có mà thiếu trường = 0. Dạng chữ ("15") nhận được; ngoài 0–100 bị kẹp; không phải số ⇒ null (sai dạng).
const pct = (v) => {
  if (v === undefined || v === null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null
}

// { known, daily, weekly, resetAt } — known:false (các số null) khi chưa biết. Không bao giờ ném vì lỗi mạng/dạng; chưa đăng nhập thì êm, còn lại để lại ĐÚNG MỘT dòng ctx.warn.
export async function quotaStatus(ctx, login = null) {
  const unknown = (why) => {
    ctx.warn(`không đọc được hạn mức ngày của Devin (${why}) — coi như chưa biết, không chặn`)
    return noQuota()
  }
  let lg = login
  if (!lg) {
    try {
      lg = await loadLogin(ctx)
    } catch (e) {
      if (e instanceof DevinUnavailable) return noQuota()
      throw e
    }
  }
  let url
  try {
    const base = new URL(lg.server ?? QUOTA_DEFAULT_SERVER)
    if (base.protocol !== 'https:' || base.username || base.password || !QUOTA_HOST_RE.test(base.hostname)) return unknown('máy chủ hạn mức không phải của Devin nên không gửi khoá')
    url = `${base.origin}${QUOTA_RPC}`
  } catch (e) {
    if (!(e instanceof TypeError)) throw e // new URL() báo địa chỉ hỏng bằng TypeError
    return unknown('địa chỉ máy chủ hạn mức hỏng')
  }
  let res
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify({ metadata: { apiKey: lg.key, ideName: 'devin-cli', ideVersion: '3000.11.238', extensionVersion: '3000.11.238' } }),
      redirect: 'manual', // POST kèm khoá không được theo chuyển hướng sang nơi khác
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    })
  } catch (e) {
    return unknown(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'quá 5 giây' : 'lỗi mạng')
  }
  if (res.status !== 200) return unknown(`mã ${res.status}`)
  let j
  try {
    j = JSON.parse(await res.text())
  } catch (e) {
    return unknown(e instanceof SyntaxError ? 'phản hồi sai dạng' : 'đứt kết nối khi đọc phản hồi')
  }
  const ps = j?.userStatus?.planStatus
  if (!ps || typeof ps !== 'object' || Array.isArray(ps) || !QUOTA_FIELDS.some((k) => k in ps)) return unknown('phản hồi sai dạng')
  const daily = pct(ps.dailyQuotaRemainingPercent)
  const weekly = pct(ps.weeklyQuotaRemainingPercent)
  if (daily === null || weekly === null) return unknown('phản hồi sai dạng')
  const when = new Date(Number(ps.dailyQuotaResetAtUnix) * 1000)
  return { known: true, daily, weekly, resetAt: Number.isNaN(when.getTime()) || Number(ps.dailyQuotaResetAtUnix) <= 0 ? null : when.toISOString() }
}
// Lý do chặn (một câu, giờ hồi theo giờ Việt Nam UTC+7) hoặc null khi đủ / chưa biết.
export function quotaBlock(ctx, q) {
  if (!q?.known) return null
  const min = minDaily(ctx)
  if (q.daily >= min) return null
  const vn = q.resetAt ? new Date(Date.parse(q.resetAt) + 7 * 3600_000).toISOString().slice(11, 16) : null
  return `Devin còn ${q.daily}% hạn mức hôm nay (dưới ${min}%)${vn ? `, hồi lúc ${vn}` : ''} — chạy trên máy bạn`
}

// Dựng body tạo máy (AC-06): luôn SWE-2, không giao việc; nối kho GitHub chỉ khi origin là github.com/kayntran/*.
export function createBody({ os: osName, name, slug }) {
  return {
    prompt: CREATE_PROMPT,
    platform: osName,
    devin_mode: 'swe-2-medium',
    title: `devin-vm ${name} ${osName}`,
    ...(slug ? { repos: [`${slug.owner}/${slug.repo}`] } : {}),
  }
}

async function createSession(ctx, login, body) {
  const { res } = await http(ctx, login, 'POST', `${API}/${login.org}/sessions`, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  const j = await jsonOf(res)
  const id = fullId(j.session_id)
  if (!ID_RE.test(id)) throw new ToolError('Devin không trả mã máy ảo hợp lệ')
  return id
}

// { status, detail } hoặc null nếu máy không còn (404).
export async function getSession(ctx, login, id) {
  const { status, res } = await http(ctx, login, 'GET', sessionUrl(login, id))
  if (status === 404) return null
  const j = await jsonOf(res)
  return { status: String(j.status ?? 'unknown'), detail: j.status_detail ?? null }
}

async function deleteSession(ctx, login, id) {
  const { res } = await http(ctx, login, 'DELETE', sessionUrl(login, id))
  await res.arrayBuffer().catch((e) => ignoreOnly('đọc hết phản hồi DELETE', e)) // đọc cho hết để nhả kết nối; trạng thái đã kiểm ở http(), hỏng ở đây chỉ để lại một dòng
}

// Gọi một tool MCP của Devin (Streamable HTTP). Dùng cho `sleep` vì REST /archive không làm máy ngủ.
async function mcpCall(ctx, login, tool, args) {
  let sid = null
  let n = 0
  const rpc = async (method, params) => {
    const note = method.startsWith('notifications/')
    const payload = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(note ? {} : { id: ++n }) }
    const { res } = await http(ctx, login, 'POST', MCP_URL, {
      body: JSON.stringify(payload),
      headers: { 'X-Org-Id': login.org, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    })
    sid = res.headers?.get?.('mcp-session-id') ?? sid
    if (note) return null
    const t = await textOf(res)
    const line = t.split('\n').find((l) => l.startsWith('data:'))
    try { return JSON.parse(line ? line.slice(5) : t) } catch { throw new ToolError('Devin MCP trả dữ liệu không đọc được') }
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'devin-vm', version: '1' } })
  await rpc('notifications/initialized')
  const r = await rpc('tools/call', { name: tool, arguments: args })
  if (r?.error || r?.result?.isError) throw new ToolError(`Devin MCP báo lỗi: ${scrub(firstLine(JSON.stringify(r.error ?? r.result), 160))}`)
  return r?.result
}

// Chép file lên máy ảo: tệp đính kèm Devin ⇒ link tải ký sẵn có hạn (307). Trả { name, url } — url KHÔNG liệt kê được.
export async function uploadFile(ctx, file, name) {
  const login = await loadLogin(ctx)
  let size
  try { size = fs.statSync(file).size } catch { throw new ToolError(`Không đọc được file cần chép: ${path.basename(file)}`) }
  if (size > MAX_UPLOAD) throw new ToolError(`File quá lớn để chép (${Math.round(size / 1048576)} MB, tối đa ${MAX_UPLOAD / 1048576} MB)`)
  const blob = typeof fs.openAsBlob === 'function' ? await fs.openAsBlob(file) : new Blob([fs.readFileSync(file)])
  const form = new FormData()
  form.append('file', blob, name)
  const { res } = await http(ctx, login, 'POST', `${API}/${login.org}/attachments`, { body: form, timeout: 10 * 60_000 })
  const j = await jsonOf(res)
  if (!/^[\w-]{6,80}$/.test(String(j.attachment_id ?? '')) || !j.name) throw new ToolError('Devin không trả tệp đính kèm hợp lệ')
  const got = await http(ctx, login, 'GET', `${API}/${login.org}/attachments/${j.attachment_id}/${encodeURIComponent(j.name)}`, { manual: true })
  const url = got.res.headers?.get?.('location')
  if (got.status === 404 || !url || !/^https:\/\//.test(url)) throw new ToolError('Devin không cho link tải của tệp đính kèm')
  const out = { name: String(j.name) }
  Object.defineProperty(out, 'url', { value: url })
  return out
}

// ---------- sổ máy ảo ----------
export const registryFile = (ctx) => path.join(ctx.stateDir, 'devin-vm.json')
// Chuẩn hoá khoá: tuyệt đối, dấu `/`; Windows không phân biệt hoa thường ⇒ hạ chữ thường (như wt-env).
export function projectKey(ctx, root, osName) {
  const s = path.resolve(root).replace(/\\/g, '/')
  return `${ctx.platform === 'win32' ? s.toLowerCase() : s}|${osName}`
}

export function readRegistry(ctx) {
  const file = registryFile(ctx)
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  try {
    const j = JSON.parse(text)
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e // sổ hỏng (SyntaxError): bỏ sang bên, coi như chưa có (mất sổ ⇒ tạo máy mới)
  }
  try { fs.renameSync(file, `${file}.bad-${ctx.now()}`) } catch (e) { ignoreOnly('để sổ hỏng sang bên', e, 'ENOENT') } // ENOENT: phiên khác vừa dời
  return {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
const readOwner = (lock) => { try { const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); return o && typeof o === 'object' ? o : null } catch { return null } }

// Khoá bằng mkdir (như wt-env): chỉ phá khi cũ > 60 s VÀ chủ đã chết. Trả kết quả của fn.
async function withLock(ctx, fn, timeoutMs = 60_000) {
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  const lock = path.join(ctx.stateDir, 'devin-vm.lock')
  const token = randomBytes(16).toString('hex')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      const busy = e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code))
      if (!busy) throw e
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS && !pidAlive(readOwner(lock)?.pid)) {
          const grave = `${lock}.stale-${process.pid}-${Date.now()}`
          fs.renameSync(lock, grave)
          fs.rmSync(grave, { recursive: true, force: true })
        }
      } catch (e2) {
        // người khác vừa nhả / phá khoá (thư mục khoá biến mất, hoặc Windows còn giữ handle): thử lại; lỗi khác là lỗi thật
        if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'].includes(e2?.code)) throw e2
      }
      if (Date.now() >= deadline) throw new ToolError('Không lấy được khoá sổ máy ảo (phiên khác đang bật máy cho dự án này?)')
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, token }))
    return await fn()
  } finally {
    if (readOwner(lock)?.token === token) fs.rmSync(lock, { recursive: true, force: true })
  }
}

// Đọc–sửa–ghi sổ dưới khoá, ghi nguyên tử (file tạm + rename). fn(reg) sửa reg tại chỗ (có thể async).
export async function updateRegistry(ctx, fn) {
  return withLock(ctx, async () => {
    const reg = readRegistry(ctx)
    const result = await fn(reg)
    const file = registryFile(ctx)
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`)
    fs.renameSync(tmp, file)
    return result
  })
}

// ---------- dự án: gốc git, kiểu app, cấu hình ----------
const git = (ctx, cwd, args, o = {}) => ctx.spawn('git', args, { cwd, timeout: 120_000, env: ctx.env, ...o })
const outOf = (r) => String(r?.stdout ?? '').trim()
const sanitizeName = (s) => {
  const v = String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[-.]+/, '')
  return v && !/^\.+$/.test(v) ? v.slice(0, 100) : 'project'
}
export function parseSlug(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

// { top (thư mục làm việc hiện tại của kho/worktree), root (gốc kho CHÍNH — chung cho mọi worktree), name, slug, kayntran } hoặc null nếu không phải kho git.
// Địa chỉ origin có thể chứa token ⇒ chỉ phân tích ra owner/repo, không lưu, không in.
export async function projectInfo(ctx, dir) {
  const cwd = path.resolve(dir ?? process.cwd())
  const t = await git(ctx, cwd, ['rev-parse', '--show-toplevel'])
  if (t.code !== 0 || !outOf(t)) return null
  const top = path.resolve(outOf(t))
  const c = await git(ctx, top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = c.code === 0 ? outOf(c) : ''
  const root = common && path.basename(common) === '.git' ? path.dirname(path.resolve(common)) : top
  const o = await git(ctx, top, ['config', '--get', 'remote.origin.url'])
  const slug = o.code === 0 ? parseSlug(outOf(o)) : null
  const kayntran = slug?.owner?.toLowerCase() === 'kayntran'
  return { top, root, name: sanitizeName(slug?.repo ?? path.basename(root)), slug: kayntran ? { owner: 'kayntran', repo: slug.repo } : null, kayntran }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', '.claude', 'vendor', 'Pods', 'DerivedData'])
const WIN_DEPS = ['electron', 'electron-vite', 'electron-builder', '@electron-forge/cli', '@tauri-apps/cli', 'nw']
const WIN_FILES = ['wails.json', 'tauri.conf.json', 'electron-builder.yml', 'electron-builder.json', 'electron.vite.config.ts', 'electron.vite.config.js', 'electron.vite.config.mjs']
const WIN_EXT = /\.(?:csproj|fsproj|vbproj|sln|slnx)$/i

// Dò loại app theo file trong dự án (sâu ≤ 2 cấp): electron/wails/tauri/.NET ⇒ windows; xcodeproj/Package.swift ⇒ macos; còn lại (webapp, tiện ích, CLI) ⇒ linux.
// Hai dấu hiệu lẫn nhau ⇒ windows thắng (máy chính của user là Windows); chỉ định tay bằng `os` trong .claude/devin.json.
export function detectOs(dir) {
  let win = null
  let mac = null
  const walk = (d, depth) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p).replace(/\\/g, '/')
      if (e.isDirectory()) {
        if (/\.(?:xcodeproj|xcworkspace)$/i.test(e.name)) mac ??= `có ${rel}`
        else if (depth < 2 && !SKIP_DIRS.has(e.name)) walk(p, depth + 1)
        continue
      }
      if (e.name === 'Package.swift') mac ??= `có ${rel}`
      else if (WIN_FILES.includes(e.name) || WIN_EXT.test(e.name)) win ??= `có ${rel}`
      else if (e.name === 'package.json') {
        try {
          if (fs.statSync(p).size > 1_000_000) continue
          const j = JSON.parse(fs.readFileSync(p, 'utf8'))
          const dep = WIN_DEPS.find((n) => j?.dependencies?.[n] || j?.devDependencies?.[n])
          if (dep) win ??= `${rel} dùng ${dep}`
        } catch (e) {
          // package.json hỏng (SyntaxError) hoặc không đọc được thì bỏ qua file đó, không để nó làm sập việc dò kiểu app; lỗi lạ thì để lại một dòng
          if (!(e instanceof SyntaxError)) ignoreOnly(`đọc ${rel}`, e, 'ENOENT', 'EACCES', 'EPERM', 'EISDIR')
        }
      }
    }
  }
  walk(dir, 0)
  if (win) return { os: 'windows', why: `app desktop (${win})` }
  if (mac) return { os: 'macos', why: `app Mac (${mac})` }
  return { os: 'linux', why: 'webapp/tiện ích/CLI (mặc định)' }
}

// .claude/devin.json: { os?, local?:[nhãn cần máy thật], setup?:"lệnh", env?:[TÊN_KHOÁ], node?:"<major>", audio?:bool, off?:bool }. Tìm ở worktree trước, rồi gốc kho chính.
// node: `up` cài ĐÚNG major này nếu máy thiếu/khác (không ghi ⇒ linux/mac cài LTS khi chưa có node, Windows dùng Node có sẵn của máy).
// Trường sai kiểu bị bỏ và ghi vào problems (không ném lỗi: file của dự án không được làm sập công cụ).
export function readProjectConfig(dirs) {
  for (const d of dirs) {
    let text
    try { text = fs.readFileSync(path.join(d, '.claude', 'devin.json'), 'utf8') } catch { continue }
    const problems = []
    let j
    try { j = JSON.parse(text) } catch { return { config: {}, problems: ['devin.json không phải JSON hợp lệ'], file: d } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { config: {}, problems: ['devin.json phải là object'], file: d }
    const config = {}
    if (j.os !== undefined) OSES.includes(j.os) ? (config.os = j.os) : problems.push(`os phải là ${OSES.join('|')}`)
    if (j.local !== undefined) Array.isArray(j.local) && j.local.every((x) => typeof x === 'string') ? (config.local = j.local.map((x) => x.trim().toLowerCase()).filter(Boolean)) : problems.push('local phải là mảng chuỗi')
    if (j.setup !== undefined) typeof j.setup === 'string' && j.setup.trim() ? (config.setup = j.setup) : problems.push('setup phải là chuỗi lệnh')
    if (j.env !== undefined) Array.isArray(j.env) && j.env.every((x) => typeof x === 'string' && ENV_NAME_RE.test(x)) ? (config.env = j.env) : problems.push('env phải là mảng tên biến')
    if (j.node !== undefined) /^[1-9]\d?$/.test(String(j.node)) && ['string', 'number'].includes(typeof j.node) ? (config.node = String(j.node)) : problems.push('node phải là số major, ví dụ "25"')
    if (j.audio !== undefined) typeof j.audio === 'boolean' ? (config.audio = j.audio) : problems.push('audio phải là true/false')
    if (j.off !== undefined) typeof j.off === 'boolean' ? (config.off = j.off) : problems.push('off phải là true/false')
    return { config, problems, file: d }
  }
  return { config: {}, problems: [], file: null }
}

const parseNeeds = (need) => [...new Set((Array.isArray(need) ? need : String(need ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean))]

// os cho lệnh này: cờ --os > biến DEVIN_VM_OS (job đặt) > devin.json > dò loại app.
function pickOs(ctx, forced, config, top) {
  for (const v of [forced, ctx.env.DEVIN_VM_OS]) if (OSES.includes(v)) return { os: v, why: v === forced ? 'chỉ định bằng --os' : 'theo DEVIN_VM_OS' }
  if (config.os) return { os: config.os, why: 'dự án chỉ định (devin.json)' }
  return detectOs(top)
}

// Chọn nơi chạy (AC-01..04, 11, 16): { runner:'devin'|'local', os, reason, login? }. Thứ tự: tắt ⇒ cần máy thật ⇒ Devin sẵn sàng chưa ⇒ máy ảo.
export async function where(ctx, { dir, need = [], os: forced } = {}) {
  const info = await projectInfo(ctx, dir)
  const { config } = readProjectConfig(info ? [info.top, info.root] : [path.resolve(dir ?? process.cwd())])
  const det = pickOs(ctx, forced, config, info?.top ?? path.resolve(dir ?? process.cwd()))
  const local = (reason, extra = {}) => ({ runner: 'local', os: det.os, reason, ...extra })
  if (ctx.env.DEVIN_VM === 'off') return local('máy ảo Devin đang tắt (DEVIN_VM=off)')
  if (config.off) return local('dự án tắt máy ảo Devin (.claude/devin.json off)')
  const hit = parseNeeds(need).filter((n) => (config.local ?? []).includes(n))
  if (hit.length) return local(`cần máy thật: ${hit.join(', ')}`)
  if (!info) return local('thư mục không nằm trong kho git (máy ảo cần kho git)')
  if (!resolveDevin(ctx)) return local('Devin CLI chưa cài (xem: node hooks/cli-check.mjs devin)')
  try {
    await loadLogin(ctx)
  } catch (e) {
    if (e instanceof DevinUnavailable) return local(e.message, e.loginCmd ? { login: e.loginCmd } : {})
    throw e
  }
  const block = quotaBlock(ctx, await quotaStatus(ctx)) // phanh hạn mức ngày: dưới ngưỡng ⇒ máy user
  if (block) return local(block)
  return { runner: 'devin', os: det.os, reason: `${OS_LABEL[det.os]} — ${det.why}` }
}

// Lấy đích cho một lệnh: thông tin dự án + cấu hình + os + khoá sổ.
async function target(ctx, { dir, os: forced } = {}) {
  const info = await projectInfo(ctx, dir)
  if (!info) throw new ToolError('Thư mục này không nằm trong kho git')
  const { config } = readProjectConfig([info.top, info.root])
  const det = pickOs(ctx, forced, config, info.top)
  return { info, config, os: det.os, key: projectKey(ctx, info.root, det.os) }
}
function requireEntry(ctx, t) {
  const entry = readRegistry(ctx)[t.key]
  if (!entry?.id || !ID_RE.test(entry.id)) throw new ToolError(`Chưa có máy ảo ${OS_LABEL[t.os]} cho dự án này — chạy trước: node hooks/devin-vm.mjs up --os ${t.os}`)
  return entry
}

// ---------- chạy lệnh trên máy ảo ----------
// Mọi đối số tới `devin ssh` chỉ có ký tự an toàn: script đi dạng base64 qua một dòng lệnh, chạy từ file tạm (stdin của ssh bị treo; file tạm cũng
// giữ stdin của lệnh người dùng trống). Dòng này chạy được trên bash của Linux, macOS và Git Bash của Windows.
export function wrapRemote(script) {
  return `f=$(mktemp); printf %s '${b64(script)}' | base64 --decode > $f; bash $f </dev/null; rc=$?; rm -f $f; exit $rc`
}
// PATH đầu mỗi script chạy trên máy ảo. linux/mac: ~/.local/bin (Node do `up` cài) trước. Windows: chỉ thêm Node do `up` cài khi devin.json có `node`
// (không ghi ⇒ dùng Node có sẵn của máy).
export const pathPrefix = (osName, nodeMajor) => {
  if (osName !== 'windows') return 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n'
  return nodeMajor ? `export PATH="/c/devinvm/node-v${nodeMajor}:$PATH"\n` : ''
}
const repoDir = (name) => `"$HOME/repos/${name}"`

function devinBinary(ctx) {
  const bin = resolveDevin(ctx)
  if (!bin) throw new DevinUnavailable('not-installed', 'Devin CLI chưa cài')
  return bin
}

// `devin ssh <id> <lệnh>` có lọc ANSI, che giá trị bí mật. Lần đầu đôi khi "Could not verify the code" ⇒ thử lại (đo 31/10).
export async function sshRun(ctx, id, command, { timeout = 10 * 60_000, secrets = [] } = {}) {
  if (!ID_RE.test(id)) throw new ToolError('Mã máy ảo không hợp lệ')
  const bin = devinBinary(ctx)
  let r
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await ctx.spawn(bin, ['ssh', id, command], { timeout, env: { ...ctx.env, NO_COLOR: '1', NO_OPEN_BROWSER: '1' } })
    const text = `${r.stdout}\n${r.stderr}`
    if (r.code !== 0 && !r.timedOut && !r.error && /Could not verify the code/i.test(text) && attempt < 3) {
      await ctx.sleep(2000)
      continue
    }
    break
  }
  return {
    code: r.code,
    timedOut: Boolean(r.timedOut),
    error: r.error,
    // che trên đầu ra THÔ (khoá có thể bị ConPTY cắt bằng ESC/CR/LF), lọc ANSI, rồi che lần nữa (khoá bị cắt bằng ký tự điều khiển khác mà stripAnsi bỏ)
    stdout: redact(stripAnsi(redact(r.stdout, secrets)), secrets),
    stderr: redact(stripAnsi(redact(r.stderr, secrets)), secrets),
  }
}
// Chạy một script bash trên máy ảo (đã bọc base64).
export const runScript = (ctx, id, script, o = {}) => sshRun(ctx, id, wrapRemote(script), o)

export function parseMarks(text) {
  const out = {}
  for (const m of String(text ?? '').matchAll(new RegExp(`^${MARK} (\\w+) (.*)$`, 'gm'))) out[m[1]] = m[2].trim()
  return out
}

const MAJOR_RE = /^[1-9]\d?$/
// Cài Node linux/mac vào ~/.local (tarball chính thức, có kiểm sha256). exact=false: đã có node thì giữ nguyên; exact=true (devin.json có `node`): chỉ giữ khi đúng major, khác thì cài đè.
export function nodePrepScript({ major = NODE_MAJOR, exact = false } = {}) {
  if (!MAJOR_RE.test(String(major))) throw new Error(`major Node lạ: ${major}`)
  return [
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'cur=""',
    'if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then cur=$(node -v </dev/null); fi',
    exact
      ? `case "$cur" in v${major}.*) echo "${MARK} node $cur"; exit 0 ;; esac`
      : `[ -z "$cur" ] || { echo "${MARK} node $cur"; exit 0; }`,
    'case "$(uname -s)" in Linux) p=linux ;; Darwin) p=darwin ;; *) exit 90 ;; esac',
    'case "$(uname -m)" in x86_64|amd64) a=x64 ;; aarch64|arm64) a=arm64 ;; *) exit 90 ;; esac',
    `base=https://nodejs.org/dist/latest-v${major}.x`,
    'sums=$(curl -fsSL --retry 3 "$base/SHASUMS256.txt" </dev/null) || exit 91',
    'line=$(printf "%s\\n" "$sums" | grep "node-v[0-9.]*-$p-$a.tar.gz\\$" | head -1)',
    '[ -n "$line" ] || exit 91',
    'want=${line%% *}',
    'file=${line##* }',
    'tmp=$(mktemp -d) || exit 92',
    'trap \'[ -n "$tmp" ] && rm -rf -- "$tmp"\' EXIT',
    'curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file" </dev/null || exit 92',
    'if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$file" | cut -d" " -f1); else got=$(shasum -a 256 "$tmp/$file" | cut -d" " -f1); fi',
    '[ "$got" = "$want" ] || exit 93',
    'mkdir -p "$HOME/.local" || exit 92',
    // bản cũ (major khác) để lại npm/corepack cũ ⇒ gỡ hai thư mục đó của CHÍNH ~/.local trước khi giải nén đè
    'rm -rf -- "$HOME/.local/lib/node_modules/npm" "$HOME/.local/lib/node_modules/corepack"',
    'tar -xzf "$tmp/$file" -C "$HOME/.local" --strip-components=1 || exit 92',
    `echo "${MARK} node $(node -v)"`,
    '',
  ].join('\n')
}
// Windows: zip chính thức nodejs.org (có kiểm sha256) giải vào C:\devinvm\node-v<major>; pathPrefix('windows', major) thêm thư mục đó vào PATH của mọi script.
// Chạy bằng PowerShell -EncodedCommand. Máy đã có đúng major (ở thư mục đó hoặc trong PATH) thì không tải.
export function nodeWinScript({ major }) {
  if (!MAJOR_RE.test(String(major))) throw new Error(`major Node lạ: ${major}`)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$major = '${major}'`,
    '$dest = "C:\\devinvm\\node-v$major"',
    'try {',
    '  if (Test-Path "$dest\\node.exe") { $v = (& "$dest\\node.exe" -v); if ($v -match "^v$major\\.") { "' + MARK + ' node $v"; exit 0 } }',
    "  $sys = Get-Command node -ErrorAction SilentlyContinue",
    '  if ($sys) { $v = (& $sys.Source -v); if ($v -match "^v$major\\.") { "' + MARK + ' node $v"; exit 0 } }',
    '  $base = "https://nodejs.org/dist/latest-v$major.x"',
    '  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content',
    '  $line = ($sums -split "`n" | Where-Object { $_ -match "node-v[0-9.]+-win-x64\\.zip\\s*$" } | Select-Object -First 1)',
    '  if (-not $line) { exit 91 }',
    '  $parts = $line.Trim() -split "\\s+"',
    '  $want = $parts[0].ToLower(); $file = $parts[1]',
    '  $tmp = Join-Path $env:TEMP ("devinvm-node-" + [guid]::NewGuid().ToString("N"))',
    '  New-Item -ItemType Directory -Path $tmp | Out-Null',
    '  try {',
    '    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile "$tmp\\$file"',
    '    $got = (Get-FileHash "$tmp\\$file" -Algorithm SHA256).Hash.ToLower()',
    '    if ($got -ne $want) { exit 93 }',
    '    Expand-Archive -Path "$tmp\\$file" -DestinationPath "$tmp\\x" -Force',
    '    $inner = Get-ChildItem "$tmp\\x" -Directory | Select-Object -First 1',
    '    New-Item -ItemType Directory -Path "C:\\devinvm" -Force | Out-Null',
    '    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }',
    '    Move-Item $inner.FullName $dest',
    '  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }',
    '  $v = (& "$dest\\node.exe" -v)',
    '  "' + MARK + ' node $v"',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 92 }',
  ].join('\n')
}
const NODE_PREP_ERR = { 90: 'hệ điều hành/kiến trúc lạ', 91: 'không tải được danh sách bản Node', 92: 'không tải/giải nén được Node', 93: 'Node tải về sai mã kiểm' }

// Bật âm thanh Windows (AC-14): Audiosrv + AudioEndpointBuilder. Chạy bằng PowerShell -EncodedCommand (không dính trích dẫn của ssh).
export function audioScript() {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    'Set-Service AudioEndpointBuilder -StartupType Automatic',
    'Set-Service Audiosrv -StartupType Automatic',
    'Start-Service AudioEndpointBuilder, Audiosrv',
    `"${MARK} audio " + (Get-Service Audiosrv).Status`,
  ].join('\n')
}
// Mở app GUI qua tác vụ hẹn giờ Interactive. Thiếu cwd ⇒ thư mục kho trên máy ảo (%USERPROFILE%\repos\<tên>, nếu chưa có thì %USERPROFILE%), KHÔNG để mặc định System32.
export function guiScript({ exe, args = '', cwd = '', repo = '' }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${psq(exe)}`,
    `$arg = ${psq(args)}`,
    `$wd = ${psq(cwd)}`,
    `$repo = ${psq(repo)}`,
    "$name = 'devinvm-gui'",
    "if (-not $wd) { $wd = $env:USERPROFILE; if ($repo) { $cand = Join-Path $env:USERPROFILE (Join-Path 'repos' $repo); if (Test-Path -LiteralPath $cand) { $wd = $cand } } }",
    'Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '$p = @{ Execute = $exe }',
    "if ($arg) { $p.Argument = $arg }",
    "if ($wd) { $p.WorkingDirectory = $wd }",
    '$a = New-ScheduledTaskAction @p',
    '$pr = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive',
    'Register-ScheduledTask -TaskName $name -Action $a -Principal $pr -Force | Out-Null',
    'Start-ScheduledTask -TaskName $name',
    'Start-Sleep 3',
    `"${MARK} gui " + (Get-ScheduledTask -TaskName $name).State`,
  ].join('\n')
}
// powershell -EncodedCommand <UTF-16LE base64>: chỉ có chữ/số/+/=/ nên đi qua ssh không bị trích dẫn làm hỏng.
export const psCommand = (script) => `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`

// ---------- bật / đánh thức máy (AC-05, 06, 14) ----------
const iso = (ctx) => new Date(ctx.now()).toISOString()

async function waitRunning(ctx, login, id, say, timeoutMs = 180_000) {
  const deadline = ctx.now() + timeoutMs
  for (;;) {
    const g = await getSession(ctx, login, id)
    if (g?.status === 'running') return
    if (!g || ['exit', 'error'].includes(g.status)) throw new DevinUnavailable('service', 'Máy ảo mới bị dừng ngay khi bật')
    if (ctx.now() > deadline) throw new DevinUnavailable('timeout', 'Máy ảo bật quá lâu')
    say?.('Chờ máy ảo bật…')
    await ctx.sleep(3000)
  }
}
// Thử nối ssh `echo` tới khi được (lần đầu sau ngủ tự đánh thức ~30 s; máy mới bật xong cổng ssh có thể chưa sẵn vài giây). ≤ 6 lần và ≤ 4 phút. true = nối được.
async function probe(ctx, id, say) {
  const deadline = ctx.now() + 240_000
  for (let i = 1; i <= 6; i++) {
    const r = await sshRun(ctx, id, 'echo devinvm-ready', { timeout: 100_000 })
    if (r.code === 0 && r.stdout.includes('devinvm-ready')) return true
    say?.(`Chưa nối được máy ảo (lần ${i}/6)…`)
    if (i === 6 || ctx.now() > deadline) break
    await ctx.sleep(5000)
  }
  return false
}

// node = major do devin.json yêu cầu (hoặc null). Sổ ghi prep.node = major Node đang có trên máy (chuỗi, vd "24").
// linux/mac: chưa có ghi nhận ⇒ cài khi máy thiếu node; có `node` mà ghi nhận khác ⇒ cài đúng major đó. Windows: chỉ khi có `node` (máy có sẵn Node, không ép).
async function prepare(ctx, { id, os: osName, entry, key, audio, node, say }) {
  const done = {}
  const have = entry.prep?.node ? String(entry.prep.node) : null
  if (osName !== 'windows' ? !have || (node && have !== node) : node && have !== node) {
    say?.(node ? `Cài Node ${node} lên máy ảo…` : 'Cài Node LTS lên máy ảo (lần đầu)…')
    const win = osName === 'windows'
    const r = win ? await sshRun(ctx, id, psCommand(nodeWinScript({ major: node })), { timeout: 10 * 60_000 }) : await runScript(ctx, id, nodePrepScript({ major: node ?? NODE_MAJOR, exact: Boolean(node) }), { timeout: 10 * 60_000 })
    if (r.code !== 0) throw new ToolError(`Cài Node lên máy ảo lỗi: ${NODE_PREP_ERR[r.code] ?? `mã ${r.code}`}${firstLine(r.stderr) ? ` — ${firstLine(r.stderr)}` : ''}`)
    done.node = /^v(\d+)\./.exec(parseMarks(r.stdout).node ?? '')?.[1] ?? node ?? String(NODE_MAJOR)
  }
  if (osName === 'windows' && audio && !entry.prep?.audio) {
    say?.('Bật âm thanh Windows trên máy ảo…')
    const r = await sshRun(ctx, id, psCommand(audioScript()), { timeout: 3 * 60_000 })
    if (r.code !== 0 || !/audio Running/.test(r.stdout)) throw new ToolError(`Bật âm thanh Windows lỗi${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ` (mã ${r.code})`}`)
    done.audio = true
  }
  await updateRegistry(ctx, (reg) => {
    const e = reg[key]
    if (e && e.id === id) e.prep = { ...e.prep, ...done }
  })
}

// Đánh thức hoặc tạo máy cho (dự án, os). Trả { id, os, created, woke, prep }.
// Chống đua: bước "có máy chưa? chưa thì tạo + ghi sổ" nằm dưới khoá; phần chờ bật/đánh thức nằm ngoài khoá.
// quota: số hạn mức đã đo sẵn (job đo trước khi gọi up) · quotaLog: nơi ghi % ngày lúc bắt đầu / lúc xong cho devin-vm.log (CLI truyền; không truyền thì khỏi đo lần cuối).
export async function up(ctx, { dir, os: forced, audio, noRepos = false, quota, quotaLog, say } = {}) {
  const t = await target(ctx, { dir, os: forced })
  const login = await loadLogin(ctx)
  const q = quota ?? (await quotaStatus(ctx, login))
  if (quotaLog) quotaLog.start = q.daily
  const block = quotaBlock(ctx, q)
  if (block) throw new DevinUnavailable('quota', block) // TRƯỚC khi tạo / đánh thức: không cờ touched
  const wantAudio = audio ?? t.config.audio ?? false
  // Vòng 1: dùng máy trong sổ nếu còn sống. Máy cũ không nối được ⇒ vòng 2: bỏ máy cũ, tạo máy mới (AC-06).
  for (let round = 1; round <= 2; round++) {
    let created = false
    let state = null
    let entry = null
    await updateRegistry(ctx, async (reg) => {
      const e = reg[t.key]
      if (round === 1 && e?.id && ID_RE.test(e.id)) state = await getSession(ctx, login, e.id)
      if (state && ['exit', 'error'].includes(state.status)) state = null // máy đã chết ⇒ tạo lại
      if (state?.status === 'suspended' && QUOTA_DETAILS.has(state.detail)) throw new DevinUnavailable('quota', `Devin không đánh thức được máy (${state.detail})`)
      if (state) {
        entry = e
        return
      }
      const id = await createSession(ctx, login, createBody({ os: t.os, name: e?.name ?? t.info.name, slug: noRepos ? null : t.info.slug }))
      entry = { id, os: t.os, name: e?.name ?? t.info.name, root: t.info.root, created: iso(ctx), lastUp: iso(ctx), prep: {} }
      reg[t.key] = entry
      created = true
    })
    // Từ đây máy đã được tạo / đánh thức (hoặc ít nhất đang chạy): lỗi "Devin không dùng được" ném ra sau điểm này mang cờ `touched`,
    // để `job` biết máy có thể đang bật mà đòi cho ngủ (lỗi TRƯỚC điểm này — đăng nhập, hạn mức — thì job chưa làm gì với máy).
    try {
      const woke = !created && state.status !== 'running'
      say?.(created ? `Tạo máy ${OS_LABEL[t.os]} mới…` : woke ? `Đánh thức máy ${OS_LABEL[t.os]}…` : `Dùng lại máy ${OS_LABEL[t.os]} đang chạy`)
      if (created) await waitRunning(ctx, login, entry.id, say)
      if (await probe(ctx, entry.id, say)) {
        await prepare(ctx, { id: entry.id, os: t.os, entry, key: t.key, audio: wantAudio, node: t.config.node ?? null, say })
        await updateRegistry(ctx, (reg) => { if (reg[t.key]?.id === entry.id) reg[t.key].lastUp = iso(ctx) })
        if (quotaLog) quotaLog.end = (await quotaStatus(ctx, login)).daily
        return { id: entry.id, os: t.os, created, woke }
      }
      if (created) throw new DevinUnavailable('service', 'Máy ảo mới tạo nhưng không nối ssh được')
      say?.('Máy cũ không đánh thức được — tạo máy mới')
    } catch (e) {
      if (e instanceof DevinUnavailable) e.touched = true
      throw e
    }
  }
  throw Object.assign(new DevinUnavailable('service', 'Không bật được máy ảo'), { touched: true })
}

// ---------- ngủ / xoá / trạng thái (AC-07, 13) ----------
// Cho máy ngủ qua MCP rồi CHỜ tới khi suspended (≤ waitMs). Trả { ok, status }. Máy không còn (404) coi như ổn.
export async function sleepVm(ctx, id, { waitMs = 60_000, say } = {}) {
  const login = await loadLogin(ctx)
  let g = await getSession(ctx, login, id)
  if (!g) return { ok: true, status: 'gone' }
  if (g.status === 'suspended') return { ok: true, status: 'suspended' }
  await mcpCall(ctx, login, 'devin_session_interact', { action: 'sleep', session_id: id })
  const deadline = ctx.now() + waitMs
  for (;;) {
    g = await getSession(ctx, login, id)
    if (!g) return { ok: true, status: 'gone' }
    if (g.status === 'suspended') return { ok: true, status: 'suspended' }
    if (ctx.now() >= deadline) return { ok: false, status: g.status }
    say?.('Chờ máy ngủ…')
    await ctx.sleep(5000)
  }
}

// pid trong sổ có còn đúng là `devin forward <id của máy này> …` không (số pid có thể đã bị tiến trình khác mượn lại). Không đọc được dòng lệnh ⇒ không xác nhận ⇒ false.
async function isForwardOf(ctx, entry, f) {
  const cl = await ctx.cmdline(f.pid)
  return Boolean(cl && /forward/.test(cl) && cl.includes(entry.id))
}
// Dừng các `devin forward` của một mục sổ. Chỉ diệt khi pid vẫn đúng là `devin forward <id>`.
async function stopForwardsOf(ctx, entry, only = () => true) {
  let stopped = 0
  let stale = 0
  const keep = []
  for (const f of entry?.fwd ?? []) {
    if (!only(f)) {
      keep.push(f)
      continue
    }
    if (await isForwardOf(ctx, entry, f)) {
      ctx.kill(f.pid)
      stopped++
    } else stale++
  }
  if (entry) entry.fwd = keep
  return { stopped, stale }
}

// ---------- giữ máy thức (đo thật 31/10 vòng 2) ----------
// Máy tạo qua REST là "API-created": Devin cho NGỦ sau ~5 phút không có TIN NHẮN (status_detail: inactivity). ssh / forward / app đang chạy KHÔNG tính.
// Cách giữ: MCP devin_session_interact {action:"message"} mỗi 4 phút (SWE-2 trả "ok", acus 0, máy thức suốt 12 phút khi thử).
// Ba chỗ ping: (a) `job` suốt lệnh; (b) `forward` bật thêm tiến trình nền `keepalive` (dừng bởi forward --stop / sleep / rm); (c) run / gui / sync ping nếu lần ping cuối > 3 phút
// (lastPing trong sổ), run và sync ping tiếp mỗi 4 phút nếu lệnh kéo dài. KHÔNG BAO GIỜ ping máy không ở trạng thái running: máy ngủ do `sleep` mà bị ping sẽ thức lại.
const PING_EVERY_MS = 4 * 60_000
const PING_FRESH_MS = 3 * 60_000
const KEEPALIVE_MAX_MS = 6 * 60 * 60_000 // trần tuổi tiến trình nền: forward bị bỏ quên cũng không giữ máy (tốn hạn mức) mãi
export const KEEPALIVE_MESSAGE = 'keepalive: reply with the single word ok. Do not run any tools or commands.'

async function sendPing(ctx, t, login, id) {
  await mcpCall(ctx, login, 'devin_session_interact', { action: 'message', session_id: id, message: KEEPALIVE_MESSAGE })
  await updateRegistry(ctx, (reg) => { if (reg[t.key]?.id === id) reg[t.key].lastPing = ctx.now() })
}

// Ping nếu lần ping cuối > 3 phút VÀ máy đang running. Trả 'pinged' | 'fresh' | 'skipped' (máy không running) | 'failed'. Không bao giờ ném: ping hỏng không được làm hỏng lệnh chính.
async function pingIfNeeded(ctx, t, id, say) {
  try {
    const e = readRegistry(ctx)[t.key]
    if (e?.id === id && e.lastPing && ctx.now() - e.lastPing < PING_FRESH_MS) return 'fresh'
    const login = await loadLogin(ctx)
    const g = await getSession(ctx, login, id)
    if (g?.status !== 'running') return 'skipped'
    await sendPing(ctx, t, login, id)
    return 'pinged'
  } catch (e) {
    say?.(`Không ping giữ máy thức được (${firstLine(e?.message)}) — máy có thể tự ngủ sau ~5 phút không có tin nhắn`)
    return 'failed'
  }
}

// Ping ngay (nếu cần) rồi hẹn giờ ping mỗi 4 phút. Trả stop(): dừng hẹn giờ và CHỜ lần ping đang bay xong (để không có ping nào sau khi người gọi cho máy ngủ).
async function beginKeepalive(ctx, t, id, say) {
  await pingIfNeeded(ctx, t, id, say)
  let busy = null
  let stopped = false
  const timer = ctx.setInterval(() => {
    if (busy || stopped) return busy
    busy = pingIfNeeded(ctx, t, id, say).finally(() => { busy = null })
    return busy
  }, PING_EVERY_MS)
  timer?.unref?.()
  return async () => {
    stopped = true
    ctx.clearInterval(timer)
    await busy
  }
}
async function withKeepalive(ctx, t, id, fn, say) {
  const stop = await beginKeepalive(ctx, t, id, say)
  try {
    return await fn()
  } finally {
    await stop()
  }
}

const keepaliveRunning = async (ctx, entry) => {
  const cl = entry?.keepalive?.pid ? await ctx.cmdline(entry.keepalive.pid) : null
  return Boolean(cl && /keepalive/.test(cl) && /devin-vm/.test(cl))
}
// Bật tiến trình nền `devin-vm.mjs keepalive` cho máy này (một cái thôi; đã chạy thì giữ). Ghi pid vào sổ.
async function ensureKeepalive(ctx, t, entry) {
  if (await keepaliveRunning(ctx, entry)) return entry.keepalive.pid
  const bg = ctx.startBackground(process.execPath, [ctx.cliPath, 'keepalive', '--dir', t.info.top, '--os', t.os], { env: ctx.env })
  if (!bg.pid) throw new ToolError('không sinh được tiến trình nền')
  await updateRegistry(ctx, (reg) => { if (reg[t.key]?.id === entry.id) reg[t.key].keepalive = { pid: bg.pid, at: iso(ctx) } })
  return bg.pid
}
// Dừng tiến trình nền của một mục sổ (chỉ diệt khi pid vẫn đúng là `devin-vm keepalive`; không đọc được thì chỉ gỡ khỏi sổ — nó tự thoát vòng sau vì không còn tên trong sổ).
async function stopKeepaliveOf(ctx, entry) {
  if (!entry?.keepalive) return 0
  const alive = await keepaliveRunning(ctx, entry)
  if (alive) ctx.kill(entry.keepalive.pid)
  delete entry.keepalive
  return alive ? 1 : 0
}

// Thân của tiến trình nền `keepalive`: mỗi 4 phút ping nếu máy đang running. Tự thoát khi: không còn tên trong sổ (bị dừng/thay) · không còn forward nào sống · máy đã ngủ/xoá
// (kể cả do `sleep`) · quá 6 giờ · Devin hỏng 5 lần liền. Trả lý do thoát.
export async function runKeepalive(ctx, { dir, os: forced, say } = {}) {
  const t = await target(ctx, { dir, os: forced })
  const pid = ctx.pid
  const start = ctx.now()
  const end = async (why) => {
    await updateRegistry(ctx, (reg) => { if (reg[t.key]?.keepalive?.pid === pid) delete reg[t.key].keepalive })
    return why
  }
  // cha ghi pid vào sổ ngay sau khi sinh ra con: chờ tối đa 10 s trước khi kết luận "không ai đăng ký tôi"
  for (let i = 0; i < 20 && readRegistry(ctx)[t.key]?.keepalive?.pid !== pid; i++) await ctx.sleep(500)
  let failures = 0
  for (;;) {
    const e = readRegistry(ctx)[t.key]
    if (e?.keepalive?.pid !== pid) return 'stopped'
    // "còn forward" = pid còn sống VÀ dòng lệnh đúng là `devin forward <id>` (pid bị dùng lại cho tiến trình khác thì không giữ máy thức tới 6 giờ)
    let forwarding = false
    for (const f of e.fwd ?? []) if (ctx.pidAlive(f.pid) && (await isForwardOf(ctx, e, f))) { forwarding = true; break }
    if (!forwarding) return end('no-forward')
    if (ctx.now() - start > KEEPALIVE_MAX_MS) return end('max-age')
    try {
      const login = await loadLogin(ctx)
      const g = await getSession(ctx, login, e.id)
      if (!g || ['suspended', 'exit', 'error'].includes(g.status)) return end('asleep')
      if (g.status === 'running') await sendPing(ctx, t, login, e.id)
      failures = 0
    } catch (err) {
      if (!(err instanceof DevinUnavailable || err instanceof ToolError)) throw err
      say?.(`keepalive: ${firstLine(err.message)}`)
      if (++failures >= 5) return end('devin-down')
    }
    await ctx.sleep(PING_EVERY_MS)
  }
}

// ---------- lease độc quyền theo máy (QA: 2–3 qa-tester song song cùng dự án dùng chung MỘT máy) ----------
// Không có lease thì job xong cho máy ngủ dưới chân job kia, sync của job này ghi đè code job kia. Lease nằm trong sổ, khoá riêng `lease|<khoá máy>`
// ({ pid, token, at }) vì có thể cần giữ TRƯỚC khi mục máy tồn tại (lần đầu `up` mới tạo máy). Còn sống = pid còn chạy VÀ dòng lệnh đúng là `devin-vm … job`
// (kiểm như stopForwardsOf: pid chết hoặc bị tiến trình khác mượn lại thì lease mồ côi, người sau lấy luôn).
const LEASE_WAIT_MS = 20 * 60_000
const LEASE_POLL_MS = 5000
export const leaseKey = (key) => `lease|${key}`
const isLeaseKey = (k) => String(k).startsWith('lease|')
async function leaseAlive(ctx, lease) {
  if (!lease?.pid || !ctx.pidAlive(lease.pid)) return false
  const cl = await ctx.cmdline(lease.pid)
  // `sleep` thủ công cũng giữ lease trong lúc cho ngủ; mac-check (vmClient) giữ suốt từ up tới sleep
  return Boolean(cl && ((/devin-vm/.test(cl) && /\b(?:job|sleep)\b/.test(cl)) || /mac-check/.test(cl)))
}
// Lấy lease (nguyên tử dưới khoá sổ); đang bị job sống khác giữ thì chờ ≤ 20 phút, báo MỘT dòng. Trả { token } hoặc { why: 'timeout' | 'interrupted' }.
async function acquireLease(ctx, t, { say, aborted = () => false } = {}) {
  const token = randomBytes(8).toString('hex')
  const key = leaseKey(t.key)
  const deadline = ctx.now() + LEASE_WAIT_MS
  let told = false
  for (;;) {
    let busy = false
    await updateRegistry(ctx, async (reg) => {
      if (reg[key] && (await leaseAlive(ctx, reg[key]))) busy = true
      else reg[key] = { pid: ctx.pid, token, at: iso(ctx) }
    })
    if (!busy) return { token }
    if (aborted()) return { why: 'interrupted' }
    if (ctx.now() >= deadline) return { why: 'timeout' }
    if (!told) {
      say?.('Đang chờ máy ảo của dự án đang bận (job khác đang dùng) — tối đa 20 phút')
      told = true
    }
    await ctx.sleep(LEASE_POLL_MS)
  }
}
async function releaseLease(ctx, t, token) {
  await updateRegistry(ctx, (reg) => { if (reg[leaseKey(t.key)]?.token === token) delete reg[leaseKey(t.key)] })
}

// opts.force: bỏ qua lease người khác. opts.lease: token lease của CHÍNH job này (job tự cho máy ngủ khi xong).
// `sleep` thủ công (không có opts.lease) kiểm VÀ lấy lease trong CÙNG một lần giữ khoá sổ, giữ suốt lúc cho ngủ rồi nhả:
// kiểm rồi mới cho ngủ ngoài khoá thì job vừa lấy lease giữa chừng vẫn bị cho ngủ dưới chân (Grok lượt 2).
export async function sleepProject(ctx, opts = {}) {
  const t = await target(ctx, opts)
  const entry = readRegistry(ctx)[t.key]
  if (!entry?.id) return { ok: true, status: 'none', os: t.os }
  const key = leaseKey(t.key)
  let holder = null
  let own = null
  const token = randomBytes(8).toString('hex')
  await updateRegistry(ctx, async (reg) => {
    if (reg[key] && reg[key].token !== opts.lease && (await leaseAlive(ctx, reg[key]))) holder = reg[key]
    else if (!opts.lease) {
      reg[key] = { pid: ctx.pid, token, at: iso(ctx) }
      own = token
    }
  })
  if (holder && !opts.force) return { ok: false, busy: true, status: 'busy', holder: holder.pid, id: entry.id, os: t.os }
  try {
    return await sleepInner(ctx, t, entry, opts)
  } finally {
    if (own) await updateRegistry(ctx, (reg) => { if (reg[key]?.token === own) delete reg[key] })
  }
}
async function sleepInner(ctx, t, entry, opts) {
  // dừng forward + keepalive TRƯỚC khi cho ngủ (keepalive còn sống thì ping sẽ đánh thức máy)
  const killedKeepalive = await updateRegistry(ctx, async (reg) => {
    await stopForwardsOf(ctx, reg[t.key])
    return stopKeepaliveOf(ctx, reg[t.key])
  })
  let r = await sleepVm(ctx, entry.id, { say: opts.say })
  if (killedKeepalive && r.ok && r.status === 'suspended') {
    // một ping đã bay đi trước khi tiến trình nền bị diệt có thể vừa đánh thức máy: nhìn lại một lần
    await ctx.sleep(3000)
    const g = await getSession(ctx, await loadLogin(ctx), entry.id)
    if (g && g.status !== 'suspended') r = await sleepVm(ctx, entry.id, { say: opts.say })
  }
  return { ...r, id: entry.id, os: t.os }
}

export async function removeVm(ctx, opts = {}) {
  const t = await target(ctx, opts)
  const entry = readRegistry(ctx)[t.key]
  if (!entry?.id) return { ok: true, removed: null, os: t.os }
  const login = await loadLogin(ctx)
  await updateRegistry(ctx, async (reg) => {
    await stopForwardsOf(ctx, reg[t.key])
    await stopKeepaliveOf(ctx, reg[t.key])
  })
  // Đo 31/10: DELETE (và MCP terminate) lên máy đang NGỦ trả 200 nhưng không xoá — máy vẫn đánh thức được.
  // ⇒ máy ngủ thì đánh thức bằng ssh trước, rồi DELETE và chờ tới `exit` (máy đang chạy: ~5 s).
  const before = await getSession(ctx, login, entry.id)
  if (before?.status === 'suspended' && !(await probe(ctx, entry.id, opts.say)))
    throw new ToolError(`Devin chưa xoá máy ${entry.id}: không đánh thức được máy để xoá`)
  // Máy Windows (đo 31/10): DELETE để lại `running/finished`; MCP terminate thì `exit` sau ~20 s ⇒ chưa xong sau 20 s thì gọi thêm.
  let g = before
  if (g) await deleteSession(ctx, login, entry.id)
  const start = ctx.now()
  let terminated = false
  for (;;) {
    g = await getSession(ctx, login, entry.id)
    if (!g || ['exit', 'error'].includes(g.status) || ctx.now() > start + 90_000) break
    if (!terminated && ctx.now() > start + 20_000) {
      terminated = true
      await mcpCall(ctx, login, 'devin_session_interact', { action: 'terminate', session_id: entry.id })
    }
    await ctx.sleep(5000)
  }
  const gone = !g || ['exit', 'error'].includes(g.status)
  if (!gone) throw new ToolError(`Devin chưa xoá máy ${entry.id} (trạng thái ${g.status})`)
  await updateRegistry(ctx, (reg) => { if (reg[t.key]?.id === entry.id) delete reg[t.key] })
  return { ok: true, removed: entry.id, os: t.os }
}

export async function statusOf(ctx, { dir, os: forced, all = false } = {}) {
  const reg = readRegistry(ctx)
  let items
  if (all) items = Object.entries(reg).filter(([k]) => !isLeaseKey(k))
  else {
    const info = await projectInfo(ctx, dir)
    if (!info) throw new ToolError('Thư mục này không nằm trong kho git')
    items = OSES.filter((o) => !forced || o === forced).map((o) => [projectKey(ctx, info.root, o), reg[projectKey(ctx, info.root, o)]]).filter(([, e]) => e)
  }
  let login = null
  try {
    login = await loadLogin(ctx)
  } catch (e) {
    if (!(e instanceof DevinUnavailable)) throw e // chưa đăng nhập / thiếu CLI: vẫn liệt kê sổ, trạng thái unknown
  }
  const quotaP = login ? quotaStatus(ctx, login) : Promise.resolve(noQuota()) // chỉ để xem (status không chặn gì)
  const vms = await Promise.all(items.map(async ([key, e]) => {
    let status = 'unknown'
    let detail = null
    if (login && ID_RE.test(e.id ?? '')) {
      try {
        const g = await getSession(ctx, login, e.id)
        status = g ? g.status : 'gone'
        detail = g?.detail ?? null
      } catch (err) {
        if (!(err instanceof DevinUnavailable || err instanceof ToolError)) throw err
        status = 'unknown'
      }
    }
    return { id: e.id, os: e.os ?? key.split('|').pop(), root: e.root ?? key.split('|')[0], status, detail, awake: !['suspended', 'gone', 'exit', 'error', 'unknown'].includes(status), created: e.created ?? null, lastUp: e.lastUp ?? null }
  }))
  const { daily, weekly, resetAt } = await quotaP
  return { vms, quota: { daily, weekly, resetAt } }
}

// ---------- bản chụp code (AC-08, 09) ----------
const SECRET_PATH_RE = /(^|\/)(?:\.env(?:\.(?!example$|sample$|template$|defaults$)[^/]+)?|\.dev\.vars|\.mcp\.json|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$|^Note\//i
export const isSecretPath = (p) => SECRET_PATH_RE.test(String(p).replace(/\\/g, '/'))

// Chụp trạng thái làm việc thành commit tạm W KHÔNG đụng ref/index/cây làm việc thật: index tạm = HEAD + `git add -A` (file ignore không vào),
// bỏ file khoá/bí mật CHƯA commit (.env, .mcp.json, *.pem…) ⇒ write-tree ⇒ commit-tree (cha = HEAD nếu có). Trả { sha, tree, head, skipped }.
export async function snapshot(ctx, top) {
  const G = (args, o = {}) => git(ctx, top, args, o)
  const must = (r, what) => {
    if (r.code !== 0) throw new ToolError(`${what} lỗi: ${firstLine(r.stderr || r.error?.message || '')}`)
    return outOf(r)
  }
  const h = await G(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  const head = h.code === 0 ? outOf(h) : null
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devinvm-'))
  try {
    const env = {
      ...ctx.env,
      GIT_INDEX_FILE: path.join(tmpDir, 'index'),
      GIT_AUTHOR_NAME: 'devin-vm', GIT_AUTHOR_EMAIL: 'devin-vm@localhost', GIT_COMMITTER_NAME: 'devin-vm', GIT_COMMITTER_EMAIL: 'devin-vm@localhost',
    }
    if (head) must(await G(['read-tree', head], { env }), 'git read-tree')
    must(await G(['add', '-A'], { env }), 'git add')
    // Lọc trên index TẠM (đã gồm cả file `git add` rồi mà chưa commit): mọi đường dẫn bí mật KHÔNG có trong HEAD ⇒ bỏ khỏi index tạm trước write-tree.
    // (Lọc theo `ls-files --others` của index thật bỏ sót đúng loại file này.) Bí mật đã nằm trong HEAD thì đã commit rồi — không phải việc của lọc này.
    const splitZ = (r, what) => { must(r, what); return String(r.stdout ?? '').split('\0').filter(Boolean) }
    const secret = splitZ(await G(['ls-files', '-z'], { env }), 'git ls-files').filter(isSecretPath)
    let skipped = []
    if (secret.length) {
      const inHead = new Set(head ? splitZ(await G(['ls-tree', '-r', '--name-only', '-z', head]), 'git ls-tree') : [])
      skipped = secret.filter((p) => !inHead.has(p))
    }
    if (skipped.length) must(await G(['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${skipped.join('\0')}\0` }), 'git rm --cached')
    const tree = must(await G(['write-tree'], { env }), 'git write-tree')
    const sha = must(await G(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'devin-vm snapshot'], { env }), 'git commit-tree')
    return { sha, tree, head, skipped }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// Gói git của bản chụp. delta = chỉ phần chưa có ở origin (`W --not --remotes=origin`, máy ảo đã có kho kayntran); full = commit W không cha (cả cây).
// Bundle cần một ref ⇒ ref tạm refs/devin-vm/snap-<ngẫu nhiên>, xoá ngay sau khi đóng gói. KHÔNG đẩy gì lên GitHub.
export async function buildBundle(ctx, { top, mode, file, say }) {
  const snap = await snapshot(ctx, top)
  if (snap.skipped.length) say?.(`Bỏ ${snap.skipped.length} file khoá/bí mật chưa commit khỏi bản chụp`)
  let sha = snap.sha
  if (mode === 'full' && snap.head) {
    // cây giống hệt nhưng không cha: máy ảo không cần lịch sử, cũng không cần commit nền ở origin
    const env = { ...ctx.env, GIT_AUTHOR_NAME: 'devin-vm', GIT_AUTHOR_EMAIL: 'devin-vm@localhost', GIT_COMMITTER_NAME: 'devin-vm', GIT_COMMITTER_EMAIL: 'devin-vm@localhost' }
    const c = await git(ctx, top, ['commit-tree', snap.tree, '-m', 'devin-vm snapshot'], { env })
    if (c.code !== 0) throw new ToolError(`git commit-tree lỗi: ${firstLine(c.stderr)}`)
    sha = outOf(c)
  }
  const ref = `refs/devin-vm/snap-${randomBytes(4).toString('hex')}`
  const u = await git(ctx, top, ['update-ref', ref, sha])
  if (u.code !== 0) throw new ToolError(`git update-ref lỗi: ${firstLine(u.stderr)}`)
  try {
    const args = ['bundle', 'create', file, ref, ...(mode === 'delta' ? ['--not', '--remotes=origin'] : [])]
    const b = await git(ctx, top, args)
    if (b.code !== 0) throw new ToolError(`git bundle lỗi: ${firstLine(b.stderr)}`)
  } finally {
    await git(ctx, top, ['update-ref', '-d', ref])
  }
  return { sha, tree: snap.tree, ref }
}

// Script chạy trên máy ảo: lấy gói về (curl link ký sẵn), fetch vào kho ~/repos/<name>, checkout W, dọn file thừa, in mã commit + dấu vân tay cây làm việc.
// Mã thoát: 90 fetch gói lỗi (thiếu commit nền ở chế độ delta) · 91 không tải được gói · 92 checkout lỗi · 93 không tính được dấu vân tay.
export function syncScript({ name, url, ref, sha, delta }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) throw new Error(`tên kho lạ: ${name}`)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`mã commit lạ: ${sha}`)
  if (!/^refs\/devin-vm\/snap-[0-9a-f]{8}$/.test(ref)) throw new Error(`ref lạ: ${ref}`)
  if (!/^https:\/\//.test(url)) throw new Error('link tải phải là https')
  return [
    pathPrefix('linux').trimEnd(),
    'mkdir -p "$HOME/repos" || exit 92',
    `D=${repoDir(name)}`,
    '[ -d "$D/.git" ] || git init -q "$D" </dev/null || exit 92',
    'cd "$D" || exit 92',
    // gói nằm trong .git của kho và dùng đường dẫn tương đối: tránh lệch kiểu đường dẫn MSYS/Windows giữa bash và git.exe
    'rm -f .git/devinvm.bundle',
    `curl -fsSL --retry 3 -o .git/devinvm.bundle ${shq(url)} </dev/null || exit 91`,
    ...(delta ? ['git fetch -q origin </dev/null || true'] : []),
    `git fetch -q ./.git/devinvm.bundle ${shq(ref)} </dev/null || exit 90`,
    `git -c advice.detachedHead=false checkout -q -f --detach ${sha} </dev/null || exit 92`,
    'git clean -fdq </dev/null || exit 92',
    'rm -f .git/devinvm.bundle .git/devinvm-index',
    'GIT_INDEX_FILE=.git/devinvm-index git read-tree HEAD </dev/null || exit 93',
    'GIT_INDEX_FILE=.git/devinvm-index git add -A </dev/null || exit 93',
    'T=$(GIT_INDEX_FILE=.git/devinvm-index git write-tree </dev/null) || exit 93',
    'rm -f .git/devinvm-index',
    `echo "${MARK} head $(git rev-parse HEAD </dev/null)"`,
    `echo "${MARK} tree $T"`,
    '',
  ].join('\n')
}
const SYNC_ERR = { 90: 'máy ảo không nhận được gói code (git fetch lỗi)', 91: 'máy ảo không tải được gói code', 92: 'máy ảo không dựng được thư mục code', 93: 'máy ảo không tính được dấu vân tay cây làm việc' }

async function hasOriginRefs(ctx, top) {
  const r = await git(ctx, top, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin'])
  return r.code === 0 && Boolean(outOf(r))
}

const hashStr = (s) => b64(s).slice(0, 40)

// Chép bản code đang làm lên máy ảo và chứng minh nó chạy đúng bản đó (commit W + cây khớp). Kho kayntran: gói chênh (delta), lỗi thì chép cả bản.
export async function syncProject(ctx, { dir, os: forced, full = false, setup = false, say } = {}) {
  const t = await target(ctx, { dir, os: forced })
  const entry = requireEntry(ctx, t)
  return withKeepalive(ctx, t, entry.id, () => syncInner(ctx, t, entry, { full, setup, say }), say) // chép + setup có thể kéo dài hơn 5 phút
}
async function syncInner(ctx, t, entry, { full, setup, say }) {
  const name = entry.name ?? t.info.name
  const modes = !full && t.info.kayntran && t.info.slug && (await hasOriginRefs(ctx, t.info.top)) ? ['delta', 'full'] : ['full']
  let res = null
  for (const mode of modes) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devinvm-'))
    try {
      const file = path.join(tmpDir, 'snap.bundle')
      const b = await buildBundle(ctx, { top: t.info.top, mode, file, say })
      say?.(`Chép bản code lên máy ảo (${mode === 'delta' ? 'phần chênh' : 'cả bản'}, ${Math.max(1, Math.round(fs.statSync(file).size / 1024))} KB)…`)
      const up_ = await uploadFile(ctx, file, `snap-${b.sha.slice(0, 8)}.bundle`)
      const r = await runScript(ctx, entry.id, syncScript({ name, url: up_.url, ref: b.ref, sha: b.sha, delta: mode === 'delta' }), { timeout: 15 * 60_000, secrets: [up_.url] })
      if (r.code === 90 && mode === 'delta') {
        say?.('Máy ảo thiếu commit nền — chép cả bản')
        continue
      }
      if (r.code !== 0) throw new ToolError(`Chép code lên máy ảo lỗi: ${SYNC_ERR[r.code] ?? (r.timedOut ? 'quá giờ' : r.code === 255 ? 'mất kết nối ssh' : `mã ${r.code}`)}${firstLine(r.stderr) ? ` — ${firstLine(r.stderr)}` : ''}`)
      const marks = parseMarks(r.stdout)
      if (marks.head !== b.sha || marks.tree !== b.tree) throw new ToolError('Máy ảo không khớp bản đang làm (commit hoặc cây khác) — không chạy test trên bản lệch')
      res = { ok: true, mode, head: b.sha, tree: b.tree }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    break
  }
  if (!res) throw new ToolError('Chép code lên máy ảo không xong')
  const cmd = t.config.setup
  if (cmd && (setup || entry.setup !== hashStr(cmd))) {
    say?.('Chạy bước chuẩn bị của dự án (setup)…')
    const r = await runScript(ctx, entry.id, `${pathPrefix(t.os, t.config.node)}cd ${repoDir(name)} || exit 125\n${cmd}\n`, { timeout: 30 * 60_000 })
    if (r.code !== 0) throw new ToolError(`setup của dự án lỗi (mã ${r.code})${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''}`)
    await updateRegistry(ctx, (reg) => { if (reg[t.key]?.id === entry.id) reg[t.key].setup = hashStr(cmd) })
    res.setup = 'ran'
  }
  return res
}

// ---------- run / put / get / forward / gui ----------
export function parseDotenv(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1].startsWith('#')) continue
    let v = m[2]
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}
// Giá trị khoá cho --env: môi trường trước, rồi .env / .env.local của dự án. Thiếu ⇒ ToolError (nêu TÊN, không bao giờ nêu giá trị).
function envValues(ctx, names, dirs) {
  const files = {}
  // gốc kho chính trước, worktree sau (worktree thắng); trong một thư mục .env.local thắng .env
  for (const d of [...new Set(dirs)].reverse()) {
    for (const f of ['.env', '.env.local']) {
      try {
        Object.assign(files, parseDotenv(fs.readFileSync(path.join(d, f), 'utf8')))
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR'].includes(e?.code)) throw new ToolError(`Không đọc được ${f} trong ${d}: ${e?.code ?? 'lỗi lạ'}`) // chưa có file thì thôi; có mà không đọc được thì báo
      }
    }
  }
  const pairs = []
  const missing = []
  for (const n of names) {
    if (!ENV_NAME_RE.test(n)) throw new UsageError(`tên biến không hợp lệ: ${n}`)
    const v = ctx.env[n] ?? files[n]
    if (v === undefined || v === '') missing.push(n)
    else pairs.push([n, v])
  }
  if (missing.length) throw new ToolError(`Thiếu giá trị cho ${missing.join(', ')} (không có trong môi trường hay .env của dự án)`)
  return pairs
}
// Mỗi khoá đi dạng base64 trong script của ĐÚNG lần chạy này; không ghi file, không vào git.
export const envLines = (pairs) => pairs.map(([n, v]) => `export ${n}="$(printf %s '${b64(v)}' | base64 --decode)"`)

export async function runProject(ctx, { dir, os: forced, command, env = [], timeout, say } = {}) {
  if (!String(command ?? '').trim()) throw new UsageError('thiếu lệnh sau --')
  const t = await target(ctx, { dir, os: forced })
  const entry = requireEntry(ctx, t)
  const names = env.flatMap((n) => (n === '@config' ? (t.config.env ?? []) : [n]))
  const pairs = envValues(ctx, names, [t.info.top, t.info.root])
  const secrets = pairs.map(([, v]) => v)
  if (pairs.length) say?.(`Đưa khoá lên máy ảo cho lần chạy này: ${pairs.map(([n]) => n).join(', ')}`)
  const script = [
    pathPrefix(t.os, t.config.node).trimEnd(),
    ...envLines(pairs),
    `cd ${repoDir(entry.name ?? t.info.name)} || { echo 'chưa có code trên máy ảo — chạy: devin-vm.mjs sync' >&2; exit 125; }`,
    String(command),
    '',
  ].filter((l) => l !== '').join('\n')
  const r = await withKeepalive(ctx, t, entry.id, () => runScript(ctx, entry.id, `${script}\n`, { timeout: timeout ?? 10 * 60_000, secrets }), say)
  return { ...r, id: entry.id, os: t.os, envNames: pairs.map(([n]) => n) }
}

// Đường dẫn trên máy ảo: `~/x` ⇒ "$HOME"/'x'; còn lại giữ nguyên trong nháy đơn (tương đối ⇒ so với thư mục code của dự án).
function remotePath(p) {
  const s = String(p)
  if (!s || /[\0\r\n]/.test(s)) throw new UsageError('đường dẫn máy ảo không hợp lệ')
  return s === '~' ? '"$HOME"' : s.startsWith('~/') ? `"$HOME"/${shq(s.slice(2))}` : shq(s)
}

export async function putFile(ctx, { dir, os: forced, local, remote, say }) {
  const t = await target(ctx, { dir, os: forced })
  const entry = requireEntry(ctx, t)
  return withKeepalive(ctx, t, entry.id, () => putInner(ctx, t, entry, { local, remote, say }), say) // chép file lớn có thể kéo dài hơn 5 phút
}
async function putInner(ctx, t, entry, { local, remote, say }) {
  const name = `put-${randomBytes(4).toString('hex')}-${sanitizeName(path.basename(local))}`
  say?.('Chép file lên máy ảo…')
  const up_ = await uploadFile(ctx, local, name)
  const script = [
    pathPrefix(t.os).trimEnd(),
    `cd ${repoDir(entry.name ?? t.info.name)} 2>/dev/null || cd "$HOME"`,
    `dest=${remotePath(remote)}`,
    'mkdir -p "$(dirname "$dest")" || exit 92',
    `curl -fsSL --retry 3 -o "$dest" ${shq(up_.url)} </dev/null || exit 91`,
    `echo "${MARK} size $(wc -c < "$dest" | tr -d ' ')"`,
    '',
  ].join('\n')
  const r = await runScript(ctx, entry.id, script, { timeout: 10 * 60_000, secrets: [up_.url] })
  if (r.code !== 0) throw new ToolError(`Chép file lên máy ảo lỗi (mã ${r.code})${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''}`)
  return { ok: true, bytes: Number(parseMarks(r.stdout).size ?? 0) }
}

// `get` KHÔNG đi qua stdout của `devin ssh`: trên Windows devin.exe chạy ssh trong ConPTY, dòng dài bị bẻ + chèn ESC (đo 31/10: base64 11 KB → 11844 byte,
// 71 CR, 82 ESC ⇒ file hỏng). Thay vào đó: máy ảo mở server tĩnh TẠM chỉ phục vụ một bản sao của file, bind 127.0.0.1, cổng ngẫu nhiên, tách nền; máy bạn mở
// `devin forward` nền tới cổng đó, tải bằng fetch, so sha256 + kích thước với giá trị máy ảo tự tính (qua dòng MARK ngắn); xong thì LUÔN dọn server + forward + thư mục tạm.
const GID_RE = /^[0-9a-f]{8}$/
const getDir = (gid) => `"$HOME/.devinvm-get-${gid}"`

// Mã thoát: 94 không có file · 95 quá lớn · 96 máy ảo không có Python · 92 không tạo/chép được thư mục tạm · 97 server không mở cổng.
// In ra (dòng ngắn): MARK port <cổng>, MARK sha <sha256>, MARK size <byte>.
export function getStartScript({ os: osName, name, remote, gid, node }) {
  if (!GID_RE.test(gid)) throw new Error(`mã lần lấy lạ: ${gid}`)
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) throw new Error(`tên kho lạ: ${name}`)
  return [
    pathPrefix(osName, node).trimEnd(),
    `cd ${repoDir(name)} 2>/dev/null || cd "$HOME"`,
    `src=${remotePath(remote)}`,
    '[ -f "$src" ] || exit 94',
    `[ "$(wc -c < "$src" | tr -d ' ')" -le ${MAX_PULL} ] || exit 95`,
    // python3 trên Windows có thể là bí danh Microsoft Store (chạy không được) ⇒ thử chạy thật từng ứng viên
    `for c in ${osName === 'windows' ? 'python python3' : 'python3 python'}; do "$c" -c 'import http.server' >/dev/null 2>&1 </dev/null && { PY=$c; break; }; done`,
    '[ -n "$PY" ] || exit 96',
    `W=${getDir(gid)}`,
    'mkdir -p "$W/serve" || exit 92',
    'cp "$src" "$W/serve/payload" || exit 92',
    // sha256 + kích thước của chính bản sao sẽ được phục vụ
    'if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum "$W/serve/payload" | cut -d" " -f1); else h=$(shasum -a 256 "$W/serve/payload" | cut -d" " -f1); fi',
    'n=$(wc -c < "$W/serve/payload" | tr -d " ")',
    // server nền: mọi fd chuyển hướng (ssh không chờ nó), cổng 0 = hệ điều hành chọn, chỉ 127.0.0.1, thư mục phục vụ chỉ chứa bản sao
    'cd "$W/serve" || exit 92',
    'nohup "$PY" -u -m http.server 0 --bind 127.0.0.1 >"$W/log" 2>&1 </dev/null &',
    'echo $! > "$W/pid"',
    'port=""; i=0',
    'while [ -z "$port" ] && [ "$i" -lt 60 ]; do port=$(sed -n "s/.*port \\([0-9][0-9]*\\).*/\\1/p" "$W/log" | head -1); [ -n "$port" ] || { sleep 0.3; i=$((i+1)); }; done',
    '[ -n "$port" ] || exit 97',
    `echo "${MARK} port $port"`,
    `echo "${MARK} sha $h"`,
    `echo "${MARK} size $n"`,
    '',
  ].join('\n')
}

// Dọn phía máy ảo (gọi lại được nhiều lần, kể cả khi script khởi động hỏng giữa chừng): dừng server theo pid đã ghi, xoá đúng thư mục riêng của lần này.
export function getCleanScript({ gid }) {
  if (!GID_RE.test(gid)) throw new Error(`mã lần lấy lạ: ${gid}`)
  return [
    `W=${getDir(gid)}`,
    'if [ -f "$W/pid" ]; then',
    '  p=$(cat "$W/pid")',
    '  wp=""; [ -r "/proc/$p/winpid" ] && wp=$(cat "/proc/$p/winpid")', // Git Bash: pid Windows của tiến trình native
    '  kill "$p" >/dev/null 2>&1',
    '  [ -n "$wp" ] && taskkill //PID "$wp" //F >/dev/null 2>&1',
    '  sleep 1',
    '  kill -9 "$p" >/dev/null 2>&1',
    'fi',
    'case "$W" in "$HOME"/.devinvm-get-*) rm -rf -- "$W" ;; esac',
    `if [ ! -e "$W" ]; then echo "${MARK} cleaned"; else echo "${MARK} not-cleaned"; fi`,
    'exit 0',
    '',
  ].join('\n')
}
const GET_ERR = { 92: 'máy ảo không tạo/chép được thư mục tạm', 96: 'máy ảo không có Python (cần python3 hoặc python)', 97: 'server tạm trên máy ảo không mở được cổng' }

// Tải qua cổng chuyển, ghi ra file `.devinvm-part` rồi đổi tên khi sha256 + kích thước khớp. Không gửi khoá Devin tới server (fetch trần). Thử lại ≤ 3 lần.
async function downloadVerified(ctx, port, local, { sha, size }) {
  const dest = path.resolve(local)
  const part = `${dest}.devinvm-part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let last
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await ctx.fetch(`http://127.0.0.1:${port}/payload`, { signal: AbortSignal.timeout(15 * 60_000) })
      if (!res.ok) throw new ToolError(`server tạm trả mã ${res.status}`)
      const hash = createHash('sha256')
      let n = 0
      if (res.body) {
        await pipeline(Readable.fromWeb(res.body), async function* (src) {
          for await (const chunk of src) {
            hash.update(chunk)
            n += chunk.length
            yield chunk
          }
        }, fs.createWriteStream(part))
      } else fs.writeFileSync(part, '')
      if (n !== size || hash.digest('hex') !== sha) throw new ToolError(`file tải về không khớp máy ảo (${n}/${size} byte, sha256 khác) — không dùng`)
      fs.renameSync(part, dest)
      return n
    } catch (e) {
      last = e
      fs.rmSync(part, { force: true })
      if (attempt < 3) await ctx.sleep(1000)
    }
  }
  throw last instanceof ToolError ? last : new ToolError(`Tải file qua cổng chuyển lỗi: ${firstLine(last?.message)}`)
}

export async function getFile(ctx, { dir, os: forced, remote, local, say }) {
  const t = await target(ctx, { dir, os: forced })
  const entry = requireEntry(ctx, t)
  return withKeepalive(ctx, t, entry.id, () => getInner(ctx, t, entry, { remote, local, say }), say) // suốt mở server + tải + dọn
}
async function getInner(ctx, t, entry, { remote, local, say }) {
  const gid = randomBytes(4).toString('hex')
  let tunnel = null
  let result = null
  let failure = null
  try {
    say?.('Mở server tạm trên máy ảo…')
    const r = await runScript(ctx, entry.id, getStartScript({ os: t.os, name: entry.name ?? t.info.name, remote, gid, node: t.config.node }), { timeout: 5 * 60_000 })
    if (r.code === 94) throw new ToolError('Không thấy file trên máy ảo')
    if (r.code === 95) throw new ToolError(`File trên máy ảo quá lớn (tối đa ${MAX_PULL / 1048576} MB) — nén bớt rồi lấy lại`)
    const m = parseMarks(r.stdout)
    const port = Number(m.port)
    const size = Number(m.size)
    if (r.code !== 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(m.sha ?? '') || !Number.isInteger(size)) {
      throw new ToolError(`Lấy file từ máy ảo lỗi: ${GET_ERR[r.code] ?? (r.timedOut ? 'quá giờ' : r.code === 255 ? 'mất kết nối ssh' : `mã ${r.code}`)}${firstLine(r.stderr) ? ` — ${firstLine(r.stderr)}` : ''}`)
    }
    tunnel = await openTunnel(ctx, { t, entry, local: await ctx.freePort(), remote: port, say })
    say?.('Tải file qua cổng chuyển…')
    const bytes = await downloadVerified(ctx, tunnel.local, local, { sha: m.sha, size })
    result = { ok: true, bytes, sha256: m.sha }
  } catch (e) {
    failure = e
  }
  // Dọn LUÔN (kể cả khi lỗi): forward ở máy bạn trước, rồi server + thư mục tạm trên máy ảo. Devin đã không dùng được thì không có gì để dọn từ xa (máy ngủ là mất server).
  let cleaned = true
  if (tunnel) {
    try { await closeTunnel(ctx, t, tunnel.pid) } catch { cleaned = false }
  }
  if (!(failure instanceof DevinUnavailable)) {
    try {
      const c = await runScript(ctx, entry.id, getCleanScript({ gid }), { timeout: 2 * 60_000 })
      cleaned = cleaned && c.code === 0 && c.stdout.includes(`${MARK} cleaned`)
    } catch {
      cleaned = false
    }
  }
  if (!cleaned) say?.('CẢNH BÁO: chưa dọn hết server tạm trên máy ảo — cho máy ngủ (sleep) là mất hết tiến trình')
  if (failure) throw failure
  return { ...result, cleaned }
}

export function parsePorts(spec) {
  const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(String(spec ?? ''))
  if (!m) throw new UsageError('cổng phải dạng <cổng> hoặc <cổng-máy-bạn>:<cổng-máy-ảo>, ví dụ 9333:9333')
  const local = Number(m[1])
  const remote = m[2] === undefined ? local : Number(m[2])
  if (![local, remote].every((p) => p >= 1 && p <= 65535)) throw new UsageError('cổng ngoài khoảng 1–65535')
  return { local, remote }
}

// Mở `devin forward <id> local:remote` nền, chờ cổng máy bạn mở (≤ 30 s), ghi pid vào sổ (để `forward --stop` / `sleep` dọn nếu tiến trình này chết giữa chừng).
// Cổng máy bạn đã có tiến trình KHÁC nghe (forward cũ mồ côi, app khác…) ⇒ báo lỗi: nếu cứ mở, `devin forward` mới thất bại im lặng mà cổng "mở" là của kẻ khác.
async function openTunnel(ctx, { t, entry, local, remote, say }) {
  const bin = devinBinary(ctx)
  const freed = await updateRegistry(ctx, (reg) => stopForwardsOf(ctx, reg[t.key], (f) => f.local === local)) // chỉ nhả đúng cổng này nếu chính mình đang giữ
  for (let i = 0; freed.stopped && i < 15 && (await ctx.probePort(local)); i++) await ctx.sleep(200) // forward cũ của mình vừa bị diệt: chờ cổng nhả
  if (await ctx.probePort(local)) throw new ToolError(`Cổng ${local} trên máy bạn đang có tiến trình khác nghe (không phải forward của công cụ này) — tắt nó hoặc chọn cổng khác`)
  const bg = ctx.startBackground(bin, ['forward', entry.id, `${local}:${remote}`], { env: { ...ctx.env, NO_COLOR: '1' } })
  const deadline = ctx.now() + 30_000
  for (;;) {
    if (bg.exited()) throw new ToolError('devin forward thoát ngay (máy ảo đang ngủ hoặc cổng bận?) — chạy up rồi thử lại')
    if (await ctx.probePort(local)) break
    if (ctx.now() > deadline) {
      ctx.kill(bg.pid)
      throw new ToolError(`Cổng ${local} chưa mở sau 30 giây`)
    }
    say?.('Chờ cổng chuyển mở…')
    await ctx.sleep(500)
  }
  // cổng mở chưa chắc là của con này (kẻ khác có thể chen vào giữa lúc kiểm và lúc bind): đợi 1 s rồi chắc con còn sống
  await ctx.sleep(1000)
  if (bg.exited()) throw new ToolError(`devin forward thoát sau khi cổng ${local} đã mở — cổng đó không phải của nó (tiến trình khác đang giữ?)`)
  await updateRegistry(ctx, (reg) => {
    const e = reg[t.key]
    if (e) e.fwd = [...(e.fwd ?? []), { pid: bg.pid, local, remote, at: iso(ctx) }]
  })
  return { pid: bg.pid, local, remote }
}
// Đóng đúng cổng chuyển do mình vừa mở (pid chính mình sinh ra nên diệt thẳng) và gỡ khỏi sổ.
async function closeTunnel(ctx, t, pid) {
  ctx.kill(pid)
  await updateRegistry(ctx, (reg) => { if (reg[t.key]) reg[t.key].fwd = (reg[t.key].fwd ?? []).filter((f) => f.pid !== pid) })
}

// Chuyển cổng máy ảo ⇒ localhost bằng `devin forward` chạy nền; pid ghi vào sổ để `forward --stop` dừng.
// Kèm một tiến trình nền `keepalive` (ping giữ máy thức mỗi 4 phút, tự thoát khi hết forward / máy ngủ) — forward không tính là hoạt động nên không có nó máy ngủ sau ~5 phút.
export async function startForward(ctx, { dir, os: forced, spec, say }) {
  const { local, remote } = parsePorts(spec)
  const t = await target(ctx, { dir, os: forced })
  const entry = requireEntry(ctx, t)
  const tunnel = await openTunnel(ctx, { t, entry, local, remote, say })
  let keepalive = null
  try {
    keepalive = await ensureKeepalive(ctx, t, readRegistry(ctx)[t.key] ?? entry)
  } catch (e) {
    say?.(`Không bật được tiến trình giữ máy thức (${firstLine(e?.message)}) — máy có thể tự ngủ sau ~5 phút`)
  }
  return { ok: true, ...tunnel, keepalive }
}

export async function stopForward(ctx, { dir, os: forced }) {
  const t = await target(ctx, { dir, os: forced })
  let r = { stopped: 0, stale: 0 }
  await updateRegistry(ctx, async (reg) => {
    r = await stopForwardsOf(ctx, reg[t.key])
    r.keepalive = await stopKeepaliveOf(ctx, reg[t.key])
  })
  return { ok: true, ...r }
}

// Mở app GUI trên máy Windows: tác vụ hẹn giờ kiểu Interactive (lệnh qua ssh chạy ở phiên ẩn nên app mở thẳng sẽ không hiện) (AC-02).
// `cmd` = cả dòng lệnh chạy qua `cmd.exe /c <dòng>` (dựng ở đây, vì Git Bash đổi `/c` thành `C:/` trước khi tới node). Thiếu cwd ⇒ thư mục kho trên máy ảo.
export async function guiLaunch(ctx, { dir, os: forced, exe, args = '', cwd = '', cmd, say }) {
  const t = await target(ctx, { dir, os: forced })
  if (t.os !== 'windows') throw new ToolError(`gui chỉ dùng cho máy Windows (đang chọn ${OS_LABEL[t.os]})`)
  if (cmd !== undefined && cmd !== null) {
    if (String(exe ?? '').trim()) throw new UsageError('chọn một: --cmd "<dòng lệnh>" hoặc -- <app> [tham số]')
    if (!String(cmd).trim()) throw new UsageError('--cmd trống')
    exe = 'cmd.exe'
    args = `/c ${cmd}`
  }
  if (!String(exe ?? '').trim() || /[\0\r\n]/.test(exe + args + cwd)) throw new UsageError('thiếu đường dẫn app hoặc có ký tự lạ')
  const entry = requireEntry(ctx, t)
  await pingIfNeeded(ctx, t, entry.id, say)
  const r = await sshRun(ctx, entry.id, psCommand(guiScript({ exe, args, cwd, repo: entry.name ?? t.info.name })), { timeout: 3 * 60_000 })
  if (r.code !== 0 || !new RegExp(`${MARK} gui `).test(r.stdout)) throw new ToolError(`Mở app trên máy ảo lỗi (mã ${r.code})${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''}`)
  return { ok: true, state: parseMarks(r.stdout).gui ?? null }
}

// ---------- job: máy ảo quanh một lệnh của máy user (AC-07, 11, 12) ----------
// where ⇒ (local: chạy lệnh luôn) · up + sync + chạy lệnh với DEVIN_VM_ID / DEVIN_VM_OS / DEVIN_VM_RUNNER ⇒ `finally` + SIGINT/SIGTERM: máy ngủ, chờ suspended.
// Devin không dùng được (chưa đăng nhập, hết hạn mức, lỗi mạng) ⇒ chạy lệnh trên máy user như trước. Trả mã thoát.
// quotaLog: nơi ghi % hạn mức NGÀY trước up (start) và sau khi cho ngủ (end) cho devin-vm.log — đo mỗi lần chạy tốn bao nhiêu %.
export async function runJob(ctx, { dir, os: forced, need = [], command, quotaLog = {}, say = () => {} } = {}) {
  if (!String(command ?? '').trim()) throw new UsageError('thiếu lệnh sau --')
  const cwd = path.resolve(dir ?? process.cwd())
  const w = await where(ctx, { dir, need, os: forced })
  const runHere = (why) => {
    say(why)
    return ctx.runLocal(command, { env: { ...ctx.env, DEVIN_VM_RUNNER: 'local', DEVIN_VM_OS: w.os }, cwd })
  }
  if (w.runner === 'local') return runHere(`Chạy trên máy bạn: ${w.reason}${w.login ? ` (đăng nhập: ${w.login})` : ''}`)

  const t = await target(ctx, { dir, os: w.os })
  let child = null
  let interrupted = null
  let code = 1
  let fellBack = false
  let thrown = null
  let stopPing = null
  let lease = null
  let blocked = false // up bị phanh hạn mức (chưa đụng máy) ⇒ khỏi đo lần cuối
  const sigs = ['SIGINT', 'SIGTERM']
  const onSig = (s) => { interrupted ??= s; child?.kill() }
  for (const s of sigs) ctx.proc.on(s, onSig)
  try {
    // Lease độc quyền TRƯỚC khi đụng máy: job khác của dự án đang dùng máy thì chờ (≤ 20 phút); Ctrl+C khi đang chờ thì thôi, không đụng gì
    const got = await acquireLease(ctx, t, { say, aborted: () => Boolean(interrupted) })
    lease = got.token ?? null
    if (got.why === 'timeout') {
      fellBack = true
      code = await runHere(`Máy ảo của dự án vẫn bận sau ${LEASE_WAIT_MS / 60_000} phút — chạy trên máy bạn`)
    }
    let vm
    if (lease && !interrupted) {
      const q0 = await quotaStatus(ctx) // % ngày ngay trước khi đụng máy (where đã kiểm một lần; lần này vừa để ghi log vừa chặn nếu tụt giữa chừng)
      quotaLog.start = q0.daily
      try {
        vm = await up(ctx, { dir, os: w.os, quota: q0, say })
      } catch (e) {
        if (!(e instanceof DevinUnavailable)) throw e
        blocked = e.kind === 'quota' && !e.touched
        fellBack = !e.touched // `touched`: up đã tạo/đánh thức máy trước khi hỏng ⇒ máy có thể đang bật, job vẫn phải đòi nó ngủ
        code = await runHere(`Devin không dùng được (${e.message}${e.loginCmd ? ` — chạy: ${e.loginCmd}` : ''}) — chạy trên máy bạn`)
      }
    }
    if (vm && !interrupted) {
      // hẹn giờ ping giữ máy thức suốt lệnh (lệnh của máy user có thể im lặng với Devin hơn 5 phút: ssh không tính là hoạt động)
      stopPing = await beginKeepalive(ctx, t, vm.id, say)
      await syncProject(ctx, { dir, os: w.os, say })
      say(`Chạy lệnh (máy ảo ${OS_LABEL[w.os]} ${vm.id})`)
      code = await ctx.runLocal(command, {
        env: { ...ctx.env, DEVIN_VM_RUNNER: 'devin', DEVIN_VM_ID: vm.id, DEVIN_VM_OS: w.os },
        cwd,
        onChild: (c) => { child = c; if (interrupted) c.kill() },
      })
    }
  } catch (e) {
    thrown = e
  }
  // Dù đạt, hỏng, ném lỗi hay bị ngắt: máy ngủ rồi mới báo xong (AC-07). Lỗi lúc ngủ không được che mã thoát của lệnh.
  for (const s of sigs) ctx.proc.removeListener(s, onSig)
  child = null
  try {
    await stopPing?.() // xong hẳn ping rồi mới cho ngủ, kẻo ping đánh thức lại máy
  } catch (e) {
    say(`CẢNH BÁO: dừng hẹn giờ giữ máy thức lỗi (${scrub(e.message)})`) // không được làm hỏng việc dọn
  }
  let sleepNote = null
  // Chỉ job đang GIỮ lease mới được cho máy ngủ (chưa có lease = máy của job khác, đừng đụng); ngủ xong mới nhả lease để job chờ vào sau.
  if (lease && readRegistry(ctx)[t.key]?.id) {
    try {
      say('Cho máy ảo ngủ…')
      const s = await sleepProject(ctx, { dir, os: w.os, say, lease })
      if (!s.ok) sleepNote = `máy ${s.id} chưa ngủ (trạng thái ${s.status})`
    } catch (e) {
      sleepNote = `không cho máy ngủ được (${scrub(e.message)})`
    }
    if (sleepNote) say(`CẢNH BÁO: ${sleepNote} — chạy: node hooks/devin-vm.mjs sleep --os ${w.os}`)
  }
  if (lease) {
    try {
      await releaseLease(ctx, t, lease)
    } catch (e) {
      say(`CẢNH BÁO: không nhả được lease máy ảo (${scrub(e.message)}) — job khác sẽ nhận ra lease mồ côi khi tiến trình này thoát`)
    }
  }
  if (lease && quotaLog.start !== undefined && !blocked) {
    try {
      quotaLog.end = (await quotaStatus(ctx)).daily // sau khi máy đã ngủ: hiệu hai số = phần trăm ngày lần chạy này tốn
    } catch (e) {
      say(`CẢNH BÁO: không đo được hạn mức sau khi xong (${scrub(e.message)})`)
    }
  }
  if (thrown) throw thrown
  if (interrupted) return interrupted === 'SIGINT' ? 130 : 143
  // Lệnh đạt mà máy chưa ngủ ⇒ không báo xong (mã 1): máy còn bật là tốn hạn mức. Chỉ khi Devin hỏng TRƯỚC khi job đụng tới máy
  // (đăng nhập / hạn mức lúc up) và quay về máy user thì không có gì để đòi; đã tạo/đánh thức máy rồi mới hỏng (ssh không nối được…) thì vẫn đòi.
  return sleepNote && code === 0 && !fellBack ? 1 : code
}

// ---------- mặt tiền cho công cụ khác (mac-check) ----------
// Một máy (dự án, os) với bốn việc: bật · chép file · chạy script bash · cho ngủ (tìm máy theo sổ nên ngủ được cả khi `up` ném lỗi giữa chừng).
// Giữ lease độc quyền như `job` từ up tới sleep (Grok lượt 3: không giữ thì job khác cùng máy bị cho ngủ / ghi đè dưới chân mac-check).
// Job khác giữ máy quá 20 phút ⇒ up ném DevinUnavailable (người gọi chạy máy user) và sleep KHÔNG đụng máy / lease của job kia.
export function vmClient(ctx, { dir, os: osName, noRepos = false }) {
  let lease = null
  let busy = false
  return {
    up: async (say) => {
      if (!lease) {
        const got = await acquireLease(ctx, await target(ctx, { dir, os: osName }), { say })
        if (!got.token) {
          busy = true
          throw new DevinUnavailable('service', `Máy ảo của dự án vẫn bận sau ${LEASE_WAIT_MS / 60_000} phút (job khác đang dùng)`)
        }
        lease = got.token
      }
      return up(ctx, { dir, os: osName, noRepos, say })
    },
    upload: (file, name) => uploadFile(ctx, file, name),
    // chạy script dài (mac-check) thì ping giữ máy thức: ssh không tính là hoạt động nên máy ngủ giữa chừng
    runScript: async (id, script, o) => withKeepalive(ctx, await target(ctx, { dir, os: osName }), id, () => runScript(ctx, id, script, o)),
    sleep: async (say) => {
      if (busy && !lease) return { ok: true, status: 'not-ours', id: null } // chưa từng giữ máy: máy là của job kia, nó tự cho ngủ
      try {
        return await sleepProject(ctx, { dir, os: osName, say, ...(lease ? { lease } : {}) })
      } finally {
        if (lease) {
          await releaseLease(ctx, await target(ctx, { dir, os: osName }), lease)
          lease = null
        }
      }
    },
  }
}

// ---------- ghi log ----------
// Mỗi lệnh một dòng: giờ, lệnh (chỉ tên lệnh), mã máy, ms, mã thoát. KHÔNG ghi nội dung lệnh / khoá / link.
// Lệnh có đo hạn mức (`up`, `job` — truyền `quota`) thêm hai cột cuối = % hạn mức NGÀY lúc bắt đầu và lúc xong (chưa biết ⇒ "-"), để biết mỗi lần chạy tốn bao nhiêu %.
// Lệnh khác giữ năm cột như cũ. Chỉ chữ số vào log.
export function appendLog(ctx, { cmd, id = '-', ms = 0, code = 0, quota } = {}) {
  const col = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '-')
  const tail = quota ? `\t${col(quota.start)}\t${col(quota.end)}` : ''
  try {
    fs.mkdirSync(path.dirname(ctx.logFile), { recursive: true })
    fs.appendFileSync(ctx.logFile, `${iso(ctx)}\t${String(cmd).replace(/[^\w-]/g, '')}\t${String(id).replace(/[^\w-]/g, '')}\t${Math.round(ms)}\t${code}${tail}\n`)
    if (fs.statSync(ctx.logFile).size > 1_000_000) {
      const lines = fs.readFileSync(ctx.logFile, 'utf8').split('\n')
      fs.writeFileSync(ctx.logFile, lines.slice(Math.floor(lines.length / 2)).join('\n'))
    }
  } catch (e) {
    ignoreOnly('không ghi được hooks/devin-vm.log', e) // log hỏng không được làm hỏng lệnh, nhưng phải để lại dấu vết ở stderr
  }
}

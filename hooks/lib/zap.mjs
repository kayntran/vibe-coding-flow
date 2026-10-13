// zap: lõi cho hooks/zap-scan.mjs (SPEC AC-22). Quét THỤ ĐỘNG bản chạy ở máy (localhost) bằng OWASP ZAP 2.17 Automation Framework,
// KHÔNG Docker: `zap.bat|zap.sh -cmd -autorun <plan.yaml>` (Java 17+; zap-baseline.py cứng đường dẫn image Docker nên không dùng).
// Plan mẫu: kit/zap/baseline.plan.yaml. Mức chặn/cảnh báo + danh sách miễn do module này tính từ báo cáo traditional-json, không nhờ job exitStatus.
//
//   await scan({ target, reportDir?, ignoreFile?, …deps }) → { exit, status, lines, counts, findings, reportFile }
//       exit: 0 sạch (Low/Info không đổi mã) · 1 có lỗi mức cao HOẶC quét không chạy xong (không bao giờ báo sạch khi chưa quét được) ·
//             2 chỉ có lỗi mức vừa · 3 thiếu ZAP/Java 17+/app chưa chạy/target không phải localhost (kèm lệnh cài).
//       status: 'clean'|'warn'|'blocked'|'failed'|'missing'|'refused'. `lines` = câu đời thường để CLI in; lib không in.
//   Lõi thuần: parseTarget · javaMajor · findZap · checkTools · installHints · buildPlan · parseReport · loadIgnores · applyIgnores · judge
//   Chạy lệnh ngoài qua `run(file, args, opts) → {status, stdout, stderr, error}` (tiêm được; mặc định spawnSync mảng tham số).
//
// docs/security-ignore.json (lib sở hữu): [{ "rule": "10038" | "10038-1" | "<tên cảnh báo>", "url"?: "<tiền tố URL>", "reason": "<vì sao>", "until": "YYYY-MM-DD" }]
//   Mục dùng được khi có reason + until hợp lệ và hôm nay ≤ until (tính theo giờ máy). Hết hạn ⇒ lỗi tính lại + dòng nói rõ; mục sai ⇒ không áp dụng + dòng nói rõ.
//   File hỏng ⇒ không miễn mục nào (an toàn hơn là nuốt lỗi) + dòng nói rõ.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']
export const DEFAULT_IGNORE_FILE = 'docs/security-ignore.json'
export const REPORT_BASE = 'zap-report' // ZAP có thể thêm đuôi (.json) hoặc không ⇒ tìm theo tiền tố
export const MIN_JAVA = 17
export const ZAP_TIMEOUT_MS = 15 * 60 * 1000
export const TEMPLATE_FILE = fileURLToPath(new URL('../../kit/zap/baseline.plan.yaml', import.meta.url))
const MAX_LISTED = 8
const RISK = { 3: 'high', 2: 'medium', 1: 'low', 0: 'info' }

// ---------- target: chỉ localhost ----------

// URL.hostname đã chuẩn hoá (127.1 → 127.0.0.1) ⇒ đưa cho ZAP đúng bản đã chuẩn hoá, không để hai bộ đọc URL hiểu khác nhau.
export function parseTarget(t) {
  if (typeof t !== 'string' || !t.trim()) return { ok: false, reason: 'thiếu địa chỉ cần quét (-t http://localhost:<cổng>)' }
  let u
  try { u = new URL(t.trim()) } catch { return { ok: false, reason: `"${clean(t)}" không phải địa chỉ http(s)://localhost:<cổng>` } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `"${clean(t)}" không phải địa chỉ http(s)` }
  if (u.username || u.password) return { ok: false, reason: 'địa chỉ có tên đăng nhập/mật khẩu' }
  if (!LOCAL_HOSTS.includes(u.hostname)) return { ok: false, reason: `"${u.hostname}" không phải máy này` }
  return { ok: true, url: u.href, origin: u.origin }
}

// ---------- công cụ: ZAP + Java ----------

const isFileDefault = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const pathMod = (platform) => (platform === 'win32' ? path.win32 : path.posix)
const zapNames = (platform) => (platform === 'win32' ? ['zap.bat'] : ['zap.sh', 'zaproxy'])

// ZAP_PATH (file zap.bat|zap.sh hoặc thư mục chứa nó) thắng và là DUY NHẤT nếu có đặt (sai ⇒ không tìm chỗ khác, để lỗi hiện rõ).
// Không đặt ⇒ PATH rồi các chỗ cài mặc định (winget ZAP.ZAP → Program Files\ZAP\Zed Attack Proxy; brew cask → /Applications/ZAP.app).
export function findZap({ platform = process.platform, env = process.env, isFile = isFileDefault } = {}) {
  const P = pathMod(platform)
  const names = zapNames(platform)
  const inDir = (d) => names.map((n) => P.join(d, n)).find(isFile) ?? null
  if (env.ZAP_PATH) return (isFile(env.ZAP_PATH) ? env.ZAP_PATH : null) ?? inDir(env.ZAP_PATH)
  const onPath = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const known = platform === 'win32'
    ? [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']
        .map((d) => P.join(d, 'ZAP', 'Zed Attack Proxy')).concat(env.LOCALAPPDATA ? [P.join(env.LOCALAPPDATA, 'Programs', 'ZAP', 'Zed Attack Proxy')] : [])
    : platform === 'darwin' ? ['/Applications/ZAP.app/Contents/Java'] : ['/usr/share/zaproxy', '/opt/zaproxy']
  for (const d of [...onPath, ...known]) { const f = inDir(d); if (f) return f }
  return null
}

// `java -version` in ra stderr: `openjdk version "17.0.9" …` · `java version "1.8.0_392"` · `openjdk 21 2023-09-19`.
export function javaMajor(text) {
  const m = /version\s+"([^"]+)"/i.exec(String(text)) ?? /^(?:openjdk|java)\s+(\d[\w.+-]*)/im.exec(String(text))
  if (!m) return null
  const parts = m[1].split(/[._+-]/)
  const n = parseInt(parts[0], 10) === 1 ? parseInt(parts[1], 10) : parseInt(parts[0], 10)
  return Number.isFinite(n) ? n : null
}

const listDirDefault = (d) => { try { return fs.readdirSync(d) } catch { return [] } }

// Vừa cài Java mà cửa sổ lệnh chưa mở lại ⇒ PATH cũ chưa có Java ⇒ dò thêm chỗ cài mặc định (bản mới nhất trước).
function knownJavaBins({ platform, env, listDir }) {
  const P = pathMod(platform)
  const exe = platform === 'win32' ? 'java.exe' : 'java'
  const roots = platform === 'win32'
    ? ['Eclipse Adoptium', 'Microsoft', 'Java', 'Zulu'].map((v) => P.join(env.ProgramFiles ?? 'C:\\Program Files', v))
    : platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines'] : ['/usr/lib/jvm']
  const sub = platform === 'darwin' ? ['Contents', 'Home', 'bin'] : ['bin']
  return roots.flatMap((r) => listDir(r).sort().reverse().map((d) => P.join(r, d, ...sub, exe)))
}

function probeJava({ platform, env, run, isFile, listDir }) {
  const home = env.JAVA_HOME ? [pathMod(platform).join(env.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java')] : []
  let first = null
  for (const bin of [...home, 'java', ...knownJavaBins({ platform, env, listDir }).filter(isFile)]) {
    const r = run(bin, ['-version'], { timeoutMs: 15_000, env, platform })
    const major = r.error ? null : javaMajor(`${r.stderr}\n${r.stdout}`)
    if (major >= MIN_JAVA) return { major, bin }
    first ??= major ? { major, bin } : null
  }
  return first
}

// Java tìm ở chỗ cài mặc định (không có trên PATH) ⇒ zap.bat|zap.sh gọi `java` trần nên phải thêm thư mục bin vào PATH của lệnh con.
function envWithJava(env, bin, platform) {
  if (!bin || bin === 'java') return env
  const P = pathMod(platform)
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) ?? 'PATH'
  return { ...env, JAVA_HOME: P.dirname(P.dirname(bin)), [key]: [P.dirname(bin), env[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':') }
}

// Lệnh cài theo máy. Windows mở lại cửa sổ lệnh sau khi cài vì PATH chỉ nạp lúc mở.
export function installHints(platform, { zap, java }) {
  const hints = []
  if (platform === 'win32') {
    if (java) hints.push('winget install -e --id EclipseAdoptium.Temurin.17.JRE')
    if (zap) hints.push('winget install -e --id ZAP.ZAP')
    hints.push('(cài xong mở lại cửa sổ lệnh rồi chạy lại)')
  } else if (platform === 'darwin') {
    if (zap) hints.push('brew install --cask zap   (đã kèm Java)')
    else if (java) hints.push('brew install --cask temurin@17')
  } else {
    if (java) hints.push('sudo apt install openjdk-17-jre   (hoặc gói Java 17 của bản Linux bạn dùng)')
    if (zap) hints.push('tải ZAP bản Linux tại https://www.zaproxy.org/download/ hoặc: snap install zaproxy --classic')
  }
  return hints
}

// macOS: ZAP.app kèm Java ⇒ không đòi Java hệ thống khi ZAP nằm trong .app (research.md §3).
export function checkTools({ platform = process.platform, env = process.env, isFile = isFileDefault, run = defaultRun, listDir = listDirDefault } = {}) {
  const zap = findZap({ platform, env, isFile })
  const bundled = platform === 'darwin' && !!zap && zap.includes('.app/')
  const found = bundled ? null : probeJava({ platform, env, run, isFile, listDir })
  const java = found?.major ?? null
  const needJava = !bundled && !(java >= MIN_JAVA)
  const missing = []
  if (!zap) missing.push(env.ZAP_PATH ? `ZAP (ZAP_PATH="${clean(env.ZAP_PATH)}" không có zap.bat|zap.sh)` : 'ZAP')
  if (needJava) missing.push(java ? `Java ${MIN_JAVA}+ (máy có Java ${java})` : `Java ${MIN_JAVA}+`)
  return { ok: !missing.length, zap, java, missing, hints: missing.length ? installHints(platform, { zap: !zap, java: needJava }) : [], runEnv: envWithJava(env, needJava ? null : found?.bin, platform) }
}

// ---------- chạy lệnh ngoài ----------

// Windows .bat/.cmd: Node không cho spawn thẳng (EINVAL) ⇒ cmd.exe /d /s /c "<đường dẫn nháy kép> <đối số nháy kép>". Chỉ dựng từ file + đối số
// do mã này sinh; ký tự " % ! ⇒ từ chối. Thuần (không chạy) để test.
export function buildInvocation(file, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(file)) {
    if ([file, ...args].some((a) => /["%!]/.test(a))) return { error: Object.assign(new Error('đường dẫn/đối số có ký tự " % ! không an toàn để chạy qua cmd.exe'), { code: 'EUNSAFE' }) }
    const q = (a) => (/^[\w.:\\/=-]+$/.test(a) ? a : `"${a}"`) // cờ như -cmd để trần; đường dẫn có dấu cách/chữ Việt ⇒ nháy kép
    return { cmd: env.ComSpec || env.COMSPEC || 'cmd.exe', argv: ['/d', '/s', '/c', `"${[`"${file}"`, ...args.map(q)].join(' ')}"`], verbatim: true }
  }
  return { cmd: file, argv: args, verbatim: false }
}

// Không bao giờ ném. Hết giờ ⇒ error.code === 'ETIMEDOUT' (Windows: chỉ diệt được cmd.exe/zap.bat, Java con có thể còn chạy nốt).
export function defaultRun(file, args = [], { timeoutMs = 20_000, env = process.env, platform = process.platform, cwd } = {}) {
  const inv = buildInvocation(file, args, { platform, env })
  if (inv.error) return { status: null, stdout: '', stderr: '', error: inv.error }
  const r = spawnSync(inv.cmd, inv.argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: inv.verbatim })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null }
}

// App phải đang chạy: spider vào địa chỉ chết ⇒ báo cáo rỗng ⇒ "sạch" giả. Mọi phản hồi HTTP (kể cả 404/500) = đang chạy; lỗi chứng chỉ (https tự ký) = đang chạy.
export async function probeTarget(url, { fetch = globalThis.fetch, timeoutMs = 5000 } = {}) {
  try {
    await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true }
  } catch (e) {
    const code = e?.cause?.code ?? (typeof e?.code === 'string' ? e.code : undefined) ?? e?.name ?? 'lỗi lạ'
    return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(String(code)) ? { ok: true } : { ok: false, detail: String(code) }
  }
}

// ---------- plan ----------

// Chuỗi YAML nháy kép chỉ gồm ASCII (non-ASCII → \uXXXX): Java 17 trên Windows đọc file theo bảng mã máy, đường dẫn có chữ Việt sẽ vỡ nếu để nguyên.
export function yamlStr(s) {
  let out = ''
  for (const ch of JSON.stringify(String(s)).slice(1, -1)) {
    const cp = ch.codePointAt(0)
    out += cp < 0x7f ? ch : cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\U${cp.toString(16).padStart(8, '0')}`
  }
  return `"${out}"`
}

const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bỏ chú thích YAML (chỉ cắt `#` nằm ngoài chuỗi nháy kép) ⇒ plan đưa cho ZAP thuần ASCII, không phụ thuộc bảng mã mặc định của Java.
export function stripYamlComments(yaml) {
  return yaml.split(/\r?\n/).map((line) => {
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      if (quoted && line[i] === '\\') i++
      else if (line[i] === '"') quoted = !quoted
      else if (line[i] === '#' && !quoted && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
    }
    return line
  }).filter((line) => line.trim()).join('\n')
}

// template có 4 chỗ "__TARGET__" "__INCLUDE__" "__REPORT_DIR__" "__REPORT_FILE__"; thiếu chỗ nào ⇒ ném (plan không có phạm vi thì không được chạy).
export function buildPlan(template, { target, reportDir, reportFile }) {
  const vals = { __TARGET__: target.url, __INCLUDE__: `${regexEscape(target.origin)}.*`, __REPORT_DIR__: reportDir, __REPORT_FILE__: reportFile }
  let plan = stripYamlComments(template)
  for (const [k, v] of Object.entries(vals)) {
    if (!plan.includes(`"${k}"`)) throw new Error(`mẫu plan thiếu chỗ "${k}"`)
    plan = plan.split(`"${k}"`).join(yamlStr(v))
  }
  return plan
}

// ---------- báo cáo ZAP ----------

export class ReportError extends Error {}

// traditional-json: { site: [{ "@name", alerts: [{ pluginid, alertRef, name, riskcode:"3", riskdesc, instances:[{uri}], count, solution }] }] }
export function parseReport(text) {
  let j
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch { throw new ReportError('báo cáo ZAP không phải JSON hợp lệ') }
  if (!j || !Array.isArray(j.site)) throw new ReportError('báo cáo ZAP thiếu danh sách "site"')
  if (!j.site.length) throw new ReportError('báo cáo ZAP không có trang nào (ZAP chưa thấy app)')
  const alerts = []
  for (const s of j.site) {
    for (const a of Array.isArray(s?.alerts) ? s.alerts : []) {
      const code = a.riskcode == null || a.riskcode === '' ? NaN : Number(a.riskcode)
      const risk = RISK[Number.isInteger(code) ? code : NaN] ?? riskFromDesc(a.riskdesc)
      if (!risk) throw new ReportError(`báo cáo ZAP có mức rủi ro lạ ("${clean(a.riskcode ?? a.riskdesc)}") ở "${clean(a.name ?? a.alert)}"`)
      const instances = (Array.isArray(a.instances) ? a.instances : []).map((i) => ({ uri: String(i?.uri ?? '') }))
      alerts.push({ pluginid: String(a.pluginid ?? ''), alertRef: String(a.alertRef ?? ''), name: clean(a.name ?? a.alert ?? `rule ${a.pluginid}`), risk, instances, count: instances.length || Number(a.count) || 1, solution: htmlText(a.solution), site: String(s['@name'] ?? '') })
    }
  }
  return { sites: j.site.length, alerts }
}

function riskFromDesc(d) {
  const m = /^\s*(high|medium|low|informational|info)/i.exec(String(d ?? ''))
  return m ? { high: 'high', medium: 'medium', low: 'low', informational: 'info', info: 'info' }[m[1].toLowerCase()] : null
}

// ---------- danh sách miễn ----------

const pad = (n) => String(n).padStart(2, '0')
export const localDate = (now) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const validDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

// Phân mục: active (còn hạn) · expired (qua hạn ⇒ tính lại) · invalid (thiếu rule/reason, until sai ⇒ không áp dụng). Hạn tính hết ngày `until`.
export function classifyIgnores(list, now = new Date()) {
  const today = localDate(now)
  const r = { active: [], expired: [], invalid: [] }
  list.forEach((e, i) => {
    const rule = e && typeof e.rule !== 'object' ? String(e.rule ?? '').trim() : ''
    const reason = typeof e?.reason === 'string' ? e.reason.trim() : ''
    const until = typeof e?.until === 'string' ? e.until.trim() : ''
    const why = !rule ? 'thiếu rule' : !reason ? 'thiếu reason (lý do)' : !validDate(until) ? 'until phải là ngày YYYY-MM-DD' : e.url !== undefined && typeof e.url !== 'string' ? 'url phải là chuỗi' : null
    if (why) return r.invalid.push({ index: i + 1, why })
    const entry = { rule, url: e.url || undefined, reason, until }
    ;(until >= today ? r.active : r.expired).push(entry)
  })
  return r
}

// File không có ⇒ rỗng không lỗi. Đọc/parse hỏng ⇒ không miễn mục nào + `problem` để báo ra.
export function loadIgnores(file, now = new Date()) {
  const none = { active: [], expired: [], invalid: [] }
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return e.code === 'ENOENT' ? none : { ...none, problem: `không đọc được (${e.code ?? e.message})` } }
  let list
  try { list = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return { ...none, problem: 'không phải JSON hợp lệ' } }
  if (!Array.isArray(list)) return { ...none, problem: 'phải là mảng [{rule, reason, until}]' }
  return classifyIgnores(list, now)
}

const ruleHit = (e, a) => [a.pluginid, a.alertRef, a.name].some((v) => v && v.toLowerCase() === e.rule.toLowerCase())

// → { kept: cảnh báo còn tính (mục hết hạn gắn `expired`), ignored: [{ name, rule, until, reason, count }] }. Mục có url ⇒ chỉ bỏ các chỗ (instance) có URL bắt đầu bằng url.
export function applyIgnores(alerts, ig) {
  const kept = []
  const ignored = []
  for (const a of alerts) {
    const act = ig.active.filter((e) => ruleHit(e, a))
    const whole = act.find((e) => !e.url)
    if (whole) { ignored.push({ name: a.name, rule: whole.rule, until: whole.until, reason: whole.reason, count: a.count }); continue }
    const urlHits = act.filter((e) => e.url)
    const rest = a.instances.filter((i) => !urlHits.some((e) => i.uri.startsWith(e.url)))
    const gone = a.instances.length - rest.length
    if (gone && !rest.length) { ignored.push({ name: a.name, rule: urlHits[0].rule, until: urlHits[0].until, reason: urlHits[0].reason, count: gone }); continue }
    if (gone) ignored.push({ name: a.name, rule: urlHits[0].rule, until: urlHits[0].until, reason: urlHits[0].reason, count: gone })
    const left = gone ? { ...a, instances: rest, count: rest.length } : a
    const expired = ig.expired.find((e) => ruleHit(e, a) && (!e.url || left.instances.some((i) => i.uri.startsWith(e.url))))
    kept.push(expired ? { ...left, expired } : left)
  }
  return { kept, ignored }
}

export function judge(alerts) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const a of alerts) counts[a.risk]++
  return { exit: counts.high ? 1 : counts.medium ? 2 : 0, counts }
}

// ---------- chữ cho người ----------

// Chữ từ trang/ZAP có thể mang ký tự điều khiển (mã thoát terminal) ⇒ bỏ hết trước khi in.
function clean(s) { return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() }
function htmlText(s) {
  return clean(String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))
}
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Lời sửa tiếng Việt (một câu) cho cảnh báo ZAP hay gặp. Khớp pluginid trước, rồi tên cảnh báo (bản ZAP khác có thể đổi số).
// Không có trong bảng ⇒ fixVi trả null ⇒ findingLine in lời tiếng Anh của ZAP (cắt 140 chữ như trước).
const FIX_VI = [
  { ids: ['10038'], name: /content security policy.*not set/i, fix: 'Thêm tiêu đề Content-Security-Policy để trình duyệt chỉ chạy script từ nguồn bạn cho phép.' },
  { ids: ['10020'], name: /anti-clickjacking|x-frame-options/i, fix: 'Thêm tiêu đề X-Frame-Options (hoặc frame-ancestors trong CSP) để trang không bị nhúng vào trang lạ rồi lừa bấm nhầm.' },
  { ids: ['10202'], name: /anti-csrf/i, fix: 'Gắn mã chống giả mạo (CSRF token) vào các form để trang lạ không gửi thay người dùng được.' },
  { ids: ['10010'], name: /cookie.*httponly/i, fix: 'Đặt cờ HttpOnly cho cookie để script trên trang không đọc trộm được phiên đăng nhập.' },
  { ids: ['10011'], name: /cookie.*secure flag/i, fix: 'Đặt cờ Secure cho cookie để nó chỉ được gửi qua kết nối https.' },
  { ids: ['10054'], name: /cookie.*samesite/i, fix: 'Đặt SameSite=Lax (hoặc Strict) cho cookie để trang lạ không dùng nhờ phiên của người dùng.' },
  { ids: ['10021'], name: /x-content-type-options/i, fix: 'Thêm tiêu đề X-Content-Type-Options: nosniff để trình duyệt không tự đoán sai loại file.' },
  { ids: ['10035'], name: /strict-transport-security/i, fix: 'Đặt đúng tiêu đề Strict-Transport-Security để trình duyệt luôn vào trang bằng https.' },
  { ids: ['10036', '10037', '10061'], name: /server leaks|x-powered-by|x-aspnet-version/i, fix: 'Tắt hoặc giấu các tiêu đề Server / X-Powered-By để kẻ xấu không biết bạn dùng phần mềm bản nào.' },
  { ids: ['90022', '10023'], name: /application error disclosure|debug error messages/i, fix: 'Chỉ hiện thông báo lỗi chung chung cho người dùng, chi tiết lỗi ghi vào nhật ký trên máy chủ.' },
]

export function fixVi(a) {
  const id = String(a?.pluginid ?? '')
  const name = String(a?.name ?? '')
  return (FIX_VI.find((e) => e.ids.includes(id)) ?? FIX_VI.find((e) => e.name.test(name)))?.fix ?? null
}

function findingLine(a) {
  const sample = a.instances[0]?.uri ? `, vd ${cut(clean(a.instances[0].uri), 80)}` : ''
  const fixText = fixVi(a) ?? (a.solution ? cut(a.solution, 140) : '')
  const fix = fixText ? `. Sửa: ${fixText}` : ''
  const exp = a.expired ? ` (đã miễn đến ${a.expired.until} nhưng hết hạn nên tính lại)` : ''
  return `  - ${a.name} — ${a.count} chỗ${sample}${fix}${exp}`
}

function section(head, list) {
  const lines = [head, ...list.slice(0, MAX_LISTED).map(findingLine)]
  if (list.length > MAX_LISTED) lines.push(`  …và ${list.length - MAX_LISTED} lỗi khác (xem báo cáo đầy đủ)`)
  return lines
}

const tailOf = (r) => `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split(/\r?\n/).map(clean).filter(Boolean).slice(-6).map((l) => `  ${cut(l, 200)}`)

// ---------- chạy một lượt quét ----------

const done = (exit, status, lines, extra = {}) => ({ exit, status, lines, counts: null, findings: [], reportFile: null, ...extra })

export async function scan({
  target, reportDir, ignoreFile = path.resolve(DEFAULT_IGNORE_FILE), now = new Date(), timeoutMs = ZAP_TIMEOUT_MS,
  platform = process.platform, env = process.env, isFile = isFileDefault, run = defaultRun, probe = probeTarget,
  tmpdir = os.tmpdir(), templateFile = TEMPLATE_FILE, listDir = listDirDefault,
} = {}) {
  const t = parseTarget(target)
  if (!t.ok) return done(3, 'refused', [`zap-scan từ chối: ${t.reason}. Chỉ quét bản chạy ở máy này: http(s)://localhost|127.0.0.1|[::1]:<cổng>.`])

  const tools = checkTools({ platform, env, isFile, run, listDir })
  if (!tools.ok) return done(3, 'missing', [`Chưa quét được: thiếu ${tools.missing.join(', ')}.`, ...(tools.hints.length ? ['Cài bằng:', ...tools.hints.map((h) => `  ${h}`)] : [])])

  const up = await probe(t.url)
  if (!up.ok) return done(3, 'missing', [`Chưa quét được: app chưa chạy ở ${t.origin} (${clean(up.detail)}). Bật app (dev/preview) rồi quét lại.`])

  let planDir = null
  let outDir
  try {
    outDir = path.resolve(reportDir ?? fs.mkdtempSync(path.join(tmpdir, 'zap-report-')))
    fs.mkdirSync(outDir, { recursive: true })
    for (const f of fs.readdirSync(outDir)) { // báo cáo cũ cùng tiền tố ⇒ xoá, kẻo đọc nhầm kết quả lần trước khi lần này hỏng
      const p = path.join(outDir, f)
      if (f.startsWith(REPORT_BASE) && isFileDefault(p)) fs.rmSync(p, { force: true })
    }
    planDir = fs.mkdtempSync(path.join(tmpdir, 'zap-plan-'))
    const planFile = path.join(planDir, 'plan.yaml')
    fs.writeFileSync(planFile, buildPlan(fs.readFileSync(templateFile, 'utf8'), { target: t, reportDir: outDir, reportFile: REPORT_BASE }), 'utf8')

    // zap.bat gọi `-jar zap-<bản>.jar` theo đường tương đối ⇒ phải chạy trong thư mục cài ZAP
    const r = run(tools.zap, ['-cmd', '-autorun', planFile], { timeoutMs, env: tools.runEnv, platform, cwd: pathMod(platform).dirname(tools.zap) })
    if (r.error?.code === 'ENOENT') return done(3, 'missing', [`Chưa quét được: không chạy được ${clean(tools.zap)} (không tìm thấy file).`])
    if (r.error?.code === 'ETIMEDOUT') return done(1, 'failed', [`Quét không chạy xong: ZAP chạy quá ${Math.round(timeoutMs / 60000)} phút nên bị dừng. Không coi là sạch.`])
    if (r.error) return done(1, 'failed', [`Quét không chạy xong: không chạy được ZAP (${clean(r.error.message)}). Không coi là sạch.`])
    if (r.status !== 0) return done(1, 'failed', [`Quét không chạy xong: ZAP thoát mã ${r.status}. Không coi là sạch — sửa lỗi rồi quét lại.`, ...tailOf(r)])

    const found = fs.readdirSync(outDir).filter((f) => f.startsWith(REPORT_BASE)).map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    if (!found) return done(1, 'failed', [`Quét không chạy xong: ZAP không ghi báo cáo JSON vào ${outDir}. Không coi là sạch.`])
    let report
    try { report = parseReport(fs.readFileSync(found, 'utf8')) } catch (e) {
      if (!(e instanceof ReportError)) throw e
      return done(1, 'failed', [`Quét không chạy xong: ${e.message} (${found}). Không coi là sạch.`], { reportFile: found })
    }

    const ig = loadIgnores(ignoreFile, now)
    const { kept, ignored } = applyIgnores(report.alerts, ig)
    const { exit, counts } = judge(kept)
    const high = kept.filter((a) => a.risk === 'high')
    const medium = kept.filter((a) => a.risk === 'medium')
    const lines = []
    if (high.length) lines.push(...section(`CHẶN phát hành: ${high.length} lỗi mức cao ở ${t.origin}.`, high))
    if (medium.length) lines.push(...section(`Cảnh báo (không chặn): ${medium.length} lỗi mức vừa ở ${t.origin}.`, medium))
    if (!exit) lines.push(`Sạch: không thấy lỗi mức cao hay vừa ở ${t.origin}.`)
    lines.push(`Mức thấp: ${counts.low} · thông tin: ${counts.info} (không đổi kết quả).`)
    if (ig.problem) lines.push(`${DEFAULT_IGNORE_FILE} ${ig.problem} — không miễn mục nào.`)
    for (const bad of ig.invalid) lines.push(`Mục miễn #${bad.index} không dùng được: ${bad.why}.`)
    if (ignored.length) {
      lines.push(`Đã miễn ${ignored.reduce((n, i) => n + i.count, 0)} chỗ theo ${DEFAULT_IGNORE_FILE}:`)
      for (const i of ignored.slice(0, MAX_LISTED)) lines.push(`  - ${i.name} (rule ${i.rule}, đến ${i.until}) — ${cut(clean(i.reason), 100)}`)
    }
    lines.push(`Báo cáo đầy đủ: ${found}`)
    const findings = kept.filter((a) => a.risk === 'high' || a.risk === 'medium').map((a) => ({ name: a.name, risk: a.risk, count: a.count, rule: a.pluginid }))
    return { exit, status: exit === 1 ? 'blocked' : exit === 2 ? 'warn' : 'clean', lines, counts: { ...counts, ignored: ignored.length }, findings, reportFile: found }
  } catch (e) {
    return done(1, 'failed', [`Quét không chạy xong: ${clean(e.message)}. Không coi là sạch.`])
  } finally {
    if (planDir) fs.rmSync(planDir, { recursive: true, force: true })
  }
}

// app-safety: mẫu an toàn cho web và extension (AC-29). Đọc file cấu hình trong dự án, báo chỗ thiếu bằng lời đời thường + cách sửa.
//
// Hàm xuất cho flow-check (checker `web-headers`, mở rộng `mv3-manifest`); cả hai KHÔNG sửa file, KHÔNG chạy lệnh ngoài:
//   headerProblems(dir) → [{ file, msg, fix }]        web: PHẢI có file cấu hình header ở chỗ đã biết, MỖI file tự đủ 4 thứ (báo theo từng file, không gộp giữa các nền):
//       Content-Security-Policy · X-Content-Type-Options: nosniff · Referrer-Policy · chống nhúng (CSP frame-ancestors hoặc X-Frame-Options).
//       Chống nhúng chỉ nhận frame-ancestors không rỗng và không có nguồn mọi nơi (* · http: · https: · https://* · *://*), hoặc X-Frame-Options DENY|SAMEORIGIN.
//       CSP có 'unsafe-eval' hoặc script-src / script-src-elem / script-src-attr cho mọi nguồn ⇒ báo. Meta CSP trong index.html KHÔNG thay được (không có frame-ancestors).
//       Chỗ đã biết: public/_headers, _headers, static/_headers (Cloudflare/Netlify) · vercel.json · netlify.toml · *.conf nginx · Caddyfile.
//       _headers / vercel.json / netlify.toml chỉ tính phần áp cho cả site (/*); nginx/Caddy tính mọi add_header / header.
//       _headers luôn bị xét; vercel.json / netlify.toml / *.conf / Caddyfile chỉ khi có khai header đang theo dõi (netlify.toml chỉ [build] không tính là một nền).
//   extensionPermProblems(dir) → [{ file, msg, fix }]  extension: host_permissions rộng (mọi trang) ⇒ báo, kèm dặn chuyển sang optional_host_permissions.
//       Đọc mọi manifest.json ở chỗ đã biết VÀ luôn đọc host_permissions trong wxt.config.* (WXT sinh manifest lúc build; manifest cũ không che cấu hình mới).
import fs from 'node:fs'
import path from 'node:path'

// --- tiện ích nhỏ -------------------------------------------------------------------------------------------------------------------

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`)
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').replace(BOM, '') } catch { return null } }
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const at = (dir, rel) => path.join(dir, ...rel.split('/'))
const asArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// --- web: header bảo mật ------------------------------------------------------------------------------------------------------------

const CSP = 'content-security-policy'
const NOSNIFF = 'x-content-type-options'
const REFERRER = 'referrer-policy'
const XFO = 'x-frame-options'
const WATCHED = new Set([CSP, NOSNIFF, REFERRER, XFO])
const SAMPLE_FILE = 'public/_headers'

const HEADER_FILES = ['public/_headers', '_headers', 'static/_headers', 'vercel.json', 'netlify.toml']
const SERVER_DIRS = ['', 'nginx', 'deploy', 'docker', 'config', 'conf', 'infra']
const GLOBAL_PATH = /^(?:\/\*|\/\*\*|\*|\/\(\.\*\)\*?|\/:[A-Za-z]+\*|\/:[A-Za-z]+\(\.\*\))$/

const isGlobal = (p) => GLOBAL_PATH.test(String(p).trim())
const keep = (list, name, value) => { const n = String(name).trim().toLowerCase(); if (WATCHED.has(n)) list.push({ name: n, value: String(value ?? '').trim() }) }

// Cloudflare/Netlify `_headers`: dòng không thụt = mẫu đường dẫn; dòng thụt `Tên: giá trị`.
function parseHeadersFile(text) {
  const out = []
  let global = false
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) { global = isGlobal(raw); continue }
    const m = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(raw)
    if (m && global) keep(out, m[1], m[2])
  }
  return out
}

function parseVercel(text) {
  let json
  try { json = JSON.parse(text) } catch { return [] }
  const out = []
  for (const rule of Array.isArray(json?.headers) ? json.headers : []) {
    if (!isGlobal(rule?.source)) continue
    for (const h of Array.isArray(rule.headers) ? rule.headers : []) keep(out, h?.key, h?.value)
  }
  return out
}

// netlify.toml: [[headers]] for = "/*" ... [headers.values] Tên = "giá trị" (đọc từng dòng, không cần thư viện TOML).
function parseNetlify(text) {
  const out = []
  let inBlock = false
  let global = false
  let inValues = false
  const unq = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[\[headers\]\]$/.test(line)) { inBlock = true; global = false; inValues = false; continue }
    if (/^\[headers\.values\]$/.test(line)) { inValues = inBlock; continue }
    if (/^\[/.test(line)) { inBlock = false; inValues = false; continue }
    const kv = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv || !inBlock) continue
    if (!inValues && unq(kv[1]) === 'for') global = isGlobal(unq(kv[2]))
    else if (inValues && global) keep(out, unq(kv[1]), unq(kv[2]))
  }
  return out
}

// nginx: add_header Tên "giá trị" [always];   Caddy: `header Tên "giá trị"` hoặc dòng `Tên "giá trị"` trong khối header { }.
function parseServerConf(text) {
  const out = []
  const clean = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n')
  for (const m of clean.matchAll(/\badd_header\s+([\w-]+)\s+("[^"]*"|'[^']*'|[^;]+?)\s*(?:always\s*)?;/gi)) keep(out, m[1], m[2].replace(/^(["'])(.*)\1$/, '$2'))
  for (const m of clean.matchAll(/^[ \t]*(?:header\s+)?[+?]?([A-Za-z][\w-]*)[ \t]+("[^"\n]*"|[^\n]+)$/gim)) keep(out, m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2'))
  return out
}

// File cấu hình header có thật trong dự án → [{ file, headers, pure }]. pure = file sinh ra chỉ để khai header (`_headers`): luôn bị xét dù rỗng.
// File đa năng (vercel.json, netlify.toml, *.conf, Caddyfile) chỉ bị xét khi có khai ít nhất một header đang theo dõi (xem headerProblems).
function headerSources(dir) {
  const found = []
  const add = (rel, parse, pure) => { const t = readText(at(dir, rel)); if (t !== null) found.push({ file: rel, headers: parse(t), pure }) }
  for (const rel of HEADER_FILES) {
    if (!isFile(at(dir, rel))) continue
    const vercel = rel.endsWith('vercel.json')
    const netlify = rel.endsWith('netlify.toml')
    add(rel, vercel ? parseVercel : netlify ? parseNetlify : parseHeadersFile, !vercel && !netlify)
  }
  for (const d of SERVER_DIRS) {
    for (const e of readDir(d ? at(dir, d) : dir)) {
      if (e.isFile() && /(?:\.conf|^Caddyfile)$/i.test(e.name)) add(d ? `${d}/${e.name}` : e.name, parseServerConf, false)
    }
  }
  return found
}

// CSP → { directive → [nguồn] }
function cspDirectives(policy) {
  const map = {}
  for (const part of policy.split(';')) {
    const [name, ...src] = part.trim().split(/\s+/)
    if (name) map[name.toLowerCase()] = src
  }
  return map
}

// Nguồn "cho mọi nơi": `*`, `http:`, `https:` trơn, và `http://*`, `https://*`, `*://*` (kể cả `:*` cổng, `/` cuối). `https://*.example.com` thì không.
const ANYWHERE = /^(?:\*|https?:|(?:\*|https?):\/\/\*(?::\*)?\/?)$/i
const isAnywhere = (s) => ANYWHERE.test(s)
const SCRIPT_DIRECTIVES = ['script-src-elem', 'script-src-attr']

// Một file cấu hình header phải tự đủ 4 thứ và không mở toang; mỗi file được báo riêng (mỗi nền triển khai đọc file của nó, không gộp).
function fileProblems({ file, headers }) {
  const of = (name) => headers.filter((h) => h.name === name)
  const out = []
  const csps = of(CSP)
  if (!csps.length) {
    out.push({ file, msg: 'Thiếu header Content-Security-Policy: trình duyệt không bị dặn chỉ chạy mã từ nguồn tin cậy, nên mã lạ chèn vào trang có thể chạy.', fix: `Thêm dòng Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none' vào mục /* của ${file}.` })
  }
  if (!of(NOSNIFF).some((h) => /\bnosniff\b/i.test(h.value))) {
    out.push({ file, msg: 'Thiếu header X-Content-Type-Options: nosniff: trình duyệt có thể đoán nhầm file người dùng tải lên là mã chạy được.', fix: `Thêm dòng X-Content-Type-Options: nosniff vào mục /* của ${file}.` })
  }
  if (!of(REFERRER).some((h) => h.value)) {
    out.push({ file, msg: 'Thiếu header Referrer-Policy: địa chỉ trang người dùng đang xem (có thể chứa mã, id) bị gửi sang web khác khi bấm link ra ngoài.', fix: `Thêm dòng Referrer-Policy: strict-origin-when-cross-origin vào mục /* của ${file}.` })
  }
  // Chống nhúng: CSP có frame-ancestors thì trình duyệt theo nó (X-Frame-Options bị bỏ qua); chỉ nhận danh sách không rỗng và không có nguồn "mọi nơi". Không thì X-Frame-Options DENY|SAMEORIGIN.
  const ancestors = csps.map((h) => cspDirectives(h.value)['frame-ancestors']).filter(Boolean)
  const framed = ancestors.length
    ? ancestors.some((a) => a.length > 0 && !a.some(isAnywhere))
    : of(XFO).some((h) => /^(?:deny|sameorigin)$/i.test(h.value.trim()))
  if (!framed) {
    const weak = ancestors.length ? `frame-ancestors ${ancestors[0].join(' ')}`.trim() : of(XFO).length ? `X-Frame-Options: ${of(XFO)[0].value}`.trim() : null
    out.push(weak
      ? { file, msg: `Có khai chống nhúng nhưng chưa chặn gì (${weak}): web nào cũng nhúng được trang này vào khung ẩn để lừa người dùng bấm.`, fix: `Đổi thành frame-ancestors 'none' (hoặc 'self') trong Content-Security-Policy, hoặc dòng X-Frame-Options: DENY (hoặc SAMEORIGIN), trong mục /* của ${file}.` }
      : { file, msg: 'Thiếu chống nhúng (frame-ancestors trong Content-Security-Policy hoặc X-Frame-Options): web khác có thể nhúng trang này vào khung ẩn để lừa người dùng bấm.', fix: `Thêm frame-ancestors 'none' vào Content-Security-Policy, hoặc dòng X-Frame-Options: DENY, trong mục /* của ${file}.` })
  }
  for (const h of csps) {
    const dirs = cspDirectives(h.value)
    if (/'unsafe-eval'/i.test(h.value)) {
      out.push({ file, msg: "Content-Security-Policy có 'unsafe-eval': cho phép chạy mã sinh từ chuỗi, mở đường cho mã lạ chạy trong trang.", fix: `Bỏ 'unsafe-eval' khỏi Content-Security-Policy trong ${file}; sửa thư viện cần eval thay vì mở CSP.` })
    }
    // script-src (hoặc default-src khi không có) và, nếu khai riêng, script-src-elem / script-src-attr: nguồn nào cũng chạy được thì CSP vô tác dụng.
    const checks = [['script-src', dirs['script-src'] ?? dirs['default-src'] ?? []], ...SCRIPT_DIRECTIVES.filter((n) => n in dirs).map((n) => [n, dirs[n]])]
    for (const [name, list] of checks) {
      const wide = list.find(isAnywhere)
      if (wide) out.push({ file, msg: `Content-Security-Policy cho tải mã từ mọi nguồn (${name} ${wide}): chặn mã lạ gần như vô tác dụng.`, fix: `Đổi ${name} trong ${file} thành 'self' cộng đúng các tên miền cần dùng.` })
    }
  }
  return out
}

export function headerProblems(dir) {
  const sources = headerSources(dir)
  if (!sources.length) {
    return [{
      file: SAMPLE_FILE,
      msg: 'Chưa có file cấu hình header bảo mật (public/_headers, vercel.json, netlify.toml hay cấu hình nginx/Caddy). Thiếu nó, trình duyệt không được dặn chặn mã lạ, chặn nhúng trang vào web khác hay chặn đoán nhầm kiểu file.',
      fix: `Tạo ${SAMPLE_FILE} với mục /* gồm Content-Security-Policy, X-Content-Type-Options: nosniff, Referrer-Policy, và frame-ancestors 'none' (hoặc X-Frame-Options: DENY). Thẻ meta CSP trong index.html không thay được.`,
    }]
  }
  // File đa năng không khai header nào (netlify.toml chỉ có [build], redis.conf…) không phải "một nền thiếu header"; không file nào khai thì xét file đầu để báo thiếu đủ 4.
  const judged = sources.filter((s) => s.pure || s.headers.length)
  return (judged.length ? judged : [sources[0]]).flatMap(fileProblems)
}

// --- extension: quyền host rộng -----------------------------------------------------------------------------------------------------

const MANIFEST_FILES = ['manifest.json', 'public/manifest.json', 'src/manifest.json', 'extension/manifest.json', '.output/chrome-mv3/manifest.json', 'dist/manifest.json', 'build/manifest.json']
const WXT_CONFIGS = ['wxt.config.ts', 'wxt.config.js', 'wxt.config.mjs', 'wxt.config.mts']

// Mẫu host phủ mọi (hoặc gần mọi) trang: <all_urls>, host là `*`, hoặc `*.<một nhãn>` như *.com.
export function isBroadHost(pattern) {
  const p = String(pattern).trim()
  if (p === '<all_urls>') return true
  const m = /^(?:\*|https?|ftp|file|wss?):\/\/([^/]*)/i.exec(p)
  if (!m) return false
  return m[1] === '*' || /^\*\.[a-z0-9-]+$/i.test(m[1]) || m[1] === '*.*'
}

const broadProblem = (file, pattern) => ({
  file,
  msg: `host_permissions xin quyền đọc/sửa mọi trang (${pattern}): người dùng thấy cảnh báo "đọc dữ liệu của bạn trên mọi web" ngay lúc cài, và nếu extension bị chiếm thì lộ hết.`,
  fix: `Bỏ ${pattern} khỏi host_permissions; dùng activeTab (quyền tạm cho tab người dùng vừa bấm) hoặc chuyển sang optional_host_permissions để xin khi cần, hoặc ghi đúng các trang cần dùng.`,
})

export function extensionPermProblems(dir) {
  const out = []
  for (const rel of MANIFEST_FILES) {
    const text = readText(at(dir, rel))
    if (text === null) continue
    let manifest
    try { manifest = JSON.parse(text) } catch { continue }
    if (!manifest || typeof manifest !== 'object' || manifest.manifest_version === undefined) continue
    for (const p of asArr(manifest.host_permissions)) if (isBroadHost(p)) out.push(broadProblem(rel, p))
  }
  // WXT khai manifest trong wxt.config.* — lấy mảng host_permissions: [ ... ] đầu tiên. Luôn đọc, kể cả khi đã có manifest: manifest build cũ không được che quyền rộng mới khai trong cấu hình chưa build.
  for (const rel of WXT_CONFIGS) {
    const text = readText(at(dir, rel))
    const m = text && /\bhost_permissions\s*:\s*\[([^\]]*)\]/.exec(text)
    if (!m) continue
    for (const s of m[1].matchAll(/(["'`])((?:(?!\1).)*)\1/g)) if (isBroadHost(s[2])) out.push(broadProblem(rel, s[2]))
  }
  return out
}

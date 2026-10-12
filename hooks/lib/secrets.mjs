// secrets: MỘT nơi duy nhất biết "cái gì là secret" cho cả kit — cổng commit/push (flow-gate), máy kiểm bản build (flow-check),
// gửi review cho model ngoài (review-ext), nhắc khi mở phiên (session-start), cài đặt (install). Spec: docs/specs/2026-10-11-flow-v7-nocode (AC-11, AC-28).
//
// Gốc: SECRET_PATTERNS / KNOWN_FALSE_POSITIVES / isSensitiveFile / scanLine / scanPatch chép từ hooks/flow-gate.mjs (hành vi giữ nguyên;
// flow-gate sẽ chuyển sang import thư viện này ở làn D). Thêm: Stripe live, Supabase sb_secret_, SendGrid, Twilio, Cloudflare; JWT được giải mã
// (role=anon ⇒ khoá công khai, bỏ qua; role=service_role ⇒ lỗi riêng); scanText / scanDiff (quét cả dòng xoá) / scanDir (bản build) /
// isPrivateData / scanHidden + scanHiddenPaths (ký tự ẩn trong file luật).
//
// Quy ước đầu ra: finding.value luôn đã che (4 ký tự đầu + …), không bao giờ là giá trị đầy đủ. Finding không gắn với một dòng cụ thể
// (file nhạy cảm, không quét được…) có line = null. "Không quét được" ⇒ báo, không bao giờ coi là sạch.
//
// Export:
//   scanLine(text)                      → [{ name, index, end, value }]
//   scanText(text, { allow })           → [{ line, name, index, end, value }]          (line từ 1; allow:true ⇒ bỏ dòng có ALLOW_MARK)
//   scanPatch(patch)                    → { findings: [{ file, line, name, value }], allowed: Set<file> }   (git diff -U0 --no-prefix, chỉ dòng THÊM)
//   scanDiff(diff, { projectCfg, allow })→ [{ file, line, name, value, removed }]       (diff bất kỳ; CẢ dòng xoá; kèm file nhạy cảm/dữ liệu riêng)
//   scanDir(dir, { build, outbound, projectCfg, maxFileBytes, maxFiles }) → [{ file, line, name, value }]
//   unquoteGitPath(s)                   → đường dẫn git bọc nháy C-quote ("a\"b", \\, \t, \ooo bát phân UTF-8) giải ra tên thật
//   diffSectionPaths(section)           → mọi đường dẫn (đã giải nháy) mà MỘT mục `diff --git` đụng tới (tiêu đề, ---/+++, rename|copy)
//   isSensitiveFile(path) · isPrivateData(path, projectCfg) · scanHidden(text) → [{ line, col, kind, count, codepoints }]
//   scanHiddenPaths(paths)              → { findings: [{ file, line, col, kind, count, codepoints }], errors: [{ file, error }] }
import fs from 'node:fs'
import path from 'node:path'

export const ALLOW_MARK = 'flow-gate: allow-secret'

// Tên mẫu ↔ regex (mỗi dòng chỉ lấy khớp đầu tiên không phải ví dụ của từng mẫu). url-credential: bỏ mật khẩu dạng placeholder ($VAR, {{x}}, <pw>);
// lookbehind để chỉ thử từ đầu mỗi cụm scheme (tránh O(n^2) với dòng dài toàn [a-z0-9]).
// Mẫu mới (sau url-credential): mọi phần "giữa chữ" đều chặn độ dài ({0,n}) để dòng bundle minify hàng MB không làm regex quay lùi.
export const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws', /AKIA[0-9A-Z]{16}/],
  ['github', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['github', /github_pat_[A-Za-z0-9_]{60,}/],
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['xai', /xai-[A-Za-z0-9]{40,}/],
  ['google', /AIza[0-9A-Za-z_-]{35}/],
  ['slack', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['url-credential', /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/$<{][^@\s/]{7,}@/i],
  // Stripe: chỉ khoá live bí mật/giới hạn (pk_live_ là khoá công khai, *_test_ là khoá thử)
  ['stripe', /(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  // Supabase: khoá bí mật kiểu mới (sb_publishable_ là khoá công khai)
  ['supabase', /(?<![A-Za-z0-9])sb_secret_[A-Za-z0-9_-]{16,}/],
  // Supabase personal access token (sbp_ + 40 hex) — quyền cả tài khoản; Neon API key; Sentry token (từ skills-check, làn H)
  ['supabase', /(?<![A-Za-z0-9])sbp_[0-9a-f]{40}(?![0-9A-Za-z])/],
  ['neon', /(?<![A-Za-z0-9])napi_[a-z0-9]{30,}/],
  ['sentry', /(?<![A-Za-z0-9])sntry[su]_[A-Za-z0-9+/=_-]{20,}/],
  // SendGrid: SG.<22>.<43> cố định
  ['sendgrid', /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/],
  // Twilio: API key SID (SK + 32 hex) và auth token (32 hex trần, chỉ nhận khi đứng sau tên biến twilio…token/secret/key)
  ['twilio', /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![0-9A-Za-z])/],
  ['twilio', /twilio[\w.-]{0,24}(?:token|secret|key)[\w.-]{0,16}["']?\s*[:=]\s*["']?[0-9a-f]{32}(?![0-9A-Za-z])/i],
  // Cloudflare: token có tiền tố (cfut_ người dùng, cfat_ tài khoản) và giá trị dài sau CLOUDFLARE_*/CF_*…token/key/secret
  ['cloudflare', /(?<![A-Za-z0-9])cf(?:ut|at)_[A-Za-z0-9]{32,}/],
  ['cloudflare', /(?:cloudflare|(?<![a-z])cf)[\w.-]{0,24}(?:token|key|secret)[\w.-]{0,16}["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{37,}/i],
]

// Khớp đã biết là KHÔNG phải secret: khoá ví dụ công khai trong tài liệu AWS (bộ test SigV4), URL mẫu mà mật khẩu chính là chữ "password"
// (chữ gợi ý trong ô nhập proxy), JWT role=anon (khoá công khai của Supabase, cố ý nằm trong client), khoá Stripe chỉ toàn chữ x (giữ chỗ
// trong tài liệu), giá trị Cloudflare là chữ giữ chỗ. Chỉ bỏ đúng chuỗi này, không nới mẫu.
export const KNOWN_FALSE_POSITIVES = [
  ['aws', (m) => m === 'AKIAIOSFODNN7EXAMPLE'],
  ['url-credential', (m) => /:password@$/i.test(m)],
  ['jwt', (m) => jwtRole(m) === 'anon'],
  ['stripe', (m) => /_live_x+$/i.test(m)],
  ['cloudflare', (m) => /your|example|placeholder|changeme|x{6,}/i.test(m.replace(/^[^:=]*[:=]\s*["']?/, ''))],
]
const isKnownFalsePositive = (name, match) => KNOWN_FALSE_POSITIVES.some(([n, ok]) => n === name && ok(match))

// Vai trò trong payload của một JWT (đoạn giữa), hoặc null khi không giải mã được / không có role. Không giải mã được ⇒ null ⇒ vẫn bị báo là jwt.
function jwtRole(token) {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const role = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.role
    return typeof role === 'string' ? role : null
  } catch {
    return null
  }
}

// Tên báo cáo cuối cùng: JWT service_role (khoá quản trị Supabase) có tên riêng để cổng/lời dặn nói rõ nguy cơ.
const reportName = (name, match) => (name === 'jwt' && jwtRole(match) === 'service_role' ? 'jwt-service-role' : name)

export function isSensitiveFile(file) {
  const n = path.posix.basename(String(file).replace(/\\/g, '/')).toLowerCase()
  if (n === '.env') return true
  if (n.startsWith('.env.')) return !/\.(example|sample|template)$/.test(n)
  if (/^id_(rsa|ed25519)/.test(n)) return !n.endsWith('.pub') // khoá công khai không phải secret
  return n.endsWith('.pem') || n === '.dev.vars' || n === 'credentials.json'
}

// ---------- dữ liệu riêng (không được gửi cho model hãng khác) ----------

const PRIVATE_EXT = /\.(?:csv|sqlite3?|db|dump)$/i
// File mã nguồn nằm trong thư mục data/ lồng nhau (src/data/constants.ts) là code, không phải dữ liệu; data/ ở gốc repo luôn là dữ liệu.
const CODE_EXT = /\.(?:[cm]?[jt]sx?|go|py|rs|java|kt|swift|rb|php|cs|vue|svelte|astro|css|scss|html|mdx?)$/i

function globToRegExp(pat) {
  let s = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++
        if (pat[i + 1] === '/') { i++; s += '(?:.*/)?' } else s += '.*'
      } else s += '[^/]*'
    } else if (c === '?') s += '[^/]'
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${s}$`, 'i')
}

// Glob kiểu .gitignore rút gọn: không có "/" (trừ "/" cuối) ⇒ khớp tên bất kỳ đoạn nào của đường dẫn (file hoặc thư mục cha); có "/" ⇒ neo từ gốc repo;
// khớp một thư mục cha ⇒ mọi thứ bên trong cũng khớp.
function matchesGlob(pat, segs) {
  const p = pat.replace(/^\.?\//, '').replace(/\/+$/, '')
  if (!p) return false
  const re = globToRegExp(p)
  if (!p.includes('/')) return segs.some((s) => re.test(s))
  for (let k = 1; k <= segs.length; k++) if (re.test(segs.slice(0, k).join('/'))) return true
  return false
}

// projectCfg = nội dung .claude/flow.json (đã parse); `private` = mảng glob (hoặc một chuỗi) thêm vào bộ mặc định.
export function isPrivateData(file, projectCfg) {
  const rel = String(file).replace(/\\/g, '/').replace(/^\.?\//, '')
  const segs = rel.split('/').filter(Boolean)
  if (!segs.length) return false
  if (PRIVATE_EXT.test(rel)) return true
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase())
  if (dirs[0] === 'data') return true
  if (dirs.includes('data') && !CODE_EXT.test(rel)) return true
  const extra = projectCfg?.private
  const globs = (Array.isArray(extra) ? extra : [extra]).filter((g) => typeof g === 'string')
  return globs.some((g) => matchesGlob(g, segs))
}

// ---------- quét dòng / văn bản / patch ----------

// Bản có cờ g của từng mẫu: duyệt MỌI khớp trên dòng (khớp đầu là ví dụ/anon không được che khớp thật đứng sau, vd bundle có cả khoá anon lẫn service_role).
const GLOBAL_PATTERNS = SECRET_PATTERNS.map(([name, re]) => [name, new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)])

// Các khớp secret trong một dòng: [{ name, index, end, value }] với value đã che (4 ký tự đầu + …). Mỗi mẫu lấy khớp hợp lệ đầu tiên.
export function scanLine(text) {
  const hits = []
  for (const [name, re] of GLOBAL_PATTERNS) {
    re.lastIndex = 0
    for (let m; (m = re.exec(text)); ) {
      if (isKnownFalsePositive(name, m[0])) continue
      const end = m.index + m[0].length
      if (hits.some((h) => m.index < h.end && h.index < end)) continue // cùng một token đã được mẫu khác báo (sk-ant-… vs openai)
      hits.push({ name: reportName(name, m[0]), index: m.index, end, value: `${m[0].slice(0, 4)}…` })
      break
    }
  }
  return hits
}

// Văn bản nhiều dòng. Mặc định KHÔNG tôn trọng ALLOW_MARK (dùng cho thứ sắp gửi ra ngoài); allow:true ⇒ bỏ dòng có dấu (như cổng commit).
export function scanText(text, { allow = false } = {}) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (allow && lines[i].includes(ALLOW_MARK)) continue
    for (const h of scanLine(lines[i])) out.push({ line: i + 1, ...h })
  }
  return out
}

// Duyệt `git diff -U0` (đã --no-prefix): trả { findings: [{file, line, name, value}], allowed: Set<file có dòng allow> }.
export function scanPatch(patch) {
  const findings = []
  const allowed = new Set()
  let file = null
  let line = 0
  let inHunk = false
  for (const l of patch.split(/\r?\n/)) {
    if (l.startsWith('diff --git ')) { inHunk = false; file = null; continue }
    if (l.startsWith('@@ ')) { line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0); inHunk = true; continue }
    if (!inHunk) {
      if (l.startsWith('+++ ')) { const f = l.slice(4).replace(/\t$/, ''); file = f === '/dev/null' ? null : f }
      continue
    }
    if (l[0] !== '+' || file === null) continue
    const text = l.slice(1)
    const lineNo = line++
    if (text.includes(ALLOW_MARK)) { allowed.add(file); continue }
    for (const h of scanLine(text)) findings.push({ file, line: lineNo, name: h.name, value: h.value })
  }
  return { findings, allowed }
}

// Đường dẫn git bọc nháy kiểu C khi có ký tự lạ (", \, tab, xuống dòng, byte điều khiển; byte ≥ 0x80 nếu core.quotepath bật): giải \" \\ \a\b\f\n\r\t\v và
// \ooo bát phân (byte UTF-8) ra tên thật. Không có nháy bọc ⇒ giữ nguyên. Thoát lạ/thiếu ⇒ giữ nguyên chữ (không ném).
const C_ESCAPES = new Map([['a', 7], ['b', 8], ['f', 12], ['n', 10], ['r', 13], ['t', 9], ['v', 11], ['"', 34], ['\\', 92]])
export function unquoteGitPath(f) {
  if (!(f.length > 1 && f.startsWith('"') && f.endsWith('"'))) return f
  const s = f.slice(1, -1)
  const bytes = []
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\') {
      const esc = C_ESCAPES.get(s[i + 1])
      const oct = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4))
      if (esc !== undefined) { bytes.push(esc); i += 2; continue }
      if (oct) { bytes.push(parseInt(oct[0], 8) & 0xFF); i += 4; continue }
    }
    const ch = String.fromCodePoint(s.codePointAt(i))
    bytes.push(...Buffer.from(ch, 'utf8'))
    i += ch.length
  }
  return Buffer.from(bytes).toString('utf8')
}
const unquote = unquoteGitPath

// Hai đường dẫn của dòng `diff --git <a> <b>` (sau chữ "diff --git "): mỗi vế bọc nháy C-quote độc lập. Cả hai không nháy ⇒ null (mơ hồ nếu có dấu cách).
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"'
const HEADER_QQ = new RegExp(`^(${QUOTED}) (${QUOTED}|\\S.*)$`)
const HEADER_BQ = new RegExp(`^(\\S.*?) (${QUOTED})$`)
function quotedHeaderPaths(rest) {
  const m = HEADER_QQ.exec(rest) ?? HEADER_BQ.exec(rest)
  return m ? [unquote(m[1]), unquote(m[2])] : null
}

// Dòng `diff --git …` → { prefixed (có a/ b/), names: đường dẫn đã giải nháy và bỏ a/ b/ }. Không nháy mà hai vế khác tên + có dấu cách ⇒ names rỗng (mơ hồ;
// đã có dòng ---/+++ hoặc rename/copy bù).
function headerNames(l) {
  const prefixed = /^diff --git "?a\/.+ "?b\/./.test(l)
  const quoted = quotedHeaderPaths(l.slice('diff --git '.length))
  if (quoted) return { prefixed, names: quoted.map((p, i) => (prefixed && p.startsWith(i ? 'b/' : 'a/') ? p.slice(2) : p)) }
  const same = /^diff --git (?:a\/)?(.+?) (?:b\/)?\1$/.exec(l)
  return { prefixed, names: same ? [same[1]] : [] }
}

// Mọi đường dẫn (đã giải nháy) mà MỘT mục `diff --git` đụng tới, chỉ đọc phần tiêu đề trước hunk đầu: hai vế dòng diff --git, ---/+++, rename|copy from|to.
export function diffSectionPaths(section) {
  const out = new Set()
  let prefixed = false
  for (const l of String(section).split(/\r?\n/)) {
    if (l.startsWith('@@ ')) break
    if (l.startsWith('diff --git ')) { const h = headerNames(l); prefixed = h.prefixed; h.names.forEach((n) => out.add(n)) }
    else if (l.startsWith('--- ') || l.startsWith('+++ ')) {
      const n = unquote(l.slice(4).replace(/\t$/, ''))
      const pre = l[0] === '-' ? 'a/' : 'b/'
      if (n !== '/dev/null') out.add(prefixed && n.startsWith(pre) ? n.slice(2) : n)
    } else if (/^(?:rename|copy) (?:from|to) /.test(l)) out.add(unquote(l.replace(/^(?:rename|copy) (?:from|to) /, '')))
  }
  return [...out]
}

// Diff bất kỳ (có hoặc không tiền tố a/ b/, có dòng ngữ cảnh). Khác scanPatch: quét CẢ dòng xoá (secret đã xoá vẫn nằm trong diff gửi đi),
// và báo mọi file nhạy cảm / dữ liệu riêng có mặt trong diff (kể cả chỉ đổi tên hay nhị phân) với line = null.
// Dòng xoá: line = số dòng trong file CŨ, removed = true. Mặc định không tôn trọng ALLOW_MARK (xem scanText).
export function scanDiff(diff, { projectCfg, allow = false } = {}) {
  const findings = []
  const touched = new Set()
  const allowed = new Set()
  let prefixed = false
  let oldFile = null
  let newFile = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const stripPrefix = (f, p) => {
    const n = unquote(f.replace(/\t$/, ''))
    if (n === '/dev/null') return null
    return prefixed && n.startsWith(p) ? n.slice(p.length) : n
  }
  for (const l of String(diff).split(/\r?\n/)) {
    if (l.startsWith('diff --git ')) {
      inHunk = false
      oldFile = newFile = null
      const h = headerNames(l) // tên có ký tự lạ ⇒ git bọc nháy: giải đúng, mỗi vế riêng
      prefixed = h.prefixed
      h.names.forEach((n) => touched.add(n))
      continue
    }
    if (l.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
      oldLine = Number(m?.[1] ?? 0)
      newLine = Number(m?.[2] ?? 0)
      inHunk = true
      continue
    }
    if (!inHunk) {
      if (l.startsWith('--- ')) { oldFile = stripPrefix(l.slice(4), 'a/'); if (oldFile) touched.add(oldFile) }
      else if (l.startsWith('+++ ')) { newFile = stripPrefix(l.slice(4), 'b/'); if (newFile) touched.add(newFile) }
      else if (/^(?:rename|copy) (?:from|to) /.test(l)) touched.add(unquote(l.replace(/^(?:rename|copy) (?:from|to) /, '')))
      continue
    }
    const kind = l[0]
    if (kind === ' ') { oldLine++; newLine++; continue }
    if (kind !== '+' && kind !== '-') continue // "\ No newline at end of file", dòng trống cuối
    const removed = kind === '-'
    const file = removed ? (oldFile ?? newFile) : (newFile ?? oldFile)
    const lineNo = removed ? oldLine++ : newLine++
    if (file === null) continue
    const text = l.slice(1)
    if (allow && text.includes(ALLOW_MARK)) { allowed.add(file); continue }
    for (const h of scanLine(text)) findings.push({ file, line: lineNo, name: h.name, value: h.value, removed })
  }
  for (const f of touched) {
    if (isSensitiveFile(f)) { if (!allowed.has(f)) findings.push({ file: f, line: null, name: 'file nhạy cảm', value: null, removed: false }) }
    else if (isPrivateData(f, projectCfg)) findings.push({ file: f, line: null, name: 'dữ liệu riêng', value: null, removed: false })
  }
  return findings
}

// ---------- quét thư mục ----------

export const BUILD_DIRS = ['dist', 'build', '.next', 'out']
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|mov|zip|gz|br|tgz|7z|wasm|pdf|exe|dll|so|dylib)$/i
const isBinary = (buf) => buf.subarray(0, 8000).includes(0)

// File có byte NUL mà thật ra là văn bản UTF-16 (Windows/PowerShell hay ghi kiểu này) → chuỗi đã giải mã; không giống UTF-16 → null.
// Nhận ra bằng BOM (FF FE = LE, FE FF = BE) hoặc, khi không BOM, NUL xen kẽ rõ rệt ở 8000 byte đầu (chữ ASCII có byte cao = 0).
function decodeUtf16(buf) {
  let be
  if (buf[0] === 0xFF && buf[1] === 0xFE) be = false
  else if (buf[0] === 0xFE && buf[1] === 0xFF) be = true
  else {
    const n = Math.min(buf.length, 8000) & ~1
    let even = 0
    let odd = 0
    for (let i = 0; i < n; i++) if (buf[i] === 0) { if (i & 1) odd++; else even++ }
    const pairs = n / 2
    if (pairs === 0) return null
    if (odd >= pairs * 0.3 && even <= pairs * 0.02) be = false
    else if (even >= pairs * 0.3 && odd <= pairs * 0.02) be = true
    else return null
  }
  const body = buf.subarray(0, buf.length & ~1)
  return (be ? Buffer.from(body).swap16() : body).toString('utf16le').replace(/^﻿/, '')
}

// Mọi cách đọc một file có byte NUL để quét; null = nhị phân thật (NUL trong 8000 byte đầu mà không giống UTF-16).
// File trộn mã hoá (BOM/NUL kiểu UTF-16 ở đầu, phần sau là UTF-8 — hoặc ngược lại, đuôi UTF-16 gắn vào file UTF-8 dài) mà chỉ giải một kiểu
// thì khoá ở phần kia vỡ cặp byte và lọt ⇒ quét CẢ bản thô lẫn bản bỏ NUL (chữ ASCII của UTF-16 ra nguyên) lẫn bản giải UTF-16.
function textViews(buf) {
  const raw = buf.toString('utf8')
  if (!buf.includes(0)) return [raw]
  const views = [raw, raw.replace(/\0/g, '')]
  if (isBinary(buf)) {
    const u16 = decodeUtf16(buf)
    if (u16 === null) return null
    views.push(u16)
  }
  return views
}

// Duyệt cây thư mục (không đi theo liên kết tượng trưng). visit(abs, rel, entryKind) với entryKind 'file' | 'symlink'. Trả false khi quá maxFiles.
function walk(root, { build, maxFiles }, visit) {
  let count = 0
  const rec = (abs, rel, inBuild) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        if (e.name === 'cache' && path.basename(abs) === '.next') continue // bộ nhớ đệm webpack của Next, hàng trăm MB, không phải bản phát hành
        if (!rec(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, inBuild || BUILD_DIRS.includes(e.name))) return false
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (build && !inBuild) continue
        if (++count > maxFiles) return false
        visit(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, e.isSymbolicLink() ? 'symlink' : 'file')
      }
    }
    return true
  }
  return rec(root, '', BUILD_DIRS.includes(path.basename(path.resolve(root))))
}

// build:true ⇒ chỉ quét thư mục build (dist/ build/ .next/ out/, ở mọi độ sâu, hoặc chính dir nếu nó là thư mục build); mặc định quét cả cây.
// outbound:true ⇒ kiểm một thư mục sắp đưa cho bên ngoài: báo thêm file dữ liệu riêng (isPrivateData + projectCfg) và liên kết tượng trưng (có thể trỏ ra ngoài).
// File nhạy cảm luôn được báo. File quá lớn / không đọc được ⇒ báo (line = null), không coi là sạch. Thư mục gốc không đọc được ⇒ ném lỗi.
// File có byte NUL: quét CẢ bản giải UTF-16 (BOM hoặc NUL xen kẽ) LẪN bản thô (UTF-8 và bản bỏ NUL) rồi gộp phát hiện — file trộn mã hoá không
// được lọt; không phải UTF-16 ⇒ outbound báo name 'binary' (line = null, review-ext loại file khỏi workspace), chế độ thường/build bỏ qua.
// outbound cũng quét file đuôi ảnh/nén (BINARY_EXT) thay vì tin đuôi.
export function scanDir(dir, { build = false, outbound = false, projectCfg, maxFileBytes = 10 * 1024 * 1024, maxFiles = 50000 } = {}) {
  const findings = []
  const note = (file, name) => findings.push({ file, line: null, name, value: null })
  const complete = walk(dir, { build, maxFiles }, (abs, rel, kind) => {
    if (kind === 'symlink') { if (outbound) note(rel, 'liên kết tượng trưng (không quét)'); return }
    if (isSensitiveFile(rel)) note(rel, 'file nhạy cảm')
    else if (outbound && isPrivateData(rel, projectCfg)) note(rel, 'dữ liệu riêng')
    if (BINARY_EXT.test(rel) && !outbound) return // outbound không tin đuôi file: tên .png mà ruột là chữ vẫn phải quét
    let buf
    try {
      if (fs.statSync(abs).size > maxFileBytes) return note(rel, 'quá lớn, chưa quét')
      buf = fs.readFileSync(abs)
    } catch (e) {
      return note(rel, `không đọc được (${e.code ?? 'lỗi'})`)
    }
    const views = textViews(buf)
    if (views === null) { if (outbound) note(rel, 'binary'); return } // outbound: không quét được ⇒ báo để người gọi loại file khỏi thứ gửi đi
    const seen = new Set() // cùng một khoá thấy ở nhiều bản đọc ⇒ báo một lần
    for (const text of views) {
      for (const h of scanText(text)) {
        const key = `${h.line}:${h.name}:${h.value}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({ file: rel, line: h.line, name: h.name, value: h.value })
      }
    }
  })
  if (!complete) note('.', `quá ${maxFiles} file, chưa quét hết`)
  return findings
}

// ---------- ký tự ẩn ----------

function hiddenKind(cp) {
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'tag' // "ASCII smuggling": mỗi ký tự là một chữ ASCII vô hình
  if (cp >= 0xE0100 && cp <= 0xE01EF) return 'variation-selector'
  if (cp === 0x061C || cp === 0x200E || cp === 0x200F || (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi'
  if ((cp >= 0x200B && cp <= 0x200D) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xFEFF || cp === 0x180E) return 'zero-width'
  return null
}
const BEFORE_ZWJ = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/u
const AFTER_ZWJ = /\p{Extended_Pictographic}/u

// Ký tự vô hình có thể giấu lệnh trong file luật/skill. Hợp lệ (không báo): BOM ở đầu file, ZWJ nối hai emoji (👩‍💻). Ký tự liền nhau cùng loại gộp một mục.
// Trả [{ line, col, kind, count, codepoints }] — line/col từ 1 (col theo đơn vị UTF-16 như trình soạn thảo). KHÔNG giải mã/trả lại nội dung giấu.
export function scanHidden(text) {
  const out = []
  String(text).split(/\r?\n/).forEach((l, li) => {
    const chars = Array.from(l)
    let col = 0
    let cur = null
    chars.forEach((ch, j) => {
      const cp = ch.codePointAt(0)
      const here = col
      col += ch.length
      let kind = hiddenKind(cp)
      if (kind && cp === 0xFEFF && li === 0 && here === 0) kind = null
      if (kind && cp === 0x200D && BEFORE_ZWJ.test(chars[j - 1] ?? '') && AFTER_ZWJ.test(chars[j + 1] ?? '')) kind = null
      if (!kind) { cur = null; return }
      const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
      if (cur && cur.kind === kind) {
        cur.count++
        if (cur.codepoints.length < 5 && !cur.codepoints.includes(code)) cur.codepoints.push(code)
      } else {
        cur = { line: li + 1, col: here + 1, kind, count: 1, codepoints: [code] }
        out.push(cur)
      }
    })
  })
  return out
}

// scanHidden cho nhiều đường dẫn: mỗi mục là file hoặc thư mục (đệ quy; bỏ .git/node_modules, liên kết tượng trưng, file nhị phân).
// Trả { findings: [{ file, line, col, kind, count, codepoints }], errors: [{ file, error }] }. File không đọc được / quá lớn nằm ở errors
// (không coi là sạch). findings.file = đường dẫn như người gọi đưa (mục là thư mục ⇒ nối thêm đường dẫn con).
export function scanHiddenPaths(paths, { maxFileBytes = 5 * 1024 * 1024, maxFiles = 50000 } = {}) {
  const findings = []
  const errors = []
  const fail = (file, e) => errors.push({ file, error: `không đọc được (${e.code ?? 'lỗi'})` })
  const one = (abs, shown) => {
    if (BINARY_EXT.test(abs)) return
    let buf
    try {
      if (fs.statSync(abs).size > maxFileBytes) return errors.push({ file: shown, error: 'quá lớn, chưa quét' })
      buf = fs.readFileSync(abs)
    } catch (e) {
      return fail(shown, e)
    }
    if (isBinary(buf)) return
    for (const h of scanHidden(buf.toString('utf8'))) findings.push({ file: shown, ...h })
  }
  for (const p of paths) {
    let st
    try { st = fs.statSync(p) } catch (e) { fail(p, e); continue }
    if (!st.isDirectory()) { one(p, p); continue }
    try {
      const complete = walk(p, { build: false, maxFiles }, (abs, rel, kind) => { if (kind === 'file') one(abs, path.join(p, rel)) })
      if (!complete) errors.push({ file: p, error: `quá ${maxFiles} file, chưa quét hết` })
    } catch (e) {
      fail(p, e)
    }
  }
  return { findings, errors }
}

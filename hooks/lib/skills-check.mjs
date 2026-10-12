// skills-check: dự án này đã có skill/MCP CHÍNH HÃNG của từng thư viện chưa, và dùng được không (AC-32).
// Danh sách chính hãng nằm ở kit/official.json. Đọc cấu hình TRỰC TIẾP (không gọi `claude mcp list`, chậm); không gọi mạng; không cài gì —
// chỉ trả lệnh cài để captain hỏi user. Spec: docs/specs/2026-10-11-flow-v7-nocode (PLAN.md, dòng skills-check).
//
// Nguồn đọc theo app:
//   claude  MCP: ~/.claude.json (mcpServers + projects[<dự án>].mcpServers), <dự án>/.mcp.json · skill: ~/.claude/skills, <dự án>/.claude/skills
//   codex   MCP: $CODEX_HOME|~/.codex/config.toml [mcp_servers.*]                               · skill: ~/.agents/skills, <dự án>/.agents/skills
//   devin   MCP như claude (Devin đọc ~/.claude.json)                                           · skill: cả bốn thư mục trên
// "Dự án" = thư mục được hỏi và các thư mục cha tới gốc repo (có .git), như cách Claude/Codex tìm skill.
//
// check(projectDir, host, opts?) → [{ lib, status, usable, scope, problems[], warnings[], installCmd, installAlt, sourceOrg, note, parts, found }]
//   status  installed (có skill HOẶC MCP chính hãng) · missing · community-only (chỉ có thứ trông giống nhưng không khớp danh sách chính hãng) ·
//           none (hãng không có bản chính hãng: Go, Wails)
//   usable  ok · needs-login · misconfigured · unknown (chưa cài ⇒ unknown). Mỗi MCP server được xét:
//             - lệnh stdio không tìm thấy, URL hỏng, server bị tắt (Codex enabled=false)            ⇒ misconfigured
//             - khoá gõ thẳng trong env/args/header/URL (mẫu của secrets.mjs, hoặc giá trị chữ ở khoá tên token/key/secret) ⇒ misconfigured
//             - biến ${VAR} được tham chiếu chưa có giá trị: tên giống khoá/token ⇒ needs-login (user cần đăng nhập/đặt khoá), còn lại ⇒ misconfigured
//             - Supabase thiếu read_only=true, hoặc trỏ project production                              ⇒ misconfigured
//             - Stripe dùng khoá live                                                                   ⇒ misconfigured
//             - server từ xa không có khoá/header (OAuth): đăng nhập nằm ngoài file cấu hình ⇒ unknown (skill bảo thử MỘT lệnh đọc rẻ)
//           parts = { skill?, mcp? } từng phần; usable của thư viện = misconfigured nếu BẤT KỲ phần nào sai (nguy cơ còn trên máy), còn lại ok nếu có
//           phần ok (ưu tiên skill), rồi unknown, rồi needs-login.
//   scope   { readOnly?, env: 'dev'|'prod'|'unknown' }. readOnly chỉ có cho Supabase (read_only). env: Supabase theo project_ref trong
//           .claude/flow.json {"supabase":{"prod":[ref…],"dev":[ref…]}} hoặc chữ prod/production/live · dev/staging/test… trong TÊN server;
//           Stripe theo tiền tố khoá (_live_ ⇒ prod, _test_ ⇒ dev) kể cả khoá nằm trong biến môi trường được tham chiếu.
//   installCmd  lệnh cài bản chính hãng (ưu tiên skill, rồi MCP theo app) khi missing/community-only, còn lại null; installAlt = lệnh còn lại.
//   problems = lý do usable chưa ok; warnings = điều đáng biết nhưng không đổi usable (thiếu project_ref, file cấu hình đọc lỗi, bản cộng đồng).
// Giới hạn đã biết: skill chỉ nhận ra theo TÊN thư mục (không chứng minh được nguồn); skill đi kèm plugin (/plugin marketplace add) chưa được đọc;
// trạng thái duyệt .mcp.json và đăng nhập OAuth của Claude/Codex nằm ngoài file cấu hình nên không xét (⇒ unknown).
// Nhận chính hãng theo ĐÍCH THẬT của server (tên miền trong url / sau mcp-remote, hoặc gói npm đứng sau trình chạy npx/pnpm/bunx…), không theo tên
// do user đặt. Đầu ra chỉ chứa tên server (đã làm sạch) và tên biến — KHÔNG BAO GIỜ chứa lệnh, giá trị env/header/args hay project_ref.
//
// opts (cho test / CLI): { home, env (mặc định process.env), libs (lọc), official (thay official.json) }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanText } from './secrets.mjs'

export const OFFICIAL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit', 'official.json')

export const HOSTS = {
  claude: { mcp: 'claude', skillDirs: ['.claude'] },
  codex: { mcp: 'codex', skillDirs: ['.agents'] },
  devin: { mcp: 'claude', skillDirs: ['.claude', '.agents'] },
}

export function loadOfficial(file = OFFICIAL_FILE) {
  const all = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')))
}

// ---------------------------------------------------------------- TOML tối thiểu

const nul = () => Object.create(null) // __proto__ trong file cấu hình chỉ là một khoá thường

// Đủ cho config.toml của Codex: bảng [a.b], mảng bảng [[a]], khoá chấm/nháy, chuỗi basic/literal (một và nhiều dòng), số, bool, mảng, inline table, chú thích.
// Ngày giờ giữ nguyên dạng chuỗi. Lỗi ở một câu lệnh ⇒ ghi { line, message } và đọc tiếp từ dòng sau; không bao giờ ném.
export function parseToml(text) {
  const src = String(text).replace(/^\uFEFF/, '')
  const root = nul()
  const errors = []
  let pos = 0
  let cur = root
  const fail = (msg) => { throw new SyntaxError(msg) }
  const lineAt = (p) => src.slice(0, p).split('\n').length
  const ws = () => { while (src[pos] === ' ' || src[pos] === '\t') pos++ }
  const comment = () => { if (src[pos] === '#') while (pos < src.length && src[pos] !== '\n') pos++ }
  const trivia = () => {
    for (;;) {
      const c = src[pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++
      else if (c === '#') comment()
      else return
    }
  }

  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  const escape = () => {
    const c = src[pos++]
    if (c !== undefined && Object.hasOwn(ESC, c)) return ESC[c]
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8
      const hex = src.slice(pos, pos + n)
      if (hex.length !== n || !/^[0-9a-fA-F]+$/.test(hex)) fail('escape \\u lỗi')
      pos += n
      return String.fromCodePoint(parseInt(hex, 16))
    }
    return fail('escape lỗi')
  }
  const basicString = () => {
    if (src.startsWith('"""', pos)) {
      pos += 3
      if (src[pos] === '\r') pos++
      if (src[pos] === '\n') pos++
      let out = ''
      for (;;) {
        if (pos >= src.length) fail('chuỗi chưa đóng')
        if (src.startsWith('"""', pos)) { pos += 3; return out.replace(/\r\n/g, '\n') }
        const c = src[pos++]
        if (c !== '\\') { out += c; continue }
        if (/[ \t\r\n]/.test(src[pos] ?? '')) { while (/[ \t\r\n]/.test(src[pos] ?? 'x')) pos++ } else out += escape()
      }
    }
    pos++
    let out = ''
    for (;;) {
      const c = src[pos++]
      if (c === undefined || c === '\n') fail('chuỗi chưa đóng')
      if (c === '"') return out
      out += c === '\\' ? escape() : c
    }
  }
  const literalString = () => {
    if (src.startsWith("'''", pos)) {
      pos += 3
      if (src[pos] === '\r') pos++
      if (src[pos] === '\n') pos++
      const end = src.indexOf("'''", pos)
      if (end < 0) fail('chuỗi chưa đóng')
      const out = src.slice(pos, end).replace(/\r\n/g, '\n')
      pos = end + 3
      return out
    }
    const end = src.indexOf("'", pos + 1)
    const nl = src.indexOf('\n', pos)
    if (end < 0 || (nl >= 0 && nl < end)) fail('chuỗi chưa đóng')
    const out = src.slice(pos + 1, end)
    pos = end + 1
    return out
  }

  const keyPart = () => {
    ws()
    if (src[pos] === '"') return basicString()
    if (src[pos] === "'") return literalString()
    const start = pos
    while (pos < src.length && /[A-Za-z0-9_-]/.test(src[pos])) pos++
    if (pos === start) fail('khoá không hợp lệ')
    return src.slice(start, pos)
  }
  const keyPath = () => {
    const parts = [keyPart()]
    ws()
    while (src[pos] === '.') { pos++; parts.push(keyPart()); ws() }
    return parts
  }
  const descend = (obj, keys) => {
    for (const k of keys) {
      let n = obj[k]
      if (Array.isArray(n)) n = n[n.length - 1]
      if (n === undefined) n = obj[k] = nul()
      else if (typeof n !== 'object' || n === null) fail('khoá trùng')
      obj = n
    }
    return obj
  }
  const setPath = (obj, keys, val) => { descend(obj, keys.slice(0, -1))[keys[keys.length - 1]] = val }

  const value = () => {
    ws()
    const c = src[pos]
    if (c === '"') return basicString()
    if (c === "'") return literalString()
    if (c === '[') return array()
    if (c === '{') return inlineTable()
    const start = pos
    while (pos < src.length && !/[\s,\]}#]/.test(src[pos])) pos++
    const tok = src.slice(start, pos)
    if (tok === 'true') return true
    if (tok === 'false') return false
    if (/^[+-]?(?:0|[1-9][\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(tok)) return Number(tok.replace(/_/g, ''))
    if (/^(?:[+-]?(?:inf|nan)|0[xob][0-9a-fA-F_]+|\d{4}-\d\d-\d\d(?:[Tt][\d:.]+(?:[Zz]|[+-]\d\d:\d\d)?)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/.test(tok)) return tok
    return fail('giá trị không hợp lệ')
  }
  function array() {
    pos++
    const out = []
    for (;;) {
      trivia()
      if (src[pos] === ']') { pos++; return out }
      out.push(value())
      trivia()
      if (src[pos] === ',') { pos++; continue }
      if (src[pos] === ']') { pos++; return out }
      fail('mảng lỗi')
    }
  }
  function inlineTable() {
    pos++
    const out = nul()
    for (;;) {
      trivia()
      if (src[pos] === '}') { pos++; return out }
      const k = keyPath()
      ws()
      if (src[pos] !== '=') fail('thiếu =')
      pos++
      setPath(out, k, value())
      trivia()
      if (src[pos] === ',') { pos++; continue }
      if (src[pos] === '}') { pos++; return out }
      fail('bảng nội tuyến lỗi')
    }
  }

  for (;;) {
    trivia()
    if (pos >= src.length) break
    const start = pos
    try {
      if (src.startsWith('[[', pos)) {
        pos += 2
        const k = keyPath()
        ws()
        if (!src.startsWith(']]', pos)) fail('thiếu ]]')
        pos += 2
        const parent = descend(root, k.slice(0, -1))
        const last = k[k.length - 1]
        if (parent[last] === undefined) parent[last] = []
        if (!Array.isArray(parent[last])) fail('khoá trùng')
        cur = nul()
        parent[last].push(cur)
      } else if (src[pos] === '[') {
        pos++
        const k = keyPath()
        ws()
        if (src[pos] !== ']') fail('thiếu ]')
        pos++
        cur = descend(root, k)
      } else {
        const k = keyPath()
        ws()
        if (src[pos] !== '=') fail('thiếu =')
        pos++
        setPath(cur, k, value())
      }
      ws()
      comment()
      if (pos < src.length && src[pos] !== '\n' && src[pos] !== '\r') fail('thừa ký tự cuối dòng')
    } catch (e) {
      if (errors.length < 20) errors.push({ line: lineAt(start), message: e.message })
      const nl = src.indexOf('\n', start)
      pos = nl < 0 ? src.length : nl + 1
    }
  }
  return { data: root, errors }
}

// ---------------------------------------------------------------- tiện ích

const SEVERITY = { ok: 0, unknown: 1, 'needs-login': 2, misconfigured: 3 }
const worst = (list) => list.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ok')
// Gộp nhiều phần/server cùng thư viện: sai là sai (nguy cơ còn trên máy); còn lại có phần ok thì ok, rồi unknown, rồi needs-login.
const combine = (list) => {
  if (!list.length) return 'unknown'
  for (const u of ['misconfigured', 'ok', 'unknown']) if (list.includes(u)) return u
  return 'needs-login'
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
const hasVarRef = (s) => new RegExp(VAR_RE.source).test(s)
// Tên khoá/biến/cờ trông như thông tin xác thực (không bắt "monkey", "keyboard": khoá/key/pat/auth phải đứng riêng một đoạn).
const CRED_KEY = /token|secret|passw(?:or)?d|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|bearer|(?:^|[^a-z])(?:key|pat|auth)(?:[^a-z]|$)/i
// Khoá của các hãng trong official.json mà secrets.mjs chưa có mẫu riêng: Supabase PAT, Neon API key, Sentry auth token.
const EXTRA_SECRETS = [/\bsbp_[0-9a-f]{40}\b/, /\bnapi_[a-z0-9]{30,}\b/, /\bsntry[su]_[A-Za-z0-9+/=_-]{20,}/]
const PLACEHOLDER = /^(?:<.*>|\[.*\]|your[-_ ]|example|placeholder|change[-_]?me|replace|insert|todo|x{3,}$|\*{3,}|\.{3,}|none$|null$|undefined$)/i
const RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'bunx', 'bun', 'yarn', 'npm', 'cmd'])
const BRIDGES = new Set(['mcp-remote'])
const PROD_WORDS = new Set(['prod', 'production', 'prd', 'live'])
const DEV_WORDS = new Set(['dev', 'development', 'staging', 'stage', 'test', 'local', 'preview', 'sandbox'])

// Tên (server, biến, thư mục skill) đến từ file người khác viết (.mcp.json nằm trong repo): làm sạch trước khi in, không bao giờ in dạng khoá bí mật.
export function safe(s) {
  const t = String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]+/gu, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return scanText(t).length ? '<ẩn>' : t
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
const strMap = (v) => Object.fromEntries(Object.entries(isObj(v) ? v : {}).filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x)).map(([k, x]) => [k, String(x)]))
const envGet = (env, name) => env[name] ?? env[Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())]

function readFile(file, errors, label = path.basename(file)) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push(`${label} không đọc được (${e.code ?? 'lỗi'})`)
    return null
  }
}
function readJson(file, errors) {
  const text = readFile(file, errors)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    errors.push(`${path.basename(file)} không phải JSON hợp lệ`)
    return null
  }
}

// Thư mục dự án và các thư mục cha tới gốc repo (có .git, kể cả khi .git là file của worktree). Không thấy .git ⇒ chỉ chính thư mục đó.
function projectDirs(projectDir) {
  const start = path.resolve(projectDir)
  const out = [start]
  let d = start
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return out
    const up = path.dirname(d)
    if (up === d) break
    d = up
    out.push(d)
  }
  return [start]
}

const normPath = (p) => {
  const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n
}
const pathKeys = (dirs) => {
  const keys = new Set()
  for (const d of dirs) {
    keys.add(normPath(d))
    try { keys.add(normPath(fs.realpathSync.native(d))) } catch { /* thư mục không tồn tại: chỉ dùng dạng đã cho */ }
  }
  return keys
}

function findCommand(cmd, env, cwd) {
  const win = process.platform === 'win32'
  const exts = win ? (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toUpperCase()) : []
  const hasSep = /[\\/]/.test(cmd)
  const bases = hasSep ? [path.resolve(cwd, cmd)] : (envGet(env, 'PATH') || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd))
  const runnable = (f) => {
    try {
      const st = fs.statSync(f)
      return st.isFile() && (win || (st.mode & 0o111) !== 0)
    } catch {
      return false
    }
  }
  return bases.some((b) => {
    if (!win) return runnable(b)
    return (exts.includes(path.extname(b).toUpperCase()) && runnable(b)) || exts.some((e) => runnable(b + e))
  })
}

// ---------------------------------------------------------------- đọc MCP

function normClaude(name, scope, raw) {
  const r = isObj(raw) ? raw : {}
  return { name, scope, expand: true, command: str(r.command), args: strArr(r.args), url: str(r.url), env: strMap(r.env), headers: strMap(r.headers), requiredVars: [], hasAuthConfig: false, disabled: false }
}
function normCodex(name, raw) {
  const r = isObj(raw) ? raw : {}
  const envHeaders = strMap(r.env_http_headers)
  const bearer = str(r.bearer_token_env_var)
  return {
    name, scope: 'user', expand: false, command: str(r.command), args: strArr(r.args), url: str(r.url), env: strMap(r.env), headers: strMap(r.http_headers),
    requiredVars: [...strArr(r.env_vars), ...(bearer ? [bearer] : []), ...Object.values(envHeaders)],
    hasAuthConfig: Boolean(bearer) || Object.keys(envHeaders).length > 0,
    disabled: r.enabled === false,
  }
}

const SCOPE_RANK = { local: 0, project: 1, user: 2 }

function readClaudeServers(home, dirs, errors) {
  const found = new Map()
  const put = (srv) => {
    const old = found.get(srv.name)
    if (!old || SCOPE_RANK[srv.scope] < SCOPE_RANK[old.scope]) found.set(srv.name, srv)
  }
  const cfg = readJson(path.join(home, '.claude.json'), errors)
  if (isObj(cfg)) {
    const keys = pathKeys(dirs)
    for (const [p, v] of Object.entries(isObj(cfg.projects) ? cfg.projects : {})) {
      if (keys.has(normPath(p))) for (const [n, raw] of Object.entries(isObj(v?.mcpServers) ? v.mcpServers : {})) put(normClaude(n, 'local', raw))
    }
    for (const [n, raw] of Object.entries(isObj(cfg.mcpServers) ? cfg.mcpServers : {})) put(normClaude(n, 'user', raw))
  }
  for (const d of dirs) {
    const j = readJson(path.join(d, '.mcp.json'), errors)
    for (const [n, raw] of Object.entries(isObj(j?.mcpServers) ? j.mcpServers : {})) put(normClaude(n, 'project', raw))
  }
  return [...found.values()]
}

function readCodexServers(home, env, errors) {
  const file = path.join(envGet(env, 'CODEX_HOME') || path.join(home, '.codex'), 'config.toml')
  const text = readFile(file, errors)
  if (text === null) return []
  const { data, errors: perr } = parseToml(text)
  if (perr.length) errors.push(`config.toml có ${perr.length} dòng đọc lỗi (đầu tiên: dòng ${perr[0].line})`)
  return Object.entries(isObj(data.mcp_servers) ? data.mcp_servers : {}).map(([n, raw]) => normCodex(n, raw))
}

function listSkills(roots) {
  const found = new Map() // tên thường → tên thật
  for (const root of roots) {
    let names
    try { names = fs.readdirSync(root) } catch { continue }
    for (const n of names) if (!found.has(n.toLowerCase()) && fs.existsSync(path.join(root, n, 'SKILL.md'))) found.set(n.toLowerCase(), n)
  }
  return found
}

// ---------------------------------------------------------------- xét một MCP server

function expandVars(s, env, unset) {
  return s.replace(VAR_RE, (_, name, def) => {
    const v = envGet(env, name)
    if (v !== undefined && v !== '') return v
    if (def !== undefined) return def
    unset.add(name)
    return ''
  })
}

// Dạng đã mở ${VAR} (Claude) của server + danh sách biến chưa có giá trị.
function resolve(srv, env) {
  const unset = new Set()
  const R = (s) => (srv.expand ? expandVars(s, env, unset) : s)
  const RM = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, R(v)]))
  for (const v of srv.requiredVars) if (envGet(env, v) === undefined || envGet(env, v) === '') unset.add(v)
  return { command: R(srv.command), args: srv.args.map(R), url: R(srv.url), env: RM(srv.env), headers: RM(srv.headers), unset }
}

function urlsIn(strings) {
  const out = []
  for (const s of strings) for (const m of s.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) out.push(m)
  return out
}
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase() } catch { return null } }
const stripVersion = (t) => t.replace(/^(@[^/@]+\/[^@]+|[^@/][^@]*)@.+$/, '$1')
const runnerOf = (cmd) => path.basename(cmd.replace(/\\/g, '/')).replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()

// Server có phải bản chính hãng của `mcp` (mục mcp trong official.json) không? Trả { matchedUrl } hoặc null.
function identify(rv, mcp) {
  const hosts = mcp.hosts ?? []
  const tokens = [rv.command, ...rv.args]
  const viaRunner = Boolean(rv.command) && RUNNERS.has(runnerOf(rv.command))
  const bridged = viaRunner && tokens.some((t) => BRIDGES.has(stripVersion(t)))
  const candidates = rv.command ? (bridged ? urlsIn(rv.args) : []) : urlsIn([rv.url])
  const matchedUrl = candidates.find((u) => { const h = hostOf(u); return h && hosts.some((d) => h === d || h.endsWith(`.${d}`)) })
  if (matchedUrl) return { matchedUrl }
  if (viaRunner && (mcp.packages ?? []).some((p) => tokens.some((t) => stripVersion(t) === p)) && (!mcp.needArg || rv.args.includes(mcp.needArg))) {
    return { matchedUrl: null }
  }
  return null
}

// Cặp [khoá, giá trị] để soi khoá gõ thẳng: env, header, cờ dòng lệnh (--k=v, --k v, "Header: v"), tham số/mật khẩu trong URL.
function secretPairs(srv) {
  const pairs = [...Object.entries(srv.env), ...Object.entries(srv.headers), ['', srv.command]]
  const a = srv.args
  const push = (k, v) => {
    pairs.push([k, v])
    const h = !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && /^([A-Za-z][\w-]*):\s*(\S[\s\S]*)$/.exec(v) // "Authorization: Bearer …"
    if (h) pairs.push([h[1], h[2]])
  }
  for (let i = 0; i < a.length; i++) {
    let m = /^--?([\w.-]+)=([\s\S]*)$/.exec(a[i])
    if (m) { push(m[1], m[2]); continue }
    m = /^--?([\w.-]+)$/.exec(a[i])
    if (!m) { push('', a[i]); continue }
    if (a[i + 1] !== undefined && !a[i + 1].startsWith('-')) push(m[1], a[++i])
  }
  for (const u of [srv.url, ...urlsIn(a)]) {
    if (!u) continue
    pairs.push(['', u])
    try {
      const url = new URL(u)
      for (const [k, v] of url.searchParams) pairs.push([k, v])
      if (url.password) pairs.push(['password', decodeURIComponent(url.password)])
    } catch { /* URL hỏng: đã bị bắt ở bước kiểm transport */ }
  }
  return pairs
}
function isLiteralValue(v) {
  if (hasVarRef(v)) return false
  const s = v.replace(/^\s*(?:Bearer|Basic|Token)\s+/i, '').trim()
  if (s.length < 8 || PLACEHOLDER.test(s)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i.test(s)) return false // URL không kèm mật khẩu
  return !/^(?:[.~]?\/|[A-Za-z]:[\\/])/.test(s) // đường dẫn file
}
function hasLiteralSecret(srv) {
  return secretPairs(srv).some(([k, v]) => {
    if (!v) return false
    if (scanText(`${k}=${v}`).length || EXTRA_SECRETS.some((re) => re.test(v))) return true
    return CRED_KEY.test(k) && isLiteralValue(v)
  })
}

// prod/dev theo chữ trong tên server (cameCase tách thành từ). prod thắng khi có cả hai.
function envFromName(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((w) => PROD_WORDS.has(w))) return 'prod'
  return words.some((w) => DEV_WORDS.has(w)) ? 'dev' : 'unknown'
}
function flagValue(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : ''
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1)
  }
  return null
}

function guardSupabase(rv, matchedUrl, nameEnv, cfg) {
  let readOnly
  let ref
  if (matchedUrl) {
    const q = new URL(matchedUrl).searchParams
    readOnly = ['true', '1'].includes((q.get('read_only') ?? '').toLowerCase())
    ref = q.get('project_ref')
  } else {
    const eq = rv.args.find((x) => x.startsWith('--read-only='))
    readOnly = eq ? ['true', '1'].includes(eq.slice('--read-only='.length).toLowerCase()) : rv.args.includes('--read-only')
    ref = flagValue(rv.args, '--project-ref')
  }
  const list = (k) => (Array.isArray(cfg?.supabase?.[k]) ? cfg.supabase[k] : [])
  let env = nameEnv
  if (ref && list('prod').includes(ref)) env = 'prod'
  else if (env !== 'prod' && ref && list('dev').includes(ref)) env = 'dev'
  return { readOnly, env, hasRef: Boolean(ref) }
}
function guardStripe(rv, nameEnv) {
  const text = [rv.url, ...rv.args, ...Object.values(rv.env), ...Object.values(rv.headers)].join('\n')
  if (/(?:sk|rk)_live_/.test(text)) return 'prod'
  return /(?:sk|rk)_test_/.test(text) ? 'dev' : nameEnv
}

// Server từ xa có khoá/header/tham số xác thực trong cấu hình không (không có ⇒ chắc là OAuth, trạng thái đăng nhập nằm ngoài file).
function remoteHasAuth(srv, rv) {
  if (srv.hasAuthConfig || Object.keys(rv.headers).some((k) => CRED_KEY.test(k))) return true
  try { return [...new URL(rv.url).searchParams.keys()].some((k) => CRED_KEY.test(k)) } catch { return false }
}

function evalServer(srv, rv, matchedUrl, mcp, ctx) {
  const label = `server "${safe(srv.name)}"`
  const issues = [] // [usable, thông báo]
  const warnings = []
  const add = (u, msg) => issues.push([u, `${label}: ${msg}`])
  const nameEnv = envFromName(srv.name)
  let scope = { env: nameEnv }

  if (srv.disabled) add('misconfigured', 'đang bị tắt trong cấu hình')
  if (hasLiteralSecret(srv)) add('misconfigured', 'có khoá gõ thẳng trong cấu hình — chuyển sang biến môi trường')
  for (const name of rv.unset) {
    const cred = CRED_KEY.test(name)
    add(cred ? 'needs-login' : 'misconfigured', `biến ${safe(name)} chưa có giá trị${cred ? ' (cần đăng nhập hoặc lấy khoá rồi đặt biến)' : ''}`)
  }
  if (rv.command) {
    if (!findCommand(rv.command, ctx.env, ctx.projectDir)) add('misconfigured', 'lệnh khởi chạy không tìm thấy trên máy')
  } else if (rv.url) {
    if (!hostOf(rv.url)) add('misconfigured', 'URL không hợp lệ')
  } else {
    add('misconfigured', 'thiếu command hoặc url')
  }

  if (mcp.guard === 'supabase') {
    const g = guardSupabase(rv, matchedUrl, nameEnv, ctx.cfg)
    scope = { readOnly: g.readOnly, env: g.env }
    if (!g.readOnly) add('misconfigured', 'Supabase thiếu read_only=true (cho phép ghi vào database)')
    if (g.env === 'prod') add('misconfigured', 'Supabase trỏ project production — chỉ dùng project dev/nhánh')
    if (!g.hasRef) warnings.push(`${label}: Supabase thiếu project_ref (server thấy mọi project của tài khoản)`)
  } else if (mcp.guard === 'stripe') {
    scope = { env: guardStripe(rv, nameEnv) }
    if (scope.env === 'prod') add('misconfigured', 'Stripe dùng khoá live — chỉ dùng khoá test hoặc restricted key')
  }

  if (!issues.length && !rv.command) {
    if (!remoteHasAuth(srv, rv)) add('unknown', 'đăng nhập OAuth không đọc được từ cấu hình — thử một lệnh đọc rẻ trước khi dùng')
  }
  return { usable: worst(issues.map(([u]) => u)), problems: issues.map(([, m]) => m), warnings, scope }
}

// ---------------------------------------------------------------- check

export function check(projectDir, host, opts = {}) {
  const spec = Object.hasOwn(HOSTS, host) ? HOSTS[host] : null
  if (!spec) throw new Error(`host không hỗ trợ: ${safe(host)} (claude | codex | devin)`)
  const official = opts.official ?? loadOfficial()
  const libs = opts.libs ?? Object.keys(official)
  for (const l of libs) if (!Object.hasOwn(official, l)) throw new Error(`thư viện không có trong official.json: ${safe(l)}`)
  const home = opts.home ?? os.homedir()
  const env = opts.env ?? process.env
  const dirs = projectDirs(projectDir)
  const errors = []
  const ctx = { env, projectDir: path.resolve(projectDir), cfg: null }
  for (const d of dirs) {
    const j = readJson(path.join(d, '.claude', 'flow.json'), [])
    if (isObj(j)) { ctx.cfg = j; break }
  }

  const servers = spec.mcp === 'codex' ? readCodexServers(home, env, errors) : readClaudeServers(home, dirs, errors)
  const skills = listSkills(spec.skillDirs.flatMap((s) => [path.join(home, s, 'skills'), ...dirs.map((d) => path.join(d, s, 'skills'))]))
  const views = servers.map((srv) => ({ srv, rv: resolve(srv, env) }))

  const claimed = new Set()
  const officialSkillNames = new Set(Object.values(official).flatMap((o) => (o.skill?.names ?? []).map((n) => n.toLowerCase())))
  const hits = {} // lib → [{ srv, rv, matchedUrl }]
  for (const lib of Object.keys(official)) {
    if (!official[lib].mcp) continue
    hits[lib] = []
    for (const v of views) {
      const id = identify(v.rv, official[lib].mcp)
      if (id) { hits[lib].push({ ...v, ...id }); claimed.add(v.srv) }
    }
  }

  return libs.map((lib) => {
    const off = official[lib]
    const row = {
      lib, status: 'none', usable: 'unknown', scope: { env: 'unknown' }, problems: [], warnings: [], installCmd: null, installAlt: null,
      sourceOrg: off.sourceOrg, note: off.note ?? '', parts: {}, found: { skills: [], servers: [] },
    }
    if (!off.skill && !off.mcp) return row

    const skillHits = (off.skill?.names ?? []).filter((n) => skills.has(n.toLowerCase()))
    const mcpHits = hits[lib] ?? []
    if (skillHits.length || mcpHits.length) {
      row.status = 'installed'
      row.found = { skills: skillHits, servers: mcpHits.map((h) => safe(h.srv.name)) }
      if (skillHits.length) row.parts.skill = 'ok'
      if (mcpHits.length) {
        const res = mcpHits.map((h) => evalServer(h.srv, h.rv, h.matchedUrl, off.mcp, ctx))
        row.parts.mcp = combine(res.map((r) => r.usable))
        row.problems = res.flatMap((r) => r.problems)
        row.warnings = res.flatMap((r) => r.warnings)
        const envs = res.map((r) => r.scope.env)
        row.scope.env = envs.includes('prod') ? 'prod' : envs.every((e) => e === 'dev') ? 'dev' : 'unknown'
        const ro = res.filter((r) => 'readOnly' in r.scope)
        if (ro.length) row.scope.readOnly = ro.every((r) => r.scope.readOnly)
      }
      row.usable = combine(Object.values(row.parts))
      return row
    }

    row.status = 'missing'
    const kw = lib.toLowerCase()
    const comm = [
      ...views.filter((v) => !claimed.has(v.srv) && [v.srv.name, v.srv.command, ...v.srv.args, v.srv.url].join(' ').toLowerCase().includes(kw)).map((v) => `server "${safe(v.srv.name)}"`),
      ...[...skills.entries()].filter(([k]) => !officialSkillNames.has(k) && k.includes(kw)).map(([, n]) => `skill "${safe(n)}"`),
    ]
    if (comm.length) {
      row.status = 'community-only'
      row.warnings.push(`chỉ có bản không nằm trong danh sách chính hãng: ${comm.join(', ')} — không dùng; cài bản chính hãng`)
    }
    for (const e of errors) row.warnings.push(`${e} — có thể bỏ sót`)
    const mcpCmd = off.mcp?.installCmd?.[spec.mcp] ?? null
    const skillCmd = off.skill?.installCmd ?? null
    row.installCmd = skillCmd ?? mcpCmd
    row.installAlt = skillCmd ? mcpCmd : null
    return row
  })
}

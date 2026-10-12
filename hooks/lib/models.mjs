// models: vai -> dòng model -> model cụ thể MỚI NHẤT có trên máy [vmdk]; ghi đè của user ở ~/.claude/flow.local.json.
// Nguồn vai: kit/roles.json. Claude trả alias (opus|sonnet|haiku, app tự lên đời); Codex đọc models_cache.json / `codex debug models`;
// agy đọc `agy models`. Thuật toán: research.md §2.5 — lọc ẩn, khớp dòng theo TOKEN, xếp số phiên bản, hạ effort nếu không hỗ trợ,
// cảnh báo sắp hết hạn, KHÔNG BAO GIỜ đoán id (không có ứng viên ⇒ model:null để CLI tự dùng mặc định).
// CLI: hooks/models.mjs (pick | set | reset | list). Node built-in, chạy Windows + macOS (không `timeout`, shim .cmd xử lý riêng).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROLES_FILE = path.join(HERE, '..', '..', 'kit', 'roles.json')

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const DAY = 86400000
const CACHE_TTL_MS = 10 * 60 * 1000 // danh sách agy nhớ 10 phút
const CODEX_FILE_MAX_AGE_MS = DAY // models_cache.json cũ hơn 24 giờ ⇒ hỏi `codex debug models`
const RETIRE_WARN_DAYS = 14
const EXEC_TIMEOUT_MS = 15000
const LINE_ALIASES = { 'gemini-flash': 'flash', 'gemini-pro': 'pro' }
// Token không phải tên dòng khi gợi ý "dòng có trên máy".
const NOISE = new Set(['gpt', 'claude', 'gemini', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'thinking', 'preview', 'legacy', 'deprecated', 'fast', 'auto', 'review', 'codex', 'reserve'])

class FlowModelsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const usage = (message) => new FlowModelsError('USAGE', message)

// ---------- registry vai ----------

export function loadRoles(file = ROLES_FILE) {
  let reg
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new FlowModelsError('BAD_REGISTRY', `Không đọc được bảng vai ${file}: ${e.message}`)
  }
  if (!reg || typeof reg.hosts !== 'object' || typeof reg.roles !== 'object') throw new FlowModelsError('BAD_REGISTRY', `Bảng vai ${file} thiếu "hosts" hoặc "roles".`)
  return reg
}

// Tập tên vai có cờ bật: roleSet('receipt') | 'audit' | 'writesCode' — thay danh sách cứng trong flow-gate / flow-dispatch.
export function roleSet(flag, reg = loadRoles()) {
  return new Set(Object.entries(reg.roles).filter(([, r]) => r[flag] === true).map(([name]) => name))
}

function hostLines(reg, host) {
  const l = reg.hosts[host]?.lines
  return Array.isArray(l) ? l : Object.keys(l ?? {})
}

const normalizeLine = (l) => LINE_ALIASES[String(l).toLowerCase()] ?? String(l).toLowerCase()

// ---------- phân tích catalog ----------

const tokensOf = (id) => id.toLowerCase().split(/[-_/:\s]+/).filter(Boolean)
const isNum = (t) => /^\d+(\.\d+)*$/.test(t)

// Số phiên bản = dãy token số liền nhau đầu tiên (6.1 -> [6,1]; 5-5 -> [5,5]; 120b -> không có).
function versionOf(tokens) {
  const i = tokens.findIndex(isNum)
  if (i < 0) return []
  const v = []
  for (let j = i; j < tokens.length && isNum(tokens[j]); j++) v.push(...tokens[j].split('.').map(Number))
  return v
}

function baseEntry(id, order) {
  const tokens = tokensOf(id)
  return { id, tokens, version: versionOf(tokens), priority: null, retirementAt: null, upgradeTo: null, efforts: [], effortIds: null, order }
}

// `codex debug models` / ~/.codex/models_cache.json -> ứng viên hiển thị. Rỗng/hỏng ⇒ [].
export function parseCodexCatalog(input) {
  let data = input
  if (typeof input === 'string') {
    if (!input.trim()) return []
    try { data = JSON.parse(input) } catch { return [] }
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : []
  const out = []
  const seen = new Set()
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.slug !== 'string' || !m.slug.trim() || seen.has(m.slug)) continue
    if (m.visibility !== undefined && m.visibility !== 'list') continue // ẩn (hide) không phải ứng viên
    seen.add(m.slug)
    const e = baseEntry(m.slug, out.length)
    if (Number.isFinite(m.priority)) e.priority = m.priority
    if (Array.isArray(m.supported_reasoning_levels)) e.efforts = m.supported_reasoning_levels.map((l) => (typeof l === 'string' ? l : l?.effort)).filter((x) => typeof x === 'string')
    if (typeof m.upgrade?.retirement_at === 'string') e.retirementAt = m.upgrade.retirement_at
    if (typeof m.upgrade?.model === 'string') e.upgradeTo = m.upgrade.model
    out.push(e)
  }
  return out
}

// `agy models`: mỗi dòng "id<TAB>tên". Mức effort gắn ở đuôi id ⇒ gom các id cùng gốc thành một ứng viên.
export function parseAgyCatalog(text) {
  if (typeof text !== 'string') return []
  const groups = new Map()
  for (const line of text.split(/\r?\n/)) {
    const id = line.split(/\t|\s+-\s+|\s{2,}/)[0].trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._]*(-[A-Za-z0-9._]+)+$/.test(id)) continue // tiêu đề/lỗi không có dạng id-có-dấu-gạch
    const m = /^(.*)-(minimal|low|medium|high|xhigh|max|ultra)$/i.exec(id)
    const base = m ? m[1] : id
    let g = groups.get(base)
    if (!g) { g = { ...baseEntry(base, groups.size), efforts: null }; groups.set(base, g) }
    if (m) {
      g.effortIds ??= {}
      g.effortIds[m[2].toLowerCase()] = id
      g.efforts = Object.keys(g.effortIds)
    }
  }
  return [...groups.values()]
}

// ---------- chọn model ----------

const rank = (e) => EFFORTS.indexOf(String(e).toLowerCase())

// Hạ xuống mức cao nhất ≤ yêu cầu (cách Claude xử lý); thấp hơn mọi mức có ⇒ lấy mức thấp nhất. avail null = model không có khái niệm mức.
function chooseEffort(want, avail) {
  if (avail === null) return null
  if (!avail.length || avail.includes(want)) return want
  const ranked = avail.filter((x) => rank(x) >= 0).sort((a, b) => rank(a) - rank(b))
  if (!ranked.length) return want
  const below = ranked.filter((x) => rank(x) <= rank(want))
  return below.length ? below.at(-1) : ranked[0]
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

// Mới nhất trước: có số phiên bản hơn không có; phiên bản lớn hơn; priority nhỏ hơn; xuất hiện trước.
function byNewest(a, b) {
  if ((a.version.length > 0) !== (b.version.length > 0)) return a.version.length > 0 ? -1 : 1
  return compareVersions(b.version, a.version) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.order - b.order
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)

// entries đã parse -> { id, line, effort, entry, fellBack, warnings } hoặc null. fallback = các dòng thử tiếp khi dòng yêu cầu không có.
export function pickModel(entries, { line, effort, fallback = [], now = Date.now() } = {}) {
  const warnings = []
  const tried = [line, ...fallback].map(normalizeLine)
  for (let i = 0; i < tried.length; i++) {
    const l = tried[i]
    let pool = []
    for (const e of entries) {
      if (!e.tokens.includes(l) || e.tokens.includes('deprecated') || e.tokens.includes('legacy')) continue
      const at = e.retirementAt ? Date.parse(e.retirementAt) : NaN
      if (Number.isFinite(at) && at <= now) { warnings.push(`${e.id} đã hết hạn từ ${ymd(at)}, bỏ qua.`); continue }
      pool.push(e)
    }
    const stable = pool.filter((e) => !e.tokens.includes('preview'))
    pool = (stable.length ? stable : pool).sort(byNewest)
    if (!pool.length) continue
    const entry = pool[0]
    const got = chooseEffort(effort, entry.efforts)
    const id = entry.effortIds ? entry.effortIds[got] ?? entry.id : entry.id
    if (got !== effort && got !== null && effort) warnings.push(`${entry.id} không có mức ${effort}, dùng ${got}.`)
    if (i > 0) warnings.push(`Máy này không có dòng ${tried[0]}, dùng dòng ${l} (${id}).`)
    const at = entry.retirementAt ? Date.parse(entry.retirementAt) : NaN
    if (Number.isFinite(at) && at - now <= RETIRE_WARN_DAYS * DAY) {
      warnings.push(`${entry.id} sẽ hết hạn ngày ${ymd(at)} (còn ${Math.max(1, Math.ceil((at - now) / DAY))} ngày)${entry.upgradeTo ? `, nên chuyển sang ${entry.upgradeTo}` : ''}.`)
    }
    return { id, line: l, effort: got, entry, fellBack: i > 0, warnings }
  }
  return null
}

// ---------- đọc catalog trên máy ----------

const homeOf = (o) => o.home ?? os.homedir()
const nowOf = (o) => o.now ?? Date.now()
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

function isFile(f) {
  try { return fs.statSync(f).isFile() } catch { return false }
}

// Tìm file chạy được trên PATH (Windows: theo PATHEXT, bỏ qua file không đuôi vì không chạy được; macOS: thêm Homebrew + ~/.local/bin).
// env.VIBE_FLOW_PATH_ONLY=1 (kiểm thử) ⇒ chỉ tìm trên PATH, bỏ thư mục quen: máy thật có sẵn codex ở Homebrew không lọt vào bài kiểm "máy trống".
export function findExe(name, env = process.env, home = os.homedir()) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean)
  const win = process.platform === 'win32'
  if (!win && !env.VIBE_FLOW_PATH_ONLY) dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'))
  const exts = win ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const d of dirs) {
    for (const ext of exts) {
      const f = path.join(d, name + ext)
      if (isFile(f)) { try { if (!win) fs.accessSync(f, fs.constants.X_OK) } catch { continue } return f }
    }
  }
  return null
}

// Chạy CLI không shell, đầu ra ra file tạm (không phải pipe) để quá giờ thì giết được mà không kẹt vì tiến trình con còn giữ pipe.
// Chỉ nhận tên/tham số cố định dạng [\w.-]; shim .cmd/.bat (Windows) đi qua cmd.exe với đúng các tham số đó.
function realExec(name, args, { timeoutMs = EXEC_TIMEOUT_MS, env = process.env, home } = {}) {
  if (![name, ...args].every((a) => /^[\w.-]+$/.test(a))) return { ok: false, stdout: '', error: 'tham số không hợp lệ' }
  const file = findExe(name, env, home)
  if (!file) return { ok: false, stdout: '', error: `${name} không có trên PATH` }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-models-'))
  const outFile = path.join(dir, 'out'); const errFile = path.join(dir, 'err')
  const outFd = fs.openSync(outFile, 'w'); const errFd = fs.openSync(errFile, 'w')
  try {
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
    const stdio = ['ignore', outFd, errFd]
    const r = shim
      ? spawnSync(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], { stdio, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: true, env })
      : spawnSync(file, args, { stdio, timeout: timeoutMs, windowsHide: true, env })
    fs.closeSync(outFd); fs.closeSync(errFd)
    if (r.error) return { ok: false, stdout: '', error: r.error.code === 'ETIMEDOUT' ? `${name} không trả lời trong ${Math.round(timeoutMs / 1000)} giây` : r.error.message }
    const stdout = fs.readFileSync(outFile, 'utf8')
    if (r.status !== 0) return { ok: false, stdout, error: `${name} thoát mã ${r.status}` }
    return { ok: true, stdout }
  } finally {
    for (const fd of [outFd, errFd]) { try { fs.closeSync(fd) } catch { /* đã đóng ở nhánh thường */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows có thể còn giữ file tạm của tiến trình con bị giết; để hệ điều hành dọn */ }
  }
}

function execCli(name, args, o) {
  const env = o.env ?? process.env
  const timeoutMs = o.timeoutMs ?? EXEC_TIMEOUT_MS
  return o.exec ? o.exec(name, args, { timeoutMs, env }) : realExec(name, args, { timeoutMs, env, home: homeOf(o) })
}

// Cache danh sách đã parse: ~/.claude/cache/models.json. Hỏng/thiếu ⇒ coi như chưa có (cache sinh lại được).
const cacheFile = (o) => path.join(o.cacheDir ?? path.join(homeOf(o), '.claude', 'cache'), 'models.json')
function readCache(o) {
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(o), 'utf8'))
    return d && typeof d.hosts === 'object' ? d : { hosts: {} }
  } catch { return { hosts: {} } }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmpFile = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmpFile, text)
  fs.renameSync(tmpFile, file)
}
function saveCache(o, host, entries, at) {
  try {
    const d = readCache(o)
    d.hosts[host] = { fetchedAt: at, entries }
    writeAtomic(cacheFile(o), JSON.stringify(d))
    return null
  } catch (e) { return `không ghi được cache model: ${e.message}` }
}

function readCodexFile(o) {
  const file = path.join((o.env ?? process.env).CODEX_HOME || path.join(homeOf(o), '.codex'), 'models_cache.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entries = parseCodexCatalog(data)
    if (!entries.length) return null
    const at = Date.parse(data.fetched_at)
    return { entries, at: Number.isFinite(at) ? at : fs.statSync(file).mtimeMs }
  } catch { return null }
}

// -> { entries, origin: 'live'|'file'|'cache'|'stale'|'none', warnings }. Thất bại ⇒ danh sách đã lưu mới nhất (stale) rồi mới tới 'none'.
function fetchCatalog(host, o) {
  const now = nowOf(o)
  const parse = host === 'codex' ? parseCodexCatalog : parseAgyCatalog
  const cached = readCache(o).hosts[host]
  const stale = cached?.entries?.length ? [{ entries: cached.entries, at: cached.fetchedAt }] : []
  const reasons = []
  const live = (entries) => {
    const w = saveCache(o, host, entries, now)
    return { entries, origin: 'live', warnings: w ? [w] : [] }
  }
  const injected = o.catalog && Object.hasOwn(o.catalog, host) ? o.catalog[host] : undefined
  if (injected !== undefined) {
    const entries = injected === null ? [] : parse(injected)
    if (entries.length) return live(entries)
    reasons.push('danh sách rỗng hoặc không đọc được')
  } else if (host === 'codex') {
    const f = readCodexFile(o)
    if (f && now - f.at <= CODEX_FILE_MAX_AGE_MS) return { entries: f.entries, origin: 'file', warnings: [] }
    if (f) stale.push(f)
    const r = execCli('codex', ['debug', 'models'], o)
    const entries = r.ok ? parseCodexCatalog(r.stdout) : []
    if (entries.length) return live(entries)
    reasons.push(r.ok ? 'codex debug models trả danh sách rỗng' : r.error)
  } else {
    if (stale.length && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < CACHE_TTL_MS) return { entries: cached.entries, origin: 'cache', warnings: [] }
    const r = execCli(host, ['models'], o)
    const entries = r.ok ? parse(r.stdout) : []
    if (entries.length) return live(entries)
    reasons.push(r.ok ? `${host} models trả danh sách rỗng (chưa đăng nhập hoặc mất mạng?)` : r.error)
  }
  const best = stale.sort((a, b) => b.at - a.at)[0]
  if (best) return { entries: best.entries, origin: 'stale', warnings: [`Không đọc được danh sách model ${host} lúc này (${reasons.join('; ')}), dùng danh sách đã lưu lúc ${stamp(best.at)}.`] }
  return { entries: [], origin: 'none', warnings: [`Không đọc được danh sách model ${host} (${reasons.join('; ')}).`] }
}

function loadCatalog(host, o) {
  if (o.memo?.has(host)) return o.memo.get(host)
  const c = fetchCatalog(host, o)
  o.memo?.set(host, c)
  return c
}

// ---------- ghi đè của user ----------

export const localConfigPath = (o = {}) => path.join(homeOf(o), '.claude', 'flow.local.json')

function readLocal(o) {
  const file = localConfigPath(o)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { data: {}, error: null }
    return { data: {}, error: e.message }
  }
  try {
    const d = JSON.parse(text.replace(/^﻿/, ''))
    if (d && typeof d === 'object' && !Array.isArray(d)) return { data: d, error: null }
    return { data: {}, error: 'không phải object' }
  } catch (e) {
    return { data: {}, error: e.message.replace(/\s+/g, ' ') }
  }
}

function readLocalOrFail(o) {
  const l = readLocal(o)
  if (l.error) throw usage(`flow.local.json đang hỏng (${l.error}); sửa hoặc xoá file rồi thử lại: ${localConfigPath(o)}`)
  return l.data
}

function lookup(reg, host, role) {
  if (!reg.hosts[host]) throw new FlowModelsError('NO_HOST', `Không có app "${host}". App có: ${Object.keys(reg.hosts).join(', ')}.`)
  const r = reg.roles[role]
  if (!r) throw new FlowModelsError('NO_ROLE', `Không có vai "${role}". Vai có: ${Object.keys(reg.roles).join(', ')}.`)
  if (!r.models?.[host]) throw new FlowModelsError('NO_MODEL_FOR_HOST', `Vai ${role} không chạy trên ${host}; chạy được trên: ${Object.keys(r.models ?? {}).join(', ')}.`)
  return r.models[host]
}

// Tên dòng có trên máy: Claude theo alias của kit; Codex/agy suy từ danh sách thật (token chữ, bỏ tên hãng/mức); không đọc được ⇒ dòng đã biết của host.
function availableLines(reg, host, o) {
  if (host === 'claude') return hostLines(reg, host)
  const entries = loadCatalog(host, o).entries
  if (!entries.length) return hostLines(reg, host)
  const lines = []
  for (const e of entries) for (const t of e.tokens) if (/^[a-z]+$/.test(t) && !NOISE.has(t) && !lines.includes(t)) lines.push(t)
  return lines
}

export function setOverride(role, host, spec, opts = {}) {
  const reg = opts.roles ?? loadRoles()
  if (!reg.roles[role]) throw usage(`Không có vai "${role}". Vai có: ${Object.keys(reg.roles).join(', ')}.`)
  if (!reg.hosts[host]) throw usage(`Không có app "${host}". App có: ${Object.keys(reg.hosts).join(', ')}.`)
  if (!reg.roles[role].models[host]) throw usage(`Vai ${role} không chạy trên ${host}; chạy được trên: ${Object.keys(reg.roles[role].models).join(', ')}.`)
  const parts = String(spec ?? '').split(':')
  if (!parts[0].trim() || parts.length > 2) throw usage('Cú pháp: set <vai> <app> <dòng>[:mức], ví dụ sol:high.')
  const line = normalizeLine(parts[0].trim())
  const effort = parts[1]?.trim().toLowerCase()
  if (parts.length === 2 && !EFFORTS.includes(effort)) throw usage(`Mức "${parts[1]}" không có. Mức có: ${EFFORTS.slice(1).join(', ')}.`)
  const lines = availableLines(reg, host, opts)
  if (!lines.includes(line)) throw usage(`Máy này không có dòng "${parts[0].trim()}" cho ${host}. Dòng có: ${lines.join(', ')}.`)
  const data = readLocalOrFail(opts)
  data.models = data.models && typeof data.models === 'object' ? data.models : {}
  data.models[role] = data.models[role] && typeof data.models[role] === 'object' ? data.models[role] : {}
  data.models[role][host] = effort ? { line, effort } : { line }
  writeAtomic(localConfigPath(opts), `${JSON.stringify(data, null, 2)}\n`)
  return { role, host, line, effort: effort ?? null }
}

// Gỡ ghi đè (một app hoặc cả vai). Không có gì để gỡ ⇒ { removed:false } và không tạo file.
export function resetOverride(role, host, opts = {}) {
  const reg = opts.roles ?? loadRoles()
  if (!reg.roles[role]) throw usage(`Không có vai "${role}". Vai có: ${Object.keys(reg.roles).join(', ')}.`)
  const data = readLocalOrFail(opts)
  const mine = data.models?.[role]
  if (!mine || typeof mine !== 'object' || (host && !(host in mine))) return { removed: false }
  if (host) delete mine[host]
  if (!host || !Object.keys(mine).length) delete data.models[role]
  if (!Object.keys(data.models).length) delete data.models
  writeAtomic(localConfigPath(opts), `${JSON.stringify(data, null, 2)}\n`)
  return { removed: true }
}

// ---------- resolve ----------

// resolve(host, role) -> { model, effort, source:'alias'|'catalog'|'fallback'|'user', line, host, role, escalated, warnings }
//  alias: Claude (tên dòng) · catalog: bản mới nhất từ danh sách trên máy · fallback: lùi dòng khác / danh sách đã lưu / model:null (CLI tự dùng mặc định)
//  · user: theo ~/.claude/flow.local.json. escalate: dùng bậc leo thang của vai (Claude: Opus high; Codex: Astra) khi hỏng 2 lần.
export function resolve(host, role, opts = {}, { escalate = false } = {}) {
  const reg = opts.roles ?? loadRoles()
  const base = lookup(reg, host, role)
  const warnings = []
  const useEsc = escalate && !!base.escalate
  const spec = useEsc ? base.escalate : base
  let want = { line: spec.line, effort: spec.effort }
  let user = false
  if (!escalate) {
    const local = readLocal(opts)
    if (local.error) warnings.push(`File cấu hình riêng flow.local.json hỏng (${local.error}), đang dùng mặc định.`)
    const ov = local.data.models?.[role]?.[host]
    if (ov && typeof ov.line === 'string') { want = { line: normalizeLine(ov.line), effort: ov.effort ?? spec.effort }; user = true }
  }
  const out = { host, role, line: want.line, escalated: useEsc }
  if (host === 'claude') {
    if (!hostLines(reg, 'claude').includes(want.line)) {
      warnings.push(`Dòng "${want.line}" trong flow.local.json không phải ${hostLines(reg, 'claude').join('/')}, dùng mặc định.`)
      want = { line: spec.line, effort: spec.effort }; user = false
    }
    return { ...out, line: want.line, model: want.line, effort: want.effort, source: user ? 'user' : 'alias', warnings }
  }
  const cat = loadCatalog(host, opts)
  warnings.push(...cat.warnings)
  const chain = [...new Set([...(user ? [spec.line] : []), ...(reg.hosts[host].lines?.[want.line] ?? [])])]
  const pick = cat.entries.length ? pickModel(cat.entries, { line: want.line, effort: want.effort, fallback: chain, now: nowOf(opts) }) : null
  if (!pick) {
    warnings.push(`Không chọn được model dòng ${want.line} cho ${host}; CLI sẽ dùng model mặc định của nó.`)
    return { ...out, model: null, effort: want.effort, source: 'fallback', warnings }
  }
  warnings.push(...pick.warnings)
  const source = pick.fellBack || cat.origin === 'stale' ? 'fallback' : user ? 'user' : 'catalog'
  return { ...out, line: pick.line, model: pick.id, effort: pick.effort, source, warnings }
}

// ---------- CLI ----------

const HELP = `Dùng:
  models.mjs pick <app> <vai> [--escalate] [--json] [--field model|effort|source]
  models.mjs set <vai> <app> <dòng>[:mức]     vd: set debugger claude opus:high
  models.mjs reset <vai> [<app>]
  models.mjs list [--json]
App: claude, codex, agy.`
const SOURCE_LABEL = { alias: 'tên dòng', catalog: 'danh sách máy', fallback: 'dự phòng', user: 'bạn đặt' }

function parseArgs(argv) {
  const pos = []; const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--escalate') flags[a.slice(2)] = true
    else if (a === '--field') flags.field = argv[++i]
    else if (a.startsWith('--')) throw usage(`Cờ lạ ${a}.\n${HELP}`)
    else pos.push(a)
  }
  return { pos, flags }
}

function dispatch(argv, opts, out, err) {
  const { pos, flags } = parseArgs(argv)
  const [cmd, ...rest] = pos
  switch (cmd) {
    case 'pick': {
      if (rest.length !== 2) throw usage(HELP)
      const r = resolve(rest[0], rest[1], opts, { escalate: !!flags.escalate })
      for (const w of r.warnings) err(`! ${w}\n`)
      if (flags.json) out(`${JSON.stringify(r)}\n`)
      else if (flags.field) out(`${r[flags.field] ?? ''}\n`)
      else if (r.model) out(`${r.model}\n`)
      return r.model ? 0 : 3
    }
    case 'set': {
      if (rest.length !== 3) throw usage(HELP)
      const s = setOverride(rest[0], rest[1], rest[2], opts)
      const r = resolve(s.host, s.role, opts)
      for (const w of r.warnings) err(`! ${w}\n`)
      out(`Đã đặt ${s.role} (${s.host}) = ${s.line}${s.effort ? `:${s.effort}` : ''} → ${r.model ?? 'model mặc định của CLI'}\n`)
      return 0
    }
    case 'reset': {
      if (rest.length < 1 || rest.length > 2) throw usage(HELP)
      const { removed } = resetOverride(rest[0], rest[1], opts)
      out(removed ? `Đã trả ${rest[0]}${rest[1] ? ` (${rest[1]})` : ''} về mặc định.\n` : `${rest[0]} đang dùng mặc định.\n`)
      return 0
    }
    case 'list': {
      if (rest.length) throw usage(HELP)
      const reg = opts.roles ?? loadRoles()
      const o = { ...opts, memo: new Map() }
      const rows = []
      for (const [role, def] of Object.entries(reg.roles)) for (const host of Object.keys(def.models)) rows.push({ role, ...resolve(host, role, o) })
      if (flags.json) { out(`${JSON.stringify(rows)}\n`); return 0 }
      const cells = rows.map((r) => [r.role, r.host, `${r.line}:${r.effort ?? '-'}`, r.model ?? '(mặc định CLI)', SOURCE_LABEL[r.source]])
      const table = [['vai', 'app', 'dòng:mức', 'model', 'nguồn'], ...cells]
      const widths = table[0].map((_, c) => Math.max(...table.map((row) => [...row[c]].length)))
      for (const row of table) out(`${row.map((v, c) => v + ' '.repeat(widths[c] - [...v].length)).join('  ').trimEnd()}\n`)
      for (const w of new Set(rows.flatMap((r) => r.warnings))) err(`! ${w}\n`)
      return 0
    }
    default:
      throw usage(HELP)
  }
}

// Trả exit code: 0 xong · 2 dùng sai/tên không có · 3 không chọn được model (stdout rỗng) · 1 lỗi khác.
export function runCli(argv, io = {}) {
  const { out: o, err: e, ...opts } = io
  const out = o ?? ((s) => process.stdout.write(s))
  const err = e ?? ((s) => process.stderr.write(s))
  try {
    return dispatch(argv, opts, out, err)
  } catch (ex) {
    if (!(ex instanceof FlowModelsError)) { err(`models: lỗi không mong đợi: ${ex.message}\n`); return 1 }
    err(`${ex.message}\n`)
    return ex.code === 'BAD_REGISTRY' ? 1 : 2
  }
}

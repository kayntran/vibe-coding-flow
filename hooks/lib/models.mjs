// models: vai -> HẠNG (manh > vua > nhanh) -> model cụ thể có trên máy [vmdk]; ghi đè của user ở ~/.claude/flow.local.json.
// Nguồn vai: kit/roles.json. Claude trả alias (opus|sonnet|haiku, app tự lên đời); Codex đọc models_cache.json / `codex debug models`;
// agy đọc `agy models`; Factory đọc cuối `droid exec --help`. Id LUÔN lấy từ danh sách đó (không đoán: không có ứng viên ⇒ model:null để CLI
// tự dùng mặc định); dữ liệu ngoài danh sách chỉ dùng để XẾP HẠNG cho dòng, và chỉ là thông tin có sẵn trên máy (không tra mạng [kstu]).
// Thuật toán: lọc mục không phải model làm việc (skip/ẩn/legacy) → gom theo dòng → xếp hạng (bảng gợi ý kit > mô tả nhà cung cấp > từ khoá tên >
// đời mới hơn dòng đã biết cùng họ) → chọn bản mới nhất → hạ effort nếu không hỗ trợ → cảnh báo sắp hết hạn. Thiếu hạng: Factory (chỉ khi
// người gọi bật allowFallbackHost) → hạng kề thấp hơn → null.
// CLI: hooks/models.mjs (pick | set | reset | list | refresh). Node built-in, chạy Windows + macOS (không `timeout`, shim .cmd xử lý riêng).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CLI_NAMES, resolveBin } from './clis.mjs'
import { homeKey, label as accountLabel, listHomes, order as orderHomes, readState, statePath } from './codex-accounts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROLES_FILE = path.join(HERE, '..', '..', 'kit', 'roles.json')

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const DAY = 86400000
const CACHE_TTL_MS = 10 * 60 * 1000 // danh sách agy/droid nhớ 10 phút
const CODEX_FILE_MAX_AGE_MS = DAY // models_cache.json cũ hơn 24 giờ ⇒ hỏi `codex debug models`
const NOTICE_STALE_MS = 6 * 60 * 60 * 1000 // session-start: cache cũ hơn 6 giờ ⇒ kích làm tươi nền (không chờ)
const REFRESH_GRACE_MS = 10 * 60 * 1000 // khoá làm tươi nền hết hạn sau 10 phút
const RETIRE_WARN_DAYS = 14
const EXEC_TIMEOUT_MS = 15000
const LINE_ALIASES = { 'gemini-flash': 'flash', 'gemini-pro': 'pro' }

// Hạng: mạnh > vừa > nhanh. 'chua-xep' = không đủ thông tin ⇒ không bao giờ tự dùng (AC-11).
export const TIERS = ['manh', 'vua', 'nhanh']
const TIER_LABEL = { manh: 'mạnh', vua: 'vừa', nhanh: 'nhanh', 'chua-xep': 'chưa xếp' }
const HOST_LABEL = { claude: 'Claude', codex: 'Codex', agy: 'agy', droid: 'Factory', 'cursor-agent': 'Cursor', grok: 'Grok', qodercli: 'Qoder' }
const VENDORS = new Set(['gpt', 'claude', 'gemini']) // tên nhà, không phải tên dòng
// Token không làm tên dòng: tên nhà, mức effort, nhãn phụ.
const IGNORE_LINE = new Set([...VENDORS, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'off', 'thinking', 'preview', 'latest', 'codex', 'cursor'])
// Mục không phải model để làm việc: bộ điều phối, model duyệt tự động, model ẩn, bản cũ. roles.json (hosts.*.skip) ghi đè được.
// Biến thể "chế độ nhanh" của cùng một model (hậu tố -fast: claude-opus-5-5-fast) cũng bị bỏ, nhưng chữ `fast` KHÔNG nằm trong skip: luật từ khoá fast ⇒ nhanh vẫn áp.
const DEFAULT_SKIP = ['orchestrator', 'auto', 'review', 'reserve', 'deprecated', 'legacy']
const NHANH_WORD = /^(flash|mini|lite|nano|haiku|luna|small|fast)$/
const MANH_WORD = /^(opus|pro|ultra|premium|max)$/
const HIGH_EFFORTS = ['xhigh', 'max', 'ultra']

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

// Dòng đã biết của host: Claude ghi `lines` (alias); host theo hạng ghi `tiers` (gom các danh sách ưu tiên).
function hostLines(reg, host) {
  const cfg = reg.hosts[host]
  if (cfg?.tiers) return [...new Set(TIERS.flatMap((t) => cfg.tiers[t] ?? []))]
  const l = cfg?.lines
  return Array.isArray(l) ? l : Object.keys(l ?? {})
}

const normalizeLine = (l) => LINE_ALIASES[String(l).toLowerCase()] ?? String(l).toLowerCase()
const tierOfLine = (cfg, line) => (line ? TIERS.find((t) => cfg?.tiers?.[t]?.includes(normalizeLine(line))) ?? null : null)

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

// desc = mô tả nhà cung cấp tự ghi (Codex); alias = mẫu "mới nhất trong hạng" của droid (không phải model cụ thể).
function baseEntry(id, order) {
  const tokens = tokensOf(id)
  return { id, tokens, version: versionOf(tokens), priority: null, retirementAt: null, upgradeTo: null, efforts: [], effortIds: null, desc: null, alias: false, order }
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
    if (typeof m.description === 'string') e.desc = m.description
    out.push(e)
  }
  return out
}

// `agy models`: mỗi dòng "id<TAB>tên". Mức effort gắn ở đuôi id ⇒ gom các id cùng gốc thành một ứng viên.
// Danh sách "id<TAB hoặc ' - '>tên", mức effort nằm ở đuôi id ⇒ gom các id cùng gốc thành một ứng viên (effortIds: mức → id thật). effortRe: nhóm 1 = gốc, 2 = mức, 3 (tuỳ chọn) = đuôi giữ lại.
function groupEffortIds(text, effortRe, { skipFast = false } = {}) {
  if (typeof text !== 'string') return []
  const groups = new Map()
  for (const line of text.split(/\r?\n/)) {
    const id = line.split(/\t|\s+-\s+|\s{2,}/)[0].trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._]*(-[A-Za-z0-9._]+)+$/.test(id)) continue // tiêu đề/lỗi không có dạng id-có-dấu-gạch
    if (skipFast && /-fast$/i.test(id)) continue // biến thể chế độ nhanh của cùng model
    const m = effortRe.exec(id)
    const base = m ? m[1] + (m[3] ?? '') : id
    let g = groups.get(base)
    if (!g) { g = { ...baseEntry(base, groups.size), efforts: null }; groups.set(base, g) }
    if (/\(NO ZDR\)/i.test(line)) g.noZdr = true // Cursor: model không giữ lời hứa "không lưu dữ liệu" — chỉ ghi cờ, không loại
    if (m) {
      g.effortIds ??= {}
      g.effortIds[m[2].toLowerCase().replace('extra-high', 'xhigh')] = id
      g.efforts = Object.keys(g.effortIds)
    }
  }
  return [...groups.values()]
}

// `agy models`: mỗi dòng "id<TAB>tên". Mức effort gắn ở đuôi id.
export const parseAgyCatalog = (text) => groupEffortIds(text, /^(.*)-(minimal|low|medium|high|xhigh|max|ultra)$/i)

// `cursor-agent models` [KIỂM 2026.11.22]: tiêu đề "Available models", dòng "id - Tên" (tên có thể kèm "(NO ZDR)", "(default)", "(current)"), dòng "Tip: …".
// Id dạng <dòng>-<mức> với mức = none|minimal|low|medium|high|xhigh|max|extra-high (bản mới dùng xhigh), có thể kèm `-thinking` (trước hoặc sau mức) và đuôi `-fast`
// (chế độ nhanh ⇒ bỏ); một số id không có mức (gpt-5.2, composer-2.5); `auto` = để Cursor tự chọn ⇒ không phải ứng viên (không có dấu gạch nên tự bị bỏ).
export const parseCursorModels = (text) => groupEffortIds(text, /^(.*?)-(none|minimal|low|medium|high|xhigh|max|extra-high)(-thinking)?$/i, { skipFast: true })

// `grok models` [KIỂM grok 1.0.92]: "You are logged in with grok.com." · "Default model: grok-4.7" · "Available models:" rồi từng dòng "  * grok-4.7 (default)". Không có mức effort.
export function parseGrokModels(text) {
  if (typeof text !== 'string') return []
  const out = []
  let inList = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*available models\s*:?\s*$/i.test(line)) { inList = true; continue }
    const m = inList ? /^\s*\*?\s*([A-Za-z0-9][\w.-]*)(?:\s*\(.*\))?\s*$/.exec(line) : null
    if (m && !out.some((e) => e.id === m[1])) out.push({ ...baseEntry(m[1], out.length), efforts: null })
  }
  return out
}

// `qodercli --list-models` [KIỂM 1.1.65]: máy chỉ có tài khoản miễn phí in tiêu đề "MODEL" trên stdout và "Warning: no models available for your account." trên stderr ⇒ danh sách rỗng.
// Dòng của bảng khi có model (chưa gặp thật, suy từ tiêu đề cột): cột đầu là id. Qoder chọn model miễn phí do nhà cung cấp tự quyết ⇒ host providerPicks (không truyền -m).
export function parseQoderModels(text) {
  if (typeof text !== 'string') return []
  const out = []
  let inTable = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*MODEL\b/.test(line)) { inTable = true; continue }
    const id = inTable ? /^\s*([A-Za-z0-9][\w.-]*)(?:\s|$)/.exec(line)?.[1] : null
    if (id && !/^warning$/i.test(id) && !out.some((e) => e.id === id)) out.push({ ...baseEntry(id, out.length), efforts: null })
  }
  return out
}

// `droid exec --help` (droid không có lệnh `models`): "Available Models:" = id + tên hiển thị ("[Deprecated]" bị bỏ, "(default)" chỉ là nhãn),
// "Model details:" = mức effort theo tên hiển thị (không hỗ trợ/không có dòng ⇒ efforts null ⇒ không truyền -r), "Pinning the Latest Model:" =
// alias hạng `openai-latest-{premium,balanced,…}` ⇒ mục alias (chỉ làm tín hiệu hạng hoặc dự phòng cuối, không bao giờ qua pickModel).
export function parseDroidHelp(text) {
  if (typeof text !== 'string') return []
  const lines = text.split(/\r?\n/)
  const section = (title) => {
    const i = lines.findIndex((l) => l.trim() === title)
    const out = []
    for (let j = i < 0 ? lines.length : i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out.push(lines[j])
    return out
  }
  const efforts = new Map()
  for (const l of section('Model details:')) {
    const m = /^\s*-\s+(.+?):\s+supports reasoning:\s*(Yes|No);\s*supported:\s*\[([^\]]*)\]/i.exec(l)
    if (m) efforts.set(m[1].trim(), /yes/i.test(m[2]) ? m[3].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null)
  }
  const out = []
  const seen = new Set()
  for (const l of section('Available Models:')) {
    const m = /^\s+([A-Za-z0-9][\w.:-]*)\s{2,}(\S.*?)\s*$/.exec(l)
    if (!m || seen.has(m[1])) continue
    const name = m[2].replace(/\s*\(default\)\s*$/i, '')
    if (/\[deprecated\]/i.test(name)) continue
    seen.add(m[1])
    const e = baseEntry(m[1], out.length)
    e.efforts = efforts.get(name) ?? null
    out.push(e)
  }
  for (const m of text.matchAll(/^[ \t]+([a-z]+)-latest-\{([a-z,]+)\}/gm)) {
    for (const t of m[2].split(',')) {
      const id = `${m[1]}-latest-${t}`
      if (!seen.has(id)) { seen.add(id); out.push({ ...baseEntry(id, out.length), alias: true, efforts: null }) }
    }
  }
  return out
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

// ---------- hạng: gom dòng, xếp hạng, chọn theo hạng ----------

const skipSet = (cfg) => new Set(cfg?.skip ?? DEFAULT_SKIP)

// Dòng của id = token chữ đầu tiên không phải tên nhà, số, mức effort hay token skip: gemini-4-neon-high → neon, gpt-6-sol → sol, gpt-5.5 → null (bỏ).
export function lineOf(idOrTokens, cfg = {}) {
  const tokens = typeof idOrTokens === 'string' ? tokensOf(idOrTokens) : idOrTokens
  const skip = skipSet(cfg)
  return tokens.find((t) => /^[a-z]{2,}$/.test(t) && !IGNORE_LINE.has(t) && !skip.has(t)) ?? null
}

// Ứng viên làm việc: bỏ alias, mục có token skip (orchestrator, auto, review, reserve…), biến thể hậu tố -fast và mục nhà cung cấp tự ghi "Legacy".
export function usableEntries(entries, cfg = {}) {
  const skip = skipSet(cfg)
  return entries.filter((e) => !e.alias && e.tokens.at(-1) !== 'fast' && !e.tokens.some((t) => skip.has(t)) && !/\blegacy\b/i.test(e.desc ?? ''))
}

// Gom theo dòng, giữ thứ tự xuất hiện. Mỗi nhóm: bản mới nhất (newest), đời (version), họ (family: tên nhà, không có thì chính dòng), mức effort của bản đó.
function groupsOf(entries, cfg) {
  const by = new Map()
  for (const e of usableEntries(entries, cfg)) {
    const line = lineOf(e.tokens, cfg)
    if (!line) continue
    if (!by.has(line)) by.set(line, { line, entries: [] })
    by.get(line).entries.push(e)
  }
  for (const g of by.values()) {
    g.newest = [...g.entries].sort(byNewest)[0]
    g.version = g.newest.version
    g.family = VENDORS.has(g.newest.tokens[0]) ? g.newest.tokens[0] : g.line
    g.efforts = g.newest.efforts ?? []
  }
  return [...by.values()]
}

// Dòng chưa có trong bảng gợi ý. Tín hiệu theo thứ tự tin cậy, chỉ dùng thông tin trên máy [kstu]: (1) nhà cung cấp tự khai (mô tả Codex);
// (2) từ khoá tên; (3) CHỈ host tách mức effort theo hạng (cfg.tierByEffort, agy): đời ≥ đời mới nhất của dòng đã biết cùng họ, có mức xhigh trở lên ⇒ manh,
// tối đa high ⇒ vua — Codex/Factory thì không dùng mức effort để phân hạng (gpt-6-luna cũng có xhigh, max); (4) không đủ ⇒ chua-xep.
function rankGroup(g, known, cfg) {
  const desc = g.newest.desc ?? '' // mô tả của BẢN MỚI NHẤT (bản sẽ được chọn); nối mô tả mọi bản thì chữ "frontier" của bản cũ kéo bản nhanh mới nhất lên hạng mạnh
  // Mô tả khớp cả nhóm mạnh lẫn nhanh ("Frontier model. Fast and capable for the hardest tasks.") ⇒ lấy tín hiệu MẠNH trước, kẻo dòng mới mạnh nhất bị đẩy xuống hạng nhanh.
  if (/\b(frontier|flagship|most capable|strongest|hardest)\b/i.test(desc)) return ['manh', 'desc', 'nhà cung cấp tự khai mạnh nhất']
  if (/\b(fast|affordable|easier|simpler)\b/i.test(desc)) return ['nhanh', 'desc', 'nhà cung cấp tự khai nhanh/rẻ']
  if (/\bbalanced\b/i.test(desc)) return ['vua', 'desc', 'nhà cung cấp tự khai cân bằng']
  const quick = g.newest.tokens.find((t) => NHANH_WORD.test(t))
  if (quick) return ['nhanh', 'keyword', `tên có "${quick}"`]
  const strong = g.newest.tokens.find((t) => MANH_WORD.test(t))
  if (strong) return ['manh', 'keyword', `tên có "${strong}"`]
  const ref = known.get(g.family)
  if (cfg.tierByEffort && ref?.length && g.version.length && g.efforts.length && compareVersions(g.version, ref) >= 0) {
    const high = g.efforts.some((x) => HIGH_EFFORTS.includes(x))
    return [high ? 'manh' : 'vua', 'gen', `đời ${g.version.join('.')} ≥ ${ref.join('.')} cùng họ ${g.family}, ${high ? 'có mức xhigh trở lên' : 'tối đa mức high'}`]
  }
  if (cfg.defaultTier) return [cfg.defaultTier, 'default', `host này coi mọi dòng chưa biết là hạng ${TIER_LABEL[cfg.defaultTier]}`] // vd Qoder: model miễn phí do nhà cung cấp chọn
  return ['chua-xep', 'none', 'không đủ thông tin để xếp']
}

// entries (đã parse) + cấu hình host (kit/roles.json hosts.<host>) -> { manh: [nhóm…], vua: […], nhanh: […], 'chua-xep': […] }.
// Nhóm: { line, family, version, efforts, entries, newest, tier, source: 'hint'|'desc'|'keyword'|'gen'|'none', reason }.
export function classify(entries, cfg = {}) {
  const groups = groupsOf(entries, cfg)
  const hintOf = new Map()
  for (const t of TIERS) for (const l of cfg.tiers?.[t] ?? []) if (!hintOf.has(l)) hintOf.set(l, t)
  const known = new Map() // họ -> đời mới nhất trong các dòng của bảng gợi ý có mặt trên máy
  for (const g of groups) {
    const t = hintOf.get(g.line)
    if (!t) continue
    Object.assign(g, { tier: t, source: 'hint', reason: 'bảng gợi ý của kit' })
    if (!known.has(g.family) || compareVersions(g.version, known.get(g.family)) > 0) known.set(g.family, g.version)
  }
  for (const g of groups) if (!g.tier) [g.tier, g.source, g.reason] = rankGroup(g, known, cfg)
  const out = { manh: [], vua: [], nhanh: [], 'chua-xep': [] }
  for (const g of groups) out[g.tier].push(g)
  return out
}

// Hai nhóm cùng hạng: cùng họ ⇒ đời mới hơn thắng; khác họ ⇒ họ `prefer` của host thắng; còn lại giữ bên đứng trước (thứ tự tiers rồi thứ tự danh sách).
function better(c, best, prefer) {
  if (c.family === best.family) return compareVersions(c.version, best.version) > 0
  return Boolean(prefer) && c.family === prefer && best.family !== prefer
}

// Model tốt nhất của một hạng: -> { id, line, effort, entry, fellBack, warnings, tier, group } hoặc null.
// Id luôn có trong danh sách. Không có model cụ thể mà host có alias hạng (droid) và help liệt kê alias đó ⇒ trả alias (effort null: alias không có danh sách mức).
export function pickTier(entries, cfg, tier, { effort, now = Date.now() } = {}) {
  const groups = classify(entries, cfg)[tier] ?? []
  const order = cfg.tiers?.[tier] ?? []
  const rankIn = (g) => (g.source === 'hint' ? order.indexOf(g.line) : order.length)
  const left = [...groups].sort((a, b) => rankIn(a) - rankIn(b))
  while (left.length) {
    let best = left[0]
    for (const c of left.slice(1)) if (better(c, best, cfg.prefer)) best = c
    const p = pickModel(best.entries, { line: best.line, effort, now })
    if (p) return { ...p, tier, group: best }
    left.splice(left.indexOf(best), 1) // cả nhóm đã hết hạn ⇒ thử nhóm kế
  }
  const alias = cfg.aliases?.[tier]
  const a = alias ? entries.find((e) => e.alias && e.id === alias) : null
  return a ? { id: a.id, line: null, effort: null, entry: a, fellBack: false, warnings: [], tier, group: null } : null
}

// ---------- đọc catalog trên máy ----------

const homeOf = (o) => o.home ?? os.homedir()
const nowOf = (o) => o.now ?? Date.now()
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

function isFile(f) {
  try { return fs.statSync(f).isFile() } catch { return false }
}

// Tìm file chạy được. CLI của kit (CLI_NAMES): dùng chung resolveBin của clis.mjs (PATH → thư mục cài quen của từng CLI, Windows theo PATHEXT) để `cli-check`
// và chọn model luôn thấy cùng một bản kể cả khi PATH thưa (app mở từ GUI/ssh). Tên khác (vd rg của install.mjs): chỉ PATH (macOS thêm Homebrew + ~/.local/bin).
// env.VIBE_FLOW_PATH_ONLY=1 (kiểm thử) ⇒ chỉ tìm trên PATH, bỏ thư mục quen.
export function findExe(name, env = process.env, home = os.homedir()) {
  if (CLI_NAMES.includes(name)) return resolveBin(name, { env, home })
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
// Đọc-sửa-ghi cache (giữ mọi khoá khác như seenLines). Không ghi được ⇒ trả lý do, không ném.
function updateCache(o, fn) {
  try {
    const d = readCache(o)
    fn(d)
    writeAtomic(cacheFile(o), JSON.stringify(d))
    return null
  } catch (e) { return `không ghi được cache model: ${e.message}` }
}
const saveCache = (o, host, entries, at) => updateCache(o, (d) => { d.hosts[host] = { fetchedAt: at, entries } })

// Codex có thể có NHIỀU tài khoản (mỗi CODEX_HOME một models_cache.json, danh sách model KHÁC nhau): mỗi mục nhớ những tài khoản có nó (`homes`).
const defaultCodexHome = (o) => path.resolve((o.env ?? process.env).CODEX_HOME || path.join(homeOf(o), '.codex'))
function codexHomes(o) {
  const hs = listHomes({ env: o.env ?? process.env, home: homeOf(o) })
  return hs.length ? hs : [defaultCodexHome(o)]
}
const withHome = (entries, dir) => entries.map((e) => ({ ...e, homes: [dir] }))

// Gộp danh sách của nhiều tài khoản: cùng id ⇒ một mục, homes = các tài khoản có nó, mức effort gộp.
function mergeByHome(parts) {
  const by = new Map()
  for (const entries of parts) {
    for (const e of entries) {
      const cur = by.get(e.id)
      if (!cur) { by.set(e.id, { ...e, homes: [...(e.homes ?? [])], efforts: e.efforts ? [...e.efforts] : e.efforts, order: by.size }); continue }
      for (const h of e.homes ?? []) if (!cur.homes.some((x) => homeKey(x) === homeKey(h))) cur.homes.push(h)
      for (const x of e.efforts ?? []) if (cur.efforts && !cur.efforts.includes(x)) cur.efforts.push(x)
    }
  }
  return [...by.values()]
}

// Codex ghi lại models_cache.json mỗi lần khởi động: đọc trúng lúc đang ghi ⇒ JSON hỏng ⇒ đợi rồi đọc lại (tối đa ~1 s; `tries`=1 cho hook không được chờ).
// Trả null ở đây khiến model = null và CLI rơi về model mặc định trong config.toml — có thể là bản tài khoản không còn dùng được.
function readCodexFile(o, tries = 6, dir = defaultCodexHome(o)) {
  const file = path.join(dir, 'models_cache.json')
  for (let i = 0; i < tries; i++) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const entries = withHome(parseCodexCatalog(data), dir)
      if (!entries.length) return null
      const at = Date.parse(data.fetched_at)
      return { entries, at: Number.isFinite(at) ? at : fs.statSync(file).mtimeMs }
    } catch (e) {
      if (e?.code === 'ENOENT') return null
      if (i + 1 < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
  }
  return null
}

const PARSERS = { codex: parseCodexCatalog, agy: parseAgyCatalog, droid: parseDroidHelp, 'cursor-agent': parseCursorModels, grok: parseGrokModels, qodercli: parseQoderModels }
const CLI_ARGS = { agy: ['models'], droid: ['exec', '--help'], 'cursor-agent': ['models'], grok: ['models'], qodercli: ['--list-models'] } // lệnh liệt kê model (không tốn lượt); codex có `debug models` riêng bên dưới

// -> { entries, origin: 'live'|'file'|'cache'|'stale'|'injected'|'none', at?, warnings }. Thất bại ⇒ danh sách đã lưu mới nhất (stale) rồi mới tới 'none'.
// Tuỳ chọn: o.cacheTtlMs (mặc định 10 phút) · o.cacheOnly (hook: chỉ đọc file/cache, không gọi CLI, không kiểm tuổi) · o.entries[host] (đã parse sẵn, không ghi cache).
function fetchCatalog(host, o) {
  const now = nowOf(o)
  const parse = PARSERS[host]
  if (!parse) return { entries: [], origin: 'none', warnings: [`Không có cách đọc danh sách model của ${host}.`] }
  if (o.entries && Object.hasOwn(o.entries, host)) return { entries: o.entries[host], origin: 'injected', warnings: [] }
  const cached = readCache(o).hosts[host]
  if (o.cacheOnly) {
    const files = host === 'codex' ? codexHomes(o).map((d) => readCodexFile(o, 1, d)).filter(Boolean) : []
    if (files.length) return { entries: mergeByHome(files.map((f) => f.entries)), origin: 'file', at: Math.min(...files.map((f) => f.at)), warnings: [] }
    return cached?.entries?.length ? { entries: cached.entries, origin: 'cache', at: cached.fetchedAt, warnings: [] } : { entries: [], origin: 'none', warnings: [] }
  }
  const stale = cached?.entries?.length ? [{ entries: cached.entries, at: cached.fetchedAt }] : []
  const reasons = []
  const live = (entries) => {
    const w = saveCache(o, host, entries, now)
    return { entries, origin: 'live', at: now, warnings: w ? [w] : [] }
  }
  const injected = o.catalog && Object.hasOwn(o.catalog, host) ? o.catalog[host] : undefined
  if (injected !== undefined) {
    const entries = injected === null ? [] : parse(injected)
    if (entries.length) return live(entries)
    reasons.push('danh sách rỗng hoặc không đọc được')
  } else if (host === 'codex') {
    // Mỗi tài khoản: file models_cache.json còn mới (≤ 24 giờ) thì dùng; cũ/thiếu ⇒ `codex debug models` chạy với CODEX_HOME của chính tài khoản đó.
    const homes = codexHomes(o)
    const fresh = []; const old = []
    let ranLive = false; let at = now
    for (const dir of homes) {
      const f = readCodexFile(o, 6, dir)
      if (f && now - f.at <= CODEX_FILE_MAX_AGE_MS) { fresh.push(f.entries); at = Math.min(at, f.at); continue }
      const r = execCli('codex', ['debug', 'models'], { ...o, env: { ...(o.env ?? process.env), CODEX_HOME: dir } })
      const entries = r.ok ? withHome(parseCodexCatalog(r.stdout), dir) : []
      if (entries.length) { fresh.push(entries); ranLive = true; continue }
      reasons.push(`${homes.length > 1 ? `tài khoản ${accountLabel(dir)}: ` : ''}${r.ok ? 'codex debug models trả danh sách rỗng' : r.error}`)
      if (f) { old.push(f.entries); at = Math.min(at, f.at) }
    }
    if (fresh.length && !old.length) {
      const entries = mergeByHome(fresh)
      return ranLive ? live(entries) : { entries, origin: 'file', at, warnings: [] }
    }
    if (old.length) stale.push({ entries: mergeByHome([...fresh, ...old]), at })
  } else {
    if (stale.length && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < (o.cacheTtlMs ?? CACHE_TTL_MS)) return { entries: cached.entries, origin: 'cache', at: cached.fetchedAt, warnings: [] }
    const r = execCli(host, CLI_ARGS[host], o)
    const entries = r.ok ? parse(r.stdout) : []
    if (entries.length) return live(entries)
    reasons.push(r.ok ? `${host} trả danh sách model rỗng (chưa đăng nhập hoặc mất mạng?)` : r.error)
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

// Tên dòng có trên máy: Claude theo alias của kit; host khác suy từ danh sách thật (dòng của mục làm việc được, kể cả dòng "chưa xếp" để user chọn tay);
// không đọc được ⇒ dòng đã biết của host.
function availableLines(reg, host, o) {
  if (host === 'claude') return hostLines(reg, host)
  const entries = loadCatalog(host, o).entries
  const lines = groupsOf(entries, reg.hosts[host]).map((g) => g.line)
  return lines.length ? lines : hostLines(reg, host)
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
  if (!lines.includes(line)) {
    // Id không có tên dòng (vd gpt-5.5): kit không tự xếp và không chọn theo id ⇒ nói rõ thay vì "không có".
    const noLine = host !== 'claude' && loadCatalog(host, opts).entries.some((e) => !e.alias && e.id.toLowerCase() === line && !lineOf(e.tokens, reg.hosts[host]))
    throw usage(noLine
      ? `"${parts[0].trim()}" không có tên dòng nên kit không chọn theo id được (chỉ chọn theo dòng). Dòng có: ${lines.join(', ')}.`
      : `Máy này không có dòng "${parts[0].trim()}" cho ${host}. Dòng có: ${lines.join(', ')}.`)
  }
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

const tierName = (t) => TIER_LABEL[t] ?? t
const hostName = (h) => HOST_LABEL[h] ?? h

// Chọn model trong MỘT host: dòng cụ thể trước (user chọn, hoặc vai ghi `line` làm dòng ưu tiên / bậc leo thang), rồi hạng; thiếu hạng ⇒ Factory
// (chỉ khi allowFallbackHost) ⇒ hạng kề thấp hơn ⇒ null. Không bao giờ trả id ngoài danh sách của host đã chọn.
// entries = danh sách của host đã lọc theo phạm vi tài khoản (cat.entries khi không có khái niệm tài khoản).
// -> { host, fallbackFrom?, pick, tier, source, reason, newer?, warnings }
function selectCore(reg, host, want, opts, { user, allowFallbackHost }, cat, entries) {
  const cfg = reg.hosts[host]
  const now = nowOf(opts)
  const warnings = cfg.providerPicks ? [] : [...cat.warnings]
  const stale = cat.origin === 'stale'
  const done = (pick, over = {}) => ({ host, pick, tier: want.tier ?? null, warnings, ...over })
  const none = (note) => {
    // providerPicks (Qoder): nhà cung cấp tự chọn model miễn phí, không truyền -m ⇒ model:null là bình thường, không báo "không đọc được".
    if (cfg.providerPicks) return done(null, { source: 'catalog', reason: 'nhà cung cấp tự chọn' })
    warnings.push(note ?`${note}; CLI sẽ dùng model mặc định của nó.` : `Không chọn được model ${want.tier ? `hạng ${tierName(want.tier)}` : `dòng ${want.line}`} cho ${host}; CLI sẽ dùng model mặc định của nó.`)
    return done(null, { source: 'fallback', reason: 'dự phòng (mặc định CLI)' })
  }
  if (!entries.length) return none()
  let missing = null // dòng được yêu cầu mà máy không có
  if (want.line) {
    const p = pickModel(usableEntries(entries, cfg), { line: want.line, effort: want.effort, now })
    if (p) {
      warnings.push(...p.warnings)
      let newer = null
      if (user && want.tier) { // AC-05: giữ lựa chọn của user, chỉ báo khi có dòng tự xếp mới hơn
        const alt = pickTier(entries, cfg, want.tier, { effort: want.effort, now })
        if (alt?.group && alt.group.source !== 'hint' && alt.line !== p.line) {
          newer = { line: alt.line, model: alt.id, tier: want.tier }
          warnings.push(`Có dòng mới ${alt.line} (hạng ${tierName(want.tier)}), bạn đang giữ ${p.line} (${p.id}).`)
        }
      }
      return done(p, { tier: want.tier ?? tierOfLine(cfg, p.line), source: stale ? 'fallback' : user ? 'user' : 'catalog', reason: stale ? 'dự phòng (danh sách cũ)' : user ? 'bạn chọn' : 'tự xếp', newer })
    }
    missing = `Máy này không có dòng ${want.line} cho ${host}`
  }
  if (!want.tier) return none(missing)
  const t = pickTier(entries, cfg, want.tier, { effort: want.effort, now })
  if (t) {
    warnings.push(...t.warnings)
    if (missing) warnings.push(`${missing}, dùng hạng ${tierName(want.tier)} (${t.id}).`)
    const reason = missing ? `dự phòng (dòng ${want.line} không có)` : stale ? 'dự phòng (danh sách cũ)' : t.group?.source === 'hint' ? 'tự xếp' : t.group ? 'tự xếp (dòng mới)' : 'tự xếp (alias hạng)'
    return done(t, { source: missing || stale ? 'fallback' : 'catalog', reason })
  }
  if (missing) warnings.push(`${missing}.`)
  const fb = cfg.fallbackHost
  if (allowFallbackHost && fb && fb !== host && reg.hosts[fb]) {
    const fcat = loadCatalog(fb, opts)
    // Dòng ưu tiên/bậc leo thang của vai (không phải lựa chọn của user) mang sang Factory nếu bên đó có; không thì cùng hạng.
    const f = (want.line && !user ? pickModel(usableEntries(fcat.entries, reg.hosts[fb]), { line: want.line, effort: want.effort, now }) : null)
      ?? pickTier(fcat.entries, reg.hosts[fb], want.tier, { effort: want.effort, now })
    warnings.push(...fcat.warnings)
    if (f) {
      warnings.push(...f.warnings, `${hostName(host)} thiếu hạng ${tierName(want.tier)}, dùng ${hostName(fb)} ${f.id}.`)
      return done(f, { host: fb, fallbackFrom: host, source: 'fallback', reason: `dự phòng ${hostName(fb)}` })
    }
  }
  for (const lower of TIERS.slice(TIERS.indexOf(want.tier) + 1)) {
    const l = pickTier(entries, cfg, lower, { effort: want.effort, now })
    if (!l) continue
    warnings.push(...l.warnings, `Máy này không có model hạng ${tierName(want.tier)} cho ${host}, dùng hạng ${tierName(lower)} (${l.id}).`)
    return done(l, { tier: lower, source: 'fallback', reason: `dự phòng (hạ xuống hạng ${tierName(lower)})` })
  }
  return none()
}

// Phạm vi tài khoản Codex (mỗi tài khoản một danh sách model riêng, mỗi mục nhớ `homes`). Mặc định CHỈ tài khoản mặc định (CODEX_HOME hiện tại): TOML agent của Codex và
// provider Paseo chạy ở đó. allAccounts (codex-run, review-ext: tự xoay tài khoản) = mọi tài khoản còn lượt (bỏ tài khoản ghi hết lượt trong codex-het-luot.json; hết cả ⇒ giữ cả).
// Trả CHÍNH mảng vào nếu không mục nào có homes (host khác, catalog tiêm sẵn); ngược lại bản sao đã thu hẹp homes, bỏ mục không còn tài khoản nào.
function scopeEntries(entries, o, allAccounts) {
  if (!entries.some((e) => e.homes)) return entries
  let keep
  if (allAccounts) {
    const every = [...new Set(entries.flatMap((e) => e.homes ?? []))]
    const { live } = orderHomes(every, readState(statePath(homeOf(o))), nowOf(o))
    const ok = new Set((live.length ? live : every).map((d) => homeKey(d)))
    keep = (d) => ok.has(homeKey(d))
  } else {
    const def = homeKey(defaultCodexHome(o))
    keep = (d) => homeKey(d) === def
  }
  return entries.flatMap((e) => {
    if (!e.homes) return [e]
    const homes = e.homes.filter(keep)
    return homes.length ? [{ ...e, homes }] : []
  })
}

const tierLevel = (t) => (TIERS.includes(t) ? TIERS.indexOf(t) : 99)

// selectCore trong phạm vi tài khoản. Phạm vi mặc định mà tài khoản KHÁC có model tốt hơn ⇒ vẫn dùng model của tài khoản mặc định, kèm lời báo (không ghi id tài khoản khác vào TOML/provider).
function selectIn(reg, host, want, opts, flags) {
  const cat = loadCatalog(host, opts)
  const entries = scopeEntries(cat.entries, opts, flags.allAccounts)
  const res = selectCore(reg, host, want, opts, flags, cat, entries)
  if (flags.allAccounts || entries === cat.entries) return res
  const everyone = scopeEntries(cat.entries, opts, true)
  const alt = selectCore(reg, host, want, opts, { ...flags, allowFallbackHost: false }, cat, everyone)
  const def = homeKey(defaultCodexHome(opts))
  const other = alt.pick?.entry?.homes
  if (other && alt.pick.id !== res.pick?.id && tierLevel(alt.tier) <= tierLevel(res.pick ? res.tier : null) && !other.some((d) => homeKey(d) === def)) {
    res.warnings.push(`Tài khoản Codex ${other.map(accountLabel).join(', ')} có ${alt.pick.id} (hạng ${tierName(alt.tier)}), đổi tài khoản mặc định nếu muốn.`)
  }
  return res
}

// resolve(host, role) -> { host, role, tier, line, model, effort, source:'alias'|'catalog'|'fallback'|'user', reason, escalated, warnings, newer?, fallbackFrom?, homes? }
//  alias: Claude (tên dòng) · catalog: model từ danh sách trên máy · fallback: dòng không có / hạ hạng / Factory / danh sách đã lưu / model:null (CLI tự dùng mặc định)
//  · user: theo ~/.claude/flow.local.json (luôn giữ ưu tiên; có dòng tự xếp mới hơn thì kèm `newer` + lời báo).
// escalate: bậc leo thang của vai (Claude: Opus high; Codex: Astra) khi hỏng 2 lần.
// allowFallbackHost (mặc định false = CHỈ trong host): chỉ nơi đổi được lệnh gọi (codex-run, review-ext) bật; khi Codex thiếu hạng mà Factory có thì trả
// host:'droid' + fallbackFrom:'codex'. pick, paseo, install (TOML của Codex) không bao giờ nhận id của Factory.
// allAccounts (mặc định false = chỉ tài khoản Codex mặc định): codex-run, review-ext bật vì tự xoay tài khoản; kết quả kèm `homes` = các tài khoản có model đã chọn
// (chỉ thử các tài khoản đó, không gọi -m với model mà tài khoản không có).
export function resolve(host, role, opts = {}, { escalate = false, allowFallbackHost = false, allAccounts = false } = {}) {
  const reg = opts.roles ?? loadRoles()
  const base = lookup(reg, host, role)
  const warnings = []
  const useEsc = escalate && !!base.escalate
  const spec = useEsc ? base.escalate : base
  const tier = spec.tier ?? base.tier ?? tierOfLine(reg.hosts[host], spec.line)
  let want = { line: spec.line ?? null, tier, effort: spec.effort }
  let user = false
  if (!escalate) {
    const local = readLocal(opts)
    if (local.error) warnings.push(`File cấu hình riêng flow.local.json hỏng (${local.error}), đang dùng mặc định.`)
    const ov = local.data.models?.[role]?.[host]
    if (ov && typeof ov.line === 'string') { want = { line: normalizeLine(ov.line), tier, effort: ov.effort ?? spec.effort }; user = true }
  }
  const out = { host, role, tier: null, line: want.line, escalated: useEsc }
  if (host === 'claude') {
    if (!hostLines(reg, 'claude').includes(want.line)) {
      warnings.push(`Dòng "${want.line}" trong flow.local.json không phải ${hostLines(reg, 'claude').join('/')}, dùng mặc định.`)
      want = { line: spec.line, tier: null, effort: spec.effort }; user = false
    }
    return { ...out, line: want.line, model: want.line, effort: want.effort, source: user ? 'user' : 'alias', reason: user ? 'bạn chọn' : 'tên dòng', warnings }
  }
  const sel = selectIn(reg, host, want, opts, { user, allowFallbackHost, allAccounts })
  warnings.push(...sel.warnings)
  const p = sel.pick
  const homes = p?.entry?.homes
  // Máy có nhiều tài khoản Codex ⇒ cột lý do ghi model lấy từ tài khoản nào.
  const reason = homes?.length && host === 'codex' && codexHomes(opts).length > 1 ? `${sel.reason} · tài khoản ${homes.map(accountLabel).join(', ')}` : sel.reason
  return {
    ...out, host: sel.host, ...(sel.fallbackFrom ? { fallbackFrom: sel.fallbackFrom } : {}), tier: sel.tier, line: p?.line ?? want.line,
    model: p?.id ?? null, effort: p ? p.effort : want.effort, source: sel.source, reason, ...(sel.newer ? { newer: sel.newer } : {}),
    ...(homes?.length ? { homes } : {}), ...(reg.hosts[host].providerPicks ? { providerPicks: true } : {}), warnings,
  }
}

// Bảng hạng của một host trên máy (mọi tài khoản còn lượt): mỗi hạng → các dòng (kèm nguồn xếp) + model tốt nhất ở mức high; dòng chưa xếp ở cuối. Dùng để soi/so model, không gọi model.
export function tierTable(host, opts = {}) {
  const reg = opts.roles ?? loadRoles()
  const cfg = reg.hosts[host]
  if (!cfg?.tiers) throw usage(`App "${host}" không chọn model theo hạng. App có: ${Object.keys(reg.hosts).filter((h) => reg.hosts[h].tiers).join(', ')}.`)
  const cat = loadCatalog(host, { ...opts, memo: opts.memo ?? new Map() })
  const entries = scopeEntries(cat.entries, opts, true)
  const cls = classify(entries, cfg)
  const label = (g) => `${g.line}${g.source === 'hint' ? '' : ` (${g.reason})`}`
  const rows = TIERS.map((t) => ({ tier: t, model: pickTier(entries, cfg, t, { effort: 'high', now: nowOf(opts) })?.id ?? null, lines: cls[t].map(label) }))
  rows.push({ tier: 'chua-xep', model: null, lines: cls['chua-xep'].map(label) })
  return { host, providerPicks: Boolean(cfg.providerPicks), rows, warnings: cfg.providerPicks ? [] : cat.warnings }
}

// ---------- báo dòng mới (AC-03, AC-05) + làm tươi cache nền ----------

// Quyền kích làm tươi nền: MỘT phiên giành được trong mỗi 10 phút (file khoá tạo bằng 'wx' = nguyên tử, cùng mẫu claimRefresh của lib/updates.mjs);
// khoá cũ quá 10 phút hoặc giờ ở tương lai xa ⇒ giành lại. Không đụng được đĩa ⇒ false (không kích).
export function claimModelsRefresh(o = {}, now = Date.now()) {
  const lock = path.join(path.dirname(cacheFile(o)), 'models.spawn.lock')
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }) } catch { return false }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, String(now)) } finally { fs.closeSync(fd) }
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') return false
      try {
        const at = Number(fs.readFileSync(lock, 'utf8'))
        const age = Number.isFinite(at) && at > 0 ? now - at : Date.now() - fs.statSync(lock).mtimeMs
        if (age > -60_000 && age < REFRESH_GRACE_MS) return false
        fs.rmSync(lock, { force: true })
      } catch { return false }
    }
  }
  return false
}

// Làm tươi cache danh sách model của mọi host theo hạng (agy/droid gọi CLI, Codex đọc file hoặc `codex debug models`). Host đã gỡ khỏi máy ⇒ bỏ danh sách đã lưu
// (để session-start không kích lại mãi). Chạy nền từ session-start (`models.mjs refresh`), không bao giờ ném lỗi.
export function refreshCatalogs(opts = {}) {
  const reg = opts.roles ?? loadRoles()
  const o = { ...opts, cacheTtlMs: 0, memo: new Map() }
  for (const [host, cfg] of Object.entries(reg.hosts)) {
    if (!cfg.tiers) continue
    if (!o.exec && !findExe(host, o.env ?? process.env, homeOf(o))) {
      if (readCache(o).hosts[host]) updateCache(o, (d) => { delete d.hosts[host] })
      continue
    }
    loadCatalog(host, o)
  }
}

const roleList = (rs) => (rs.length > 4 ? `${rs.slice(0, 4).join(', ')} (+${rs.length - 4} vai nữa)` : rs.join(', '))

// Một dòng báo cho một host: dòng nào, hạng nào, vai nào đổi sang model nào (so kết quả có/không có dòng mới); vai user đang giữ model riêng thì nói "bạn đang giữ X".
function noticeLine(reg, host, cat, fresh, o) {
  const cfg = reg.hosts[host]
  const cls = classify(cat.entries, cfg)
  const tierOf = (l) => TIERS.find((t) => cls[t].some((g) => g.line === l)) ?? 'chua-xep'
  const freshIds = new Set(groupsOf(cat.entries, cfg).filter((g) => fresh.includes(g.line)).flatMap((g) => g.entries.map((e) => e.id)))
  const after = { ...o, memo: new Map() }
  const before = { ...o, entries: { ...o.entries, [host]: cat.entries.filter((e) => !freshIds.has(e.id)) }, memo: new Map() }
  const moved = new Map()
  const kept = []
  for (const [role, def] of Object.entries(reg.roles)) {
    if (!def.models?.[host]) continue
    const a = resolve(host, role, after, { allAccounts: true }) // codex-run/review-ext xoay tài khoản ⇒ tính mọi tài khoản còn lượt
    if (a.source === 'user') { if (a.newer && fresh.includes(a.newer.line)) kept.push(`vai ${role}: có dòng mới ${a.newer.line}, bạn đang giữ ${a.model}`); continue }
    if (a.model && a.model !== resolve(host, role, before, { allAccounts: true }).model) moved.set(a.model, [...(moved.get(a.model) ?? []), role])
  }
  const placed = fresh.filter((l) => tierOf(l) !== 'chua-xep')
  const unplaced = fresh.filter((l) => tierOf(l) === 'chua-xep')
  const out = []
  if (placed.length) {
    const changes = moved.size ? [...moved].map(([m, rs]) => `vai ${roleList(rs)} giờ dùng ${m}`).join('; ') : 'chưa vai nào đổi model'
    out.push(`${hostName(host)} có dòng mới ${placed.map((l) => `${l} (hạng ${tierName(tierOf(l))})`).join(', ')}: ${changes}.`)
  }
  if (kept.length) out.push(`${kept.join('; ')} (không tự đổi; muốn đổi thì nói "cho vai X dùng model Y").`)
  if (unplaced.length) out.push(`${hostName(host)} có dòng mới ${unplaced.join(', ')} chưa xếp được hạng nên chưa dùng; muốn dùng: node ~/.claude/hooks/models.mjs set <vai> ${host} ${unplaced[0]}.`)
  if (placed.length) out.push('Sai thì nói "cho vai X dùng model Y".')
  return out.join(' ')
}

// Cho session-start: CHỈ đọc cache (+ ~/.codex/models_cache.json), không gọi CLI. So dòng đang có với `seenLines` trong cache: lần đầu của host ⇒ ghi im;
// có dòng mới ⇒ một dòng báo cho host rồi ghi vào seenLines (không báo lại). -> { lines: [chữ báo], stale: [host cần làm tươi nền] }
export function newLineNotices(opts = {}) {
  const reg = opts.roles ?? loadRoles()
  const o = { ...opts, cacheOnly: true, memo: new Map() }
  const now = nowOf(o)
  const seen = readCache(o).seenLines
  const known = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {}
  const next = { ...known }
  const lines = []
  const stale = []
  for (const [host, cfg] of Object.entries(reg.hosts)) {
    if (!cfg.tiers) continue
    const cat = loadCatalog(host, o)
    if (!cat.entries.length) {
      if (!cfg.providerPicks && findExe(host, o.env ?? process.env, homeOf(o))) stale.push(host) // providerPicks (Qoder): không có danh sách là bình thường, không kích làm tươi mãi
      continue
    }
    if (!(now - cat.at < NOTICE_STALE_MS)) stale.push(host)
    const current = groupsOf(cat.entries, cfg).map((g) => g.line)
    if (!Array.isArray(known[host])) { next[host] = current; continue }
    const fresh = current.filter((l) => !known[host].includes(l))
    if (!fresh.length) continue
    next[host] = [...new Set([...known[host], ...current])]
    lines.push(noticeLine(reg, host, cat, fresh, o))
  }
  if (JSON.stringify(next) !== JSON.stringify(known)) updateCache(o, (d) => { d.seenLines = next })
  return { lines, stale }
}

// ---------- CLI ----------

const HELP = `Dùng:
  models.mjs pick <app> <vai> [--escalate] [--json] [--field model|effort|source|tier]
  models.mjs set <vai> <app> <dòng>[:mức]     vd: set debugger claude opus:high
  models.mjs reset <vai> [<app>]
  models.mjs list [--json]
  models.mjs tiers <app> [--json]              bảng hạng của một app trên máy: dòng nào hạng nào, model tốt nhất mỗi hạng
  models.mjs refresh                           làm tươi danh sách model đã lưu (session-start gọi nền)
App: claude, codex, agy, droid, cursor-agent, grok, qodercli (ba app cuối chưa vai nào dùng).`

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
      return r.model || r.providerPicks ? 0 : 3 // providerPicks (Qoder): model rỗng là đúng, đừng truyền -m
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
      // Bảng cho biết cái THỰC SỰ chạy: Codex thiếu hạng mà Factory có ⇒ dòng của Codex ghi model của Factory, lý do "dự phòng Factory" (via = nơi chạy).
      for (const [role, def] of Object.entries(reg.roles)) {
        for (const host of Object.keys(def.models)) {
          const r = resolve(host, role, o, { allowFallbackHost: true, allAccounts: true })
          rows.push({ role, ...r, host, ...(r.fallbackFrom ? { via: r.host } : {}) })
        }
      }
      if (flags.json) { out(`${JSON.stringify(rows)}\n`); return 0 }
      const cells = rows.map((r) => [r.role, r.host, r.tier ? tierName(r.tier) : '-', `${r.line ?? '-'}:${r.effort ?? '-'}`, r.model ?? '(mặc định CLI)', r.reason])
      const table = [['vai', 'app', 'hạng', 'dòng:mức', 'model', 'lý do'], ...cells]
      const widths = table[0].map((_, c) => Math.max(...table.map((row) => [...row[c]].length)))
      for (const row of table) out(`${row.map((v, c) => v + ' '.repeat(widths[c] - [...v].length)).join('  ').trimEnd()}\n`)
      for (const w of new Set(rows.flatMap((r) => r.warnings))) err(`! ${w}\n`)
      return 0
    }
    case 'tiers': {
      if (rest.length !== 1) throw usage(HELP)
      const t = tierTable(rest[0], opts)
      if (flags.json) { out(`${JSON.stringify(t)}\n`); return 0 }
      if (!t.rows.some((r) => r.lines.length)) out(`${hostName(t.host)}: không có danh sách model${t.providerPicks ? ' (nhà cung cấp tự chọn model, kit không truyền -m)' : ''}.\n`)
      for (const r of t.rows) if (r.lines.length) out(`${r.tier === 'chua-xep' ? 'chưa xếp' : tierName(r.tier)}${r.model ? `  ${r.model}` : ''}: ${r.lines.join(', ')}\n`)
      for (const w of t.warnings) err(`! ${w}\n`)
      return 0
    }
    case 'refresh': {
      if (rest.length) throw usage(HELP)
      refreshCatalogs(opts)
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

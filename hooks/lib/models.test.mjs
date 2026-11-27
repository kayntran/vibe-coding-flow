// Test cho lib/models.mjs + hooks/models.mjs + kit/roles.json: node --test hooks/lib/models.test.mjs
// Catalog giả (Windows đủ gpt-6*, Mac thiếu gpt-6*, rỗng/hỏng, tên lạ, sắp hết hạn); HOME giả (USERPROFILE + HOME); không gọi CLI thật trừ shim giả.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  loadRoles, roleSet, parseCodexCatalog, parseAgyCatalog, parseDroidHelp, pickModel, resolve, setOverride, resetOverride, runCli, findExe,
  lineOf, usableEntries, classify, pickTier, newLineNotices, refreshCatalogs, claimModelsRefresh, TIERS,
  parseCursorModels, parseGrokModels, parseQoderModels, tierTable,
} from './models.mjs'
import { CLI_NAMES } from './clis.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLI = path.join(ROOT, 'hooks', 'models.mjs')
const NOW = Date.parse('2026-10-11T12:00:00Z')
const DAY = 86400000

// Bản chụp danh sách model THẬT ngày 2026-11-27 (agy, Codex, droid) + file đáp án viết tay (hooks/lib/fixtures/models/).
const FIX = path.join(HERE, 'fixtures', 'models')
const REAL = {
  agy: fs.readFileSync(path.join(FIX, 'agy.txt'), 'utf8'),
  codex: fs.readFileSync(path.join(FIX, 'codex.json'), 'utf8'),
  droid: fs.readFileSync(path.join(FIX, 'droid-help.txt'), 'utf8'),
  'cursor-agent': fs.readFileSync(path.join(FIX, 'cursor.txt'), 'utf8'),
  grok: fs.readFileSync(path.join(FIX, 'grok.txt'), 'utf8'),
  qodercli: fs.readFileSync(path.join(FIX, 'qoder.txt'), 'utf8'),
}
const DAP_AN = JSON.parse(fs.readFileSync(path.join(FIX, 'dap-an.json'), 'utf8'))
const NOW_REAL = Date.parse('2026-11-27T12:00:00Z')

// ---------- fixture ----------

const LEVELS_ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const LEVELS_LUNA = ['low', 'medium', 'high', 'xhigh', 'max']
const cm = (slug, o = {}) => ({
  slug, display_name: slug, visibility: o.hide ? 'hide' : 'list', priority: o.priority ?? 50, default_reasoning_level: 'medium',
  supported_reasoning_levels: (o.levels ?? LEVELS_ALL).map((effort) => ({ effort, description: 'x' })), upgrade: o.upgrade ?? null,
})
// Máy Windows (Codex 0.159): đủ gpt-6*, có model ẩn và gpt-5.5 sắp gỡ.
const WIN = {
  fetched_at: '2026-10-11T11:00:00Z',
  models: [
    cm('gpt-6.1-sol', { priority: 1 }), cm('gpt-6-astra', { priority: 2 }), cm('gpt-6-sol', { priority: 3 }),
    cm('gpt-6-luna', { priority: 4, levels: LEVELS_LUNA }), cm('gpt-reserve', { priority: 4, hide: true }),
    cm('gpt-5.6-sol', { priority: 5 }), cm('gpt-5.6-terra', { priority: 8 }), cm('gpt-5.6-luna', { priority: 9, levels: LEVELS_LUNA }),
    cm('gpt-5.5', { priority: 13, hide: true, upgrade: { model: 'gpt-6.1-sol', retirement_at: '2026-10-14T19:00:00Z' } }),
    cm('codex-auto-review', { priority: 43, hide: true }),
  ],
}
// Máy Mac (Codex 0.145): chỉ gpt-5.6-*, KHÔNG có gpt-6*.
const MAC = {
  models: [cm('gpt-5.6-sol', { priority: 5 }), cm('gpt-5.6-terra', { priority: 8 }), cm('gpt-5.6-luna', { priority: 9, levels: LEVELS_LUNA }), cm('gpt-5.5', { hide: true })],
}
const AGY = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)', 'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', 'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)', 'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)', 'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n')

const tmpDirs = []
function tmp(prefix = 'flow-models-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
// Dọn thư mục tạm; shim CLI treo có thể còn bị giữ trên Windows ⇒ lỗi dọn không làm hỏng test.
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

const noExec = () => { throw new Error('exec không được gọi trong ca này') }
const failExec = () => ({ ok: false, stdout: '', error: 'ENOENT' })
// opts chuẩn cho resolve(): home giả, giờ cố định, catalog tiêm sẵn, exec bị cấm.
function ctx(over = {}) {
  return { home: tmp(), now: NOW, env: {}, exec: noExec, catalog: { codex: WIN, agy: AGY, droid: REAL.droid }, ...over }
}

// ---------- kit/roles.json (registry vai) ----------

test('roles.json: cấu trúc hợp lệ, mỗi vai có writesCode/receipt/audit boolean + models theo host; mọi host là CLI của kit; vai xin hạng hợp lệ', () => {
  const reg = loadRoles()
  assert.deepEqual(Object.keys(reg.hosts).sort(), ['agy', 'claude', 'codex', 'cursor-agent', 'droid', 'grok', 'qodercli'])
  for (const host of Object.keys(reg.hosts)) assert.ok(CLI_NAMES.includes(host), `host ${host} không có trong CLI_NAMES (clis.mjs)`)
  assert.ok(Object.keys(reg.roles).length >= 12)
  for (const [host, cfg] of Object.entries(reg.hosts)) {
    if (host === 'claude') { assert.deepEqual(cfg.lines, ['opus', 'sonnet', 'haiku']); continue }
    assert.deepEqual(Object.keys(cfg.tiers).sort(), [...TIERS].sort(), `${host}: tiers phải đủ ba hạng`)
    for (const t of TIERS) for (const l of cfg.tiers[t]) assert.match(l, /^[a-z]+$/, `${host}/${t}: "${l}" phải là tên dòng`)
    assert.ok(cfg.skip.includes('orchestrator'), `${host}: skip phải loại orchestrator`)
    assert.ok(!cfg.skip.includes('fast'), `${host}: chữ fast không nằm trong skip (chỉ loại hậu tố -fast)`)
    if (cfg.fallbackHost) assert.ok(reg.hosts[cfg.fallbackHost]?.tiers, `${host}: fallbackHost ${cfg.fallbackHost} phải là host theo hạng`)
    for (const [t, alias] of Object.entries(cfg.aliases ?? {})) assert.ok(TIERS.includes(t) && /^[a-z]+-latest-[a-z]+$/.test(alias), `${host}: alias ${t}`)
  }
  for (const [name, r] of Object.entries(reg.roles)) {
    for (const k of ['writesCode', 'receipt', 'audit']) assert.equal(typeof r[k], 'boolean', `${name}.${k}`)
    if (r.audit) assert.ok(r.writesCode, `${name}: audit mà không writesCode`)
    assert.ok(Object.keys(r.models).length > 0, `${name} không có model nào`)
    for (const [host, m] of Object.entries(r.models)) {
      assert.ok(reg.hosts[host], `${name}: host lạ ${host}`)
      for (const spec of [m, m.escalate].filter(Boolean)) {
        if (spec.line !== undefined) assert.match(spec.line, /^[a-z]+$/, `${name}/${host}: dòng "${spec.line}" phải là tên dòng, không số phiên bản [vmdk]`)
        if (spec.tier !== undefined) assert.ok(TIERS.includes(spec.tier), `${name}/${host}: hạng "${spec.tier}" không hợp lệ`)
        assert.ok(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(spec.effort), `${name}/${host}: effort ${spec.effort}`)
      }
      if (host === 'claude') assert.ok(['opus', 'sonnet', 'haiku'].includes(m.line), `${name}: claude chỉ nhận alias`)
      else assert.ok(TIERS.includes(m.tier), `${name}/${host}: vai trên host theo hạng phải xin hạng (tier)`)
    }
  }
})

test('roles.json: không ghi cứng id model hay số phiên bản ở bất kỳ đâu', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'kit', 'roles.json'), 'utf8')
  assert.doesNotMatch(raw, /gpt-\d|claude-(opus|sonnet|haiku)-\d|gemini-\d|\d\.\d/i)
})

test('roles.json: khớp danh sách cứng cũ của flow-gate (receipt/audit) + coder-mini đi qua đủ cổng như coder', () => {
  assert.deepEqual(
    [...roleSet('receipt')].sort(),
    ['code-reviewer', 'coder', 'coder-lite', 'coder-mini', 'debugger', 'qa-tester', 'recon', 'researcher', 'test-runner'],
  )
  assert.deepEqual([...roleSet('audit')].sort(), ['coder', 'coder-lite', 'coder-mini'])
  assert.deepEqual([...roleSet('writesCode')].sort(), ['coder', 'coder-lite', 'coder-mini'])
  const mini = loadRoles().roles['coder-mini']
  assert.deepEqual([mini.writesCode, mini.receipt, mini.audit], [true, true, true])
})

test('roles.json: mọi agents/*.md đều có vai; vai có agent đủ model claude + codex (hostgen xuất TOML được)', () => {
  const reg = loadRoles()
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  assert.ok(agents.length >= 8)
  for (const a of agents) assert.ok(reg.roles[a], `agents/${a}.md chưa có trong roles.json`)
  for (const [name, r] of Object.entries(reg.roles)) {
    if (r.agent === false) continue
    assert.ok(r.models.claude && r.models.codex, `${name}: thiếu model claude hoặc codex`)
  }
})

test('roles.json: bảng vai-hạng đúng sổ chốt [bbzh] [50zu] [69u6] [csb8] (Claude giữ tên dòng; Codex/Factory/agy xin hạng)', () => {
  const R = loadRoles().roles
  const claude = (role) => `${R[role].models.claude.line}:${R[role].models.claude.effort}`
  const tier = (role, host) => `${R[role].models[host].tier}:${R[role].models[host].effort}`
  const esc = (role, host) => `${R[role].models[host].escalate.line ?? R[role].models[host].escalate.tier}:${R[role].models[host].escalate.effort}`
  // [bbzh] Claude: Sonnet chủ lực, leo Opus high, việc nhỏ/chạy test Haiku
  for (const role of ['coder', 'coder-lite', 'debugger', 'recon', 'researcher', 'qa-tester']) assert.equal(R[role].models.claude.line, 'sonnet', role)
  for (const role of ['coder', 'debugger']) assert.equal(esc(role, 'claude'), 'opus:high', role)
  assert.equal(R['coder-mini'].models.claude.line, 'haiku')
  assert.equal(R['test-runner'].models.claude.line, 'haiku')
  // [50zu] Codex: khó = hạng mạnh high (leo Astra), nhỏ = hạng nhanh, review luôn mạnh high — Factory (droid) mang cùng bảng để thay khi Codex thiếu hạng
  for (const host of ['codex', 'droid']) {
    for (const role of ['coder', 'debugger']) { assert.equal(tier(role, host), 'manh:high', `${host}/${role}`); assert.equal(esc(role, host), 'astra:high', `${host}/${role}`) }
    for (const role of ['coder-mini', 'test-runner']) assert.equal(R[role].models[host].tier, 'nhanh', `${host}/${role}`)
    for (const role of ['coder-lite', 'recon', 'qa-tester']) assert.equal(tier(role, host), 'manh:medium', `${host}/${role}`)
    assert.equal(tier('code-reviewer', host), 'manh:high')
    assert.equal(tier('plan-reviewer', host), 'manh:high')
    assert.equal(tier('security-reviewer', host), 'manh:high')
  }
  for (const [name, r] of Object.entries(R)) if (r.models.codex) assert.deepEqual(r.models.droid, r.models.codex, `${name}: droid phải khớp codex (dự phòng cùng hạng, cùng mức)`)
  // [69u6] soát plan: hạng mạnh qua agy (Gemini mới nhất), Opus high của Claude
  assert.equal(tier('plan-reviewer', 'agy'), 'manh:high')
  assert.equal(claude('plan-reviewer'), 'opus:high')
  // [csb8] review nhạy cảm: cũng hạng mạnh nhưng ưu tiên dòng khác plan-reviewer để nhánh dự phòng hết lượt không gọi lại đúng model vừa hết
  assert.deepEqual(R['sensitive-reviewer'].models.agy, { tier: 'manh', line: 'hydrogen', effort: 'high' })
})

// ---------- phân tích catalog ----------

test('parseCodexCatalog: bỏ model ẩn, nhận cả chuỗi JSON lẫn object, mức effort lấy từ supported_reasoning_levels', () => {
  const entries = parseCodexCatalog(JSON.stringify(WIN))
  const ids = entries.map((e) => e.id)
  assert.ok(ids.includes('gpt-6.1-sol') && ids.includes('gpt-5.6-luna'))
  for (const hidden of ['gpt-reserve', 'gpt-5.5', 'codex-auto-review']) assert.ok(!ids.includes(hidden), hidden)
  assert.deepEqual(entries.find((e) => e.id === 'gpt-6-luna').efforts, LEVELS_LUNA)
  assert.deepEqual(parseCodexCatalog(WIN).map((e) => e.id), ids)
  assert.deepEqual(parseCodexCatalog(WIN.models).map((e) => e.id), ids, 'nhận cả mảng trần')
})

test('parseCodexCatalog: rỗng/hỏng/không phải catalog ⇒ [] chứ không ném lỗi', () => {
  for (const bad of [null, undefined, '', '   ', 'không phải json', '{"models":[]}', { models: [] }, { models: 'x' }, [], 42, '[1,2,3]', { models: [null, 7, {}, { slug: 5 }] }]) {
    assert.deepEqual(parseCodexCatalog(bad), [], JSON.stringify(bad))
  }
})

test('parseAgyCatalog: tách TAB, bỏ dòng tiêu đề/lỗi, gom mức effort theo id gốc', () => {
  const entries = parseAgyCatalog(AGY)
  const flash = entries.find((e) => e.id === 'gemini-3.8-flash')
  assert.deepEqual(Object.keys(flash.effortIds).sort(), ['high', 'low', 'medium'])
  assert.equal(flash.effortIds.high, 'gemini-3.8-flash-high')
  assert.ok(entries.find((e) => e.id === 'claude-opus-4-6-thinking'), 'id không có hậu tố effort vẫn giữ nguyên')
  assert.ok(!entries.some((e) => /fetching/i.test(e.id)))
  assert.deepEqual(parseAgyCatalog(''), [])
  assert.deepEqual(parseAgyCatalog('Error: not logged in\nPlease run agy login'), [])
  assert.deepEqual(parseAgyCatalog(null), [])
})

// ---------- chọn bản mới nhất (pickModel) ----------

const codexEntries = (c) => parseCodexCatalog(c)
const P = (entries, line, effort = 'high', extra = {}) => pickModel(entries, { line, effort, now: NOW, ...extra })

test('pickModel/Windows: mỗi dòng ra bản mới nhất của dòng đó (6.1 > 6 > 5.6; không ăn nhầm model ẩn)', () => {
  const e = codexEntries(WIN)
  assert.equal(P(e, 'sol').id, 'gpt-6.1-sol')
  assert.equal(P(e, 'astra').id, 'gpt-6-astra')
  assert.equal(P(e, 'luna').id, 'gpt-6-luna')
  assert.equal(P(e, 'terra').id, 'gpt-5.6-terra')
  assert.equal(P(e, 'sol').effort, 'high')
})

test('pickModel/Mac thiếu gpt-6: dòng sol/luna ra bản 5.6; astra không có ⇒ chuỗi dự phòng sol, đánh dấu fellBack', () => {
  const e = codexEntries(MAC)
  assert.equal(P(e, 'sol').id, 'gpt-5.6-sol')
  assert.equal(P(e, 'luna').id, 'gpt-5.6-luna')
  const r = P(e, 'astra', 'high', { fallback: ['sol', 'luna'] })
  assert.equal(r.id, 'gpt-5.6-sol')
  assert.equal(r.fellBack, true)
  assert.equal(r.line, 'sol')
  assert.equal(P(e, 'astra'), null, 'không có chuỗi dự phòng ⇒ null, không đoán id')
})

test('pickModel: so số phiên bản theo số (10 > 9), hoà version thì priority nhỏ hơn, hoà nữa thì thứ tự xuất hiện', () => {
  const a = codexEntries({ models: [cm('gpt-9-sol'), cm('gpt-10-sol'), cm('gpt-9.5-sol')] })
  assert.equal(P(a, 'sol').id, 'gpt-10-sol')
  const b = codexEntries({ models: [cm('x-7-sol', { priority: 9 }), cm('y-7-sol', { priority: 2 }), cm('z-7-sol', { priority: 2 })] })
  assert.equal(P(b, 'sol').id, 'y-7-sol')
})

test('pickModel/tên lạ: khớp theo token (solar không phải sol), id không có số phiên bản vẫn dùng được nhưng xếp cuối', () => {
  assert.equal(P(codexEntries({ models: [cm('gpt-9-solar'), cm('console-5'), cm('solstice')] }), 'sol'), null)
  assert.equal(P(codexEntries({ models: [cm('mystery_sol'), cm('gpt-5.1-sol')] }), 'sol').id, 'gpt-5.1-sol')
  assert.equal(P(codexEntries({ models: [cm('mystery-sol')] }), 'sol').id, 'mystery-sol')
  assert.equal(P(codexEntries({ models: [cm('SOL-Beta'), cm('lạ-lùng-???')] }), 'sol').id, 'SOL-Beta')
  const withPreview = codexEntries({ models: [cm('gpt-7-sol-preview'), cm('gpt-6-sol')] })
  assert.equal(P(withPreview, 'sol').id, 'gpt-6-sol', 'có bản ổn định thì không lấy preview')
  assert.equal(P(codexEntries({ models: [cm('gpt-7-sol-preview')] }), 'sol').id, 'gpt-7-sol-preview', 'chỉ có preview thì vẫn dùng')
  assert.equal(P(codexEntries({ models: [cm('gpt-8-sol-deprecated'), cm('gpt-8-sol-legacy')] }), 'sol'), null)
})

test('pickModel/effort: hạ về mức cao nhất được hỗ trợ ≤ yêu cầu (luna không có ultra ⇒ max); mức thấp hơn mọi mức có ⇒ lấy mức thấp nhất', () => {
  const e = codexEntries(WIN)
  const r = P(e, 'luna', 'ultra')
  assert.equal(r.effort, 'max')
  assert.ok(r.warnings.some((w) => /ultra/.test(w) && /max/.test(w)), 'ghi lại việc hạ mức')
  assert.equal(P(e, 'sol', 'ultra').effort, 'ultra')
  const only = codexEntries({ models: [cm('gpt-6-sol', { levels: ['medium', 'high'] })] })
  assert.equal(P(only, 'sol', 'xhigh').effort, 'high')
  assert.equal(P(only, 'sol', 'low').effort, 'medium')
})

test('pickModel/hết hạn: còn ≤ 14 ngày ⇒ cảnh báo kèm ngày; xa hơn ⇒ im; đã quá hạn ⇒ không dùng nữa', () => {
  const soon = codexEntries({ models: [cm('gpt-5.6-sol', { upgrade: { model: 'gpt-6.1-sol', retirement_at: new Date(NOW + 5 * DAY).toISOString() } })] })
  const r = P(soon, 'sol')
  assert.equal(r.id, 'gpt-5.6-sol')
  assert.ok(r.warnings.some((w) => w.includes('gpt-5.6-sol') && w.includes('2026-10-16') && w.includes('gpt-6.1-sol')), r.warnings.join('|'))
  const far = codexEntries({ models: [cm('gpt-5.6-sol', { upgrade: { model: 'gpt-6.1-sol', retirement_at: new Date(NOW + 40 * DAY).toISOString() } })] })
  assert.deepEqual(P(far, 'sol').warnings, [])
  const gone = codexEntries({ models: [cm('gpt-6-sol', { upgrade: { retirement_at: new Date(NOW - DAY).toISOString() } }), cm('gpt-5.6-sol')] })
  assert.equal(P(gone, 'sol').id, 'gpt-5.6-sol')
})

test('pickModel/agy: flash 3.8 > 3.7; opus 5.5 (không lấy 4.6-thinking, không ăn nhầm gpt-oss); effort nằm trong id', () => {
  const e = parseAgyCatalog(AGY)
  assert.equal(P(e, 'flash').id, 'gemini-3.8-flash-high')
  assert.equal(P(e, 'flash', 'low').id, 'gemini-3.8-flash-low')
  assert.equal(P(e, 'flash', 'xhigh').id, 'gemini-3.8-flash-high')
  assert.equal(P(e, 'opus').id, 'claude-opus-5-5-high')
  assert.equal(P(e, 'opus', 'medium').id, 'claude-opus-5-5-medium')
  assert.equal(P(e, 'pro', 'medium').id, 'gemini-3.1-pro-low', 'pro không có medium ⇒ hạ xuống low')
  assert.equal(P(e, 'pro', 'medium').effort, 'low')
  assert.equal(P(e, 'sonnet').id, 'claude-sonnet-5-5-high')
  assert.equal(P(e, 'gemini-flash').id, 'gemini-3.8-flash-high', 'bí danh gemini-flash → flash')
  const oldOnly = parseAgyCatalog('claude-opus-4-6-thinking\tx')
  assert.equal(P(oldOnly, 'opus').id, 'claude-opus-4-6-thinking')
  assert.equal(P(oldOnly, 'opus').effort, null)
})

// ---------- resolve() ----------

test('resolve/claude: trả alias, không đụng catalog hay exec', () => {
  const c = ctx()
  assert.deepEqual(pickFields(resolve('claude', 'coder', c)), { model: 'sonnet', effort: 'xhigh', source: 'alias' })
  assert.deepEqual(pickFields(resolve('claude', 'test-runner', c)), { model: 'haiku', effort: 'medium', source: 'alias' })
  assert.equal(resolve('claude', 'coder-mini', c).model, 'haiku')
  const esc = resolve('claude', 'coder', c, { escalate: true })
  assert.deepEqual(pickFields(esc), { model: 'opus', effort: 'high', source: 'alias' })
})
function pickFields(r) { return { model: r.model, effort: r.effort, source: r.source } }

test('resolve/codex Windows: coder = gpt-6.1-sol high (catalog); leo thang = gpt-6-astra; việc nhỏ = gpt-6-luna', () => {
  const c = ctx()
  assert.deepEqual(pickFields(resolve('codex', 'coder', c)), { model: 'gpt-6.1-sol', effort: 'high', source: 'catalog' })
  assert.equal(resolve('codex', 'coder', c, { escalate: true }).model, 'gpt-6-astra')
  assert.equal(resolve('codex', 'coder-mini', c).model, 'gpt-6-luna')
  assert.equal(resolve('codex', 'plan-reviewer', c).model, 'gpt-6.1-sol')
})

test('resolve/codex Mac thiếu gpt-6: dùng bản có trên máy; leo thang astra không có ⇒ source fallback + lời báo', () => {
  const c = ctx({ catalog: { codex: MAC, agy: null } })
  assert.deepEqual(pickFields(resolve('codex', 'coder', c)), { model: 'gpt-5.6-sol', effort: 'high', source: 'catalog' })
  const esc = resolve('codex', 'coder', c, { escalate: true })
  assert.equal(esc.model, 'gpt-5.6-sol')
  assert.equal(esc.source, 'fallback')
  assert.ok(esc.warnings.some((w) => /astra/.test(w) && /sol/.test(w)), esc.warnings.join('|'))
})

test('resolve/catalog rỗng hoặc hỏng, chưa từng có cache: model null, source fallback, một lời báo, không ném lỗi', () => {
  for (const bad of [null, '', 'rác', { models: [] }, []]) {
    const r = resolve('codex', 'coder', ctx({ catalog: { codex: bad } }))
    assert.equal(r.model, null, JSON.stringify(bad))
    assert.equal(r.source, 'fallback')
    assert.equal(r.effort, 'high')
    assert.ok(r.warnings.length >= 1)
  }
})

test('resolve/catalog lỗi nhưng có danh sách lần trước ⇒ dùng bản đã lưu, source fallback + báo một dòng', () => {
  const home = tmp()
  assert.equal(resolve('codex', 'coder', ctx({ home })).model, 'gpt-6.1-sol') // lần đầu thành công ⇒ lưu cache
  const later = resolve('codex', 'coder', ctx({ home, catalog: { codex: null }, now: NOW + 3600000 }))
  assert.equal(later.model, 'gpt-6.1-sol')
  assert.equal(later.source, 'fallback')
  assert.ok(later.warnings.some((w) => /đã lưu/.test(w)), later.warnings.join('|'))
})

test('resolve/agy: dùng exec, cache 10 phút (lần 2 không exec), hết hạn cache thì exec lại, exec lỗi ⇒ dùng bản cũ', () => {
  const home = tmp()
  let calls = 0
  const exec = (name, args) => { calls++; assert.deepEqual([name, args], ['agy', ['models']]); return { ok: true, stdout: REAL.agy } }
  const base = { home, env: {}, exec, now: NOW, catalog: {} }
  const a = resolve('agy', 'plan-reviewer', base)
  assert.deepEqual(pickFields(a), { model: 'gemini-4-neon-high', effort: 'high', source: 'catalog' })
  assert.equal(calls, 1)
  resolve('agy', 'sensitive-reviewer', { ...base, now: NOW + 9 * 60000 })
  assert.equal(calls, 1, 'trong 10 phút dùng cache')
  const b = resolve('agy', 'sensitive-reviewer', { ...base, now: NOW + 11 * 60000 })
  assert.equal(calls, 2)
  assert.equal(b.model, 'gemini-4-hydrogen-high', 'cùng hạng mạnh với plan-reviewer nhưng khác dòng (nhánh dự phòng hết lượt không gọi lại đúng model đó)')
  const dead = resolve('agy', 'sensitive-reviewer', { ...base, exec: failExec, now: NOW + 30 * 60000 })
  assert.equal(dead.model, 'gemini-4-hydrogen-high')
  assert.equal(dead.source, 'fallback')
})

test('resolve/codex đọc ~/.codex/models_cache.json (mới ⇒ không exec); cũ hơn 24 giờ ⇒ codex debug models; cả hai lỗi ⇒ dùng file cũ', () => {
  const homeWith = (fetchedAt) => {
    const home = tmp()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ ...MAC, fetched_at: new Date(fetchedAt).toISOString() }))
    return home
  }
  const base = { now: NOW, env: {}, catalog: {} }
  assert.equal(resolve('codex', 'coder', { ...base, home: homeWith(NOW - 3600000), exec: noExec }).model, 'gpt-5.6-sol')
  const seen = []
  const live = resolve('codex', 'coder', {
    ...base, home: homeWith(NOW - 3 * DAY), exec: (n, a) => { seen.push([n, ...a]); return { ok: true, stdout: JSON.stringify(WIN) } },
  })
  assert.deepEqual(seen, [['codex', 'debug', 'models']])
  assert.equal(live.model, 'gpt-6.1-sol')
  const stale = resolve('codex', 'coder', { ...base, home: homeWith(NOW - 3 * DAY), exec: failExec })
  assert.equal(stale.model, 'gpt-5.6-sol')
  assert.equal(stale.source, 'fallback')
})

test('resolve/codex: models_cache.json đang bị Codex ghi dở (JSON hỏng) ⇒ đợi rồi đọc lại, không trả model null (CLI sẽ dùng mặc định có thể đã bị gỡ)', () => {
  const home = tmp()
  const file = path.join(home, '.codex', 'models_cache.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"fetched_at":"' + new Date(NOW).toISOString() + '","models":[{"slug":"gpt-5.6-s') // ghi dở
  const good = JSON.stringify({ ...MAC, fetched_at: new Date(NOW).toISOString() })
  const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(good)}), 150)`], { stdio: 'ignore' })
  try {
    const r = resolve('codex', 'coder', { home, now: NOW, env: {}, exec: () => ({ ok: false, error: 'bận' }), catalog: {} })
    assert.equal(r.model, 'gpt-5.6-sol', JSON.stringify(r))
  } finally { child.kill() }
})

test('resolve/codex: CODEX_HOME trong env được tôn trọng', () => {
  const home = tmp(); const codexHome = tmp('flow-models-codexhome-')
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ ...MAC, fetched_at: new Date(NOW).toISOString() }))
  const r = resolve('codex', 'coder', { home, now: NOW, env: { CODEX_HOME: codexHome }, exec: noExec, catalog: {} })
  assert.equal(r.model, 'gpt-5.6-sol')
})

test('resolve: vai/host lạ hoặc vai không chạy ở host đó ⇒ lỗi có mã và lời gợi ý', () => {
  const c = ctx()
  assert.throws(() => resolve('codex', 'khong-co', c), (e) => e.code === 'NO_ROLE' && /coder/.test(e.message))
  assert.throws(() => resolve('windsurf', 'coder', c), (e) => e.code === 'NO_HOST' && /claude/.test(e.message))
  assert.throws(() => resolve('agy', 'coder', c), (e) => e.code === 'NO_MODEL_FOR_HOST' && /claude/.test(e.message))
})

// ---------- ghi đè của user (~/.claude/flow.local.json) ----------

test('override: set → resolve ra source user; giữ khoá khác trong file; reset gỡ; áp dụng ngay không cần cài lại', () => {
  const home = tmp()
  const file = path.join(home, '.claude', 'flow.local.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ khac: { giu: 1 } }))
  const c = ctx({ home })
  assert.equal(resolve('claude', 'debugger', c).model, 'sonnet')
  setOverride('debugger', 'claude', 'opus:high', c)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.khac, { giu: 1 })
  assert.deepEqual(saved.models.debugger.claude, { line: 'opus', effort: 'high' })
  assert.deepEqual(pickFields(resolve('claude', 'debugger', c)), { model: 'opus', effort: 'high', source: 'user' })
  setOverride('debugger', 'codex', 'luna', c)
  const r = resolve('codex', 'debugger', c)
  assert.deepEqual(pickFields(r), { model: 'gpt-6-luna', effort: 'high', source: 'user' }, 'không ghi effort ⇒ giữ effort mặc định của vai')
  assert.equal(resolve('claude', 'coder', c).source, 'alias', 'vai khác không bị ảnh hưởng')
  resetOverride('debugger', undefined, c)
  assert.equal(resolve('claude', 'debugger', c).source, 'alias')
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.khac, { giu: 1 })
  assert.equal(after.models?.debugger, undefined)
})

test('override: dòng user đặt không có trên máy này ⇒ lùi chuỗi dự phòng, source fallback + lời báo (không giữ source user)', () => {
  const home = tmp()
  setOverride('coder', 'codex', 'astra', ctx({ home }))
  const r = resolve('codex', 'coder', { ...ctx({ home }), catalog: { codex: MAC } })
  assert.equal(r.model, 'gpt-5.6-sol')
  assert.equal(r.source, 'fallback')
  assert.ok(r.warnings.some((w) => /astra/.test(w)))
})

test('override: file cấu hình hỏng ⇒ resolve dùng mặc định + báo; set từ chối ghi đè lên file hỏng', () => {
  const home = tmp()
  const file = path.join(home, '.claude', 'flow.local.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ hỏng ')
  const c = ctx({ home })
  const r = resolve('claude', 'coder', c)
  assert.equal(r.model, 'sonnet')
  assert.ok(r.warnings.some((w) => /flow\.local\.json/.test(w)))
  assert.throws(() => setOverride('coder', 'claude', 'opus', c), (e) => e.code === 'USAGE' && /flow\.local\.json/.test(e.message))
  assert.equal(fs.readFileSync(file, 'utf8'), '{ hỏng ', 'không đè file hỏng')
})

test('override: tên không có trên máy ⇒ từ chối một dòng + gợi ý tên đúng; file không bị tạo', () => {
  const home = tmp()
  const c = ctx({ home })
  const file = path.join(home, '.claude', 'flow.local.json')
  assert.throws(() => setOverride('coder', 'codex', 'nova', c), (e) => e.code === 'USAGE' && !/\n/.test(e.message) && /sol/.test(e.message) && /luna/.test(e.message) && !/hidden|reserve/.test(e.message))
  assert.throws(() => setOverride('coder', 'claude', 'gpt-6', c), (e) => e.code === 'USAGE' && /opus/.test(e.message) && /sonnet/.test(e.message) && /haiku/.test(e.message))
  assert.throws(() => setOverride('coder', 'agy', 'opus', c), (e) => e.code === 'USAGE' && /claude/.test(e.message), 'vai coder không chạy trên agy')
  assert.throws(() => setOverride('coder', 'codex', 'sol:cực-cao', c), (e) => e.code === 'USAGE' && /high/.test(e.message))
  assert.throws(() => setOverride('coder', 'codex', 'astra', ctx({ home, catalog: { codex: MAC } })), (e) => e.code === 'USAGE' && /sol/.test(e.message), 'Mac không có astra')
  assert.throws(() => setOverride('khong-co', 'claude', 'opus', c), (e) => e.code === 'USAGE')
  assert.ok(!fs.existsSync(file))
})

test('override: không đọc được danh sách model ⇒ chỉ nhận các dòng đã biết của host, tên lạ vẫn bị từ chối', () => {
  const home = tmp()
  const c = ctx({ home, catalog: { codex: null }, exec: failExec })
  assert.doesNotThrow(() => setOverride('coder', 'codex', 'luna', c))
  assert.throws(() => setOverride('coder', 'codex', 'nova', c), (e) => e.code === 'USAGE')
})

// ---------- CLI (runCli trong tiến trình) ----------

function cli(argv, over = {}) {
  let out = ''; let err = ''
  const code = runCli(argv, { ...ctx(over), out: (s) => { out += s }, err: (s) => { err += s } })
  return { code, out, err }
}

test('CLI pick: in đúng một dòng model; --json đủ trường; --field; --escalate', () => {
  assert.deepEqual(cli(['pick', 'claude', 'coder']), { code: 0, out: 'sonnet\n', err: '' })
  const j = cli(['pick', 'codex', 'coder', '--json'])
  assert.equal(j.code, 0)
  const o = JSON.parse(j.out)
  assert.equal(o.model, 'gpt-6.1-sol'); assert.equal(o.effort, 'high'); assert.equal(o.source, 'catalog')
  assert.equal(cli(['pick', 'codex', 'coder', '--escalate']).out, 'gpt-6-astra\n')
  assert.equal(cli(['pick', 'codex', 'coder', '--field', 'effort']).out, 'high\n')
})

test('CLI pick: lời báo (hết hạn, hạ mức) ra stderr, stdout vẫn chỉ có model', () => {
  const soon = { models: [cm('gpt-5.6-sol', { upgrade: { model: 'gpt-6.1-sol', retirement_at: new Date(NOW + 2 * DAY).toISOString() } })] }
  const r = cli(['pick', 'codex', 'coder'], { catalog: { codex: soon } })
  assert.equal(r.code, 0)
  assert.equal(r.out, 'gpt-5.6-sol\n')
  assert.match(r.err, /2026-10-13/)
})

test('CLI pick: không có model dùng được ⇒ exit 3, stdout rỗng, một dòng lý do', () => {
  const r = cli(['pick', 'codex', 'coder'], { catalog: { codex: { models: [] } } })
  assert.equal(r.code, 3)
  assert.equal(r.out, '')
  assert.match(r.err, /codex/)
})

test('CLI: dùng sai ⇒ exit 2 và lời một dòng (vai lạ liệt kê vai có, host lạ, thiếu tham số, lệnh lạ)', () => {
  for (const [argv, re] of [
    [['pick', 'codex', 'khong-co'], /coder/],
    [['pick', 'agy', 'coder'], /claude/],
    [['pick', 'codex'], /pick/],
    [['pick'], /pick/],
    [['set', 'coder', 'claude'], /set/],
    [['reset'], /reset/],
    [['bay-gio'], /pick/],
    [[], /pick/],
  ]) {
    const r = cli(argv)
    assert.equal(r.code, 2, JSON.stringify(argv))
    assert.equal(r.out, '', JSON.stringify(argv))
    assert.match(r.err, re, JSON.stringify(argv))
  }
})

test('CLI set / pick / list / reset: vòng đời ghi đè', () => {
  const home = tmp()
  const o = { home }
  const s = cli(['set', 'debugger', 'claude', 'opus:high'], o)
  assert.equal(s.code, 0)
  assert.equal(s.out.trim().split('\n').length, 1, 'xác nhận một dòng')
  assert.equal(cli(['pick', 'claude', 'debugger'], o).out, 'opus\n')
  const l = cli(['list'], o)
  assert.equal(l.code, 0)
  for (const role of Object.keys(loadRoles().roles)) assert.ok(l.out.includes(role), `list thiếu ${role}`)
  const mine = l.out.split('\n').find((ln) => /^debugger\s+claude/.test(ln))
  assert.match(mine, /opus/); assert.match(mine, /bạn chọn/)
  const lj = JSON.parse(cli(['list', '--json'], o).out)
  assert.ok(Array.isArray(lj) && lj.every((x) => x.role && x.host && 'model' in x))
  assert.equal(lj.find((x) => x.role === 'debugger' && x.host === 'claude').source, 'user')
  const r = cli(['reset', 'debugger'], o)
  assert.equal(r.code, 0)
  assert.equal(cli(['pick', 'claude', 'debugger'], o).out, 'sonnet\n')
  const again = cli(['reset', 'debugger'], o)
  assert.equal(again.code, 0)
  assert.match(again.out, /mặc định/)
})

test('CLI set: tên lạ ⇒ exit 2, lời một dòng, không ghi gì', () => {
  const home = tmp()
  const r = cli(['set', 'coder', 'codex', 'nova'], { home })
  assert.equal(r.code, 2)
  assert.equal(r.err.trim().split('\n').length, 1)
  assert.match(r.err, /sol/)
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'flow.local.json')))
})

// ---------- CLI thật (tiến trình con, HOME giả, shim agy/codex giả trên PATH) ----------

function fakeEnv(home, bin) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v
  delete env.CODEX_HOME
  return { ...env, HOME: home, USERPROFILE: home, PATH: bin, VIBE_FLOW_PATH_ONLY: '1' }
}
// Shim đọc file kết quả nằm cạnh nó (tránh ký tự Unicode trong nội dung .cmd, cmd.exe đọc theo code page OEM).
function makeShim(bin, name, outName) {
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off
type "%~dp0${outName}"
`)
  // PATH của test chỉ có thư mục shim (fakeEnv) ⇒ trong shim không được gọi `cat`/`dirname` theo tên: sh báo 127 trên macOS/Linux.
  // Dùng đường dẫn tuyệt đối /bin/cat và phép thay thế tham số của sh (${0%/*}) thay cho dirname.
  else { const f = path.join(bin, name); fs.writeFileSync(f, `#!/bin/sh
/bin/cat "\${0%/*}/${outName}"
`); fs.chmodSync(f, 0o755) }
}
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
}

test('process: hooks/models.mjs đọc HOME giả — pick codex qua models_cache.json, agy qua shim .cmd/sh có dấu cách trong đường dẫn, set/reset ghi ở HOME giả', () => {
  const home = tmp(); const bin = path.join(tmp(), 'bin có dấu cách'); fs.mkdirSync(bin)
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ ...WIN, fetched_at: new Date().toISOString() }))
  fs.writeFileSync(path.join(bin, 'agy-out.txt'), REAL.agy)
  makeShim(bin, 'agy', 'agy-out.txt')
  const env = fakeEnv(home, bin)

  let r = run(['pick', 'claude', 'coder'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'sonnet\n')
  r = run(['pick', 'codex', 'coder'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'gpt-6.1-sol\n')
  r = run(['pick', 'agy', 'plan-reviewer'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'gemini-4-neon-high\n')
  assert.ok(fs.existsSync(path.join(home, '.claude', 'cache', 'models.json')), 'cache nằm ở HOME giả')

  r = run(['set', 'coder', 'claude', 'opus'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'flow.local.json'), 'utf8')).models.coder.claude.line, 'opus')
  assert.equal(run(['pick', 'claude', 'coder'], env).stdout, 'opus\n')
  r = run(['reset', 'coder'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(run(['pick', 'claude', 'coder'], env).stdout, 'sonnet\n')
})

test('findExe: ngoài PATH còn thử ~/.local/bin (macOS/Linux); VIBE_FLOW_PATH_ONLY=1 ⇒ chỉ PATH', { skip: process.platform === 'win32' }, () => {
  const home = tmp(); const empty = tmp('flow-models-empty-')
  const local = path.join(home, '.local', 'bin'); fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(local, 'droid'), '#!/bin/sh\n'); fs.chmodSync(path.join(local, 'droid'), 0o755) // findExe = resolveBin của clis.mjs: chỉ nhận tên CLI của kit
  assert.equal(findExe('droid', { PATH: empty }, home), path.join(local, 'droid'))
  assert.equal(findExe('droid', { PATH: empty, VIBE_FLOW_PATH_ONLY: '1' }, home), null)
  assert.equal(findExe('droid', { PATH: local, VIBE_FLOW_PATH_ONLY: '1' }, home), path.join(local, 'droid'))
})

test('process: CLI treo quá timeout ⇒ không treo theo, model null (exit 3) + lý do', { timeout: 60000 }, () => {
  const home = tmp(); const bin = tmp('flow-models-bin-')
  const slow = path.join(bin, 'slow.mjs'); fs.writeFileSync(slow, 'setTimeout(() => {}, 20000)\n')
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'agy.cmd'), `@echo off\r\n"${process.execPath}" "${slow}"\r\n`)
  else { const f = path.join(bin, 'agy'); fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${slow}"\n`); fs.chmodSync(f, 0o755) }
  const t0 = Date.now()
  const r = resolve('agy', 'plan-reviewer', { home, now: Date.now(), env: fakeEnv(home, bin), catalog: {}, timeoutMs: 800 })
  assert.ok(Date.now() - t0 < 12000, `chờ quá lâu: ${Date.now() - t0}ms`)
  assert.equal(r.model, null)
  assert.ok(r.warnings.some((w) => /agy/.test(w)), r.warnings.join('|'))
})

test('process: không có agy/codex trên PATH ⇒ pick agy không ném lỗi, exit 3 kèm lý do', () => {
  const home = tmp(); const bin = tmp('flow-models-empty-')
  const r = run(['pick', 'agy', 'plan-reviewer'], fakeEnv(home, bin))
  assert.equal(r.status, 3)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /agy/)
})

// ================= Hạng model (model-theo-hang): dữ liệu thật 2026-11-27 + dòng mới giả =================

const HOSTS = loadRoles().hosts
const PARSE = { agy: parseAgyCatalog, codex: parseCodexCatalog, droid: parseDroidHelp, 'cursor-agent': parseCursorModels, grok: parseGrokModels, qodercli: parseQoderModels }
const realEntries = (host) => PARSE[host](REAL[host])
const tiersOf = (host, entries = realEntries(host)) => {
  const c = classify(entries, HOSTS[host])
  return Object.fromEntries(Object.keys(c).map((t) => [t, c[t].map((g) => g.line)]))
}
const agyPlus = (...ids) => `${REAL.agy}\n${ids.map((i) => `${i}\t${i}`).join('\n')}`
const codexPlus = (...extra) => ({ ...JSON.parse(REAL.codex), models: [...JSON.parse(REAL.codex).models, ...extra] })
const pickIds = (host, entries) => Object.fromEntries(TIERS.map((t) => [t, pickTier(entries, HOSTS[host], t, { effort: 'high', now: NOW_REAL })?.id ?? null]))

test('parseDroidHelp: 51 mục (id + effort từng model), [Deprecated] bị loại, "(default)" chỉ là nhãn, 11 alias hạng chỉ làm mục alias', () => {
  const all = parseDroidHelp(REAL.droid)
  const models = all.filter((e) => !e.alias)
  assert.equal(models.length, DAP_AN.droid.entryCount)
  assert.ok(models.length >= 50)
  for (const id of DAP_AN.droid.deprecated) assert.ok(!all.some((e) => e.id === id), `${id} đã Deprecated mà vẫn có trong danh sách`)
  for (const [id, efforts] of Object.entries(DAP_AN.droid.efforts)) assert.deepEqual(models.find((e) => e.id === id).efforts, efforts, id)
  for (const id of DAP_AN.droid.noEfforts) assert.equal(models.find((e) => e.id === id).efforts, null, `${id} không có mức effort ⇒ null (không truyền -r)`)
  assert.deepEqual(all.filter((e) => e.alias).map((e) => e.id), DAP_AN.droid.aliases)
  for (const a of all.filter((e) => e.alias)) assert.equal(a.efforts, null, 'alias không có bảng effort ⇒ không bao giờ truyền -r')
  assert.ok(models.find((e) => e.id === 'gpt-6-sol'), 'gpt-6-sol (default) vẫn đọc được')
  for (const bad of [null, undefined, '', 'Error: not logged in', 42, 'Available Models:\n']) assert.deepEqual(parseDroidHelp(bad), [], String(bad))
})

test('droid: danh sách lấy bằng `droid exec --help`, nhớ 10 phút; lỗi ⇒ dùng bản đã lưu', () => {
  const home = tmp()
  let calls = 0
  const exec = (name, args) => { calls++; assert.deepEqual([name, args], ['droid', ['exec', '--help']]); return { ok: true, stdout: REAL.droid } }
  const base = { home, env: {}, exec, now: NOW_REAL, catalog: {} }
  assert.equal(resolve('droid', 'coder', base).model, 'gpt-6-sol')
  resolve('droid', 'coder-mini', { ...base, now: NOW_REAL + 9 * 60000 })
  assert.equal(calls, 1)
  resolve('droid', 'coder-mini', { ...base, now: NOW_REAL + 11 * 60000 })
  assert.equal(calls, 2)
  const dead = resolve('droid', 'coder', { ...base, exec: failExec, now: NOW_REAL + 60 * 60000 })
  assert.equal(dead.model, 'gpt-6-sol'); assert.equal(dead.source, 'fallback')
})

test('lineOf: dòng = token chữ đầu không phải tên nhà/số/mức effort/skip; id không có tên dòng ⇒ null', () => {
  const cfg = HOSTS.agy
  for (const [id, line] of [['gemini-4-neon-high', 'neon'], ['gpt-6-sol', 'sol'], ['claude-opus-4-6-thinking', 'opus'], ['gemini-3.8-flash', 'flash'], ['gpt-oss-120b', 'oss'],
    ['gemini-pro-orchestrator', 'pro'], ['mistral-medium-3.5', 'mistral'], ['kimi-k3', 'kimi'], ['gpt-5.5', null], ['gpt-5.3-codex', null], ['auto', null]]) {
    assert.equal(lineOf(id, cfg), line, id)
  }
})

test('xếp hạng trên danh sách THẬT của agy: đúng file đáp án; không ứng viên nào là orchestrator; Gemini 4 Neon thắng 3.8 Flash ở hạng mạnh', () => {
  const want = DAP_AN.agy
  const got = tiersOf('agy')
  for (const t of [...TIERS, 'chua-xep']) assert.deepEqual([...got[t]].sort(), [...want.tiers[t]].sort(), `agy ${t}`)
  const usable = usableEntries(realEntries('agy'), HOSTS.agy).map((e) => e.id)
  for (const id of want.neverPick) assert.ok(!usable.includes(id), `${id} không được là ứng viên`)
  assert.ok(!usable.some((id) => /orchestrator/.test(id)))
  assert.deepEqual(pickIds('agy', realEntries('agy')), want.pick)
  const neon = realEntries('agy').find((e) => e.id === 'gemini-4-neon')
  for (const [id, efforts] of Object.entries(want.effortTop)) assert.deepEqual([...realEntries('agy').find((e) => e.id === id).efforts].sort(), [...efforts].sort(), id)
  assert.ok(neon.efforts.includes('xhigh'))
})

test('xếp hạng trên danh sách THẬT của Codex: chỉ gpt-6-luna dùng được (nhanh); terra/luna 5.6 "Legacy", reserve và auto-review bị loại; không có hạng mạnh ⇒ null', () => {
  const want = DAP_AN.codex
  const got = tiersOf('codex')
  for (const t of [...TIERS, 'chua-xep']) assert.deepEqual([...got[t]].sort(), [...want.tiers[t]].sort(), `codex ${t}`)
  const usable = usableEntries(realEntries('codex'), HOSTS.codex).map((e) => e.id)
  assert.deepEqual(usable, ['gpt-6-luna'])
  for (const id of want.neverPick) assert.ok(!usable.includes(id), id)
  assert.deepEqual(pickIds('codex', realEntries('codex')), { manh: null, vua: null, nhanh: 'gpt-6-luna' })
})

test('xếp hạng trên danh sách THẬT của tài khoản Codex thứ hai: sol/astra mạnh, terra vừa, luna nhanh; bản Legacy bị loại; bản mới nhất gpt-6.2-*', () => {
  const want = DAP_AN.codex2
  const entries = parseCodexCatalog(CODEX2)
  const got = tiersOf('codex', entries)
  for (const t of [...TIERS, 'chua-xep']) assert.deepEqual([...got[t]].sort(), [...want.tiers[t]].sort(), `codex-2 ${t}`)
  const usable = usableEntries(entries, HOSTS.codex).map((e) => e.id)
  for (const id of want.neverPick) assert.ok(!usable.includes(id), id)
  assert.deepEqual(pickIds('codex', entries), want.pick)
  assert.equal(pickModel(usableEntries(entries, HOSTS.codex), { line: want.escalate.line, effort: 'high' }).id, want.escalate.model)
})

test('xếp hạng trên danh sách THẬT của Factory: sol/astra/opus mạnh, terra/sonnet vừa, luna/haiku nhanh; dòng lạ không đủ tin ⇒ chưa xếp; mặc định không phải alias', () => {
  const want = DAP_AN.droid
  const got = tiersOf('droid')
  for (const t of [...TIERS, 'chua-xep']) for (const line of want.tiers[t]) assert.ok(got[t].includes(line), `droid: ${line} phải ở hạng ${t}, thực tế: ${JSON.stringify(got)}`)
  const usable = usableEntries(realEntries('droid'), HOSTS.droid).map((e) => e.id)
  for (const id of want.neverPick) assert.ok(!usable.includes(id), `${id} không được là ứng viên`)
  assert.deepEqual(pickIds('droid', realEntries('droid')), want.pick)
  // mọi id chọn được đều có trong danh sách (kể cả mọi hạng × mọi mức)
  const ids = new Set(realEntries('droid').map((e) => e.id))
  for (const t of TIERS) for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(ids.has(pickTier(realEntries('droid'), HOSTS.droid, t, { effort, now: NOW_REAL }).id))
})

test('AC-02/AC-11 agy: dòng mới đời MỚI HƠN + xhigh ⇒ mạnh và thắng neon; CÙNG đời ⇒ mạnh nhưng không đè dòng đang dùng; tối đa high ⇒ vừa; tên lạ không tín hiệu ⇒ chưa xếp, không bao giờ được chọn', () => {
  const zircon5 = realEntries('agy').concat(parseAgyCatalog('gemini-5-zircon-high\tx\ngemini-5-zircon-xhigh\tx\ngemini-5-zircon-low\tx'))
  assert.ok(tiersOf('agy', zircon5).manh.includes('zircon'))
  assert.equal(pickIds('agy', zircon5).manh, 'gemini-5-zircon-high', 'đời 5 > đời 4 cùng họ gemini ⇒ dùng luôn')
  const same = realEntries('agy').concat(parseAgyCatalog('gemini-4-zircon-high\tx\ngemini-4-zircon-xhigh\tx'))
  assert.ok(tiersOf('agy', same).manh.includes('zircon'), 'cùng đời 4 + xhigh vẫn được xếp mạnh (đời ≥ chứ không phải >)')
  assert.equal(pickIds('agy', same).manh, 'gemini-4-neon-high', 'hoà đời ⇒ thứ tự tiers (neon trước) thắng')
  const quartz = realEntries('agy').concat(parseAgyCatalog('gemini-4-quartz-high\tx\ngemini-4-quartz-low\tx'))
  assert.ok(tiersOf('agy', quartz).vua.includes('quartz'), 'tối đa high ⇒ vừa')
  const odd = realEntries('agy').concat(parseAgyCatalog('foo-bar\tx\nfoo-bar-high\tx'))
  const t = tiersOf('agy', odd)
  assert.ok(t['chua-xep'].includes('foo'))
  for (const tier of TIERS) assert.ok(!t[tier].includes('foo'))
  const picks = pickIds('agy', odd)
  assert.ok(!Object.values(picks).some((id) => /foo/.test(id)), 'dòng chưa xếp không tự dùng')
})

test('AC-02 Codex/Factory: mức xhigh KHÔNG dùng để phong mạnh (gpt-6-luna cũng có xhigh); dòng mới cùng đời dựa vào mô tả nhà cung cấp hoặc từ khoá', () => {
  const mk = (slug, description) => ({ slug, visibility: 'list', priority: 9, description, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })) })
  const noDesc = parseCodexCatalog(codexPlus(mk('gpt-6-nova', 'Some new model.')))
  assert.ok(tiersOf('codex', noDesc)['chua-xep'].includes('nova'), 'có xhigh cũng không đủ để phong mạnh trên Codex')
  assert.equal(pickIds('codex', noDesc).manh, null)
  const frontier = parseCodexCatalog(codexPlus(mk('gpt-6-nova', 'Frontier model for complex coding.')))
  assert.ok(tiersOf('codex', frontier).manh.includes('nova'))
  assert.equal(pickIds('codex', frontier).manh, 'gpt-6-nova', 'Codex tự khai mạnh nhất ⇒ dùng, khỏi cần Factory')
  const cheap = parseCodexCatalog(codexPlus(mk('gpt-6-nova', 'Fast and cheap.')))
  assert.ok(tiersOf('codex', cheap).nhanh.includes('nova'))
  assert.equal(pickIds('codex', cheap).nhanh, 'gpt-6-luna', 'cùng đời, hoà ⇒ dòng trong bảng gợi ý trước')
})

test('mô tả của nhà cung cấp vừa có chữ nhanh vừa có chữ mạnh (frontier/flagship/hardest/most capable) ⇒ ưu tiên tín hiệu mạnh; chỉ có chữ nhanh/rẻ vẫn là nhanh', () => {
  const mk = (slug, description) => ({ slug, visibility: 'list', priority: 9, description, supported_reasoning_levels: [{ effort: 'high' }] })
  const mixed = parseCodexCatalog(codexPlus(mk('gpt-7-nova', 'Frontier model. Fast and capable for the hardest tasks.')))
  assert.ok(tiersOf('codex', mixed).manh.includes('nova'), JSON.stringify(tiersOf('codex', mixed)))
  assert.ok(!tiersOf('codex', mixed).nhanh.includes('nova'))
  assert.equal(pickIds('codex', mixed).manh, 'gpt-7-nova', 'hạng mạnh thấy dòng frontier mới, không bị đẩy xuống hạng nhanh để tranh với luna')
  for (const d of ['Our most capable model, fast too.', 'Flagship model with fast responses.', 'Fast model for the hardest problems.']) {
    assert.ok(tiersOf('codex', parseCodexCatalog(codexPlus(mk('gpt-7-nova', d)))).manh.includes('nova'), d)
  }
  assert.ok(tiersOf('codex', parseCodexCatalog(codexPlus(mk('gpt-7-nova', 'Fast and affordable model for easier tasks.')))).nhanh.includes('nova'))
})

test('xếp hạng theo mô tả của BẢN MỚI NHẤT trong dòng (bản sẽ được chọn), không nối mô tả mọi bản: gpt-6-nova "Frontier…" + gpt-7-nova "Fast and affordable…" ⇒ hạng mạnh không chọn gpt-7-nova', () => {
  const mk = (slug, description) => ({ slug, visibility: 'list', priority: 9, description, supported_reasoning_levels: [{ effort: 'high' }] })
  const oldStrong = parseCodexCatalog(codexPlus(mk('gpt-6-nova', 'Frontier model for complex coding.'), mk('gpt-7-nova', 'Fast and affordable model for easier tasks.')))
  const t = tiersOf('codex', oldStrong)
  assert.ok(t.nhanh.includes('nova') && !t.manh.includes('nova'), JSON.stringify(t))
  assert.notEqual(pickIds('codex', oldStrong).manh, 'gpt-7-nova')
  assert.equal(pickIds('codex', oldStrong).manh, null, 'không còn dòng nào ở hạng mạnh trên Codex này ⇒ null (Factory lo)')
  // chiều ngược lại: bản mới nhất là frontier, bản cũ là nhanh ⇒ mạnh, chọn đúng bản mới
  const newStrong = parseCodexCatalog(codexPlus(mk('gpt-6-nova', 'Fast and affordable model for easier tasks.'), mk('gpt-7-nova', 'Frontier model for complex coding.')))
  assert.ok(tiersOf('codex', newStrong).manh.includes('nova'))
  assert.equal(pickIds('codex', newStrong).manh, 'gpt-7-nova')
})

test('AC-04: bỏ bộ điều phối, model duyệt tự động, model ẩn/legacy/deprecated và hậu tố -fast; chữ fast KHÔNG nằm trong skip nên luật từ khoá fast ⇒ nhanh vẫn áp', () => {
  const ents = parseDroidHelp(REAL.droid)
  const usable = usableEntries(ents, HOSTS.droid).map((e) => e.id)
  for (const id of ['claude-opus-5-5-fast', 'gpt-5.6-sol-fast', 'gpt-5.5-fast', 'auto', 'openai-latest-premium']) assert.ok(!usable.includes(id), id)
  assert.ok(usable.includes('gpt-6-sol') && usable.includes('claude-opus-5-5'))
  const fastWord = parseCodexCatalog({ models: [{ slug: 'gpt-7-swift-fast-lite', visibility: 'list' }, { slug: 'gpt-7-quick', visibility: 'list', description: 'Fast model' }] })
  const t = tiersOf('codex', fastWord)
  assert.ok(t.nhanh.includes('swift') && t.nhanh.includes('quick'), JSON.stringify(t))
})

test('AC-06 + alias droid: hết model cụ thể ở hạng ⇒ alias hạng CHỈ khi help liệt kê, kèm effort null (không -r); không liệt kê ⇒ null', () => {
  const only = 'Available Models:\n  inkling                      Inkling\n\nModel details:\n  - Inkling: supports reasoning: Yes; supported: [low, high]; default: high\n\nPinning the Latest Model:\n    openai-latest-{premium,balanced,fast}\n'
  const r = resolve('droid', 'coder', ctx({ catalog: { droid: only } }))
  assert.deepEqual([r.model, r.effort, r.tier], ['openai-latest-premium', null, 'manh'])
  assert.equal(r.reason, 'tự xếp (alias hạng)')
  const bare = resolve('droid', 'coder', ctx({ catalog: { droid: only.replace(/Pinning[\s\S]*/, '') } }))
  assert.equal(bare.model, null)
  assert.ok(bare.warnings.some((w) => /droid/.test(w)))
})

test('AC-06: thiếu hạng ⇒ hạ hạng kề thấp hơn và báo; hết cách ⇒ model null; KHÔNG BAO GIỜ id ngoài danh sách', () => {
  const real = ctx({ catalog: { codex: REAL.codex, agy: REAL.agy, droid: REAL.droid }, now: NOW_REAL })
  const r = resolve('codex', 'coder', real)
  assert.deepEqual([r.host, r.model, r.source, r.reason], ['codex', 'gpt-6-luna', 'fallback', 'dự phòng (hạ xuống hạng nhanh)'])
  assert.ok(r.warnings.some((w) => /hạng mạnh/.test(w) && /nhanh/.test(w) && /gpt-6-luna/.test(w)), r.warnings.join('|'))
  const bare = parseCodexCatalog({ models: [{ slug: 'gpt-5.6-terra', visibility: 'list', description: 'Legacy balanced model' }] })
  assert.equal(bare.length, 1)
  const none = resolve('codex', 'coder', ctx({ catalog: { codex: { models: [{ slug: 'gpt-5.6-terra', visibility: 'list', description: 'Legacy balanced model' }] } } }))
  assert.equal(none.model, null)
  // tính chất: mọi vai × mọi host × mọi catalog thật/giả ⇒ model là null hoặc id có trong danh sách của host chạy thật
  const cats = { agy: agyPlus('gemini-5-zircon-xhigh', 'foo-bar'), codex: JSON.stringify(codexPlus()), droid: REAL.droid }
  const idsOf = { agy: new Set(), codex: new Set(), droid: new Set() }
  for (const h of Object.keys(idsOf)) for (const e of PARSE[h](cats[h])) { idsOf[h].add(e.id); for (const x of Object.values(e.effortIds ?? {})) idsOf[h].add(x) }
  for (const [role, def] of Object.entries(loadRoles().roles)) {
    for (const host of Object.keys(def.models)) {
      if (host === 'claude') continue
      for (const allowFallbackHost of [false, true]) {
        const x = resolve(host, role, ctx({ catalog: cats, now: NOW_REAL }), { allowFallbackHost })
        if (x.model !== null) assert.ok(idsOf[x.host].has(x.model), `${role}/${host}/${allowFallbackHost}: ${x.model} không có trong danh sách của ${x.host}`)
        if (!allowFallbackHost) assert.equal(x.host, host, `${role}/${host}: mặc định chỉ chọn trong đúng host`)
      }
    }
  }
})

test('AC-08/#1: allowFallbackHost mặc định TẮT ⇒ Codex không bao giờ nhận id của Factory; bật ⇒ host droid + fallbackFrom codex + một dòng báo; Codex có hạng ⇒ ở lại Codex', () => {
  const real = ctx({ catalog: { codex: REAL.codex, agy: REAL.agy, droid: REAL.droid }, now: NOW_REAL })
  const own = resolve('codex', 'debugger', real)
  assert.notEqual(own.model, 'gpt-6-sol')
  assert.equal(own.host, 'codex'); assert.equal(own.fallbackFrom, undefined)
  const fb = resolve('codex', 'debugger', real, { allowFallbackHost: true })
  assert.deepEqual([fb.host, fb.fallbackFrom, fb.model, fb.effort, fb.tier, fb.source, fb.reason], ['droid', 'codex', 'gpt-6-sol', 'high', 'manh', 'fallback', 'dự phòng Factory'])
  assert.equal(fb.warnings.filter((w) => /thiếu hạng mạnh/.test(w)).length, 1)
  assert.ok(fb.warnings.some((w) => w === 'Codex thiếu hạng mạnh, dùng Factory gpt-6-sol.'), fb.warnings.join('|'))
  const esc = resolve('codex', 'debugger', real, { escalate: true, allowFallbackHost: true })
  assert.deepEqual([esc.host, esc.model], ['droid', 'gpt-6-astra'], 'bậc leo thang astra không có trên Codex ⇒ cùng dòng astra ở Factory')
  const hasSol = resolve('codex', 'debugger', ctx({ now: NOW_REAL }), { allowFallbackHost: true })
  assert.deepEqual([hasSol.host, hasSol.model, hasSol.fallbackFrom], ['codex', 'gpt-6.1-sol', undefined])
  const noDroid = resolve('codex', 'debugger', ctx({ catalog: { codex: REAL.codex, droid: null }, now: NOW_REAL }), { allowFallbackHost: true })
  assert.deepEqual([noDroid.host, noDroid.model], ['codex', 'gpt-6-luna'], 'Factory không đọc được ⇒ hạ hạng trong Codex')
  // pick CLI không bao giờ in id của Factory
  const p = cli(['pick', 'codex', 'debugger', '--json'], { catalog: { codex: REAL.codex, agy: REAL.agy, droid: REAL.droid }, now: NOW_REAL })
  assert.equal(JSON.parse(p.out).host, 'codex'); assert.equal(JSON.parse(p.out).model, 'gpt-6-luna'); assert.equal(JSON.parse(p.out).fallbackFrom, undefined)
})

test('vai ghi line (dòng ưu tiên trong hạng): hydrogen có ⇒ dùng; không có ⇒ rơi về hạng mạnh kèm lời báo; plan-reviewer và sensitive-reviewer ra hai model KHÁC nhau', () => {
  const real = ctx({ catalog: { agy: REAL.agy }, now: NOW_REAL })
  const plan = resolve('agy', 'plan-reviewer', real)
  const sens = resolve('agy', 'sensitive-reviewer', real)
  assert.deepEqual([plan.model, sens.model], ['gemini-4-neon-high', 'gemini-4-hydrogen-high'])
  assert.notEqual(plan.model, sens.model)
  assert.deepEqual([plan.tier, sens.tier], ['manh', 'manh'])
  const noH = resolve('agy', 'sensitive-reviewer', ctx({ catalog: { agy: REAL.agy.replace(/gemini-4-hydrogen.*\n/g, '') }, now: NOW_REAL }))
  assert.equal(noH.model, 'gemini-4-neon-high')
  assert.equal(noH.source, 'fallback')
  assert.ok(noH.warnings.some((w) => /hydrogen/.test(w) && /neon/.test(w)), noH.warnings.join('|'))
})

test('AC-05: user đã chọn ⇒ giữ nguyên (source user) kể cả khi có dòng tự xếp mới hơn; chỉ báo "có dòng mới, bạn đang giữ X"; dòng đã có trong bảng gợi ý thì không báo', () => {
  const home = tmp()
  const cat = agyPlus('gemini-5-zircon-high', 'gemini-5-zircon-xhigh', 'gemini-5-zircon-medium')
  setOverride('sensitive-reviewer', 'agy', 'carbon:medium', ctx({ home, catalog: { agy: cat }, now: NOW_REAL }))
  const kept = resolve('agy', 'sensitive-reviewer', ctx({ home, catalog: { agy: cat }, now: NOW_REAL }))
  assert.deepEqual([kept.model, kept.source, kept.reason], ['gemini-4-carbon-medium', 'user', 'bạn chọn'])
  assert.deepEqual(kept.newer, { line: 'zircon', model: 'gemini-5-zircon-medium', tier: 'manh' })
  assert.ok(kept.warnings.some((w) => /Có dòng mới zircon/.test(w) && /bạn đang giữ carbon/.test(w) && /gemini-4-carbon-medium/.test(w)), kept.warnings.join('|'))
  const calm = resolve('agy', 'sensitive-reviewer', ctx({ home, catalog: { agy: REAL.agy }, now: NOW_REAL }))
  assert.equal(calm.model, 'gemini-4-carbon-medium'); assert.equal(calm.newer, undefined)
  assert.ok(!calm.warnings.some((w) => /dòng mới/.test(w)))
})

test('override: set theo id không có tên dòng (gpt-5.5) ⇒ từ chối rõ ràng một dòng, không ghi file', () => {
  const home = tmp()
  assert.throws(() => setOverride('coder', 'droid', 'gpt-5.5', ctx({ home })), (e) => e.code === 'USAGE' && !/\n/.test(e.message) && /không có tên dòng/.test(e.message) && /sol/.test(e.message))
  assert.throws(() => setOverride('coder', 'droid', 'zzz', ctx({ home })), (e) => e.code === 'USAGE' && /Máy này không có dòng/.test(e.message))
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'flow.local.json')))
  assert.doesNotThrow(() => setOverride('coder', 'droid', 'fable', ctx({ home })), 'dòng chưa xếp vẫn chọn tay được (AC-11)')
  assert.equal(resolve('droid', 'coder', ctx({ home })).model, 'claude-fable-5.1')
})

test('list: có cột hạng + lý do; vai mạnh của Codex ghi "dự phòng Factory" khi Codex thiếu hạng; --json giữ host đã hỏi và thêm via', () => {
  const o = { catalog: { codex: REAL.codex, agy: REAL.agy, droid: REAL.droid }, now: NOW_REAL }
  const l = cli(['list'], o)
  assert.equal(l.code, 0)
  const head = l.out.split('\n')[0]
  for (const col of ['vai', 'app', 'hạng', 'dòng:mức', 'model', 'lý do']) assert.ok(head.includes(col), col)
  const row = (re) => l.out.split('\n').find((ln) => re.test(ln))
  assert.match(row(/^debugger\s+codex/), /mạnh.*gpt-6-sol.*dự phòng Factory/)
  assert.match(row(/^coder-mini\s+codex/), /nhanh.*gpt-6-luna.*tự xếp/)
  assert.match(row(/^plan-reviewer\s+agy/), /mạnh.*gemini-4-neon-high.*tự xếp/)
  assert.match(row(/^sensitive-reviewer\s+agy/), /mạnh.*gemini-4-hydrogen-high/)
  assert.match(row(/^coder\s+claude/), /tên dòng/)
  assert.match(l.err, /Codex thiếu hạng mạnh, dùng Factory gpt-6-sol/)
  const j = JSON.parse(cli(['list', '--json'], o).out).find((x) => x.role === 'debugger' && x.host === 'codex')
  assert.deepEqual([j.host, j.via, j.fallbackFrom, j.model, j.tier], ['codex', 'droid', 'codex', 'gpt-6-sol', 'manh'])
})

test('#6 PATH thưa: droid chỉ nằm ở thư mục cài mặc định (~/bin trên Windows, ~/.local/bin trên macOS) vẫn đọc được danh sách qua models.resolve', () => {
  const home = tmp()
  const dir = process.platform === 'win32' ? path.join(home, 'bin') : path.join(home, '.local', 'bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'droid-out.txt'), REAL.droid)
  makeShim(dir, 'droid', 'droid-out.txt')
  const empty = tmp('flow-models-empty-')
  const env = { PATH: empty, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) }
  assert.ok(findExe('droid', env, home), 'findExe dùng resolveBin: thấy droid ở thư mục cài mặc định')
  const r = resolve('droid', 'coder', { home, env, now: NOW_REAL, catalog: {} })
  assert.deepEqual([r.model, r.source], ['gpt-6-sol', 'catalog'], r.warnings.join('|'))
  const strict = resolve('droid', 'coder', { home, env: { ...env, VIBE_FLOW_PATH_ONLY: '1' }, now: NOW_REAL, catalog: {}, cacheDir: tmp() })
  assert.equal(strict.model, null, 'VIBE_FLOW_PATH_ONLY=1 ⇒ chỉ tìm trên PATH')
})

test('claimModelsRefresh: một phiên giành được khoá trong mỗi 10 phút; khoá cũ hơn 10 phút hoặc giờ ở tương lai xa thì giành lại', () => {
  const o = { home: tmp() }
  assert.equal(claimModelsRefresh(o, NOW), true)
  assert.equal(claimModelsRefresh(o, NOW + 9 * 60000), false)
  assert.equal(claimModelsRefresh(o, NOW + 11 * 60000), true)
  assert.equal(claimModelsRefresh(o, NOW + 11 * 60000 - 3 * DAY), true, 'đồng hồ lùi xa ⇒ khoá hết hạn')
})

test('refreshCatalogs: gọi CLI lấy danh sách mới (bỏ qua hạn 10 phút), Codex đọc file; host đã gỡ khỏi máy ⇒ bỏ danh sách đã lưu', () => {
  const home = tmp()
  const calls = []
  const exec = (name, args) => { calls.push([name, ...args].join(' ')); return { ok: true, stdout: REAL[name] ?? REAL.codex } }
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ ...JSON.parse(REAL.codex), fetched_at: new Date(NOW_REAL).toISOString() }))
  refreshCatalogs({ home, env: {}, now: NOW_REAL, exec })
  refreshCatalogs({ home, env: {}, now: NOW_REAL + 1000, exec })
  const round = ['agy models', 'droid exec --help', 'cursor-agent models', 'grok models', 'qodercli --list-models']
  assert.deepEqual(calls, [...round, ...round], 'mỗi app theo hạng gọi lệnh liệt kê của nó; Codex đọc file (còn mới) nên không gọi CLI')
  const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cache', 'models.json'), 'utf8'))
  assert.ok(cache.hosts.agy.entries.length && cache.hosts.droid.entries.length)
  const bin = tmp('flow-models-empty-')
  refreshCatalogs({ home, env: { PATH: bin, VIBE_FLOW_PATH_ONLY: '1' }, now: NOW_REAL })
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cache', 'models.json'), 'utf8'))
  assert.deepEqual(Object.keys(after.hosts), [], 'agy/droid không còn trên máy ⇒ bỏ danh sách đã lưu (session-start không kích lại mãi)')
})

// ---------- Cursor, Grok, Qoder: đọc được danh sách thật, xếp hạng đúng, chưa vai nào dùng ----------

test('parseCursorModels (danh sách THẬT 2026.11.22): bỏ -fast, auto, tiêu đề/Tip; gom id cùng gốc theo mức (extra-high ⇒ xhigh, -thinking giữ ở gốc); cờ (NO ZDR) chỉ ghi chú', () => {
  const want = DAP_AN['cursor-agent']
  const ents = realEntries('cursor-agent')
  assert.equal(ents.length, want.entryCount)
  const real = new Set(ents.flatMap((e) => (e.effortIds ? Object.values(e.effortIds) : [e.id])))
  assert.ok(![...real].some((id) => /-fast$/.test(id)), 'không còn biến thể chế độ nhanh')
  assert.ok(!real.has('auto') && ![...real].some((id) => /tip|available/i.test(id)))
  for (const [base, ids] of Object.entries(want.effortIds)) for (const [effort, id] of Object.entries(ids)) assert.equal(ents.find((e) => e.id === base).effortIds[effort], id, `${base}/${effort}`)
  for (const id of want.noEfforts) assert.equal(ents.find((e) => e.id === id).efforts, null, id)
  assert.deepEqual(ents.filter((e) => e.noZdr).map((e) => e.id).sort(), want.noZdr)
  assert.ok(usableEntries(ents, HOSTS['cursor-agent']).some((e) => e.noZdr), '(NO ZDR) không bị loại')
  for (const bad of [null, undefined, '', 'Error: not logged in', 'Available models\n\nauto - Auto (default)\n']) assert.deepEqual(parseCursorModels(bad), [], String(bad))
})

test('xếp hạng danh sách THẬT của Cursor: chợ nhiều họ ⇒ theo họ; sol/terra/luna của gpt-5.6 làm đầu mỗi hạng; dòng lạ (composer, fable, muse, kimi, glm, grok) chưa xếp; không id -fast/auto', () => {
  const want = DAP_AN['cursor-agent']
  const got = tiersOf('cursor-agent')
  for (const t of [...TIERS, 'chua-xep']) assert.deepEqual([...got[t]].sort(), [...want.tiers[t]].sort(), `cursor ${t}`)
  assert.deepEqual(pickIds('cursor-agent', realEntries('cursor-agent')), want.pick)
  const ids = new Set(realEntries('cursor-agent').flatMap((e) => Object.values(e.effortIds ?? { x: e.id })))
  for (const id of want.neverPick) assert.ok(!ids.has(id), id)
  // id chọn ra là id THẬT của một mức (không phải gốc đã gom): gpt-5.6-sol có xhigh ⇒ mức xhigh lấy đúng id Cursor đặt tên
  assert.equal(pickTier(realEntries('cursor-agent'), HOSTS['cursor-agent'], 'manh', { effort: 'xhigh' }).id, 'gpt-5.6-sol-xhigh')
  assert.equal(pickModel(usableEntries(realEntries('cursor-agent'), HOSTS['cursor-agent']), { line: 'sol', effort: 'ultra' }).id, 'gpt-5.6-sol-max', 'mức không có ⇒ hạ về mức cao nhất ≤ yêu cầu')
})

test('parseGrokModels + xếp hạng (grok models 1.0.92): chỉ grok-4.7, một họ ⇒ hạng mạnh, không có mức effort ⇒ effort null (không truyền mức)', () => {
  assert.deepEqual(realEntries('grok').map((e) => e.id), DAP_AN.grok.ids)
  const got = tiersOf('grok')
  for (const t of [...TIERS, 'chua-xep']) assert.deepEqual(got[t], DAP_AN.grok.tiers[t], t)
  assert.deepEqual(pickIds('grok', realEntries('grok')), DAP_AN.grok.pick)
  assert.equal(pickTier(realEntries('grok'), HOSTS.grok, 'manh', { effort: 'high' }).effort, null)
  assert.deepEqual(parseGrokModels('Available models:\n  * grok-4.7 (default)\n  grok-4.5\n').map((e) => e.id), ['grok-4.7', 'grok-4.5'])
  for (const bad of [null, '', 'Not logged in. Run grok login', 'Default model: grok-4.7']) assert.deepEqual(parseGrokModels(bad), [], String(bad))
})

test('Qoder (qodercli --list-models): tài khoản miễn phí chỉ in tiêu đề MODEL ⇒ danh sách rỗng; có bảng thì cột đầu là id; host providerPicks không truyền -m', () => {
  assert.deepEqual(realEntries('qodercli'), DAP_AN.qoder.ids)
  assert.deepEqual(parseQoderModels('Warning: no models available for your account.\nMODEL\n'), [])
  assert.deepEqual(parseQoderModels('MODEL         NOTE\nqwen3-coder   free\nglm-5.2       free\n').map((e) => e.id), ['qwen3-coder', 'glm-5.2'])
  assert.deepEqual(parseQoderModels(null), [])
  assert.equal(HOSTS.qodercli.providerPicks, true)
  // vai thử (sổ vai thật chưa có vai nào trên qodercli): model rỗng, không cảnh báo, source catalog, pick thoát 0 + stdout rỗng
  const reg = structuredClone(loadRoles())
  reg.roles['test-runner'].models.qodercli = { tier: 'nhanh', effort: 'low' }
  const r = resolve('qodercli', 'test-runner', ctx({ roles: reg, catalog: { qodercli: REAL.qodercli } }))
  assert.deepEqual([r.model, r.source, r.providerPicks, r.reason, r.warnings], [null, 'catalog', true, 'nhà cung cấp tự chọn', []])
  const p = cli(['pick', 'qodercli', 'test-runner'], { roles: reg, catalog: { qodercli: null } })
  assert.deepEqual([p.code, p.out, p.err], [0, '', ''])
  // có danh sách ⇒ phân loại như thường; dòng chưa biết coi là hạng nhanh (defaultTier)
  const listed = resolve('qodercli', 'test-runner', ctx({ roles: reg, catalog: { qodercli: 'MODEL\nqwen3-coder\n' } }))
  assert.deepEqual([listed.model, listed.tier, listed.providerPicks], ['qwen3-coder', 'nhanh', true])
  assert.deepEqual(tiersOf('qodercli', parseQoderModels('MODEL\nqwen3-coder\n')).nhanh, ['coder'], 'dòng = token chữ đầu (qwen3 có số dính chữ nên bỏ); host defaultTier ⇒ hạng nhanh')
})

test('models.mjs tiers <app>: bảng hạng trên máy (không cần vai); app không theo hạng ⇒ exit 2; Qoder rỗng ⇒ nói rõ, không cảnh báo', () => {
  const o = { catalog: { 'cursor-agent': REAL['cursor-agent'], grok: REAL.grok, qodercli: REAL.qodercli, agy: REAL.agy }, now: NOW_REAL }
  const c = cli(['tiers', 'cursor-agent'], o)
  assert.equal(c.code, 0, c.err)
  assert.match(c.out, /^mạnh {2}gpt-5\.6-sol-high: .*sol/m)
  assert.match(c.out, /^vừa {2}gpt-5\.6-terra-high: /m)
  assert.match(c.out, /^nhanh {2}gpt-5\.6-luna-high: /m)
  assert.match(c.out, /^chưa xếp: .*fable/m)
  assert.match(cli(['tiers', 'grok'], o).out, /^mạnh {2}grok-4\.7: grok$/m)
  const q = cli(['tiers', 'qodercli'], o)
  assert.deepEqual([q.code, q.err], [0, ''])
  assert.match(q.out, /nhà cung cấp tự chọn model/)
  const j = JSON.parse(cli(['tiers', 'agy', '--json'], o).out)
  assert.deepEqual(j.rows.map((r) => r.model), ['gemini-4-neon-high', 'gemini-4-carbon-high', 'gemini-3.8-flash-high', null])
  const bad = cli(['tiers', 'claude'], o)
  assert.equal(bad.code, 2); assert.match(bad.err, /theo hạng/)
  assert.equal(cli(['tiers'], o).code, 2)
  assert.equal(tierTable('grok', { ...ctx(), catalog: { grok: REAL.grok } }).rows[0].model, 'grok-4.7')
})

test('ba app mới chưa vai nào dùng: list không đổi, pick báo "vai không chạy trên app", không ai bị đổi model', () => {
  const l = cli(['list'], ctx({ catalog: { codex: WIN, agy: AGY, droid: REAL.droid } }))
  assert.equal(l.code, 0, l.err)
  assert.ok(!/cursor-agent|grok|qodercli/.test(l.out))
  for (const host of ['cursor-agent', 'grok', 'qodercli']) {
    const r = cli(['pick', host, 'coder'])
    assert.equal(r.code, 2); assert.match(r.err, /không chạy trên/)
  }
  for (const r of Object.values(loadRoles().roles)) assert.ok(!r.models['cursor-agent'] && !r.models.grok && !r.models.qodercli)
})

// ---------- nhiều tài khoản Codex (mỗi tài khoản một models_cache.json KHÁC nhau) ----------

const CODEX2 = fs.readFileSync(path.join(FIX, 'codex-2.json'), 'utf8')
// HOME giả có ~/.codex (tài khoản 1: gpt-6-luna…, bản chụp thật) và ~/.codex-2 (tài khoản 2: gpt-6.2-sol, gpt-6.2-astra…, bản chụp thật), cả hai có auth.json.
function twoAccounts({ at = NOW_REAL } = {}) {
  const home = tmp()
  for (const [dir, text] of [['.codex', REAL.codex], ['.codex-2', CODEX2]]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
    fs.writeFileSync(path.join(home, dir, 'auth.json'), '{}')
    fs.writeFileSync(path.join(home, dir, 'models_cache.json'), JSON.stringify({ ...JSON.parse(text), fetched_at: new Date(at).toISOString() }))
  }
  const tk = (n) => path.join(home, n === 1 ? '.codex' : '.codex-2')
  return { home, tk, opts: { home, env: {}, now: NOW_REAL, exec: noExec, catalog: { droid: REAL.droid, agy: REAL.agy } } }
}
const spend = (w, n, until = NOW_REAL + 3600000) => {
  const file = path.join(w.home, '.claude', 'cache', 'codex-het-luot.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ [w.tk(n)]: { until }, [w.tk(n).toLowerCase()]: { until } }))
}

test('Codex 2 tài khoản + allAccounts: gộp danh sách mọi tài khoản ⇒ vai mạnh = gpt-6.2-sol của tài khoản 2 (homes), leo thang astra = gpt-6.2-astra, vai nhanh có ở cả hai tài khoản', () => {
  const w = twoAccounts()
  const r = resolve('codex', 'coder', w.opts, { allAccounts: true })
  assert.deepEqual([r.host, r.model, r.effort, r.source, r.tier], ['codex', 'gpt-6.2-sol', 'high', 'catalog', 'manh'])
  assert.deepEqual(r.homes, [w.tk(2)])
  assert.match(r.reason, /tự xếp · tài khoản 2/)
  assert.equal(resolve('codex', 'coder', w.opts, { allAccounts: true, escalate: true }).model, 'gpt-6.2-astra')
  const mini = resolve('codex', 'coder-mini', w.opts, { allAccounts: true })
  assert.equal(mini.model, 'gpt-6-luna')
  assert.deepEqual(mini.homes.map((d) => path.basename(d)).sort(), ['.codex', '.codex-2'])
  assert.ok(!mini.warnings.some((x) => /tài khoản/i.test(x)))
})

test('Codex 2 tài khoản, tài khoản mặc định (CODEX_HOME hiện tại) = 1 ⇒ model của tài khoản 1 + cảnh báo "tài khoản Codex 2 có <id>"; KHÔNG ghi id tài khoản khác vào TOML/Paseo', () => {
  const w = twoAccounts()
  const r = resolve('codex', 'coder', w.opts)
  assert.deepEqual([r.host, r.model, r.source], ['codex', 'gpt-6-luna', 'fallback'], 'tài khoản 1 chỉ có luna ⇒ hạ hạng, không mượn sol của tài khoản 2')
  assert.deepEqual(r.homes, [w.tk(1)])
  assert.ok(r.warnings.some((x) => x === 'Tài khoản Codex 2 có gpt-6.2-sol (hạng mạnh), đổi tài khoản mặc định nếu muốn.'), r.warnings.join('|'))
  const esc = resolve('codex', 'coder', w.opts, { escalate: true })
  assert.equal(esc.model, 'gpt-6-luna')
  assert.ok(esc.warnings.some((x) => /Tài khoản Codex 2 có gpt-6\.2-astra/.test(x)))
  // đổi tài khoản mặc định sang 2 ⇒ gpt-6.2-sol, không còn lời báo về tài khoản khác
  const two = resolve('codex', 'coder', { ...w.opts, env: { CODEX_HOME: w.tk(2) } })
  assert.deepEqual([two.model, two.source], ['gpt-6.2-sol', 'catalog'])
  assert.ok(!two.warnings.some((x) => /Tài khoản Codex/.test(x)))
})

test('Codex 2 tài khoản: tài khoản 2 ghi hết lượt ⇒ allAccounts bỏ nó (Factory gpt-6-sol nếu bật allowFallbackHost, không thì hạ hạng trong tài khoản 1); hết hạn ghi sổ ⇒ lại gpt-6.2-sol; hết cả hai ⇒ giữ cả', () => {
  const w = twoAccounts()
  spend(w, 2)
  const fb = resolve('codex', 'coder', w.opts, { allAccounts: true, allowFallbackHost: true })
  assert.deepEqual([fb.host, fb.fallbackFrom, fb.model, fb.homes], ['droid', 'codex', 'gpt-6-sol', undefined])
  assert.ok(fb.warnings.some((x) => x === 'Codex thiếu hạng mạnh, dùng Factory gpt-6-sol.'), fb.warnings.join('|'))
  const own = resolve('codex', 'coder', w.opts, { allAccounts: true })
  assert.deepEqual([own.host, own.model, own.homes], ['codex', 'gpt-6-luna', [w.tk(1)]])
  assert.equal(resolve('codex', 'coder', { ...w.opts, now: NOW_REAL + 2 * 3600000 }, { allAccounts: true }).model, 'gpt-6.2-sol')
  const file = path.join(w.home, '.claude', 'cache', 'codex-het-luot.json')
  fs.writeFileSync(file, JSON.stringify({ [w.tk(1)]: { until: NOW_REAL + 3600000 }, [w.tk(2)]: { until: NOW_REAL + 7200000 }, [w.tk(1).toLowerCase()]: { until: NOW_REAL + 3600000 }, [w.tk(2).toLowerCase()]: { until: NOW_REAL + 7200000 } }))
  assert.equal(resolve('codex', 'coder', w.opts, { allAccounts: true }).model, 'gpt-6.2-sol', 'mọi tài khoản đều hết lượt ⇒ vẫn xét hết (runWithAccounts thử tài khoản mở lại sớm nhất)')
})

test('Codex nhiều tài khoản: file models_cache.json của tài khoản cũ hơn 24 giờ ⇒ `codex debug models` chạy với CODEX_HOME của CHÍNH tài khoản đó; tài khoản còn mới không bị gọi', () => {
  const w = twoAccounts()
  fs.writeFileSync(path.join(w.tk(2), 'models_cache.json'), JSON.stringify({ ...JSON.parse(CODEX2), fetched_at: new Date(NOW_REAL - 3 * DAY).toISOString() }))
  const seen = []
  const exec = (name, args, o) => { seen.push([name, ...args, o.env.CODEX_HOME]); return { ok: true, stdout: JSON.stringify({ ...JSON.parse(CODEX2), models: [...JSON.parse(CODEX2).models, { slug: 'gpt-6.3-sol', visibility: 'list', priority: 0, supported_reasoning_levels: [{ effort: 'high' }] }] }) } }
  const r = resolve('codex', 'coder', { ...w.opts, exec }, { allAccounts: true })
  assert.deepEqual(seen, [['codex', 'debug', 'models', w.tk(2)]])
  assert.equal(r.model, 'gpt-6.3-sol')
  assert.deepEqual(r.homes, [w.tk(2)])
  // exec lỗi ⇒ dùng file cũ của tài khoản 2 (không mất tài khoản 1)
  const dead = resolve('codex', 'coder', { ...w.opts, exec: failExec, cacheDir: tmp() }, { allAccounts: true })
  assert.deepEqual([dead.model, dead.source], ['gpt-6.2-sol', 'fallback'])
  assert.ok(dead.warnings.some((x) => /tài khoản 2/.test(x)), dead.warnings.join('|'))
})

test('Codex nhiều tài khoản: list thật ghi model + tài khoản; pick (mặc định) không đụng tài khoản khác nhưng kèm lời báo trên stderr, stdout chỉ có model của tài khoản mặc định', () => {
  const w = twoAccounts()
  const l = cli(['list'], w.opts)
  assert.equal(l.code, 0, l.err)
  const row = (re) => l.out.split('\n').find((ln) => re.test(ln))
  assert.match(row(/^coder\s+codex/), /mạnh\s+sol:high\s+gpt-6\.2-sol\s+tự xếp · tài khoản 2/)
  assert.match(row(/^coder-mini\s+codex/), /gpt-6-luna.*tài khoản 1, 2/)
  const p = cli(['pick', 'codex', 'coder'], w.opts)
  assert.equal(p.out, 'gpt-6-luna\n')
  assert.match(p.err, /Tài khoản Codex 2 có gpt-6\.2-sol/)
  const e = cli(['pick', 'codex', 'coder', '--escalate'], { ...w.opts, env: { CODEX_HOME: w.tk(2) } })
  assert.equal(e.out, 'gpt-6.2-astra\n')
})

test('Codex nhiều tài khoản: session-start đọc cache gộp cả hai tài khoản (không gọi CLI); dòng mới chỉ có ở tài khoản 2 vẫn được thấy', () => {
  const w = twoAccounts()
  assert.deepEqual(newLineNotices({ home: w.home, env: {}, now: NOW_REAL }), { lines: [], stale: [] }, 'lần đầu ghi im')
  const seen = JSON.parse(fs.readFileSync(path.join(w.home, '.claude', 'cache', 'models.json'), 'utf8')).seenLines.codex
  assert.ok(seen.includes('sol') && seen.includes('astra') && seen.includes('luna'), seen.join(','))
  // tài khoản 2 có thêm dòng mới ⇒ báo (dòng 'nova' tên lạ cùng đời, không đủ tín hiệu ⇒ chưa xếp kèm lệnh chọn tay)
  const f = path.join(w.tk(2), 'models_cache.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  j.models.push({ slug: 'gpt-6.2-nova', visibility: 'list', priority: 9, description: 'Some new model.', supported_reasoning_levels: [{ effort: 'high' }] })
  fs.writeFileSync(f, JSON.stringify(j))
  const r = newLineNotices({ home: w.home, env: {}, now: NOW_REAL + 1000 })
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /Codex có dòng mới nova chưa xếp được hạng nên chưa dùng.*models\.mjs set <vai> codex nova/)
})

// ---------- báo dòng mới (AC-03, AC-05, AC-11) ----------

// Ghi cache như một lần resolve/refresh thật: resolve với catalog tiêm sẵn lưu danh sách vào ~/.claude/cache/models.json.
function seedCache(home, cats, now = NOW_REAL) {
  for (const [host, role] of [['codex', 'coder'], ['agy', 'plan-reviewer'], ['droid', 'coder']]) resolve(host, role, { home, env: {}, now, exec: noExec, catalog: { [host]: cats[host] } })
}
const REAL_CATS = { codex: REAL.codex, agy: REAL.agy, droid: REAL.droid }

test('AC-03: lần đầu ghi im; dòng mới ⇒ đúng MỘT dòng nêu dòng + hạng + vai đổi sang model nào; lần sau im; cache mới ⇒ không đòi làm tươi nền', () => {
  const home = tmp()
  seedCache(home, REAL_CATS)
  const o = { home, env: {}, now: NOW_REAL + 60000 }
  assert.deepEqual(newLineNotices(o), { lines: [], stale: [] })
  const seen = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cache', 'models.json'), 'utf8')).seenLines
  assert.ok(seen.agy.includes('neon') && seen.codex.includes('luna') && seen.droid.includes('sol'))
  seedCache(home, { ...REAL_CATS, agy: agyPlus('gemini-5-zircon-high', 'gemini-5-zircon-xhigh') }, NOW_REAL + 120000)
  const r = newLineNotices({ ...o, now: NOW_REAL + 180000 })
  assert.equal(r.lines.length, 1)
  assert.doesNotMatch(r.lines[0], /\n/)
  assert.match(r.lines[0], /agy có dòng mới zircon \(hạng mạnh\)/)
  assert.match(r.lines[0], /plan-reviewer/); assert.match(r.lines[0], /gemini-5-zircon-high/)
  assert.match(r.lines[0], /cho vai X dùng model Y/)
  assert.ok(!/sensitive-reviewer/.test(r.lines[0]) || /hydrogen|zircon/.test(r.lines[0]))
  assert.deepEqual(newLineNotices({ ...o, now: NOW_REAL + 240000 }), { lines: [], stale: [] }, 'không báo lại')
})

test('AC-05 + AC-11 ở session-start: vai user đang giữ model riêng ⇒ "bạn đang giữ X"; dòng chưa xếp ⇒ báo kèm lệnh chọn tay, không tự dùng', () => {
  const home = tmp()
  seedCache(home, REAL_CATS)
  newLineNotices({ home, env: {}, now: NOW_REAL })
  setOverride('sensitive-reviewer', 'agy', 'carbon', ctx({ home, catalog: { agy: REAL.agy }, now: NOW_REAL }))
  seedCache(home, { ...REAL_CATS, agy: agyPlus('gemini-5-zircon-high', 'gemini-5-zircon-xhigh', 'foo-bar') }, NOW_REAL + 60000)
  const r = newLineNotices({ home, env: {}, now: NOW_REAL + 120000 })
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /vai sensitive-reviewer: có dòng mới zircon, bạn đang giữ gemini-4-carbon-high/)
  assert.match(r.lines[0], /foo chưa xếp được hạng nên chưa dùng/)
  assert.match(r.lines[0], /models\.mjs set <vai> agy foo/)
  assert.doesNotMatch(r.lines[0], /sensitive-reviewer giờ dùng/)
})

test('session-start không gọi CLI: cache thiếu hoặc cũ hơn 6 giờ ⇒ liệt kê host cần làm tươi nền (host chưa cài và chưa có cache thì không)', () => {
  const home = tmp()
  seedCache(home, REAL_CATS)
  const empty = tmp('flow-models-empty-')
  const env = { PATH: empty, VIBE_FLOW_PATH_ONLY: '1' }
  assert.deepEqual(newLineNotices({ home, env, now: NOW_REAL + 5 * 3600000 }).stale, [])
  assert.deepEqual(newLineNotices({ home, env, now: NOW_REAL + 7 * 3600000 }).stale.sort(), ['agy', 'codex', 'droid'])
  const bare = tmp()
  assert.deepEqual(newLineNotices({ home: bare, env, now: NOW_REAL }), { lines: [], stale: [] }, 'máy trống: không có gì để làm tươi')
})

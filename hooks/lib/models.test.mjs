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
  loadRoles, roleSet, parseCodexCatalog, parseAgyCatalog, pickModel, resolve, setOverride, resetOverride, runCli, findExe,
} from './models.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLI = path.join(ROOT, 'hooks', 'models.mjs')
const NOW = Date.parse('2026-10-11T12:00:00Z')
const DAY = 86400000

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
  return { home: tmp(), now: NOW, env: {}, exec: noExec, catalog: { codex: WIN, agy: AGY }, ...over }
}

// ---------- kit/roles.json (registry vai) ----------

test('roles.json: cấu trúc hợp lệ, mỗi vai có writesCode/receipt/audit boolean + models theo host', () => {
  const reg = loadRoles()
  assert.deepEqual(Object.keys(reg.hosts).sort(), ['agy', 'claude', 'codex'])
  assert.ok(Object.keys(reg.roles).length >= 12)
  for (const [name, r] of Object.entries(reg.roles)) {
    for (const k of ['writesCode', 'receipt', 'audit']) assert.equal(typeof r[k], 'boolean', `${name}.${k}`)
    if (r.audit) assert.ok(r.writesCode, `${name}: audit mà không writesCode`)
    assert.ok(Object.keys(r.models).length > 0, `${name} không có model nào`)
    for (const [host, m] of Object.entries(r.models)) {
      assert.ok(reg.hosts[host], `${name}: host lạ ${host}`)
      for (const spec of [m, m.escalate].filter(Boolean)) {
        assert.match(spec.line, /^[a-z]+$/, `${name}/${host}: dòng "${spec.line}" phải là tên dòng, không số phiên bản [vmdk]`)
        assert.ok(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(spec.effort), `${name}/${host}: effort ${spec.effort}`)
      }
      if (host === 'claude') assert.ok(['opus', 'sonnet', 'haiku'].includes(m.line), `${name}: claude chỉ nhận alias`)
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

test('roles.json: bảng vai-model đúng sổ chốt [bbzh] [50zu] [69u6] [csb8]', () => {
  const R = loadRoles().roles
  const pick = (role, host) => `${R[role].models[host].line}:${R[role].models[host].effort}`
  const esc = (role, host) => `${R[role].models[host].escalate.line}:${R[role].models[host].escalate.effort}`
  // [bbzh] Claude: Sonnet chủ lực, leo Opus high, việc nhỏ/chạy test Haiku
  for (const role of ['coder', 'coder-lite', 'debugger', 'recon', 'researcher', 'qa-tester']) assert.equal(R[role].models.claude.line, 'sonnet', role)
  for (const role of ['coder', 'debugger']) assert.equal(esc(role, 'claude'), 'opus:high', role)
  assert.equal(R['coder-mini'].models.claude.line, 'haiku')
  assert.equal(R['test-runner'].models.claude.line, 'haiku')
  // [50zu] Codex: khó = Sol high (leo Astra), nhỏ = Luna, review luôn Sol high
  for (const role of ['coder', 'debugger']) { assert.equal(pick(role, 'codex'), 'sol:high', role); assert.equal(esc(role, 'codex'), 'astra:high', role) }
  for (const role of ['coder-mini', 'test-runner']) assert.equal(R[role].models.codex.line, 'luna', role)
  // Việc theo mẫu, đọc thô, test thực tế: Sol medium (bảng đề xuất user đã xem 2026-10-11)
  for (const role of ['coder-lite', 'recon', 'qa-tester']) assert.equal(pick(role, 'codex'), 'sol:medium', role)
  assert.equal(pick('code-reviewer', 'codex'), 'sol:high')
  // [69u6] soát plan: Codex Sol high → Opus 5.5 high qua agy → Opus high của Claude
  assert.equal(pick('plan-reviewer', 'codex'), 'sol:high')
  assert.equal(pick('plan-reviewer', 'agy'), 'opus:high')
  assert.equal(pick('plan-reviewer', 'claude'), 'opus:high')
  // [csb8] review: Codex Sol high bảo mật; Gemini Flash khi tiền/auth/dữ liệu
  assert.equal(pick('security-reviewer', 'codex'), 'sol:high')
  assert.equal(R['sensitive-reviewer'].models.agy.line, 'flash')
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
  const exec = (name, args) => { calls++; assert.deepEqual([name, args], ['agy', ['models']]); return { ok: true, stdout: AGY } }
  const base = { home, env: {}, exec, now: NOW, catalog: {} }
  const a = resolve('agy', 'plan-reviewer', base)
  assert.deepEqual(pickFields(a), { model: 'claude-opus-5-5-high', effort: 'high', source: 'catalog' })
  assert.equal(calls, 1)
  resolve('agy', 'sensitive-reviewer', { ...base, now: NOW + 9 * 60000 })
  assert.equal(calls, 1, 'trong 10 phút dùng cache')
  const b = resolve('agy', 'sensitive-reviewer', { ...base, now: NOW + 11 * 60000 })
  assert.equal(calls, 2)
  assert.equal(b.model, 'gemini-3.8-flash-high')
  const dead = resolve('agy', 'sensitive-reviewer', { ...base, exec: failExec, now: NOW + 30 * 60000 })
  assert.equal(dead.model, 'gemini-3.8-flash-high')
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
  assert.match(mine, /opus/); assert.match(mine, /bạn đặt/)
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
  fs.writeFileSync(path.join(bin, 'agy-out.txt'), AGY)
  makeShim(bin, 'agy', 'agy-out.txt')
  const env = fakeEnv(home, bin)

  let r = run(['pick', 'claude', 'coder'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'sonnet\n')
  r = run(['pick', 'codex', 'coder'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'gpt-6.1-sol\n')
  r = run(['pick', 'agy', 'plan-reviewer'], env)
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'claude-opus-5-5-high\n')
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
  fs.writeFileSync(path.join(local, 'vf-fake-cli'), '#!/bin/sh\n'); fs.chmodSync(path.join(local, 'vf-fake-cli'), 0o755)
  assert.equal(findExe('vf-fake-cli', { PATH: empty }, home), path.join(local, 'vf-fake-cli'))
  assert.equal(findExe('vf-fake-cli', { PATH: empty, VIBE_FLOW_PATH_ONLY: '1' }, home), null)
  assert.equal(findExe('vf-fake-cli', { PATH: local, VIBE_FLOW_PATH_ONLY: '1' }, home), path.join(local, 'vf-fake-cli'))
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

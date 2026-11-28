// Test cho so-chot-mcp.mjs (MCP stdio của sổ chốt cho Antigravity): node --test ~/.claude/hooks/so-chot-mcp.test.mjs
// Chạy máy chủ như agy chạy: tiến trình con, JSON-RPC theo dòng qua stdin/stdout. Mọi dự án, HOME đều là thư mục tạm; không đụng ~/.claude hay ~/.gemini thật.
// Phủ AC-05 (cùng sổ, cùng mã với so-chot.mjs) và plan #4 (hai dự án hai sổ), #5 (ghi_so một nguồn: có/không có sổ tiến độ đang mở).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HOOKS_DIR, 'so-chot-mcp.mjs')
const CLI = path.join(HOOKS_DIR, 'lib', 'so-chot.mjs')
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-chot-mcp-')))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
// Tắt bảo trì tự động của git (xem flow-gate.test.mjs) để dọn thư mục tạm không gặp ENOTEMPTY trên Mac.
// SO_CHOT_ALLOWED_ROOTS = TMP: mặc định cho các test cũ truyền du_an trong thư mục tạm; test về phạm vi du_an đặt '' để tắt (xem describe "du_an chỉ nhận…").
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'SO_CHOT_PROJECT_ROOT' && k !== 'SO_CHOT_ALLOWED_ROOTS')),
  HOME, USERPROFILE: HOME, SO_CHOT_ALLOWED_ROOTS: TMP,
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
}
const clients = []

after(() => {
  for (const c of clients) c.kill()
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------- helpers ----------

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
let seq = 0
function repo(name = 'du an') { // tên có dấu cách + tiếng Việt: đường dẫn thật hay gặp
  const dir = path.join(TMP, `${name}-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  return fs.realpathSync(dir)
}
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const specOf = (root, name, text) => write(root, `docs/specs/${name}/progress.md`, text)

// Ảnh chụp mọi file (trừ .git): đường dẫn → nội dung.
function snap(root) {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n === '.git') continue
      const p = path.join(d, n)
      if (fs.lstatSync(p).isDirectory()) walk(p)
      else out[path.relative(root, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

// Client MCP tối thiểu: gửi dòng JSON, đọc dòng JSON; mọi dòng stdout phải là JSON (rác ⇒ ghi lại để test kiểm).
function start({ cwd = TMP, env = {}, roots, onRoots } = {}) {
  const child = spawn(process.execPath, [SERVER], { cwd, env: { ...ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const c = { child, id: 0, waiting: new Map(), unmatched: [], garbage: [], serverRequests: [], stderr: '', exited: null }
  child.stderr.on('data', (d) => { c.stderr += d })
  child.on('close', (code) => { c.exited = code; for (const w of c.waiting.values()) w.reject(new Error(`máy chủ thoát (${code}) khi còn chờ trả lời`)) })
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let m
    try { m = JSON.parse(line) } catch { c.garbage.push(line); return }
    if (typeof m.method === 'string' && m.id !== undefined) { // yêu cầu của máy chủ (roots/list)
      c.serverRequests.push(m)
      if (onRoots) onRoots(c, m)
      return
    }
    const w = Array.isArray(m) ? null : c.waiting.get(m.id)
    if (w) { c.waiting.delete(m.id); w.resolve(m) } else c.unmatched.push(m) // trả lời không có người chờ (lỗi id null, batch…)
  })
  c.send = (obj) => child.stdin.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`)
  c.next = () => `${++c.id}`
  c.rpc = (method, params, id = ++c.id) => new Promise((resolve, reject) => {
    c.waiting.set(id, { resolve, reject })
    c.send({ jsonrpc: '2.0', id, method, params })
  })
  c.notify = (method, params) => c.send({ jsonrpc: '2.0', method, params })
  c.init = async (capabilities = roots ? { roots: {} } : {}, protocolVersion = '2025-06-18') => {
    const r = await c.rpc('initialize', { protocolVersion, capabilities, clientInfo: { name: 'test', version: '0' } })
    c.notify('notifications/initialized')
    return r
  }
  c.call = async (name, args) => {
    const r = await c.rpc('tools/call', { name, arguments: args })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.result.content[0].type, 'text')
    return { text: r.result.content[0].text, isError: r.result.isError === true }
  }
  c.close = () => new Promise((resolve) => { if (c.exited !== null) return resolve(c.exited); child.on('close', resolve); child.stdin.end() })
  c.kill = () => { try { child.kill() } catch {} }
  clients.push(c)
  return c
}

async function until(cond, ms = 10000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('quá giờ chờ trả lời của máy chủ')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const ok = async (c, name, args) => { const r = await c.call(name, args); assert.equal(r.isError, false, r.text); return r.text }
const bad = async (c, name, args) => { const r = await c.call(name, args); assert.equal(r.isError, true, `đáng lẽ lỗi: ${r.text}`); return r.text }
const ma4Of = (text) => /\[([a-z0-9]{4})\]/.exec(text)?.[1]
const cli = (cmd, root, arg) => { const r = spawnSync(process.execPath, [CLI, cmd, root, arg], { encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) }

// ---------- giao thức ----------

describe('giao thức MCP', () => {
  test('initialize: trả đúng phiên bản client xin (nếu hỗ trợ), capabilities.tools, serverInfo, hướng dẫn; ping trả {}', async () => {
    const c = start()
    const r = await c.init(undefined, '2025-03-26')
    assert.equal(r.jsonrpc, '2.0')
    assert.equal(r.result.protocolVersion, '2025-03-26')
    assert.ok(r.result.capabilities.tools)
    assert.equal(r.result.serverInfo.name, 'so-chot')
    assert.match(r.result.instructions, /ghi_chot/)
    assert.match(r.result.instructions, /du_an/)
    assert.deepEqual((await c.rpc('ping')).result, {})
    const other = start()
    assert.equal((await other.init(undefined, '1999-01-01')).result.protocolVersion, '2025-06-18', 'phiên bản lạ ⇒ phiên bản mới nhất máy chủ hỗ trợ')
  })

  test('tools/list: đúng 5 công cụ, mỗi cái có mô tả + inputSchema object + trường du_an', async () => {
    const c = start()
    await c.init()
    const { tools } = (await c.rpc('tools/list')).result
    assert.deepEqual(tools.map((t) => t.name), ['ghi_chot', 'tim_chot', 'ghi_y_tuong', 'da_xem', 'ghi_so'])
    for (const t of tools) {
      assert.ok(t.description.length > 20, t.name)
      assert.equal(t.inputSchema.type, 'object', t.name)
      assert.equal(t.inputSchema.properties.du_an.type, 'string', t.name)
      assert.ok(!(t.inputSchema.required ?? []).includes('du_an'), 'du_an không bắt buộc')
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]))
    assert.deepEqual(byName.ghi_chot.required, ['tom_tat', 'vi_sao', 'ai_quyet'])
    assert.deepEqual(byName.ghi_chot.properties.ai_quyet.enum, ['ban', 'ban-gat', 'tu-chon-khi-vang'])
    assert.deepEqual(byName.tim_chot.required, ['tu_khoa'])
    assert.deepEqual(byName.ghi_y_tuong.required, ['loai', 'noi_dung'])
    assert.deepEqual(byName.da_xem.required, ['ma'])
    assert.deepEqual(Object.keys(byName.ghi_so.properties).sort(), ['buoc_tiep_theo', 'du_an', 'pha', 'trang_thai'])
  })

  test('lỗi giao thức: JSON hỏng -32700 (id null), sai jsonrpc / thiếu method -32600, method lạ -32601, công cụ lạ -32602; thông báo không có trả lời', async () => {
    const c = start()
    await c.init()
    c.send('{không phải json')
    c.send({ id: 7, method: 'ping' }) // thiếu jsonrpc
    c.send({ jsonrpc: '2.0', id: 8 }) // thiếu method
    c.send({ jsonrpc: '2.0', method: 'notifications/khong-co' }) // thông báo lạ: im lặng
    await until(() => c.unmatched.length >= 3)
    const got = Object.fromEntries(c.unmatched.map((m) => [String(m.id), m.error.code]))
    assert.deepEqual(got, { null: -32700, 7: -32600, 8: -32600 })
    assert.equal((await c.rpc('khong/co')).error.code, -32601)
    assert.equal((await c.rpc('tools/call', { name: 'khong_co', arguments: {} })).error.code, -32602)
    assert.equal(c.unmatched.length, 3, 'thông báo không được trả lời')
  })

  test('arguments không phải object ⇒ isError (không phải lỗi giao thức); batch trả một mảng; mảng rỗng ⇒ -32600', async () => {
    const c = start()
    await c.init()
    const r = await c.rpc('tools/call', { name: 'tim_chot', arguments: 'abc' })
    assert.equal(r.result.isError, true)
    c.send([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])
    await until(() => c.unmatched.length >= 1)
    const [batch] = c.unmatched
    assert.ok(Array.isArray(batch))
    assert.deepEqual(batch.map((m) => m.id).sort(), ['a', 'b'])
    assert.deepEqual(batch.find((m) => m.id === 'a').result, {})
    assert.equal(batch.find((m) => m.id === 'b').result.tools.length, 5)
    c.send([])
    await until(() => c.unmatched.length >= 2)
    assert.equal(c.unmatched[1].error.code, -32600)
    assert.deepEqual(c.garbage, [])
  })

  test('stdout chỉ chứa JSON-RPC; stdin đóng ⇒ máy chủ thoát mã 0', async () => {
    const c = start()
    await c.init()
    await c.rpc('tools/list')
    assert.deepEqual(c.garbage, [])
    assert.equal(await c.close(), 0)
    assert.equal(c.stderr, '')
  })

  test('nhiều lời gọi song song: mỗi id nhận đúng một trả lời', async () => {
    const root = repo()
    const c = start({ cwd: root })
    await c.init()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => c.rpc('tools/call', { name: 'ghi_chot', arguments: { tom_tat: `Điều song song ${i}`, vi_sao: 'thử', ai_quyet: 'ban' } })))
    assert.equal(results.length, 12)
    assert.ok(results.every((r) => r.result.isError !== true), JSON.stringify(results.find((r) => r.result.isError)))
    assert.equal(new Set(results.map((r) => ma4Of(r.result.content[0].text))).size, 12, '12 mã khác nhau')
    assert.equal(c.unmatched.length, 0)
  })
})

// ---------- công cụ: cùng sổ, cùng mã với so-chot.mjs ----------

describe('ghi_chot / tim_chot / da_xem / ghi_y_tuong: cùng sổ với so-chot.mjs', () => {
  test('ghi_chot rồi tim_chot: mã 4 ký tự khớp file trong .claude/so-chot, so-chot.mjs tìm thấy cùng mã', async () => {
    const root = repo()
    const c = start()
    await c.init()
    const text = await ok(c, 'ghi_chot', { du_an: root, tom_tat: 'Dùng pnpm thay npm', vi_sao: 'cài nhanh hơn', ap_dung: 'mọi dự án mới', ai_quyet: 'ban-gat', da_can_nhac: ['yarn: ít người dùng'] })
    const ma4 = ma4Of(text)
    assert.ok(ma4, text)
    const file = /\.claude\/so-chot\/(\S+?\.md)/.exec(text)[1]
    const abs = path.join(root, '.claude', 'so-chot', file)
    assert.ok(fs.existsSync(abs), `không thấy ${abs}`)
    assert.ok(path.basename(abs).startsWith(ma4), 'tên file bắt đầu bằng mã')
    assert.match(fs.readFileSync(abs, 'utf8'), /Dùng pnpm thay npm/)
    const found = await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'pnpm' })
    assert.match(found, /^1 điều khớp "pnpm"/)
    assert.ok(found.includes(`[${ma4}]`), found)
    const viaCli = cli('tim', root, JSON.stringify({ query: 'pnpm' }))
    assert.equal(viaCli.length, 1)
    assert.ok(viaCli[0].ma.startsWith(ma4), 'so-chot.mjs thấy cùng mã đầy đủ')
    assert.ok(fs.readFileSync(path.join(root, '.claude', 'so-chot', 'INDEX.md'), 'utf8').includes(`[${ma4}]`), 'INDEX tự sinh lại')
  })

  test('điều ghi bằng so-chot.mjs (Claude) tim_chot thấy; tìm không dấu; tat_ca gồm cả điều đã huỷ; không khớp ⇒ nói không khớp', async () => {
    const root = repo()
    const c = start()
    await c.init()
    const d = cli('ghi', root, JSON.stringify({ tom_tat: 'Chọn cơ sở dữ liệu Postgres', vi_sao: 'ổn định', ai_quyet: 'ban' }))
    assert.ok((await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'co so du lieu' })).includes(`[${d.ma.slice(0, 4)}]`))
    cli('huy', root, d.ma)
    assert.match(await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'postgres' }), /không có điều nào khớp|1 điều khớp/)
    assert.ok((await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'postgres', tat_ca: true })).includes(`[${d.ma.slice(0, 4)}]`))
    assert.equal(await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'khong-co-gi-ca-xyz' }), 'Sổ chốt không có điều nào khớp "khong-co-gi-ca-xyz".')
  })

  test('ghi_chot tu-chon-khi-vang ⇒ ⚠️ chờ xem lại; da_xem chuyển ✅; thay_cho đánh dấu điều cũ đã thay; đúng bảng trạng thái của lib', async () => {
    const root = repo()
    const c = start()
    await c.init()
    const t1 = await ok(c, 'ghi_chot', { du_an: root, tom_tat: 'Dùng Redis làm cache', vi_sao: 'nhanh', ai_quyet: 'tu-chon-khi-vang' })
    assert.match(t1, /⚠️ chờ người dùng xem lại/)
    const ma = ma4Of(t1)
    assert.match(cli('tim', root, JSON.stringify({ query: 'redis' }))[0].dong, /⚠️/)
    assert.equal(await ok(c, 'da_xem', { du_an: root, ma }), `[${ma}] chuyển sang ✅ đang dùng.`)
    assert.match(cli('tim', root, JSON.stringify({ query: 'redis' }))[0].dong, /✅/)
    const t2 = await ok(c, 'ghi_chot', { du_an: root, tom_tat: 'Dùng Valkey thay Redis', vi_sao: 'giấy phép', ai_quyet: 'ban', thay_cho: ma, lien_quan: [ma] })
    assert.match(t2, new RegExp(`điều ${ma} chuyển ↩️ đã thay`))
    assert.match(await ok(c, 'tim_chot', { du_an: root, tu_khoa: 'redis', tat_ca: true }), /↩️/)
  })

  test('ghi_chot / da_xem sai đầu vào ⇒ isError có lý do, không ghi gì', async () => {
    const root = repo()
    const c = start()
    await c.init()
    assert.match(await bad(c, 'ghi_chot', { du_an: root, vi_sao: 'x', ai_quyet: 'ban' }), /Thiếu tom_tat/)
    assert.match(await bad(c, 'ghi_chot', { du_an: root, tom_tat: 'x', vi_sao: 'y', ai_quyet: 'thich-thi-ghi' }), /ai_quyet phải là một trong/)
    assert.match(await bad(c, 'ghi_chot', { du_an: root, tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban', pham_vi: '../ngoai' }), /phạm vi/)
    assert.match(await bad(c, 'da_xem', { du_an: root, ma: 'zzzz' }), /\S/)
    assert.match(await bad(c, 'tim_chot', { du_an: root, tu_khoa: '   ' }), /Thiếu tu_khoa/)
    assert.equal(fs.existsSync(path.join(root, '.claude')), false)
  })

  test('ghi_y_tuong ghi docs/IDEAS.md đúng định dạng của lib; loai sai ⇒ isError', async () => {
    const root = repo()
    const c = start()
    await c.init()
    assert.equal(await ok(c, 'ghi_y_tuong', { du_an: root, loai: 'tinh-nang', noi_dung: 'Xuất báo cáo PDF' }), 'Đã lưu ý tưởng vào docs/IDEAS.md (roadmap tự cập nhật).')
    assert.match(fs.readFileSync(path.join(root, 'docs', 'IDEAS.md'), 'utf8'), /- y-[a-z0-9]+ · \d{4}-\d{2}-\d{2} · .*Xuất báo cáo PDF/)
    assert.match(await bad(c, 'ghi_y_tuong', { du_an: root, loai: 'linh-tinh', noi_dung: 'x' }), /loai phải là một trong/)
    assert.match(await bad(c, 'ghi_y_tuong', { du_an: root, loai: 'cai-tien', noi_dung: '' }), /Thiếu noi_dung/)
  })
})

// ---------- ghi_so: một nguồn ở lib ----------

describe('ghi_so', () => {
  test('không có sổ tiến độ đang mở ⇒ isError đúng câu của mod; không trường nào ⇒ "Không có trường nào để đổi."', async () => {
    const root = repo()
    const c = start()
    await c.init()
    assert.equal(await bad(c, 'ghi_so', { du_an: root, pha: '5' }), 'Dự án không có sổ tiến độ đang mở (docs/specs/*/progress.md chưa xong).')
    specOf(root, 'xong-roi', '# x\nTrạng thái: xong\n')
    assert.match(await bad(c, 'ghi_so', { du_an: root, pha: '5' }), /không có sổ tiến độ đang mở/)
    specOf(root, 'dang-lam', '# y\nTrạng thái: đang làm\n')
    assert.equal(await bad(c, 'ghi_so', { du_an: root }), 'Không có trường nào để đổi.')
  })

  test('có sổ mở ⇒ đổi Pha / Trạng thái / Bước tiếp theo trong progress.md; "xong" đóng sổ', async () => {
    const root = repo()
    const f = specOf(root, '2026-11-28-viec', '# Tiến độ: việc\nTrạng thái: đang làm\nPha: 3\nBước tiếp theo: viết test\n')
    const c = start()
    await c.init()
    const t = await ok(c, 'ghi_so', { du_an: root, pha: '4 · thi công', buoc_tiep_theo: 'chạy bộ test' })
    assert.equal(t, `Đã cập nhật ${f}: Bước tiếp theo: chạy bộ test · Pha: 4 · thi công`)
    assert.equal(fs.readFileSync(f, 'utf8'), '# Tiến độ: việc\nTrạng thái: đang làm\nPha: 4 · thi công\nBước tiếp theo: chạy bộ test\n')
    assert.match(await ok(c, 'ghi_so', { du_an: root, trang_thai: 'xong' }), /Trạng thái: xong/)
    assert.match(await bad(c, 'ghi_so', { du_an: root, pha: '9' }), /không có sổ tiến độ đang mở/)
  })

  test('chọn sổ theo nhánh git của dự án khi có nhiều sổ mở', async () => {
    const root = repo()
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    git(root, 'checkout', '-q', '-b', 'feat/a')
    const cu = specOf(root, 'a-cu', '# a\nTrạng thái: đang làm\nNhánh / worktree: feat/a\n')
    fs.utimesSync(cu, new Date(Date.now() - 5 * 86400000), new Date(Date.now() - 5 * 86400000))
    const moi = specOf(root, 'b-moi', '# b\nTrạng thái: đang làm\nNhánh / worktree: feat/b\n')
    const c = start()
    await c.init()
    await ok(c, 'ghi_so', { du_an: root, pha: '6' })
    assert.match(fs.readFileSync(cu, 'utf8'), /Pha: 6/)
    assert.doesNotMatch(fs.readFileSync(moi, 'utf8'), /Pha:/)
  })
})

// ---------- chọn dự án ----------

describe('chọn dự án: hai dự án hai sổ, chỉ sổ của phiên đổi', () => {
  test('du_an quyết định: ghi cho A không đụng B và ngược lại, bất kể thư mục đứng của máy chủ', async () => {
    const a = repo('du an A')
    const b = repo('dự án B')
    const c = start({ cwd: a })
    await c.init()
    const bBefore = snap(b)
    await ok(c, 'ghi_chot', { du_an: a, tom_tat: 'Điều của A', vi_sao: 'a', ai_quyet: 'ban' })
    assert.deepEqual(snap(b), bBefore, 'B không đổi')
    const aBefore = snap(a)
    await ok(c, 'ghi_chot', { du_an: b, tom_tat: 'Điều của B', vi_sao: 'b', ai_quyet: 'ban' })
    assert.deepEqual(snap(a), aBefore, 'A không đổi')
    assert.match(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'điều của' }), /Điều của A/)
    assert.doesNotMatch(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'điều của' }), /Điều của B/)
    assert.doesNotMatch(await ok(c, 'tim_chot', { du_an: b, tu_khoa: 'điều của' }), /Điều của A/)
  })

  test('không có du_an: dùng thư mục máy chủ đang đứng (nếu là dự án); thư mục con của repo ⇒ sổ ở gốc repo đã có sổ', async () => {
    const a = repo('cwd A')
    const b = repo('cwd B')
    const ca = start({ cwd: a })
    const cb = start({ cwd: b })
    await ca.init()
    await cb.init()
    await ok(ca, 'ghi_chot', { tom_tat: 'Chỉ cho A', vi_sao: 'x', ai_quyet: 'ban' })
    assert.deepEqual(Object.keys(snap(b)), [], 'B còn trống')
    await ok(cb, 'ghi_chot', { tom_tat: 'Chỉ cho B', vi_sao: 'x', ai_quyet: 'ban' })
    assert.ok(Object.keys(snap(a)).every((f) => !snap(a)[f].includes('Chỉ cho B')))
    const sub = path.join(a, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    const cs = start({ cwd: sub })
    await cs.init()
    await ok(cs, 'ghi_chot', { tom_tat: 'Từ thư mục con', vi_sao: 'x', ai_quyet: 'ban' })
    assert.equal(fs.existsSync(path.join(sub, '.claude')), false, 'không mọc sổ lạc trong thư mục con')
    assert.match(await ok(ca, 'tim_chot', { tu_khoa: 'thư mục con' }), /Từ thư mục con/)
  })

  test('biến SO_CHOT_PROJECT_ROOT ghim dự án; du_an vẫn thắng biến', async () => {
    const a = repo('env A')
    const b = repo('env B')
    const c = start({ cwd: TMP, env: { SO_CHOT_PROJECT_ROOT: a } })
    await c.init()
    await ok(c, 'ghi_chot', { tom_tat: 'Theo biến môi trường', vi_sao: 'x', ai_quyet: 'ban' })
    assert.match(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'biến môi trường' }), /Theo biến môi trường/)
    await ok(c, 'ghi_chot', { du_an: b, tom_tat: 'Theo du_an', vi_sao: 'x', ai_quyet: 'ban' })
    assert.doesNotMatch(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'du_an' }), /Theo du_an/)
  })

  test('worktree mà git bỏ qua .claude/so-chot ⇒ sổ ở thư mục chính (chuẩn hoá như noi-so); sổ tiến độ vẫn của worktree', async () => {
    const main = repo('wt main')
    fs.writeFileSync(path.join(main, '.gitignore'), '.claude/so-chot/\n')
    fs.writeFileSync(path.join(main, 'a.txt'), 'a\n')
    git(main, 'add', '-A')
    git(main, 'commit', '-q', '-m', 'init')
    const wt = path.join(TMP, `wt-phu-${++seq}`)
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt)
    const wtReal = fs.realpathSync(wt)
    specOf(wtReal, 'viec', '# v\nTrạng thái: đang làm\nNhánh / worktree: feat\n')
    const c = start()
    await c.init()
    const t = await ok(c, 'ghi_chot', { du_an: wtReal, tom_tat: 'Điều ghi từ worktree', vi_sao: 'x', ai_quyet: 'ban' })
    const ma4 = ma4Of(t)
    assert.ok(fs.readdirSync(path.join(main, '.claude', 'so-chot', 'chung')).some((f) => f.startsWith(ma4)), 'file nằm ở thư mục chính')
    assert.equal(fs.existsSync(path.join(wtReal, '.claude', 'so-chot')), false, 'không có sổ lạc trong worktree')
    assert.match(await ok(c, 'tim_chot', { du_an: main, tu_khoa: 'worktree' }), new RegExp(`\\[${ma4}\\]`))
    assert.match(await ok(c, 'ghi_so', { du_an: wtReal, pha: '5' }), /Pha: 5/)
    assert.match(fs.readFileSync(path.join(wtReal, 'docs', 'specs', 'viec', 'progress.md'), 'utf8'), /Pha: 5/)
  })

  test('dự án không xác định được ⇒ isError nhắc truyền du_an, không tạo gì: cwd không phải dự án, du_an tương đối / không tồn tại / là file / thư mục nhà / gốc ổ đĩa', async () => {
    const plain = path.join(TMP, 'khong-phai-du-an')
    fs.mkdirSync(plain)
    const file = write(TMP, 'mot-file.txt', 'x')
    const c = start({ cwd: plain, env: { GIT_CEILING_DIRECTORIES: TMP } })
    await c.init()
    assert.match(await bad(c, 'ghi_chot', { tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /không phải thư mục dự án.*du_an/)
    assert.match(await bad(c, 'ghi_chot', { du_an: 'du-an/tuong-doi', tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /tuyệt đối/)
    assert.match(await bad(c, 'ghi_chot', { du_an: path.join(TMP, 'khong-ton-tai'), tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /Không mở được thư mục/)
    assert.match(await bad(c, 'ghi_chot', { du_an: file, tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /không phải thư mục/)
    assert.match(await bad(c, 'ghi_chot', { du_an: HOME, tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /thư mục nhà/)
    assert.match(await bad(c, 'ghi_chot', { du_an: path.parse(TMP).root, tom_tat: 'x', vi_sao: 'y', ai_quyet: 'ban' }), /gốc ổ đĩa/)
    assert.equal(fs.existsSync(path.join(plain, '.claude')), false)
    assert.equal(fs.existsSync(path.join(HOME, '.claude', 'so-chot')), false)
  })
})

// ---------- roots/list (nếu agy khai capability roots) ----------

describe('roots/list', () => {
  test('client khai roots ⇒ máy chủ hỏi roots/list khi thiếu du_an và ghi vào dự án client trả về', async () => {
    const a = repo('roots A')
    const b = repo('roots B')
    const c = start({ cwd: a, roots: true, onRoots: (cl, m) => cl.send({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(b).href, name: 'b' }] } }) })
    await c.init()
    await ok(c, 'ghi_chot', { tom_tat: 'Theo roots', vi_sao: 'x', ai_quyet: 'ban' })
    assert.equal(c.serverRequests.length, 1)
    assert.equal(c.serverRequests[0].method, 'roots/list')
    assert.match(await ok(c, 'tim_chot', { du_an: b, tu_khoa: 'theo roots' }), /Theo roots/)
    assert.deepEqual(Object.keys(snap(a)), [], 'A (thư mục đứng) không bị ghi')
    await ok(c, 'ghi_chot', { du_an: a, tom_tat: 'Có du_an thì khỏi hỏi roots', vi_sao: 'x', ai_quyet: 'ban' })
    assert.equal(c.serverRequests.length, 1, 'du_an có sẵn ⇒ không hỏi roots')
  })

  test('roots/list được nhớ giữa các lệnh; notifications/roots/list_changed ⇒ hỏi lại và theo roots mới', async () => {
    const a = repo('cache A')
    const b = repo('cache B')
    let now = a
    const c = start({ cwd: TMP, env: { SO_CHOT_ALLOWED_ROOTS: '' }, roots: true, onRoots: (cl, m) => cl.send({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(now).href, name: 'x' }] } }) })
    await c.init()
    await ok(c, 'ghi_chot', { tom_tat: 'Lệnh một vào A', vi_sao: 'x', ai_quyet: 'ban' })
    await ok(c, 'tim_chot', { tu_khoa: 'lệnh một' })
    await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'lệnh một' })
    assert.equal(c.serverRequests.length, 1, 'ba lệnh liền nhau chỉ hỏi roots một lần')
    now = b
    c.notify('notifications/roots/list_changed')
    await ok(c, 'ghi_chot', { tom_tat: 'Lệnh hai vào B', vi_sao: 'x', ai_quyet: 'ban' })
    assert.equal(c.serverRequests.length, 2, 'client báo đổi ⇒ hỏi lại')
    assert.match(await ok(c, 'tim_chot', { du_an: b, tu_khoa: 'lệnh hai' }), /Lệnh hai vào B/)
    assert.deepEqual(Object.keys(snap(a)).filter((k) => /lenh-hai/.test(k)), [], 'sổ A không có điều của B')
  })

  test('client trả lỗi roots/list hoặc client không khai roots ⇒ rơi về thư mục đang đứng, không treo', async () => {
    const a = repo('roots lỗi')
    const c = start({ cwd: a, roots: true, onRoots: (cl, m) => cl.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no roots' } }) })
    await c.init()
    await ok(c, 'ghi_chot', { tom_tat: 'Rơi về cwd', vi_sao: 'x', ai_quyet: 'ban' })
    assert.match(await ok(c, 'tim_chot', { tu_khoa: 'rơi về' }), /Rơi về cwd/)
    const none = start({ cwd: a })
    await none.init()
    await ok(none, 'tim_chot', { tu_khoa: 'rơi về' })
    assert.equal(none.serverRequests.length, 0, 'không khai roots ⇒ không hỏi')
  })
})

// ---------- du_an chỉ nhận trong workspace của phiên ----------

describe('du_an chỉ nhận khi nằm trong workspace của phiên (roots/list, SO_CHOT_PROJECT_ROOT, thư mục đứng) hoặc worktree của chính repo đó', () => {
  const NONE = { SO_CHOT_ALLOWED_ROOTS: '' } // tắt ngoại lệ của bộ test: chỉ còn workspace thật của phiên
  const OUT = /nằm ngoài|không thuộc/

  test('phiên ở repo A: du_an trỏ repo B ⇒ lỗi cho CẢ ghi lẫn đọc, sổ B không đổi, sổ A không lẫn của B; du_an = A, thư mục con của A ⇒ được', async () => {
    const a = repo('phien A')
    const b = repo('phien B')
    cli('ghi', b, JSON.stringify({ tom_tat: 'Bí mật của B', vi_sao: 'x', ai_quyet: 'ban' }))
    const c = start({ cwd: a, env: NONE })
    await c.init()
    const bBefore = snap(b)
    assert.match(await bad(c, 'ghi_chot', { du_an: b, tom_tat: 'Điều lén ghi vào B', vi_sao: 'x', ai_quyet: 'ban' }), OUT)
    assert.match(await bad(c, 'tim_chot', { du_an: b, tu_khoa: 'bí mật' }), OUT)
    assert.match(await bad(c, 'da_xem', { du_an: b, ma: 'abcd' }), OUT)
    assert.match(await bad(c, 'ghi_y_tuong', { du_an: b, loai: 'cai-tien', noi_dung: 'lén' }), OUT)
    assert.match(await bad(c, 'ghi_so', { du_an: b, pha: '9' }), OUT)
    assert.deepEqual(snap(b), bBefore, 'sổ B không đổi')
    assert.match(await ok(c, 'ghi_chot', { du_an: a, tom_tat: 'Điều của A', vi_sao: 'x', ai_quyet: 'ban' }), /Đã ghi/)
    const sub = path.join(a, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    assert.match(await ok(c, 'tim_chot', { du_an: sub, tu_khoa: 'điều của' }), /Điều của A/)
    assert.doesNotMatch(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'bí mật' }), /Bí mật của B/)
    assert.match(await bad(c, 'tim_chot', { du_an: path.dirname(a), tu_khoa: 'x' }), OUT, 'thư mục CHA của workspace cũng không được')
  })

  test('SO_CHOT_PROJECT_ROOT = A (cwd chỗ khác): du_an B bị từ chối, du_an A được; roots/list trả A: du_an B bị từ chối', async () => {
    const a = repo('env A')
    const b = repo('env B')
    const c = start({ cwd: TMP, env: { ...NONE, SO_CHOT_PROJECT_ROOT: a } })
    await c.init()
    assert.match(await bad(c, 'tim_chot', { du_an: b, tu_khoa: 'x' }), OUT)
    assert.match(await ok(c, 'tim_chot', { du_an: a, tu_khoa: 'x' }), /không có điều nào khớp/)
    const r = start({ cwd: TMP, env: NONE, roots: true, onRoots: (cl, m) => cl.send({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(a).href, name: 'a' }] } }) })
    await r.init()
    assert.match(await bad(r, 'tim_chot', { du_an: b, tu_khoa: 'x' }), OUT)
    assert.match(await ok(r, 'tim_chot', { du_an: a, tu_khoa: 'x' }), /không có điều nào khớp/)
    assert.deepEqual(snap(b), {}, 'B không bị chạm')
  })

  test('worktree của CHÍNH repo phiên (git worktree list) được nhận; worktree của repo khác thì không', async () => {
    const a = repo('wt A')
    fs.writeFileSync(path.join(a, 'a.txt'), 'a\n')
    git(a, 'add', '-A')
    git(a, 'commit', '-q', '-m', 'init')
    const wt = path.join(TMP, `wt-cua-a-${++seq}`)
    git(a, 'worktree', 'add', '-q', '-b', 'feat', wt)
    const b = repo('wt B')
    fs.writeFileSync(path.join(b, 'b.txt'), 'b\n')
    git(b, 'add', '-A')
    git(b, 'commit', '-q', '-m', 'init')
    const wtB = path.join(TMP, `wt-cua-b-${++seq}`)
    git(b, 'worktree', 'add', '-q', '-b', 'feat', wtB)
    const c = start({ cwd: a, env: NONE })
    await c.init()
    assert.match(await ok(c, 'ghi_chot', { du_an: fs.realpathSync(wt), tom_tat: 'Ghi từ worktree của A', vi_sao: 'x', ai_quyet: 'ban' }), /Đã ghi/)
    assert.match(await bad(c, 'ghi_chot', { du_an: fs.realpathSync(wtB), tom_tat: 'Lén', vi_sao: 'x', ai_quyet: 'ban' }), OUT)
    assert.match(await bad(c, 'tim_chot', { du_an: b, tu_khoa: 'x' }), OUT)
  })

  test('liên kết (junction/symlink) trong workspace trỏ ra dự án khác ⇒ so theo đường dẫn THẬT: bị từ chối', async (t) => {
    const a = repo('lk A')
    const b = repo('lk B')
    const link = path.join(a, 'sang-b')
    try { fs.symlinkSync(b, link, 'junction') } catch (e) { return t.skip(`không tạo được liên kết: ${e.code}`) }
    const c = start({ cwd: a, env: NONE })
    await c.init()
    assert.match(await bad(c, 'ghi_chot', { du_an: link, tom_tat: 'Lén qua liên kết', vi_sao: 'x', ai_quyet: 'ban' }), OUT)
    assert.deepEqual(snap(b), {})
  })

  test('chưa biết workspace nào (cwd không phải dự án, không env, không roots) ⇒ không nhận du_an, nhắc đặt SO_CHOT_PROJECT_ROOT', async () => {
    const a = repo('khong ws')
    const plain = path.join(TMP, 'khong-phai-du-an-2')
    fs.mkdirSync(plain)
    const c = start({ cwd: plain, env: { ...NONE, GIT_CEILING_DIRECTORIES: TMP } })
    await c.init()
    const msg = await bad(c, 'tim_chot', { du_an: a, tu_khoa: 'x' })
    assert.match(msg, /SO_CHOT_PROJECT_ROOT/)
    assert.deepEqual(snap(a), {})
  })

  test('SO_CHOT_ALLOWED_ROOTS (danh sách do người dùng đặt, ngăn cách bằng dấu của hệ điều hành) mở thêm vùng được phép; dự án ngoài vùng vẫn bị từ chối', async () => {
    const a = repo('ds A')
    const b = repo('ds B')
    const x = repo('ds X')
    const c = start({ cwd: TMP, env: { ...NONE, SO_CHOT_ALLOWED_ROOTS: [a, b].join(path.delimiter) } })
    await c.init()
    assert.match(await ok(c, 'ghi_chot', { du_an: a, tom_tat: 'Điều A', vi_sao: 'x', ai_quyet: 'ban' }), /Đã ghi/)
    assert.match(await ok(c, 'ghi_chot', { du_an: b, tom_tat: 'Điều B', vi_sao: 'x', ai_quyet: 'ban' }), /Đã ghi/)
    assert.match(await bad(c, 'ghi_chot', { du_an: x, tom_tat: 'Điều X', vi_sao: 'x', ai_quyet: 'ban' }), OUT)
    assert.deepEqual(snap(x), {})
  })

  test('monorepo: phiên chỉ mở thư mục con ⇒ KHÔNG leo lên gốc repo cha (ngoài workspace) để đọc/ghi sổ ở đó; cấp quyền gốc cho phiên thì được', async () => {
    const top = repo('mono')
    const sub = path.join(top, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    const prog = specOf(top, 'viec', '# v\nTrạng thái: đang làm\n')
    cli('ghi', top, JSON.stringify({ tom_tat: 'Điều của gốc monorepo', vi_sao: 'x', ai_quyet: 'ban' })) // sổ chốt nằm ở gốc: realRootOf(sub) leo lên đó
    const before = snap(top)
    const c = start({ cwd: sub, env: NONE })
    await c.init()
    for (const args of [{}, { du_an: sub }]) {
      assert.match(await bad(c, 'ghi_so', { ...args, trang_thai: 'xong' }), OUT)
      assert.match(await bad(c, 'ghi_chot', { ...args, tom_tat: 'Lén ghi lên gốc', vi_sao: 'x', ai_quyet: 'ban' }), OUT)
      assert.match(await bad(c, 'tim_chot', { ...args, tu_khoa: 'gốc' }), OUT)
      assert.match(await bad(c, 'ghi_y_tuong', { ...args, loai: 'cai-tien', noi_dung: 'lén' }), OUT)
    }
    assert.deepEqual(snap(top), before, 'gốc repo không bị đổi')
    // gốc cấp cho phiên ⇒ ghi bình thường, đúng sổ ở gốc
    const ok1 = start({ cwd: sub, env: { ...NONE, SO_CHOT_ALLOWED_ROOTS: top } })
    await ok1.init()
    assert.match(await ok(ok1, 'ghi_so', { du_an: sub, pha: '8' }), /Pha: 8/)
    assert.match(fs.readFileSync(prog, 'utf8'), /Pha: 8/)
    assert.match(await ok(ok1, 'tim_chot', { du_an: sub, tu_khoa: 'gốc monorepo' }), /Điều của gốc monorepo/)
  })

  test('monorepo chỉ có docs/specs ở gốc (gốc chưa có sổ chốt): ghi_so từ thư mục con không leo lên sửa sổ tiến độ của gốc', async () => {
    const top = repo('mono2')
    const sub = path.join(top, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    const prog = specOf(top, 'viec', '# v\nTrạng thái: đang làm\n')
    const before = fs.readFileSync(prog, 'utf8')
    const c = start({ cwd: sub, env: NONE })
    await c.init()
    assert.match(await bad(c, 'ghi_so', { trang_thai: 'xong' }), /không có sổ tiến độ đang mở/)
    assert.equal(fs.readFileSync(prog, 'utf8'), before)
    const granted = start({ cwd: sub, env: { ...NONE, SO_CHOT_PROJECT_ROOT: top } })
    await granted.init()
    assert.match(await ok(granted, 'ghi_so', { pha: '2' }), /Pha: 2/)
  })

  test('không có du_an: vẫn dùng workspace của phiên như trước (env → roots → cwd)', async () => {
    const a = repo('mac dinh')
    const c = start({ cwd: a, env: NONE })
    await c.init()
    assert.match(await ok(c, 'ghi_chot', { tom_tat: 'Mặc định theo cwd', vi_sao: 'x', ai_quyet: 'ban' }), /Đã ghi/)
    assert.match(await ok(c, 'tim_chot', { tu_khoa: 'mặc định' }), /Mặc định theo cwd/)
  })
})

// ---------- git gọi bằng đường dẫn tuyệt đối ----------

describe('git: đường dẫn tuyệt đối đã resolve, không chạy git.exe nằm trong thư mục dự án', () => {
  test('thư mục dự án có git.exe giả (Windows tìm chương trình trong cwd trước PATH) ⇒ không bị chạy, ở MỌI công cụ MCP', { skip: process.platform !== 'win32' ? 'chỉ Windows tìm chương trình trong cwd' : false }, async () => {
    const proj = repo('git gia')
    specOf(proj, 'viec', '# v\nTrạng thái: đang làm\nNhánh / worktree: main\n')
    fs.copyFileSync(process.execPath, path.join(proj, 'git.exe')) // bản sao node.exe làm "git" giả
    const marker = path.join(TMP, `git-gia-da-chay-${++seq}.txt`).replaceAll('\\', '/')
    const preload = write(TMP, 'git-gia-preload.cjs', "const p = require('node:path'); if (/^git(\\.exe)?$/i.test(p.basename(process.execPath))) require('node:fs').writeFileSync(process.env.FAKE_GIT_MARKER, 'đã chạy: ' + process.argv.slice(1).join(' '))\n")
    // NoDefaultCurrentDirectoryInExePath (nhiều máy đặt sẵn) tắt việc tìm trong cwd ⇒ bỏ khỏi môi trường của máy chủ để lỗ hổng tái hiện được.
    const c = start({ cwd: proj, env: { NoDefaultCurrentDirectoryInExePath: undefined, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`, FAKE_GIT_MARKER: marker } })
    await c.init()
    await ok(c, 'ghi_so', { du_an: proj, pha: '5' })
    await ok(c, 'ghi_chot', { du_an: proj, tom_tat: 'Có git giả trong thư mục', vi_sao: 'x', ai_quyet: 'ban' })
    await ok(c, 'tim_chot', { tu_khoa: 'git giả' })
    await ok(c, 'ghi_y_tuong', { du_an: proj, loai: 'cai-tien', noi_dung: 'x' })
    const sub = path.join(proj, 'apps', 'web') // thư mục con chưa có sổ riêng ⇒ lib hỏi git tìm gốc repo
    fs.mkdirSync(sub, { recursive: true })
    await ok(c, 'tim_chot', { du_an: sub, tu_khoa: 'git giả' })
    assert.equal(fs.existsSync(marker), false, `git giả trong thư mục dự án đã bị chạy: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`)
  })
})

// Test cho wt-env.mjs: node --test ~/.claude/hooks/wt-env.test.mjs
// Mỗi test dùng FLOW_STATE_DIR tạm (không đụng ~/.claude/state thật); port chỉ mở trên 127.0.0.1 và đóng lại.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wt-env.mjs')
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'FLOW_STATE_DIR'))
const roots = []

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------- helpers ----------

function tmp(prefix = 'wt-env-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(d)
  return d
}

// state dir mới + hai thư mục "worktree" giả
function fixture() {
  const root = tmp()
  const state = path.join(root, 'state')
  const wt = (name) => {
    const d = path.join(root, name)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  return { root, state, wt }
}

const envFor = (state) => ({ ...BASE_ENV, FLOW_STATE_DIR: state })

function run(state, args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: envFor(state) })
}

function runAsync(state, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: envFor(state), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (c) => (stdout += c))
    p.stderr.on('data', (c) => (stderr += c))
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function baseOf(r) {
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`)
  const m = r.stdout.match(/^PORT_BASE=(\d+)\r?\n$/)
  assert.ok(m, `stdout phải đúng một dòng PORT_BASE=<n>, nhận: ${JSON.stringify(r.stdout)}`)
  return Number(m[1])
}

const alloc = (state, p, cwd) => baseOf(run(state, p === undefined ? ['alloc'] : ['alloc', p], cwd))
const registry = (state) => JSON.parse(fs.readFileSync(path.join(state, 'ports.json'), 'utf8'))

// Dựng sẵn thư mục khoá `ports.lock` (kèm owner {pid, token} nếu có) với mtime lùi `ageMs`.
function makeLock(state, { pid, token, ageMs = 0 }) {
  const lock = path.join(state, 'ports.lock')
  fs.mkdirSync(lock, { recursive: true })
  if (pid !== undefined) fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid, token }))
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(lock, t, t) // sau khi ghi owner, vì ghi file làm đổi mtime thư mục
  return lock
}

// pid của một tiến trình vừa chạy xong => process.kill(pid, 0) báo ESRCH.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

// Chiếm port trên 127.0.0.1. owned=false nếu port đã bị tiến trình khác giữ sẵn (vẫn là "bị chiếm").
function occupy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve({ owned: false, close: () => Promise.resolve() }))
    srv.listen(port, '127.0.0.1', () => resolve({ owned: true, close: () => new Promise((r) => srv.close(r)) }))
  })
}

// ---------- tests ----------

describe('alloc', () => {
  test('base nằm trong 4100..8980, bước 20, in đúng một dòng PORT_BASE=<n>', () => {
    const { state, wt } = fixture()
    const b = alloc(state, wt('a'))
    assert.ok(b >= 4100 && b <= 8980 && (b - 4100) % 20 === 0, `base ${b}`)
  })

  test('idempotent: alloc lại cùng path ra cùng base, registry chỉ một mục', () => {
    const { state, wt } = fixture()
    const a = wt('a')
    const first = alloc(state, a)
    assert.equal(alloc(state, a), first)
    assert.equal(alloc(state, a), first)
    assert.equal(Object.keys(registry(state)).length, 1)
  })

  test('chuẩn hoá path: dấu phân cách cuối, `/` thay `\\`, path tương đối đều ra cùng một mục', () => {
    const { root, state, wt } = fixture()
    const a = wt('a')
    const first = alloc(state, a)
    assert.equal(alloc(state, a + path.sep), first)
    assert.equal(alloc(state, a.replace(/\\/g, '/')), first)
    assert.equal(alloc(state, path.join(a, '..', 'a')), first)
    assert.equal(alloc(state, 'a', root), first)
    assert.equal(Object.keys(registry(state)).length, 1)
  })

  test('hai path khác nhau ra hai base khác nhau', () => {
    const { state, wt } = fixture()
    const a = alloc(state, wt('a'))
    const b = alloc(state, wt('b'))
    assert.notEqual(a, b)
    assert.equal(Object.keys(registry(state)).length, 2)
  })

  test('không truyền path: dùng git toplevel của cwd (gọi từ thư mục con)', () => {
    const { root, state } = fixture()
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true })
    const g = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', env: BASE_ENV })
    assert.equal(g.status, 0, g.stderr)
    const viaSub = alloc(state, undefined, path.join(repo, 'sub', 'deep'))
    assert.equal(alloc(state, repo), viaSub)
    assert.equal(alloc(state, undefined, repo), viaSub)
    assert.equal(Object.keys(registry(state)).length, 1)
  })

  test('không truyền path và cwd không phải git repo => exit 2, stderr rõ ràng', () => {
    const { root, state } = fixture()
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    const r = run(state, ['alloc'], plain)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /wt-env: .*git repo/)
    assert.equal(r.stdout, '')
  })

  test('port đầu cửa sổ bị chiếm => bỏ qua base đó; nhả port rồi path mới lại dùng được base ấy', async () => {
    const { state, wt } = fixture()
    const srv = await occupy(4100)
    let first
    try {
      first = alloc(state, wt('a'))
      assert.notEqual(first, 4100, 'base có port đầu bị chiếm phải bị bỏ qua')
      assert.ok(first > 4100 && (first - 4100) % 20 === 0, `base ${first}`)
      assert.ok(!Object.values(registry(state)).includes(4100))
    } finally {
      await srv.close()
    }
    if (srv.owned) assert.equal(alloc(state, wt('b')), 4100, 'port đã nhả: base 4100 phải cấp được lại')
  })

  test('registry hỏng (JSON sai) => exit 2 và không bị ghi đè', () => {
    const { state, wt } = fixture()
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, 'ports.json'), '{ not json')
    const r = run(state, ['alloc', wt('a')])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ports\.json.*JSON/)
    assert.equal(fs.readFileSync(path.join(state, 'ports.json'), 'utf8'), '{ not json')
    assert.ok(!fs.existsSync(path.join(state, 'ports.lock')), 'khoá phải được nhả cả khi lỗi')
  })

  test('hết sạch cửa sổ (245 base đã có chủ) => exit 2', () => {
    const { state, wt } = fixture()
    const reg = {}
    for (let i = 0, base = 4100; base <= 8980; i++, base += 20) reg[`/fake/${i}`] = base
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, 'ports.json'), JSON.stringify(reg))
    const r = run(state, ['alloc', wt('a')])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /hết cửa sổ/)
  })
})

describe('release', () => {
  test('release rồi alloc path mới dùng lại base trống (base nhỏ nhất chưa ai giữ)', () => {
    const { state, wt } = fixture()
    const a = alloc(state, wt('a'))
    const b = alloc(state, wt('b'))
    assert.ok(a < b)
    const r = run(state, ['release', wt('a')])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^RELEASED .* ${a}\\r?\\n$`))
    assert.deepEqual(Object.values(registry(state)), [b])
    assert.equal(alloc(state, wt('c')), a)
  })

  test('release path chưa đăng ký => exit 0, NOT_FOUND, registry giữ nguyên', () => {
    const { state, wt } = fixture()
    const a = alloc(state, wt('a'))
    const r = run(state, ['release', wt('zzz')])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^NOT_FOUND /)
    assert.deepEqual(Object.values(registry(state)), [a])
  })
})

describe('list / prune', () => {
  test('list in bảng path | base | exists, theo base tăng dần', () => {
    const { state, wt } = fixture()
    const a = wt('a')
    const b = wt('b')
    const ba = alloc(state, a)
    const bb = alloc(state, b)
    fs.rmSync(b, { recursive: true })
    const r = run(state, ['list'])
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.trim().split(/\r?\n/)
    assert.match(lines[0], /^path\s+\| base \| exists$/)
    assert.equal(lines.length, 3)
    assert.match(lines[1], new RegExp(`/a\\s+\\| ${ba}\\s+\\| yes$`, 'i'))
    assert.match(lines[2], new RegExp(`/b\\s+\\| ${bb}\\s+\\| no$`, 'i'))
  })

  test('prune xoá mục có path không còn tồn tại, giữ mục còn sống', () => {
    const { state, wt } = fixture()
    const live = wt('live')
    const dead = wt('dead')
    const bl = alloc(state, live)
    const bd = alloc(state, dead)
    fs.rmSync(dead, { recursive: true })
    const r = run(state, ['prune'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`PRUNED .*dead ${bd}`, 'i'))
    assert.match(r.stdout, /pruned 1\r?\n$/)
    assert.deepEqual(Object.values(registry(state)), [bl])
    // base của mục đã prune cấp lại được
    assert.equal(alloc(state, wt('new')), bd)
  })

  test('prune khi không có gì để xoá => pruned 0, không tạo registry mới', () => {
    const { state } = fixture()
    const r = run(state, ['prune'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pruned 0/)
    assert.ok(!fs.existsSync(path.join(state, 'ports.json')))
  })
})

describe('khoá và đồng thời', () => {
  test('10 tiến trình alloc song song ra 10 base khác nhau, registry đủ 10 mục hợp lệ', async () => {
    const { state, wt } = fixture()
    const dirs = Array.from({ length: 10 }, (_, i) => wt(`w${i}`))
    const results = await Promise.all(dirs.map((d) => runAsync(state, ['alloc', d])))
    const bases = results.map(baseOf)
    assert.equal(new Set(bases).size, 10, `trùng base: ${bases.join(',')}`)
    const reg = registry(state)
    assert.equal(Object.keys(reg).length, 10)
    assert.deepEqual([...Object.values(reg)].sort((x, y) => x - y), [...bases].sort((x, y) => x - y))
    assert.ok(!fs.existsSync(path.join(state, 'ports.lock')), 'khoá phải được nhả')
    assert.deepEqual(fs.readdirSync(state).sort(), ['ports.json'], 'không để lại file tạm')
  })

  test('10 tiến trình alloc song song cùng MỘT path => cùng một base, một mục', async () => {
    const { state, wt } = fixture()
    const d = wt('same')
    const bases = (await Promise.all(Array.from({ length: 10 }, () => runAsync(state, ['alloc', d])))).map(baseOf)
    assert.equal(new Set(bases).size, 1)
    assert.equal(Object.keys(registry(state)).length, 1)
  })

  test('khoá cũ hơn 30 s không có owner (chủ chết trước khi ghi owner) bị coi là chết và bị xoá', () => {
    const { state, wt } = fixture()
    const lock = makeLock(state, { ageMs: 60_000 })
    const b = alloc(state, wt('a'))
    assert.ok(b >= 4100)
    assert.ok(!fs.existsSync(lock))
  })

  test('khoá cũ hơn 30 s của pid đã chết bị phá, B lấy được khoá và ghi registry', () => {
    const { state, wt } = fixture()
    const lock = makeLock(state, { pid: deadPid(), token: 'dead-owner', ageMs: 60_000 })
    const b = alloc(state, wt('a'))
    assert.ok(b >= 4100)
    assert.ok(!fs.existsSync(lock), 'khoá của B phải được nhả')
    assert.equal(Object.keys(registry(state)).length, 1)
  })

  test('khoá không bị phá khi chủ còn sống (kể cả >30 s) hoặc khi mới (<30 s, kể cả pid chết) => B chờ hết 5 s, exit 2', async () => {
    const cases = {
      'còn sống, cũ 60 s': { pid: process.pid, token: 'alive-old', ageMs: 60_000 },
      'còn sống, mới': { pid: process.pid, token: 'alive-new', ageMs: 0 },
      'pid chết nhưng khoá mới': { pid: deadPid(), token: 'dead-new', ageMs: 0 },
      'không có owner, mới': { ageMs: 0 },
    }
    await Promise.all(
      Object.entries(cases).map(async ([name, spec]) => {
        const { state, wt } = fixture()
        const lock = makeLock(state, spec)
        const t0 = Date.now()
        const r = await runAsync(state, ['alloc', wt('a')])
        const took = Date.now() - t0
        assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, /không lấy được khoá/, name)
        if (spec.pid) assert.match(r.stderr, new RegExp(`pid ${spec.pid}\\b`), name)
        assert.ok(took >= 4900, `${name}: chờ ${took} ms, kỳ vọng ~5 s`)
        assert.ok(fs.existsSync(lock), `${name}: khoá của người khác phải còn nguyên`)
        if (spec.token) assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).token, spec.token, name)
        assert.ok(!fs.existsSync(path.join(state, 'ports.json')), `${name}: không ghi registry`)
      }),
    )
  })
})

// Mất quyền sở hữu khoá giữa chừng (khoá bị phá/đổi chủ) => không ghi đè registry, không xoá khoá của chủ mới.
// Gọi trực tiếp withLock/saveRegistry trong tiến trình test để đổi owner đúng giữa chừng.
describe('mất quyền sở hữu khoá', () => {
  const load = () => import(pathToFileURL(SCRIPT).href)
  const lockOf = (state) => path.join(state, 'ports.lock')
  const stealLock = (state, token = 'thief') => fs.writeFileSync(path.join(lockOf(state), 'owner'), JSON.stringify({ pid: process.pid, token }))

  test('đổi chủ trước khi rename registry => reject, registry cũ nguyên vẹn, không còn file tạm, khoá của chủ mới còn nguyên', async () => {
    const { state } = fixture()
    const { withLock, saveRegistry } = await load()
    const file = path.join(state, 'ports.json')
    await withLock(state, async (assertOwner) => saveRegistry(file, { '/keep': 4100 }, assertOwner))
    const before = fs.readFileSync(file, 'utf8')
    await assert.rejects(
      withLock(state, async (assertOwner) => {
        stealLock(state)
        saveRegistry(file, { '/keep': 4100, '/new': 4120 }, assertOwner)
      }),
      /mất quyền sở hữu khoá/,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(state).sort(), ['ports.json', 'ports.lock'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockOf(state), 'owner'), 'utf8')).token, 'thief')
  })

  test('khoá bị xoá hẳn giữa chừng (bị phá) => reject, không ghi registry', async () => {
    const { state } = fixture()
    const { withLock, saveRegistry } = await load()
    const file = path.join(state, 'ports.json')
    await assert.rejects(
      withLock(state, async (assertOwner) => {
        fs.rmSync(lockOf(state), { recursive: true })
        saveRegistry(file, { '/x': 4100 }, assertOwner)
      }),
      /mất quyền sở hữu khoá/,
    )
    assert.ok(!fs.existsSync(file))
    assert.deepEqual(fs.readdirSync(state), [])
  })

  test('đổi chủ trước khi nhả khoá (fn không ghi gì) => reject, khoá của chủ mới không bị xoá', async () => {
    const { state } = fixture()
    const { withLock } = await load()
    await assert.rejects(withLock(state, async () => stealLock(state)), /mất quyền sở hữu khoá/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockOf(state), 'owner'), 'utf8')).token, 'thief')
  })

  test('lỗi của fn không bị che bởi lỗi mất khoá, và khoá của mình vẫn được nhả', async () => {
    const { state } = fixture()
    const { withLock } = await load()
    await assert.rejects(withLock(state, async () => { throw new Error('boom') }), /boom/)
    assert.ok(!fs.existsSync(lockOf(state)))
  })
})

describe('CLI', () => {
  test('lệnh lạ hoặc thừa tham số => exit 2 kèm cách dùng', () => {
    const { state } = fixture()
    for (const args of [[], ['bogus'], ['list', 'x'], ['alloc', 'a', 'b']]) {
      const r = run(state, args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /cách dùng/)
    }
  })
})

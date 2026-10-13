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
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
const BASE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'FLOW_STATE_DIR')),
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
}
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
  const m = r.stdout.match(/^PORT_BASE=(\d+)\r?\n/) // dòng PORT_BASE phải đứng đầu để brief/hook cũ vẫn đọc được
  assert.ok(m, `dòng đầu của stdout phải là PORT_BASE=<n>, nhận: ${JSON.stringify(r.stdout)}`)
  return Number(m[1])
}

// stdout dạng KEY=VALUE mỗi dòng (bỏ dòng comment `#`) => object
function kv(stdout) {
  const o = {}
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) o[m[1]] = m[2]
  }
  return o
}
const slash = (p) => p.replace(/\\/g, '/')

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
  test('base nằm trong 4100..8980, bước 20, dòng đầu là PORT_BASE=<n>', () => {
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

describe('alloc: biến cô lập làn', () => {
  test('in 4 dòng KEY=VALUE theo thứ tự PORT_BASE, FLOW_DB_NAME, FLOW_TEST_DATA, FLOW_SECRET_SCOPE', () => {
    const { state, wt } = fixture()
    const d = wt('lane-a')
    const r = run(state, ['alloc', d])
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.trimEnd().split(/\r?\n/)
    assert.equal(lines.length, 4, r.stdout)
    assert.match(lines[0], /^PORT_BASE=\d+$/)
    assert.match(lines[1], /^FLOW_DB_NAME=/)
    assert.match(lines[2], /^FLOW_TEST_DATA=/)
    assert.match(lines[3], /^FLOW_SECRET_SCOPE=/)
    const v = kv(r.stdout)
    assert.equal(v.FLOW_DB_NAME, `lane_a_wt${v.PORT_BASE}`)
    assert.equal(v.FLOW_TEST_DATA, `${slash(d)}/.flow-test-data`)
    assert.equal(v.FLOW_SECRET_SCOPE, `lane_a_wt${v.PORT_BASE}`)
  })

  test('hai worktree nhận FLOW_SECRET_SCOPE khác nhau; env in lại đúng scope; release gỡ scope', () => {
    const { state, wt } = fixture()
    const a = wt('same-name')
    const b = wt('other')
    const sa = kv(run(state, ['alloc', a]).stdout).FLOW_SECRET_SCOPE
    const sb = kv(run(state, ['alloc', b]).stdout).FLOW_SECRET_SCOPE
    assert.ok(sa && sb && sa !== sb, `${sa} vs ${sb}`)
    assert.equal(kv(run(state, ['env', a]).stdout).FLOW_SECRET_SCOPE, sa)
    run(state, ['release', a])
    const r = run(state, ['env', a])
    assert.equal(r.status, 1)
    assert.ok(!r.stdout.includes('FLOW_SECRET_SCOPE'))
    assert.equal(kv(run(state, ['env', b]).stdout).FLOW_SECRET_SCOPE, sb)
  })

  test('tên repo được làm sạch: chữ thường, ký tự lạ thành `_`, không `_` đầu/cuối hay lặp', () => {
    const { state, wt } = fixture()
    const v = kv(run(state, ['alloc', wt('My-App.v2 (x)')]).stdout)
    assert.equal(v.FLOW_DB_NAME, `my_app_v2_x_wt${v.PORT_BASE}`)
  })

  test('alloc lại cùng path in lại đúng cùng khối biến', () => {
    const { state, wt } = fixture()
    const d = wt('same')
    const a = run(state, ['alloc', d]).stdout
    assert.equal(run(state, ['alloc', d]).stdout, a)
  })

  test('hai worktree khác nhau ra FLOW_DB_NAME khác nhau', () => {
    const { state, wt } = fixture()
    const a = kv(run(state, ['alloc', wt('same-name')]).stdout)
    const b = kv(run(state, ['alloc', wt('other')]).stdout)
    assert.notEqual(a.FLOW_DB_NAME, b.FLOW_DB_NAME)
  })

  test('worktree git thật: tên DB lấy theo repo chính, không theo thư mục worktree', () => {
    const { root, state } = fixture()
    const repo = path.join(root, 'Shop-Web')
    fs.mkdirSync(repo)
    const g = (cwd, ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: BASE_ENV })
      assert.equal(r.status, 0, r.stderr)
    }
    g(repo, 'init', '-q')
    g(repo, 'commit', '-q', '--allow-empty', '-m', 'goc')
    const wtDir = path.join(root, 'lane-g')
    g(repo, 'worktree', 'add', '-q', wtDir, '-b', 'lane-g')
    const v = kv(run(state, ['alloc'], wtDir).stdout)
    assert.equal(v.FLOW_DB_NAME, `shop_web_wt${v.PORT_BASE}`)
    assert.equal(v.FLOW_TEST_DATA, `${slash(fs.realpathSync.native(wtDir))}/.flow-test-data`)
  })

  test('alloc không tạo file nào trong worktree', () => {
    const { state, wt } = fixture()
    const d = wt('clean')
    run(state, ['alloc', d])
    assert.deepEqual(fs.readdirSync(d), [])
  })
})

describe('env', () => {
  test('in khối biến giống alloc, kèm comment dặn dò, không ghi file vào worktree', () => {
    const { state, wt } = fixture()
    const d = wt('lane-b')
    const allocated = kv(run(state, ['alloc', d]).stdout)
    const r = run(state, ['env', d])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(kv(r.stdout), allocated)
    const lines = r.stdout.trimEnd().split(/\r?\n/)
    assert.match(lines[0], /^# .*DB.*khoá.*\.env/s, 'dòng đầu là comment một dòng dặn: DB thử riêng, khoá test, không chép .env')
    assert.equal(lines.filter((l) => l.startsWith('#')).length, 1)
    assert.deepEqual(fs.readdirSync(d), [])
  })

  test('không truyền path: dùng git toplevel của cwd', () => {
    const { root, state } = fixture()
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    const g = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', env: BASE_ENV })
    assert.equal(g.status, 0, g.stderr)
    const allocated = kv(run(state, ['alloc'], repo).stdout)
    assert.deepEqual(kv(run(state, ['env'], path.join(repo, 'sub')).stdout), allocated)
  })

  test('worktree chưa alloc => một dòng lỗi trên stderr, stdout trống, exit 1, không tạo registry', () => {
    const { state, wt } = fixture()
    const r = run(state, ['env', wt('nope')])
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^wt-env: .*alloc/)
    assert.equal(r.stderr.trimEnd().split(/\r?\n/).length, 1)
    assert.ok(!fs.existsSync(path.join(state, 'ports.json')))
  })

  test('đã release => env báo lỗi exit 1', () => {
    const { state, wt } = fixture()
    const d = wt('gone')
    alloc(state, d)
    run(state, ['release', d])
    assert.equal(run(state, ['env', d]).status, 1)
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

describe('check', () => {
  // repo chính thật (có .env + .claude/flow.json) và một worktree git thật
  // flow: object (ghi JSON) hoặc chuỗi (ghi nguyên văn, để dựng file hỏng); mainEnv: nội dung .env của thư mục chính
  function lane(flow, mainEnv = 'API_KEY=main-secret-value-123\n') {
    const { root, state } = fixture()
    const repo = path.join(root, 'shop')
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    const g = (cwd, ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: BASE_ENV })
      assert.equal(r.status, 0, r.stderr)
    }
    g(repo, 'init', '-q')
    fs.writeFileSync(path.join(repo, '.env'), mainEnv)
    if (flow !== undefined) fs.writeFileSync(path.join(repo, '.claude', 'flow.json'), typeof flow === 'string' ? flow : JSON.stringify(flow))
    g(repo, 'commit', '-q', '--allow-empty', '-m', 'goc')
    const wtDir = path.join(root, 'lane-g')
    g(repo, 'worktree', 'add', '-q', wtDir, '-b', 'lane-g')
    return { root, state, repo, wtDir }
  }
  const all = (r) => r.stdout + r.stderr
  // Tạo liên kết; Windows không cho symlink file khi thiếu quyền ⇒ trả false để test bỏ qua phần đó (junction thư mục thì luôn tạo được).
  function link(target, at, type) {
    try {
      fs.symlinkSync(target, at, type)
      return true
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return false
      throw e
    }
  }

  test('worktree sạch (không có .env) => exit 0, in ok', () => {
    const { state, wtDir } = lane()
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
    assert.match(r.stdout, /^ok\r?\n$/)
  })

  test('.env chép từ thư mục chính => exit 1, nêu tên file và tên biến, không lộ giá trị', () => {
    const { state, wtDir } = lane()
    fs.writeFileSync(path.join(wtDir, '.env'), 'API_KEY=main-secret-value-123\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /\.env/)
    assert.match(all(r), /API_KEY/)
    assert.ok(!all(r).includes('main-secret-value-123'))
  })

  test('chép .env rồi thêm comment / đổi khoảng trắng / đảo thứ tự / thêm biến khác => vẫn exit 1 (so từng cặp KEY=VALUE)', () => {
    const { state, wtDir } = lane(undefined, 'DB_URL=postgres://u:p@prod/db\n# khoá chính\nAPI_KEY=main-secret-value-123\nPORT=80\n')
    const variants = [
      '# lane test\nAPI_KEY=main-secret-value-123 # ghi chú\nNEW_ONE=lane-only\n',
      '  PORT=81  \n\n  API_KEY  =  main-secret-value-123  \n',
      'export API_KEY="main-secret-value-123"\n',
      "API_KEY='main-secret-value-123'\r\nOTHER=x\r\n",
      'API_KEY=lane-test-key\nDB_URL=postgres://u:p@prod/db\n', // chỉ một cặp trùng trong số nhiều cặp
    ]
    for (const text of variants) {
      fs.writeFileSync(path.join(wtDir, '.env'), text)
      const r = run(state, ['check', wtDir])
      assert.equal(r.status, 1, `${JSON.stringify(text)} → ${all(r)}`)
      assert.ok(!all(r).includes('main-secret-value-123') && !all(r).includes('postgres://'), all(r))
    }
    fs.writeFileSync(path.join(wtDir, '.env'), 'API_KEY=lane-test-key\nDB_URL=postgres://u:p@prod/db\n')
    const r = run(state, ['check', wtDir])
    assert.match(r.stderr, /DB_URL/)
    assert.doesNotMatch(r.stderr, /API_KEY/, 'chỉ nêu biến trùng')
  })

  test('cặp KEY=VALUE chỉ trùng khi giá trị khác rỗng, dài ≥ 8 và cùng tên biến => còn lại exit 0', () => {
    const { state, wtDir } = lane(undefined, 'PORT=3000\nEMPTY=\nSECRET_A=abcdefgh\nSEVEN=abcdefg\n')
    fs.writeFileSync(path.join(wtDir, '.env'), 'PORT=3000\nEMPTY=\nSEVEN=abcdefg\nOTHER_NAME=abcdefgh\nSECRET_A=different-value\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
    fs.writeFileSync(path.join(wtDir, '.env'), 'SECRET_A=abcdefgh\n') // đúng 8 ký tự, cùng biến
    assert.equal(run(state, ['check', wtDir]).status, 1)
  })

  test('check trên thư mục chính (hoặc không phải worktree) => exit 2 kèm câu đời thường, không in ok', () => {
    const { state, repo, root } = lane()
    const main = run(state, ['check', repo])
    assert.equal(main.status, 2, all(main))
    assert.match(main.stderr, /^wt-env: .*thư mục chính.*worktree/s)
    assert.ok(!/^ok/m.test(main.stdout))
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    const other = run(state, ['check', plain])
    assert.equal(other.status, 2, all(other))
    assert.ok(!/^ok/m.test(other.stdout))
  })

  // Review lượt 2: Windows không phân biệt hoa thường nên `.ENV` / `.Env.local` vẫn là file mà app đọc như `.env`
  test('tên .env viết hoa/thường lẫn lộn (.ENV, .Env.local) vẫn bị soát: chép khoá, prodRefs, junction ra ngoài', () => {
    const copied = lane()
    fs.writeFileSync(path.join(copied.wtDir, '.ENV'), 'export API_KEY=main-secret-value-123\n')
    const r1 = run(copied.state, ['check', copied.wtDir])
    assert.equal(r1.status, 1, all(r1))
    assert.match(all(r1), /\.ENV/)
    assert.match(all(r1), /API_KEY/)
    assert.ok(!all(r1).includes('main-secret-value-123'))
    const prod = lane({ prodRefs: ['prodproj123abc'] })
    fs.writeFileSync(path.join(prod.wtDir, '.Env.local'), 'URL=https://prodproj123abc.example.co\n')
    const r2 = run(prod.state, ['check', prod.wtDir])
    assert.equal(r2.status, 1, all(r2))
    assert.match(all(r2), /\.Env\.local/)
    const out = lane()
    fs.mkdirSync(path.join(out.root, 'ngoai'))
    assert.ok(link(path.join(out.root, 'ngoai'), path.join(out.wtDir, '.ENV'), 'junction'))
    const r3 = run(out.state, ['check', out.wtDir])
    assert.equal(r3.status, 1, all(r3))
    assert.match(all(r3), /\.ENV.*liên kết/)
  })

  test('file mẫu viết hoa (.ENV.EXAMPLE, .Env.Sample, .env.Template, .ENV.dist) vẫn được bỏ qua', () => {
    const { state, wtDir } = lane()
    for (const name of ['.ENV.EXAMPLE', '.Env.Sample', '.env.Template', '.ENV.dist']) fs.writeFileSync(path.join(wtDir, name), 'API_KEY=main-secret-value-123\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
  })

  test('.env là symlink trỏ ra ngoài worktree => exit 1 (kể cả khi đích rỗng/giống hệt)', (t) => {
    const { state, repo, wtDir } = lane()
    if (!link(path.join(repo, '.env'), path.join(wtDir, '.env'), 'file')) return t.skip('Windows thiếu quyền tạo symlink file')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /\.env/)
    assert.match(all(r), /liên kết/)
    assert.ok(!all(r).includes('main-secret-value-123'))
  })

  test('.env.local là symlink hỏng (đích không tồn tại) => exit 1', (t) => {
    const { state, root, wtDir } = lane()
    if (!link(path.join(root, 'khong-co-file'), path.join(wtDir, '.env.local'), 'file')) return t.skip('Windows thiếu quyền tạo symlink file')
    assert.equal(run(state, ['check', wtDir]).status, 1)
  })

  test('.env là junction/symlink thư mục trỏ ra ngoài worktree => exit 1 (tạo được cả trên Windows không quyền admin)', () => {
    const { state, root, wtDir } = lane()
    fs.mkdirSync(path.join(root, 'ngoai'))
    fs.writeFileSync(path.join(root, 'ngoai', 'x'), 'x\n')
    assert.ok(link(path.join(root, 'ngoai'), path.join(wtDir, '.env'), 'junction'))
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /\.env.*liên kết/)
  })

  test('.env* nằm trong thư mục symlink/junction trỏ ra ngoài worktree => exit 1, nêu đường dẫn trong worktree', () => {
    const { state, repo, wtDir } = lane()
    fs.mkdirSync(path.join(repo, 'cfg'))
    fs.writeFileSync(path.join(repo, 'cfg', '.env.production'), 'API_KEY=main-secret-value-123\n')
    assert.ok(link(path.join(repo, 'cfg'), path.join(wtDir, 'cfg'), 'junction'))
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /cfg[\\/]\.env\.production/)
    assert.ok(!all(r).includes('main-secret-value-123'))
  })

  test('thư mục symlink trỏ ra ngoài nhưng không chứa .env*, hoặc symlink trỏ vào trong worktree => không báo oan (exit 0)', () => {
    const { state, root, wtDir } = lane()
    fs.mkdirSync(path.join(root, 'shared-assets'))
    fs.writeFileSync(path.join(root, 'shared-assets', 'logo.txt'), 'x\n')
    assert.ok(link(path.join(root, 'shared-assets'), path.join(wtDir, 'assets'), 'junction'))
    fs.mkdirSync(path.join(wtDir, 'packages', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wtDir, 'packages', 'a', '.env.test'), 'API_KEY=lane-test-key\n')
    assert.ok(link(path.join(wtDir, 'packages', 'a'), path.join(wtDir, 'pkg'), 'junction'))
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
  })

  test('.claude/flow.json ở thư mục chính hỏng hoặc prodRefs sai kiểu => exit 1 kèm lời dặn sửa (fail closed), không in ok', () => {
    const bad = ['{ not json', '[]', '"x"', 'null', '{"prodRefs":"abc"}', '{"prodRefs":[1]}', '{"prodRefs":{"a":1}}', '{"prodRefs":null}', '{"prodRefs":["ok",2]}']
    for (const flow of bad) {
      const { state, wtDir } = lane(flow)
      fs.writeFileSync(path.join(wtDir, '.env'), 'API_KEY=lane-test-key\n') // .env sạch: chỉ cấu hình hỏng làm check đỏ
      const r = run(state, ['check', wtDir])
      assert.equal(r.status, 1, `${flow} → ${all(r)}`)
      assert.match(r.stderr, /flow\.json.*(sửa|prodRefs)/s, flow)
      assert.ok(!/^ok/m.test(r.stdout), flow)
    }
  })

  test('flow.json không có hoặc không khai prodRefs => vẫn bình thường (exit 0 khi .env sạch)', () => {
    for (const flow of [undefined, {}, { tests: 'none' }, { prodRefs: [] }, { prodRefs: ['  ', ''] }]) {
      const { state, wtDir } = lane(flow)
      fs.writeFileSync(path.join(wtDir, '.env'), 'API_KEY=lane-test-key\n')
      const r = run(state, ['check', wtDir])
      assert.equal(r.status, 0, `${JSON.stringify(flow)} → ${all(r)}`)
    }
  })

  test('.env khác thư mục chính => exit 0', () => {
    const { state, wtDir } = lane()
    fs.writeFileSync(path.join(wtDir, '.env'), 'API_KEY=lane-test-key\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
    assert.match(r.stdout, /^ok/)
  })

  test('.env.local chứa chuỗi trong prodRefs => exit 1, không lộ chuỗi đó', () => {
    const { state, wtDir } = lane({ prodRefs: ['prodproj123abc'] })
    fs.writeFileSync(path.join(wtDir, '.env.local'), 'URL=https://prodproj123abc.example.co\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /\.env\.local/)
    assert.ok(!all(r).includes('prodproj123abc'))
  })

  test('prodRefs có nhưng .env không chứa => exit 0; .env trong node_modules bị bỏ qua', () => {
    const { state, wtDir } = lane({ prodRefs: ['prodproj123abc'] })
    fs.writeFileSync(path.join(wtDir, '.env'), 'URL=https://lane.example.co\n')
    fs.mkdirSync(path.join(wtDir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(wtDir, 'node_modules', 'pkg', '.env'), 'API_KEY=main-secret-value-123\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 0, all(r))
  })

  test('.env trong thư mục con của worktree cũng bị soát', () => {
    const { state, wtDir } = lane({ prodRefs: ['prodproj123abc'] })
    fs.mkdirSync(path.join(wtDir, 'apps', 'web'), { recursive: true })
    fs.writeFileSync(path.join(wtDir, 'apps', 'web', '.env.test'), 'X=prodproj123abc\n')
    const r = run(state, ['check', wtDir])
    assert.equal(r.status, 1, all(r))
    assert.match(all(r), /apps[\\/]web[\\/]\.env\.test/)
  })

  test('check không tham số hoặc thừa tham số => exit 2 kèm cách dùng', () => {
    const { state } = fixture()
    for (const args of [['check'], ['check', 'a', 'b']]) {
      const r = run(state, args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /cách dùng/)
    }
  })
})

describe('CLI', () => {
  test('lệnh lạ hoặc thừa tham số => exit 2 kèm cách dùng', () => {
    const { state } = fixture()
    for (const args of [[], ['bogus'], ['list', 'x'], ['alloc', 'a', 'b'], ['env', 'a', 'b']]) {
      const r = run(state, args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /cách dùng/)
    }
  })
})

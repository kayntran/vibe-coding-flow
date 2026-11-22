// Bài kiểm bộ mẫu chặn quyền theo công ty: node --test hooks/postgres-rls.test.mjs
// Phần tĩnh (luôn chạy, không cần Docker): schema.sql đúng khuôn RLS, rls.test.mjs có đối chứng, công thức trỏ tới bộ mẫu.
// Phần chạy thật (cần FLOW_PG_TEST=1 và Docker): bật Postgres Docker RIÊNG (tên container + port lấy từ `wt-env.mjs alloc <worktree>`), chạy schema.sql,
// chạy kit/recipes/postgres-rls/rls.test.mjs, rồi dọn container. Không đặt biến hoặc không có Docker ⇒ bỏ qua và nói rõ lý do.
// Ảnh Postgres: FLOW_PG_IMAGE (mặc định postgres:17-alpine). Không nối DB thật, không dùng tài khoản đám mây.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECIPE = path.join(ROOT, 'kit', 'recipes', 'postgres-rls')
const IMAGE = process.env.FLOW_PG_IMAGE || 'postgres:17-alpine'
const CONTROL_LINES = ['tắt RLS: bắt được truy cập chéo', 'vai BYPASSRLS: bắt được truy cập chéo']

const read = (f) => fs.readFileSync(f, 'utf8')
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 180000, ...opts })

describe('postgres-rls: bộ mẫu đúng khuôn (không cần Docker)', () => {
  const schema = read(path.join(RECIPE, 'schema.sql'))
  const code = schema.replace(/--[^\n]*/g, '') // bỏ chú thích: chữ trong chú thích không tính

  test('schema.sql: mỗi bảng bật + ép RLS và có policy; vai app không BYPASSRLS; không SECURITY DEFINER, không policy mở toang, không cấp TRUNCATE/REFERENCES, không mật khẩu trong file', () => {
    const tables = [...code.matchAll(/CREATE TABLE\s+(\w+)/gi)].map((m) => m[1])
    assert.ok(tables.length >= 3, 'bộ mẫu phải có ít nhất tenants + 2 bảng dữ liệu')
    for (const t of tables) {
      assert.match(code, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`, 'i'), `${t}: thiếu ENABLE ROW LEVEL SECURITY`)
      assert.match(code, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`, 'i'), `${t}: thiếu FORCE ROW LEVEL SECURITY`)
      assert.match(code, new RegExp(`CREATE POLICY \\w+ ON ${t}\\b[\\s\\S]*?WITH CHECK`, 'i'), `${t}: thiếu policy có WITH CHECK`)
    }
    assert.match(code, /NOSUPERUSER NOBYPASSRLS/)
    assert.doesNotMatch(code, /(?<!NO)BYPASSRLS/, 'không được cấp BYPASSRLS')
    assert.doesNotMatch(code, /SECURITY\s+DEFINER/i)
    assert.doesNotMatch(code, /USING\s*\(\s*true\s*\)/i)
    assert.doesNotMatch(code, /GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i)
    assert.doesNotMatch(code, /PASSWORD/i)
    for (const t of tables.filter((x) => x !== 'tenants')) assert.match(code, new RegExp(`${t}\\s*\\([\\s\\S]*?tenant_id uuid NOT NULL DEFAULT app\\.tenant_id\\(\\)`, 'i'), `${t}: thiếu tenant_id NOT NULL mặc định từ phiên`)
  })

  test('rls.test.mjs: có đối chứng tắt RLS và vai BYPASSRLS, chỉ nối container flow-pg-*, bỏ qua khi không đặt FLOW_PG_TEST', () => {
    const t = read(path.join(RECIPE, 'rls.test.mjs'))
    for (const line of CONTROL_LINES) assert.ok(t.includes(line), `thiếu dòng đối chứng: ${line}`)
    assert.match(t, /flow-pg-/)
    assert.match(t, /FLOW_PG_TEST/)
    assert.doesNotMatch(t, /postgres(?:ql)?:\/\//i, 'không nhận chuỗi kết nối: tránh nối nhầm DB thật')
  })

  test('công thức Workers + Postgres trỏ tới bộ mẫu và nói đủ luật chính; SKILL.md trỏ tới công thức và đọc BUSINESS.md/STACK.md trước', () => {
    const f = read(path.join(ROOT, 'skills', 'flow-system-design', 'references', 'noi-luu-postgres-workers.md'))
    for (const must of ['kit/recipes/postgres-rls', 'set_config', 'NOBYPASSRLS', 'force row level security', '--caching-disabled', '0.45', 'tắt RLS: bắt được truy cập chéo', 'wt-env.mjs alloc']) assert.ok(f.toLowerCase().includes(must.toLowerCase()), `công thức thiếu "${must}"`)
    const s = read(path.join(ROOT, 'skills', 'flow-system-design', 'SKILL.md'))
    assert.ok(s.includes('references/noi-luu-postgres-workers.md'))
    assert.ok(s.includes('docs/BUSINESS.md') && s.includes('docs/STACK.md'), 'dòng "Ai quyết" phải đọc BUSINESS.md/STACK.md trước')
  })
})

const WANT = process.env.FLOW_PG_TEST === '1'
const HAS_DOCKER = WANT && docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 30000 }).status === 0
const SKIP = !WANT ? 'FLOW_PG_TEST=1 chưa đặt — bỏ qua bài kiểm Postgres thật (đặt FLOW_PG_TEST=1 để chạy)'
  : !HAS_DOCKER ? 'FLOW_PG_TEST=1 nhưng Docker không chạy được trên máy này — bỏ qua bài kiểm Postgres thật'
    : false
if (SKIP) console.log(`[postgres-rls] BỎ QUA: ${SKIP}`)

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
})

describe('postgres-rls: chạy thật trên Postgres Docker riêng', { skip: SKIP }, () => {
  const adminPw = randomBytes(12).toString('hex')
  const appPw = randomBytes(12).toString('hex')
  let name
  let db

  before(async () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'wt-env.mjs'), 'alloc', ROOT], { encoding: 'utf8' })
    assert.equal(r.status, 0, `wt-env alloc lỗi: ${r.stderr}`)
    const env = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const base = Number(env.PORT_BASE)
    assert.ok(base > 0 && env.FLOW_DB_NAME, `alloc trả sai: ${r.stdout}`)
    db = env.FLOW_DB_NAME
    name = `flow-pg-${db}-rlstest`
    let port = 0
    for (let p = base + 1; p < base + 20 && !port; p++) if (await portFree(p)) port = p
    assert.ok(port, `không còn port trống trong cửa sổ ${base}-${base + 19}`)

    const old = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Label "flow-test"}}'])
    if (old.stdout.trim()) {
      assert.equal(old.stdout.trim(), 'postgres-rls', `container ${name} đã có nhưng không phải của bài kiểm này — không xoá`)
      docker(['rm', '-f', '-v', name])
    }
    const run = docker(['run', '-d', '--rm', '--name', name, '--label', 'flow-test=postgres-rls', '-p', `127.0.0.1:${port}:5432`,
      '-e', `POSTGRES_PASSWORD=${adminPw}`, '-e', `POSTGRES_DB=${db}`, '--tmpfs', '/var/lib/postgresql/data', IMAGE])
    assert.equal(run.status, 0, `không bật được container: ${run.stderr}`)
    console.log(`[postgres-rls] container ${name} (${IMAGE}) cổng ${port}; localConnectionString: postgres://app_rw:***@127.0.0.1:${port}/${db}`)

    // Chỉ máy chủ thật (không phải máy chủ tạm lúc khởi tạo) mới nghe TCP: nối thử qua TCP trong container tới khi được.
    const deadline = Date.now() + 90000
    for (;;) {
      const ping = docker(['exec', '-e', `PGPASSWORD=${adminPw}`, name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', db, '-tAc', 'select 1'], { timeout: 20000 })
      if (ping.status === 0 && ping.stdout.trim() === '1') break
      assert.ok(Date.now() < deadline, `Postgres chưa sẵn sàng sau 90 giây: ${ping.stderr}`)
      await new Promise((res) => setTimeout(res, 500))
    }
    const apply = docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      { input: `${read(path.join(RECIPE, 'schema.sql'))}\nALTER ROLE app_rw PASSWORD '${appPw}';\n` })
    assert.equal(apply.status, 0, `schema.sql lỗi: ${apply.stderr}`)
  })

  after(() => {
    if (!name) return
    docker(['rm', '-f', '-v', name])
    const left = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])
    assert.equal(left.stdout.trim(), '', `container ${name} chưa dọn được`)
  })

  test('rls.test.mjs: 0 fail, có đối chứng "tắt RLS: bắt được truy cập chéo" và "vai BYPASSRLS: bắt được truy cập chéo"', (t) => {
    // NODE_TEST_CONTEXT do trình chạy test cha đặt; để lại thì `node --test` con bị coi là chạy đệ quy và bỏ qua file.
    const { NODE_TEST_CONTEXT: _ctx, ...parentEnv } = process.env
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(RECIPE, 'rls.test.mjs')], {
      encoding: 'utf8', timeout: 600000,
      env: { ...parentEnv, FLOW_PG_TEST: '1', FLOW_PG_CONTAINER: name, FLOW_PG_DB: db, FLOW_PG_APP_PASSWORD: appPw },
    })
    const out = `${r.stdout}\n${r.stderr}`
    for (const line of out.split('\n').filter((l) => !/^\s*ℹ/.test(l) && CONTROL_LINES.some((c) => l.includes(c)))) {
      console.log(line.trim())
      t.diagnostic(line.trim())
    }
    assert.equal(r.status, 0, `rls.test.mjs đỏ:\n${out}`)
    assert.match(out, /ℹ fail 0\b/, out)
    assert.match(out, /ℹ pass [1-9]\d*\b/, out)
    const sum = `rls.test.mjs: ${/ℹ pass (\d+)/.exec(out)[1]} pass, ${/ℹ fail (\d+)/.exec(out)[1]} fail (Postgres ${IMAGE})`
    console.log(`[postgres-rls] ${sum}`)
    t.diagnostic(sum)
    for (const c of CONTROL_LINES) assert.ok(out.includes(c), `thiếu dòng đối chứng "${c}" trong kết quả:\n${out}`)
  })
})

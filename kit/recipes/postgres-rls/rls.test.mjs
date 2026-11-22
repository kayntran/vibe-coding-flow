// Bài kiểm chặn quyền theo công ty (RLS) cho công thức gói Chắc. Chép vào app thành tests/rls.test.mjs, sửa TABLES và các probe theo bảng thật.
// Chạy trên Postgres DOCKER RIÊNG CỦA LÀN (tên container flow-pg-<FLOW_DB_NAME>, port từ `node ~/.claude/hooks/wt-env.mjs alloc <worktree>`);
// không nhận chuỗi kết nối nên không thể nối nhầm DB thật. Điều kiện: DB đã chạy schema.sql (hoặc migration tương đương) và vai app đã có mật khẩu.
//   FLOW_PG_TEST=1  bật bài kiểm (không đặt ⇒ bỏ qua, có báo)
//   FLOW_PG_CONTAINER=flow-pg-...   FLOW_PG_DB=<tên DB>   FLOW_PG_APP_PASSWORD=<mật khẩu vai app>
//   (tuỳ chọn) FLOW_PG_APP_USER=app_rw  FLOW_PG_ADMIN_USER=postgres (superuser, vào bằng socket trong container)  FLOW_PG_RLS_EXEMPT=bảng1,bảng2 (bảng chung đã ghi lý do)
// Kiểm: khách A không đọc/sửa/xoá/chèn dữ liệu của B (và ngược lại), chưa đặt tenant ⇒ rỗng, hết giao dịch là mất tenant, vai app không BYPASSRLS
// và không tự tắt được RLS, mọi bảng bật + ép RLS. Rồi ĐỐI CHỨNG: tắt RLS (và cho vai app BYPASSRLS) thì bài kiểm PHẢI đỏ — nếu không đỏ là bài kiểm vô dụng.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const TABLES = ['tenants', 'bookings', 'notes'] // BẢNG CỦA APP: mọi bảng dữ liệu khách; đối chứng sẽ tắt/bật RLS của các bảng này
const SAFE = /row-level security|permission denied|must be owner|violates|invalid input syntax|null value|would be affected|not permitted/i
const ENABLED = process.env.FLOW_PG_TEST === '1'
const SKIP = ENABLED ? false : 'FLOW_PG_TEST=1 chưa đặt — bỏ qua bài kiểm RLS trên Postgres thật'
if (!ENABLED) console.log(`[rls] BỎ QUA: ${SKIP}`)

let cfg
let d // dữ liệu thử: mã công ty A/B, người dùng, dòng

function config() {
  const e = process.env
  const c = {
    container: e.FLOW_PG_CONTAINER, db: e.FLOW_PG_DB, appPassword: e.FLOW_PG_APP_PASSWORD,
    appUser: e.FLOW_PG_APP_USER || 'app_rw', adminUser: e.FLOW_PG_ADMIN_USER || 'postgres', exempt: e.FLOW_PG_RLS_EXEMPT || '',
  }
  for (const k of ['container', 'db', 'appPassword']) if (!c[k]) throw new Error(`thiếu biến FLOW_PG_${{ container: 'CONTAINER', db: 'DB', appPassword: 'APP_PASSWORD' }[k]}`)
  if (!/^flow-pg-[A-Za-z0-9_.-]+$/.test(c.container)) throw new Error('FLOW_PG_CONTAINER phải là container DB thử của làn (flow-pg-…), không phải DB khác')
  for (const k of ['db', 'appUser', 'adminUser']) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c[k])) throw new Error(`tên ${k} không hợp lệ`)
  if (!/^[A-Za-z0-9_,]*$/.test(c.exempt)) throw new Error('FLOW_PG_RLS_EXEMPT chỉ gồm tên bảng cách nhau bằng dấu phẩy')
  return c
}

// who = 'admin' (superuser, qua socket trong container) | 'app' (vai ứng dụng, qua TCP + mật khẩu). Trả { ok, out, err }.
function psql(who, text) {
  const env = { ...process.env }
  const target = who === 'app' ? ['-e', 'PGPASSWORD'] : []
  const user = who === 'app' ? ['-h', cfg.appHost || '127.0.0.1', '-U', cfg.appUser] : ['-U', cfg.adminUser]
  if (who === 'app') env.PGPASSWORD = cfg.appPassword
  const args = ['exec', '-i', ...target, cfg.container, 'psql', ...user, '-d', cfg.db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-']
  return new Promise((resolve) => {
    const p = execFile('docker', args, { env, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }))
    p.stdin.end(text)
  })
}

const script = (ctx, body) =>
  `BEGIN;\n${ctx ? `SELECT set_config('app.tenant_id', '${ctx.tenant}', true) AS t, set_config('app.user_id', '${ctx.user}', true) AS u \\gset\n` : ''}${body};\nROLLBACK;\n`
const cnt = (table, where = 'true') => `SELECT 'RESULT=' || count(*) FROM ${table} WHERE ${where}`
const wcnt = (stmt, ret = '1', where = 'true') => `WITH x AS (${stmt} RETURNING ${ret}) SELECT 'RESULT=' || count(*) FROM x WHERE ${where}`
const first = (s) => s.split('\n').find((l) => /ERROR/i.test(l)) ?? s.split('\n')[0] ?? ''

// expect: 'zero' = không thấy/chạm dòng nào ngoài quyền (bị từ chối cũng an toàn) · 'refuse' = PHẢI bị từ chối · số n = việc hợp lệ phải ra đúng n dòng
function buildProbes() {
  const { A, B, a1, a2, b1, bookingA, bookingB } = d
  const ctxA = { tenant: A, user: a1 }
  const ctxA2 = { tenant: A, user: a2 }
  const ctxB = { tenant: B, user: b1 }
  const P = []
  const add = (id, desc, ctx, sql, expect) => P.push({ id, desc, ctx, sql, expect })
  const cross = (tag, ctx, mine, theirs, theirBooking) => {
    add(`R1-${tag}`, 'đọc dòng của công ty khác', ctx, cnt('bookings', `tenant_id = '${theirs}'`), 'zero')
    add(`R2-${tag}`, 'đọc không lọc: chỉ ra dòng công ty mình', ctx, cnt('bookings', `tenant_id <> '${mine}'`), 'zero')
    add(`R3-${tag}`, 'đọc theo id dòng công ty khác', ctx, cnt('bookings', `id = '${theirBooking}'`), 'zero')
    add(`U1-${tag}`, 'sửa dòng công ty khác', ctx, wcnt(`UPDATE bookings SET note = 'hack' WHERE tenant_id = '${theirs}'`), 'zero')
    add(`U2-${tag}`, 'sửa không điều kiện chỉ chạm công ty mình', ctx, wcnt(`UPDATE bookings SET note = 'hack'`, 'tenant_id', `tenant_id <> '${mine}'`), 'zero')
    add(`U4-${tag}`, 'kéo dòng công ty khác về mình', ctx, wcnt(`UPDATE bookings SET tenant_id = '${mine}' WHERE id = '${theirBooking}'`), 'zero')
    add(`D1-${tag}`, 'xoá dòng công ty khác', ctx, wcnt(`DELETE FROM bookings WHERE tenant_id = '${theirs}'`), 'zero')
    add(`D2-${tag}`, 'xoá không điều kiện chỉ chạm công ty mình', ctx, wcnt('DELETE FROM bookings', 'tenant_id', `tenant_id <> '${mine}'`), 'zero')
    add(`I1-${tag}`, 'chèn dòng mang mã công ty khác', ctx, `INSERT INTO bookings (tenant_id, customer_name, starts_at) VALUES ('${theirs}', 'rls-test', now())`, 'refuse')
  }
  cross('AB', ctxA, A, B, bookingB)
  cross('BA', ctxB, B, A, bookingA)
  add('R4', 'đọc dòng công ty khác ở bảng tenants', ctxA, cnt('tenants', `id <> '${A}'`), 'zero')
  add('R5', 'đọc ghi chú của công ty khác', ctxA, cnt('notes', `tenant_id = '${B}'`), 'zero')
  add('R6', 'tắt row_security trong phiên rồi đọc', ctxA, `SET LOCAL row_security = off;\n${cnt('bookings', `tenant_id <> '${A}'`)}`, 'zero')
  add('U3', 'chuyển dòng của mình sang công ty khác', ctxA, `UPDATE bookings SET tenant_id = '${B}' WHERE tenant_id = '${A}'`, 'refuse')
  add('U5', 'sửa tên công ty khác', ctxA, wcnt(`UPDATE tenants SET name = 'hack' WHERE id = '${B}'`), 'zero')
  add('D3', 'xoá ghi chú công ty khác', ctxA, wcnt(`DELETE FROM notes WHERE tenant_id = '${B}'`), 'zero')
  add('I2', 'chèn ghi chú vào công ty khác', ctxA, `INSERT INTO notes (tenant_id, user_id, body) VALUES ('${B}', '${b1}', 'x')`, 'refuse')
  add('I3', 'tự tạo công ty mới', ctxA, `INSERT INTO tenants (name) VALUES ('rls-test')`, 'refuse')
  add('N1', 'chưa đặt tenant: đọc', null, cnt('bookings'), 'zero')
  add('N2', 'chưa đặt tenant: chèn', null, `INSERT INTO bookings (customer_name, starts_at) VALUES ('rls-test', now())`, 'refuse')
  add('N3', 'tenant không phải uuid: đọc', { tenant: 'khong-phai-uuid', user: a1 }, cnt('bookings'), 'zero')
  add('P1', 'cùng công ty, khác người: đọc ghi chú riêng', ctxA2, cnt('notes', `user_id = '${a1}'`), 'zero')
  add('P2', 'cùng công ty, khác người: sửa ghi chú riêng', ctxA2, wcnt(`UPDATE notes SET body = 'hack' WHERE user_id = '${a1}'`), 'zero')
  add('P3', 'cùng công ty, khác người: xoá ghi chú riêng', ctxA2, wcnt(`DELETE FROM notes WHERE user_id = '${a1}'`), 'zero')
  add('P4', 'cùng công ty, khác người: chèn ghi chú mang tên người khác', ctxA2, `INSERT INTO notes (user_id, body) VALUES ('${a1}', 'x')`, 'refuse')
  add('S1', 'vai app tự tắt RLS', ctxA, 'ALTER TABLE bookings DISABLE ROW LEVEL SECURITY', 'refuse')
  add('S2', 'vai app tự tạo policy mở toang', ctxA, 'CREATE POLICY rls_test_open ON bookings USING (true)', 'refuse')
  add('S3', 'vai app TRUNCATE (RLS không chặn lệnh này)', ctxA, 'TRUNCATE bookings', 'refuse')
  add('S4', 'vai app đổi sang superuser', ctxA, `SET ROLE ${cfg.adminUser}`, 'refuse')
  add('S5', 'vai app tự cấp BYPASSRLS cho mình', ctxA, `ALTER ROLE ${cfg.appUser} BYPASSRLS`, 'refuse')
  // hết giao dịch là mất tenant: lệnh sau COMMIT trên cùng kết nối không được mượn lại tenant cũ (Hyperdrive tái dùng kết nối)
  P.push({ id: 'N4', desc: 'sau COMMIT, cùng kết nối không còn tenant cũ', raw: `BEGIN;\nSELECT set_config('app.tenant_id', '${A}', true) AS t \\gset\nCOMMIT;\n${cnt('bookings')};\n`, expect: 'zero' })
  add('OK1', 'khách A đọc được dòng của mình', ctxA, cnt('bookings'), 2)
  add('OK2', 'khách A chèn không ghi tenant_id: dòng vào đúng công ty A', ctxA, wcnt(`INSERT INTO bookings (customer_name, starts_at) VALUES ('rls-test', now())`, 'tenant_id', `tenant_id = '${A}'`), 1)
  add('OK3', 'khách A sửa được dòng của mình', ctxA, wcnt(`UPDATE bookings SET note = 'ok'`), 2)
  add('OK4', 'người dùng a1 đọc được ghi chú riêng của mình', ctxA, cnt('notes'), 1)
  add('OK5', 'khách A thấy đúng một dòng công ty của mình', ctxA, cnt('tenants'), 1)
  return P
}

function judge(p, r) {
  const n = Number(/RESULT=(\d+)/.exec(r.out)?.[1] ?? NaN)
  if (p.expect === 'zero') {
    if (!r.ok) return SAFE.test(r.err) ? null : `lỗi lạ: ${first(r.err)}`
    return n === 0 ? null : `thấy/chạm ${n} dòng ngoài quyền`
  }
  if (p.expect === 'refuse') {
    if (r.ok) return 'làm được việc lẽ ra bị từ chối'
    return SAFE.test(r.err) ? null : `lỗi lạ: ${first(r.err)}`
  }
  if (!r.ok) return `bị từ chối: ${first(r.err)}`
  return n === p.expect ? null : `ra ${n}, mong ${p.expect}`
}

// Chạy mọi probe (tối đa 8 cái cùng lúc); trả danh sách probe đỏ { id, desc, why }.
async function runProbes() {
  const probes = buildProbes()
  const bad = []
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < probes.length) {
      const p = probes[next++]
      const r = await psql('app', p.raw ?? script(p.ctx, p.sql))
      const why = judge(p, r)
      if (why) bad.push({ id: p.id, desc: p.desc, why })
    }
  }))
  return { total: probes.length, bad: bad.sort((a, b) => a.id.localeCompare(b.id)) }
}
const show = (bad) => bad.map((b) => `${b.id} (${b.desc}): ${b.why}`).join('\n')

async function structural() {
  const t = cfg.exempt
  const r = await psql('admin', `
SELECT 'bảng ' || c.relname || ': chưa bật hoặc chưa ép RLS' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity) AND c.relname <> ALL (string_to_array('${t}', ','))
UNION ALL SELECT 'vai ' || rolname || ': có quyền quản trị hoặc BYPASSRLS' FROM pg_roles
  WHERE rolname = '${cfg.appUser}' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
UNION ALL SELECT 'bảng ' || c.relname || ': thuộc sở hữu của vai app' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND o.rolname = '${cfg.appUser}'
UNION ALL SELECT 'view ' || c.relname || ': thiếu security_invoker' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v' AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
UNION ALL SELECT 'hàm ' || p.proname || ': SECURITY DEFINER bỏ qua RLS' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app') AND p.prosecdef
UNION ALL SELECT 'vai app có quyền ' || privilege_type || ' trên ' || table_name FROM information_schema.role_table_grants
  WHERE grantee = '${cfg.appUser}' AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER');`)
  assert.ok(r.ok, `không chạy được truy vấn kiểm cấu trúc: ${r.err}`)
  return r.out ? r.out.split('\n') : []
}

const rlsOn = (on) => TABLES.map((t) => (on ? `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;` : `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`)).join(' ')
const MUST_CATCH = ['R1-AB', 'U1-AB', 'D1-AB', 'I1-AB'] // đọc, sửa, xoá, chèn chéo: đối chứng mà không bắt được cả bốn là bài kiểm vô dụng

describe('RLS: khách A không đụng được dữ liệu khách B', { skip: SKIP }, () => {
  before(async () => {
    cfg = config()
    // Vai app nối bằng địa chỉ IP của container (không phải loopback, nơi Postgres tin cậy) để mật khẩu thật sự được kiểm.
    cfg.appHost = await new Promise((res) => execFile('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', cfg.container], { encoding: 'utf8' }, (e, out) => res(e ? '' : String(out).trim())))
    const ping = await psql('admin', 'SELECT 1')
    assert.ok(ping.ok, `không nối được container ${cfg.container}: ${ping.err}`)
    const app = await psql('app', 'SELECT 1')
    assert.ok(app.ok, `vai ${cfg.appUser} không đăng nhập được (đã chạy schema.sql và đặt mật khẩu chưa?): ${app.err}`)
    d = { A: randomUUID(), B: randomUUID(), a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), bookingA: randomUUID(), bookingB: randomUUID() }
    const seed = await psql('admin', `
INSERT INTO tenants (id, name) VALUES ('${d.A}', 'rls-test A'), ('${d.B}', 'rls-test B');
INSERT INTO bookings (id, tenant_id, customer_name, starts_at) VALUES ('${d.bookingA}', '${d.A}', 'a1', now()), ('${randomUUID()}', '${d.A}', 'a2', now()),
  ('${d.bookingB}', '${d.B}', 'b1', now()), ('${randomUUID()}', '${d.B}', 'b2', now());
INSERT INTO notes (tenant_id, user_id, body) VALUES ('${d.A}', '${d.a1}', 'riêng a1'), ('${d.A}', '${d.a2}', 'riêng a2'), ('${d.B}', '${d.b1}', 'riêng b1');`)
    assert.ok(seed.ok, `không tạo được dữ liệu thử: ${seed.err}`)
  })

  after(async () => {
    if (!cfg || !d) return
    const ids = `'${d.A}', '${d.B}'`
    const r = await psql('admin', `ALTER ROLE ${cfg.appUser} NOBYPASSRLS; ${rlsOn(true)}
DELETE FROM notes WHERE tenant_id IN (${ids}); DELETE FROM bookings WHERE tenant_id IN (${ids}); DELETE FROM tenants WHERE id IN (${ids});`)
    assert.ok(r.ok, `không dọn được dữ liệu thử: ${r.err}`)
  })

  test('cấu trúc: vai app không BYPASSRLS/không sở hữu bảng, mọi bảng bật và ép RLS, không SECURITY DEFINER, không TRUNCATE/REFERENCES', async () => {
    assert.deepEqual(await structural(), [])
  })

  test('cách ly: A không đọc/sửa/xoá/chèn dữ liệu B (và ngược lại), chưa đặt tenant ⇒ rỗng, vai app không tự nới quyền, việc hợp lệ vẫn chạy', async () => {
    const { total, bad } = await runProbes()
    assert.equal(bad.length, 0, `${bad.length}/${total} bài kiểm đỏ:\n${show(bad)}`)
  })

  test('đối chứng 1: tắt RLS trên DB thử ⇒ bài kiểm PHẢI bắt được truy cập chéo', async (t) => {
    try {
      const off = await psql('admin', rlsOn(false))
      assert.ok(off.ok, off.err)
      const { total, bad } = await runProbes()
      const ids = bad.map((b) => b.id)
      for (const id of MUST_CATCH) assert.ok(ids.includes(id), `tắt RLS mà bài kiểm ${id} vẫn xanh ⇒ bài kiểm không bắt được gì\n${show(bad)}`)
      assert.ok((await structural()).length > 0, 'tắt RLS mà kiểm cấu trúc vẫn xanh')
      const line = `tắt RLS: bắt được truy cập chéo (${bad.length}/${total} bài kiểm đỏ, gồm ${MUST_CATCH.join(', ')})`
      console.log(line)
      t.diagnostic(line)
    } finally {
      await psql('admin', rlsOn(true))
    }
  })

  test('đối chứng 2: vai app có BYPASSRLS ⇒ bài kiểm PHẢI bắt được', async (t) => {
    try {
      const up = await psql('admin', `ALTER ROLE ${cfg.appUser} BYPASSRLS`)
      assert.ok(up.ok, up.err)
      const { total, bad } = await runProbes()
      const ids = bad.map((b) => b.id)
      for (const id of MUST_CATCH) assert.ok(ids.includes(id), `vai BYPASSRLS mà bài kiểm ${id} vẫn xanh\n${show(bad)}`)
      assert.ok((await structural()).some((l) => l.startsWith('vai ')), 'vai BYPASSRLS mà kiểm cấu trúc vẫn xanh')
      const line = `vai BYPASSRLS: bắt được truy cập chéo (${bad.length}/${total} bài kiểm đỏ)`
      console.log(line)
      t.diagnostic(line)
    } finally {
      await psql('admin', `ALTER ROLE ${cfg.appUser} NOBYPASSRLS`)
    }
  })

  test('sau đối chứng đã bật lại: bài kiểm xanh trở lại', async () => {
    assert.deepEqual(await structural(), [])
    const { total, bad } = await runProbes()
    assert.equal(bad.length, 0, `${bad.length}/${total} bài kiểm đỏ sau khi bật lại:\n${show(bad)}`)
  })
})

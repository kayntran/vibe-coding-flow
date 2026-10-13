// Test cho lib/backup.mjs: node --test hooks/lib/backup.test.mjs
// Không chạy wrangler/pg_dump/schtasks thật: lõi nhận `run` giả (ghi lại mọi lệnh). Thư mục app/home/kho/log đều là thư mục tạm có dấu cách + tiếng Việt.
// Không cài lịch thật: lịch Windows/launchd/cron chỉ được kiểm bằng danh sách lệnh giả nhận được.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readState, writeState, backupReady } from './release-state.mjs'
import {
  EXIT, MARKER, checkDest, choose, compareCounts, cronExpr, defaultDest, detectD1Name, expandHome, hashFile, installHint, isInside, isLocalHost, parseSampleQueries,
  parseWranglerJson, pgCountSql, pgEnvFromUrl, plistFor, portablePath, removeSchedule, restoreCheck, runBackup, sampleProblem, scanSqlDump, schedule, scheduleId,
  pkgManager, schtasksArgs, slugify, status, wranglerCmd,
} from './backup.mjs'

const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

const NOW = new Date(2026, 9, 13, 10, 15, 30)
const DAY = '2026-10-13'
const STAMP = '20261013-101530'
const OK = { status: 0, stdout: '', stderr: '' }
const PASS_PG = 'p@ss-w0rd!x' // mật khẩu GIẢ để kiểm che; ghép lúc chạy để máy quét khoá không coi là khoá thật
const URL_PG = `postgres://app_user:${encodeURIComponent(PASS_PG)}@db.example.com:5432/appdb?sslmode=require`

// App nằm trong repo git giả (có thư mục .git), có sẵn wrangler cục bộ, D1 tên "kho-du-lieu".
function fixture({ wrangler = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup thử '))
  tmpDirs.push(root)
  const repo = path.join(root, 'kho mã')
  const appDir = path.join(repo, 'ứng dụng thử')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(appDir)
  fs.writeFileSync(path.join(appDir, 'wrangler.toml'), 'name = "app"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "kho-du-lieu"\ndatabase_id = "x"\n')
  if (wrangler) {
    fs.mkdirSync(path.join(appDir, 'node_modules', 'wrangler', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '// giả\n')
  }
  const f = { root, repo, appDir, home: path.join(root, 'nhà'), dest: path.join(root, 'nhà', 'kho sao lưu'), logDir: path.join(root, 'logs'), tmp: path.join(root, 'tmp'), wranglerJs: path.join(appDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js') }
  fs.mkdirSync(f.home)
  fs.mkdirSync(f.tmp)
  return f
}
function makeRun(...handlers) {
  const calls = []
  const run = (cmd, args, o = {}) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env, input: o.input })
    for (const h of handlers) { const r = h(cmd, args, o); if (r) return r }
    return { ...OK }
  }
  return { run, calls }
}
const deps = (f, run, over = {}) => ({ run, now: NOW, platform: 'win32', env: { PATH: '/usr/bin', DATABASE_URL: URL_PG }, home: f.home, nodePath: 'node', script: path.join(f.root, 'kit', 'hooks', 'backup.mjs'), pid: 4242, uid: 501, logDir: f.logDir, tmpRoot: f.tmp, ...over })
const st = (f) => readState(f.appDir, { logDir: f.logDir })
const text = (r) => r.lines.join('\n')

// ---- D1 giả ----
const SQL_OK = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
  'INSERT INTO "users" VALUES(1,\'An\');',
  'INSERT INTO "users" VALUES(2,\'Bình Đặng\');',
  'INSERT INTO "users" VALUES(3,\'Chi\');',
  'CREATE TABLE "notes" (id INTEGER);',
  'CREATE TABLE sqlite_sequence(name,seq);',
  'INSERT INTO "sqlite_sequence" VALUES(\'users\',3);',
  '',
].join('\n')
const json = (rows) => ({ status: 0, stdout: `⛅️ wrangler 4.0\n${JSON.stringify([{ results: rows, success: true }])}\n`, stderr: '' })
const d1 = ({ sql = SQL_OK, counts = { users: 3, notes: 0 }, exportResult, fileResult, queryRows } = {}) => (cmd, args, o) => {
  if (!args.includes('d1')) return undefined
  if (args.includes('export')) {
    if (exportResult) return exportResult
    fs.writeFileSync(args[args.indexOf('--output') + 1], sql)
    return { ...OK }
  }
  if (args.includes('--file')) return fileResult ?? { ...OK }
  const q = args[args.indexOf('--command') + 1]
  if (q.includes('sqlite_master')) return json(Object.keys(counts).sort().map((name) => ({ name })))
  if (/count\(\*\) AS n/.test(q)) return json([...q.matchAll(/FROM "([^"]+)"/g)].map((m, i) => ({ i, n: counts[m[1]] })))
  return queryRows ? queryRows(q) : json([{ id: 1 }])
}

// ---- Postgres giả ----
// createResult: kết quả cố định hoặc hàm (args, sql) → kết quả; version: trả lời SHOW server_version_num (không đặt ⇒ rơi vào câu trả lời mặc định "1" = máy chủ cũ)
const pg = ({ before = { 'public.users': 3 }, after: after_ = before, restored = before, dumpResult, restoreResult, createResult, dropResult, version, sample } = {}) => {
  let n = 0
  return (cmd, args, o) => {
    if (cmd === 'pg_dump') {
      if (dumpResult) return dumpResult
      fs.writeFileSync(args[args.indexOf('--file') + 1], 'PGDMP-nhị-phân')
      return { ...OK }
    }
    if (cmd === 'pg_restore') return restoreResult ?? { ...OK }
    if (cmd !== 'psql') return undefined
    const sql = args[args.indexOf('-c') + 1]
    if (/CREATE DATABASE/.test(sql)) return typeof createResult === 'function' ? createResult(args, sql) : createResult ?? { ...OK }
    if (/DROP DATABASE/.test(sql)) return dropResult ?? { ...OK }
    if (version && /server_version_num/.test(sql)) return { status: 0, stdout: `${version}\n`, stderr: '' }
    if (/query_to_xml/.test(sql)) {
      const src = String(o.env.PGDATABASE ?? '').startsWith('flow_restore_') ? restored : (n++ === 0 ? before : after_)
      return { status: 0, stdout: Object.entries(src).map(([k, v]) => `${k}\t${v}`).join('\n') + '\n', stderr: '' }
    }
    return { status: 0, stdout: sample ?? '1\tAn\n', stderr: '' }
  }
}

// bật sao lưu D1 / pg (đồng ý) rồi trả fixture
function enableD1(f, over = {}) {
  const r = choose({ appDir: f.appDir, mode: 'on', method: 'd1', dest: f.dest, agreed: true, ...over }, deps(f, makeRun().run))
  assert.equal(r.exit, 0, text(r))
}
function enablePg(f, over = {}) {
  const r = choose({ appDir: f.appDir, mode: 'on', method: 'pg', dest: f.dest, agreed: true, ...over }, deps(f, makeRun().run))
  assert.equal(r.exit, 0, text(r))
}

// ===== hàm nhỏ =====

describe('tiện ích', () => {
  test('slugify bỏ dấu tiếng Việt; scheduleId ổn định theo thư mục', () => {
    assert.equal(slugify('Ứng dụng Của Tôi!'), 'ung-dung-cua-toi')
    assert.equal(slugify('đồ án'), 'do-an')
    assert.equal(slugify('###'), 'app')
    const id = scheduleId(path.join(os.tmpdir(), 'Dự án A'))
    assert.match(id, /^flow-backup-du-an-a-[0-9a-f]{6}$/)
    assert.equal(id, scheduleId(path.join(os.tmpdir(), 'Dự án A')))
    assert.notEqual(id, scheduleId(path.join(os.tmpdir(), 'x', 'Dự án A')))
  })

  test('đường dẫn: ~ mở rộng, trong home viết lại dạng ~/…, isInside đúng biên', () => {
    const home = path.join(os.tmpdir(), 'nhà')
    assert.equal(expandHome('~', home), home)
    assert.equal(expandHome('~/kho', home), path.join(home, 'kho'))
    assert.equal(expandHome('/x/y', home), '/x/y')
    assert.equal(portablePath(path.join(home, 'a', 'b'), home), '~/a/b')
    assert.equal(portablePath(path.join(os.tmpdir(), 'ngoài'), home), path.join(os.tmpdir(), 'ngoài'))
    assert.equal(isInside(path.join(home, 'a'), home), true)
    assert.equal(isInside(home, home), true)
    assert.equal(isInside(`${home}-khác`, home), false)
    assert.equal(isInside(path.dirname(home), home), false)
  })

  test('checkDest: trong thư mục app hoặc trong repo ⇒ từ chối; ngoài repo ⇒ nhận, lưu dạng ~/…', () => {
    const f = fixture()
    const d = deps(f, makeRun().run)
    for (const bad of [path.join(f.appDir, 'sao lưu'), path.join(f.repo, 'backups'), f.repo, f.appDir]) {
      const r = checkDest(bad, f.appDir, d)
      assert.equal(r.ok, false, bad)
      assert.match(r.reason, /nằm trong thư mục dự án/)
    }
    const ok = checkDest(f.dest, f.appDir, d)
    assert.equal(ok.ok, true)
    assert.equal(ok.stored, '~/kho sao lưu')
    assert.equal(checkDest('', f.appDir, d).ok, false)
    assert.equal(checkDest('~/.flow-backups/x', f.appDir, d).ok, true)
    assert.match(defaultDest(f.appDir), /^~\/\.flow-backups\/ung-dung-thu$/)
  })

  test('detectD1Name: đúng một tên ⇒ trả về; không có hoặc nhiều ⇒ null', () => {
    const f = fixture()
    assert.equal(detectD1Name(f.appDir), 'kho-du-lieu')
    fs.writeFileSync(path.join(f.appDir, 'wrangler.toml'), 'database_name = "a"\ndatabase_name = "b"\n')
    assert.equal(detectD1Name(f.appDir), null)
    fs.writeFileSync(path.join(f.appDir, 'wrangler.toml'), 'name = "x"\n')
    fs.writeFileSync(path.join(f.appDir, 'wrangler.jsonc'), '{ "d1_databases": [{ "database_name": "jc" }] }')
    assert.equal(detectD1Name(f.appDir), 'jc')
  })

  test('pgEnvFromUrl: tách PG* env (giải mã %40), từ chối chuỗi không phải postgres', () => {
    assert.deepEqual(pgEnvFromUrl(URL_PG), { PGHOST: 'db.example.com', PGPORT: '5432', PGUSER: 'app_user', PGPASSWORD: PASS_PG, PGDATABASE: 'appdb', PGSSLMODE: 'require' })
    assert.equal(pgEnvFromUrl('postgresql://u@[::1]/d').PGHOST, '::1')
    assert.equal(pgEnvFromUrl('mysql://u:p@h/d'), null)
    assert.equal(pgEnvFromUrl('không phải url'), null)
    assert.equal(isLocalHost(''), true)
    assert.equal(isLocalHost('localhost'), true)
    assert.equal(isLocalHost('/var/run/postgresql'), true)
    assert.equal(isLocalHost('db.example.com'), false)
    assert.match(pgCountSql(['public', 'auth']), /IN \('public','auth'\)/)
  })

  test('scanSqlDump: đếm INSERT từng bảng, bảng rỗng = 0, bỏ sqlite_*, nhận tên có nháy/chữ có dấu', () => {
    const f = fixture()
    const file = path.join(f.root, 'x.sql')
    fs.writeFileSync(file, `${SQL_OK}CREATE TABLE IF NOT EXISTS \`gốc\` (a);\nINSERT INTO \`gốc\` VALUES('Đặng');\nCREATE TABLE "a ""b""" (c);\nINSERT INTO "a ""b""" VALUES(1);\r\nINSERT INTO "a ""b""" VALUES(2);\r\n`)
    assert.deepEqual(scanSqlDump(file), { users: 3, notes: 0, 'gốc': 1, 'a "b"': 2 })
    assert.equal(hashFile(file).length, 64)
  })

  test('parseSampleQueries + sampleProblem: expect, nhiều câu, chỉ câu đọc, một lệnh mỗi câu', () => {
    const qs = parseSampleQueries('-- ghi chú\n-- expect: 3\nSELECT count(*)\nFROM users;\n\nSELECT 1;\n')
    assert.deepEqual(qs, [{ sql: 'SELECT count(*)\nFROM users;', expect: '3' }, { sql: 'SELECT 1;', expect: undefined }])
    assert.equal(sampleProblem('SELECT 1;'), null)
    assert.equal(sampleProblem("select 'a;b' from t;"), null)
    assert.match(sampleProblem('DROP TABLE users;'), /chỉ được là câu đọc/)
    assert.match(sampleProblem('SELECT 1; DELETE FROM t;'), /một lệnh/)
  })

  test('sampleProblem: từ chối hàm đụng file/hệ thống dù câu bắt đầu bằng SELECT (lo_export, pg_read_file, dblink, COPY…), kể cả giấu trong chuỗi; câu đọc bình thường vẫn qua', () => {
    // Mọi lời gọi hàm (trừ count) bị từ chối — dựng câu thử từ danh sách tên hàm đụng file/hệ thống/cấu hình của Postgres
    const FN_NAMES = ['lo_export', 'lo_import', 'pg_read_file', 'pg_catalog.pg_read_binary_file', 'pg_ls_dir', 'pg_ls_logdir', 'pg_stat_file',
      'pg_execute_server_program', 'set_config', 'dblink', 'query_to_xml', 'upper', 'over', '"pg_read_file"']
    const plainCalls = FN_NAMES.flatMap((fn) => [`SELECT ${fn}('a');`, `select * from ${fn}('b') as t;`])
    const p = 'pg_read_file'
    const tricky = [
      `with cte as (select 1) select ${p}('c') from cte;`, // gọi hàm sau WITH
      `explain copy (select 1) to program 'id';`, // COPY … PROGRAM sau EXPLAIN
      `select query_to_xml('select pg_read' || '_file(''x'')', false, true, '');`, // Grok lượt lại: tên hàm ghép trong chuỗi
      `select ${p}/* x */('d');`, `select ${p}--x\n('e');`, // QA vòng 3: ghi chú chen giữa tên và "("
      `select E'\\'' || ${p}('f');`, `select $q$'$q$ || ${p}('g');`, // QA vòng 3: E'' và $tag$
      `select 1 as "x'y", ${p}('h') as "z'w";`, // QA vòng 4: nháy đơn trong tên ngoặc kép
      `select 'chưa đóng from t;`, // nháy chưa đóng
      ...['été', 'été', 'été', 'fn​', 'f😀', 'x́count'].map((fn) => `select ${fn}('i');`), // QA vòng 4–5: chữ có dấu (dựng sẵn và tổ hợp), ký tự vô hình, emoji, dấu kết hợp
      `SELECT ${'b'.repeat(20_000)} FROM t;`, // câu khổng lồ
    ]
    for (const sql of [
      ...plainCalls, ...tricky,
      "SELECT été('x');", "SELECT 'abc FROM t;",
      // QA vòng 5: dấu kết hợp, ký tự vô hình, emoji trong tên hàm; over(…) không còn là từ khoá được phép; câu khổng lồ
      "SELECT été('x');", "SELECT fn​('x');", "SELECT f😀('x');", "SELECT x́count(*);", 'SELECT over(1);',
      `SELECT ${'a'.repeat(20_000)} FROM t;`,
    ]) {
      assert.match(sampleProblem(sql) ?? '', /hàm|lệnh|ghi chú|nháy|dài quá/, sql)
    }
    for (const sql of ['SELECT count(*) FROM users;', "SELECT * FROM users WHERE note = 'copy me';", 'SELECT copy_count, lo_get_count FROM t;', 'WITH t AS (SELECT 1) SELECT * FROM t;', 'SELECT 1;',
      "SELECT title FROM todos WHERE title ILIKE '%việc (nhà)%';", 'SELECT "tiêu đề" FROM "việc cần làm" WHERE id IN (1, 2);', "SELECT 'it''s' AS \"a\"\"b\";"]) {
      assert.equal(sampleProblem(sql), null, sql)
    }
  })

  test('compareCounts: khớp theo khoảng, thiếu/thừa bảng, lệch số', () => {
    const exp = { a: { min: 3, max: 3 }, b: { min: 1, max: 4 } }
    assert.deepEqual(compareCounts(exp, { a: 3, b: 4 }), [])
    assert.equal(compareCounts(exp, { a: 2, b: 1 }).length, 1)
    assert.match(compareCounts(exp, { a: 3 })[0], /"b" không có/)
    assert.match(compareCounts(exp, { a: 3, b: 2, c: 1 })[0], /"c" có thêm/)
  })

  test('lịch: cronExpr, schtasksArgs, plistFor (thoát ký tự XML)', () => {
    assert.equal(cronExpr(1), '0 * * * *')
    assert.equal(cronExpr(6), '0 */6 * * *')
    assert.equal(cronExpr(24), '0 3 */1 * *')
    assert.equal(cronExpr(72), '0 3 */3 * *')
    assert.deepEqual(schtasksArgs('t', '"a" b', 6), ['/Create', '/TN', 't', '/TR', '"a" b', '/SC', 'HOURLY', '/MO', '6', '/F'])
    assert.deepEqual(schtasksArgs('t', 'x', 24).slice(5), ['/SC', 'DAILY', '/MO', '1', '/ST', '03:00', '/F'])
    const p = plistFor({ label: 'com.flow.x', args: ['/n', '/a & b/<c>', 'chay'], everyHours: 2, pathEnv: '/bin:/x"y' })
    assert.match(p, /<integer>7200<\/integer>/)
    assert.match(p, /<string>\/a &amp; b\/&lt;c&gt;<\/string>/)
    assert.match(p, /x&quot;y/)
    assert.match(p, /<key>RunAtLoad<\/key><false\/>/)
  })

  test('parseWranglerJson bỏ dòng chữ đứng trước; wranglerCmd ưu tiên bản cài trong app', () => {
    assert.deepEqual(parseWranglerJson('⛅️ banner\n[{"results":[{"a":1}]}]\n')[0].results, [{ a: 1 }])
    assert.equal(parseWranglerJson('không có json'), null)
    const f = fixture()
    assert.deepEqual(wranglerCmd(f.appDir, deps(f, null)), { cmd: 'node', pre: [f.wranglerJs] })
    const g = fixture({ wrangler: false })
    const viaPath = path.join(g.root, 'npm toàn cục')
    fs.mkdirSync(path.join(viaPath, 'node_modules', 'wrangler', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(viaPath, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '')
    assert.equal(wranglerCmd(g.appDir, deps(g, null, { env: { PATH: `/không/có${path.delimiter}${viaPath}` } })).pre[0], path.join(viaPath, 'node_modules', 'wrangler', 'bin', 'wrangler.js'))
    assert.deepEqual(wranglerCmd(g.appDir, deps(g, null, { env: { PATH: '/không/có' } })), { cmd: 'wrangler', pre: [] })
  })

  test('BUG-5 pkgManager: pnpm-lock.yaml → pnpm, yarn.lock → yarn, còn lại npm; lockfile ở thư mục cha nhận, ngoài gốc repo (.git) thì không', () => {
    const f = fixture()
    assert.equal(pkgManager(f.appDir), 'npm')
    fs.writeFileSync(path.join(f.appDir, 'package-lock.json'), '{}')
    assert.equal(pkgManager(f.appDir), 'npm')
    fs.writeFileSync(path.join(f.appDir, 'yarn.lock'), '')
    assert.equal(pkgManager(f.appDir), 'yarn')
    fs.writeFileSync(path.join(f.appDir, 'pnpm-lock.yaml'), '')
    assert.equal(pkgManager(f.appDir), 'pnpm')
    const g = fixture()
    fs.writeFileSync(path.join(g.repo, 'pnpm-lock.yaml'), '')
    assert.equal(pkgManager(g.appDir), 'pnpm', 'monorepo: lockfile ở gốc repo')
    const h = fixture()
    fs.writeFileSync(path.join(h.root, 'pnpm-lock.yaml'), '')
    assert.equal(pkgManager(h.appDir), 'npm', 'lockfile ngoài repo không tính')
  })

  test('BUG-5 installHint: gợi ý cài wrangler theo trình quản lý gói của app; không biết app ⇒ npm', () => {
    const f = fixture()
    assert.match(installHint('wrangler', 'win32', f.appDir), /npm install --save-dev wrangler/)
    fs.writeFileSync(path.join(f.appDir, 'pnpm-lock.yaml'), '')
    const pnpm = installHint('wrangler', 'win32', f.appDir)
    assert.match(pnpm, /pnpm add -D wrangler --allow-build=workerd/)
    assert.match(pnpm, /pnpm approve-builds/)
    assert.doesNotMatch(pnpm, /\bnpm\b|npx/)
    const g = fixture()
    fs.writeFileSync(path.join(g.appDir, 'yarn.lock'), '')
    assert.match(installHint('wrangler', 'linux', g.appDir), /yarn add -D wrangler/)
  })

  test('installHint theo máy', () => {
    assert.match(installHint('wrangler', 'win32'), /npm install --save-dev wrangler/)
    assert.match(installHint('pg_dump', 'win32'), /winget install PostgreSQL/)
    assert.match(installHint('psql', 'darwin'), /brew install libpq/)
    assert.match(installHint('pg_restore', 'linux'), /apt install postgresql-client/)
  })
})

// ===== chon =====

describe('chon', () => {
  test('chưa --dong-y ⇒ exit 4, in câu hỏi có cách + chỗ cất, KHÔNG ghi file, KHÔNG chạy lệnh nào', () => {
    const f = fixture()
    const fake = makeRun()
    const r = choose({ appDir: f.appDir, mode: 'on', method: 'd1', dest: f.dest, agreed: false }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.ASK)
    assert.match(text(r), /CHƯA làm gì/)
    assert.match(text(r), /D1 "kho-du-lieu"/)
    assert.ok(text(r).includes(f.dest))
    assert.match(text(r), /--dong-y/)
    assert.equal(st(f), null)
    assert.equal(fake.calls.length, 0)
    assert.equal(fs.existsSync(f.dest), false)
    assert.equal(choose({ appDir: f.appDir, mode: 'off', agreed: false }, deps(f, fake.run)).exit, EXIT.ASK)
    assert.equal(choose({ appDir: f.appDir, mode: 'on', supabaseFree: true, method: 'pg', agreed: false }, deps(f, fake.run)).exit, EXIT.ASK)
    assert.equal(st(f), null)
  })

  test('đích trong repo ⇒ từ chối (exit 1) dù có --dong-y, không ghi trạng thái', () => {
    const f = fixture()
    for (const agreed of [true, false]) {
      const r = choose({ appDir: f.appDir, mode: 'on', method: 'd1', dest: path.join(f.repo, 'bản sao'), agreed }, deps(f, makeRun().run))
      assert.equal(r.exit, EXIT.FAIL)
      assert.match(text(r), /nằm trong thư mục dự án/)
    }
    assert.equal(st(f), null)
  })

  test('bật D1: ghi backup vào release.json (đích dạng ~/…, tên D1 tự dò, mặc định 24 giờ)', () => {
    const f = fixture()
    const r = choose({ appDir: f.appDir, mode: 'on', method: 'd1', dest: f.dest, agreed: true }, deps(f, makeRun().run))
    assert.equal(r.exit, 0)
    assert.deepEqual(st(f).backup, { choice: 'on', method: 'd1', db: 'kho-du-lieu', dest: '~/kho sao lưu', everyHours: 24, timeTravelDays: 7 })
    assert.match(text(r), /khôi phục|chay/)
  })

  test('bật pg: nhớ tên biến kết nối (không lưu chuỗi), schema; đánh dấu Storage khi có R2 hoặc --co-storage', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.appDir, 'wrangler.toml'), '[[r2_buckets]]\nbinding = "B"\n')
    const r = choose({ appDir: f.appDir, mode: 'on', method: 'pg', dest: f.dest, every: 6, schemas: ['public', 'auth'], urlEnv: 'DB_URL', agreed: true }, deps(f, makeRun().run))
    assert.equal(r.exit, 0)
    assert.deepEqual(st(f).backup, { choice: 'on', method: 'pg', urlEnv: 'DB_URL', schemas: ['public', 'auth'], dest: '~/kho sao lưu', everyHours: 6, storage: true })
    assert.equal(fs.readFileSync(path.join(f.appDir, '.claude', 'release.json'), 'utf8').includes('example.com'), false)
  })

  test('tham số sai: thiếu method, tên D1 lạ, --every ngoài khoảng, tên biến/schema lạ ⇒ exit 1', () => {
    const f = fixture()
    const go = (o) => choose({ appDir: f.appDir, mode: 'on', dest: f.dest, agreed: true, ...o }, deps(f, makeRun().run))
    assert.match(text(go({})), /--method/)
    assert.match(text(go({ method: 'd1', db: 'a b; rm' })), /không hợp lệ/)
    assert.match(text(go({ method: 'd1', every: 0 })), /--every/)
    assert.match(text(go({ method: 'pg', urlEnv: 'a-b' })), /biến môi trường/)
    assert.match(text(go({ method: 'pg', schemas: ['public;drop'] })), /schema/)
    fs.writeFileSync(path.join(f.appDir, 'wrangler.toml'), 'name = "x"\n')
    assert.match(text(go({ method: 'd1' })), /--db/)
    assert.equal(st(f), null)
  })

  test('Supabase gói miễn phí: chỉ khuyên Pro + phí, ghi advise-pro, không sao lưu / cài lịch', () => {
    const f = fixture()
    const fake = makeRun()
    const r = choose({ appDir: f.appDir, mode: 'on', method: 'pg', supabaseFree: true, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0)
    assert.match(text(r), /25 USD\/tháng/)
    assert.equal(st(f).backup.choice, 'advise-pro')
    assert.equal(fake.calls.length, 0)
    for (const fn of [runBackup, restoreCheck, schedule]) {
      const x = fn({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
      assert.equal(x.exit, EXIT.FAIL)
      assert.match(text(x), /Pro/)
    }
    assert.equal(fake.calls.length, 0)
    assert.match(text(status({ appDir: f.appDir }, deps(f, fake.run))), /nâng Pro/)
  })

  test('tắt (off) ghi choice off và tháo lịch đang chạy; đổi nơi cất thì xoá dấu mốc cũ', () => {
    const f = fixture()
    enableD1(f)
    writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, scheduler: { kind: 'schtasks', id: 'flow-backup-x' }, lastBackup: NOW.toISOString(), lastRestoreCheck: NOW.toISOString() } }, { logDir: f.logDir })
    enableD1(f, { dest: path.join(f.home, 'chỗ khác') })
    assert.equal(st(f).backup.lastBackup, undefined)
    assert.equal(st(f).backup.lastRestoreCheck, undefined)
    assert.equal(st(f).backup.scheduler.id, 'flow-backup-x')
    const fake = makeRun()
    const r = choose({ appDir: f.appDir, mode: 'off', agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0)
    assert.deepEqual(fake.calls.map((c) => [c.cmd, ...c.args]), [['schtasks', '/Delete', '/TN', 'flow-backup-x', '/F']])
    assert.equal(st(f).backup.choice, 'off')
    assert.equal(st(f).backup.scheduler, undefined)
    assert.equal(backupReady(st(f), NOW).applicable, false)
  })

  // Bật D1 đầy đủ (lịch + bản sao + khôi phục thử) rồi trả trạng thái để đổi lựa chọn.
  const readyD1 = (f) => {
    enableD1(f)
    writeState(f.appDir, { ...st(f), lạ: 1, backup: { ...st(f).backup, scheduler: { kind: 'schtasks', id: 'flow-backup-x' }, storage: true, lastBackup: NOW.toISOString(), lastRestoreCheck: NOW.toISOString() } }, { logDir: f.logDir })
    assert.equal(backupReady(st(f), NOW).ready, true)
  }
  const OLD_FIELDS = ['method', 'db', 'urlEnv', 'schemas', 'timeTravelDays', 'storage', 'dest', 'everyHours', 'scheduler']

  test('BUG-6 đổi sang "không sao lưu" ⇒ xoá method/db/dest/everyHours/scheduler… của lựa chọn cũ, giữ lịch sử lastBackup/lastRestoreCheck và trường lạ; không phá preflight', () => {
    const f = fixture()
    readyD1(f)
    const r = choose({ appDir: f.appDir, mode: 'off', agreed: true }, deps(f, makeRun().run))
    assert.equal(r.exit, 0)
    const b = st(f).backup
    assert.deepEqual(Object.keys(b).sort(), ['choice', 'lastBackup', 'lastRestoreCheck'])
    assert.equal(b.choice, 'off')
    for (const k of OLD_FIELDS) assert.equal(k in b, false, k)
    assert.equal(b.lastBackup, NOW.toISOString())
    assert.equal(st(f).lạ, 1)
    assert.deepEqual(backupReady(st(f), NOW), { applicable: false, ready: true, reasons: [] })
    assert.match(text(status({ appDir: f.appDir }, deps(f, makeRun().run))), /TẮT/)
  })

  test('BUG-6 đổi sang "khuyên nâng Pro" (Supabase miễn phí) ⇒ xoá trường cũ, giữ lịch sử; bật lại sau đó thì đòi làm lại từ đầu', () => {
    const f = fixture()
    readyD1(f)
    const fake = makeRun()
    const r = choose({ appDir: f.appDir, mode: 'on', method: 'pg', supabaseFree: true, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0)
    const b = st(f).backup
    assert.deepEqual(Object.keys(b).sort(), ['choice', 'lastBackup', 'lastRestoreCheck'])
    assert.equal(b.choice, 'advise-pro')
    for (const k of OLD_FIELDS) assert.equal(k in b, false, k)
    assert.deepEqual(backupReady(st(f), NOW), { applicable: false, ready: true, reasons: [] })
    assert.deepEqual(fake.calls.map((c) => [c.cmd, c.args[0]]), [['schtasks', '/Delete']], 'lịch cũ vẫn được tháo')
    // bật lại: không thừa hưởng lịch sử của lần chọn trước ⇒ chưa đạt, preflight chặn đủ lý do
    enableD1(f)
    const again = backupReady(st(f), NOW)
    assert.equal(again.applicable, true)
    assert.deepEqual(again.reasons.map((x) => x.code), ['no-scheduler', 'no-backup', 'no-restore-check'])
  })

  test('BUG-6 off → advise-pro → off lặp lại vẫn sạch; chưa từng bật thì chỉ có choice', () => {
    const f = fixture()
    choose({ appDir: f.appDir, mode: 'off', agreed: true }, deps(f, makeRun().run))
    assert.deepEqual(st(f).backup, { choice: 'off' })
    choose({ appDir: f.appDir, mode: 'on', method: 'pg', supabaseFree: true, agreed: true }, deps(f, makeRun().run))
    assert.deepEqual(st(f).backup, { choice: 'advise-pro' })
    choose({ appDir: f.appDir, mode: 'off', agreed: true }, deps(f, makeRun().run))
    assert.deepEqual(st(f).backup, { choice: 'off' })
  })

  test('BUG-6 chưa --dong-y ⇒ vẫn exit 4 và không đụng trường cũ', () => {
    const f = fixture()
    readyD1(f)
    const before = JSON.stringify(st(f))
    assert.equal(choose({ appDir: f.appDir, mode: 'off', agreed: false }, deps(f, makeRun().run)).exit, EXIT.ASK)
    assert.equal(choose({ appDir: f.appDir, mode: 'on', supabaseFree: true, method: 'pg', agreed: false }, deps(f, makeRun().run)).exit, EXIT.ASK)
    assert.equal(JSON.stringify(st(f)), before)
  })
})

// ===== chay =====

describe('chay (D1)', () => {
  test('chưa --dong-y ⇒ exit 4, không chạy wrangler, không tạo thư mục', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun(d1())
    const r = runBackup({ appDir: f.appDir, agreed: false }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.ASK)
    assert.match(text(r), /Sao lưu ngay/)
    assert.equal(fake.calls.length, 0)
    assert.equal(fs.existsSync(f.dest), false)
    assert.equal(st(f).backup.lastBackup, undefined)
  })

  test('chưa bật sao lưu ⇒ exit 1; cấu hình bị sửa trỏ đích vào repo ⇒ exit 1', () => {
    const f = fixture()
    assert.match(text(runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun().run))), /Chưa bật sao lưu/)
    enableD1(f)
    writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, dest: path.join(f.repo, 'bk') } }, { logDir: f.logDir })
    const fake = makeRun(d1())
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.equal(fake.calls.length, 0)
  })

  test('thành công: wrangler d1 export --remote vào <dest>/<ngày>/, có manifest (số dòng, sha256), ghi lastBackup, không in dữ liệu', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun(d1())
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    const file = path.join(f.dest, DAY, `kho-du-lieu-${STAMP}.sql`)
    assert.ok(fs.existsSync(file))
    assert.equal(fs.existsSync(`${file}.partial`), false)
    const m = JSON.parse(fs.readFileSync(`${file}.manifest.json`, 'utf8'))
    assert.deepEqual(m.tables, { users: { min: 3, max: 3 }, notes: { min: 0, max: 0 } })
    assert.equal(m.sha256, hashFile(file))
    assert.equal(m.method, 'd1')
    const c = fake.calls[0]
    assert.deepEqual([c.cmd, c.args[0], ...c.args.slice(1, 5)], ['node', f.wranglerJs, 'd1', 'export', 'kho-du-lieu', '--remote'])
    assert.equal(c.args[c.args.indexOf('--output') + 1], `${file}.partial`)
    assert.equal(c.cwd, f.appDir)
    assert.equal(st(f).backup.lastBackup, NOW.toISOString())
    assert.match(text(r), /2 bảng, 3 dòng/)
    assert.equal(/Bình|An\b/.test(text(r)), false)
  })

  test('chưa đăng nhập Cloudflare ⇒ exit 3 + hướng dẫn đăng nhập; không để file nửa vời, không ghi lastBackup', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun(d1({ exportResult: { status: 1, stdout: '', stderr: 'You are not authenticated. Please run `wrangler login`.' } }))
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.MISSING)
    assert.match(text(r), /wrangler login/)
    assert.deepEqual(fs.readdirSync(path.join(f.dest, DAY)), [])
    assert.equal(st(f).backup.lastBackup, undefined)
    assert.match(fs.readFileSync(path.join(f.logDir, 'backup.log'), 'utf8'), /chưa đăng nhập/)
  })

  test('thiếu wrangler ⇒ exit 3 + lệnh cài; lỗi khác ⇒ exit 1 một dòng; file rỗng ⇒ exit 1', () => {
    const f = fixture()
    enableD1(f)
    const missing = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(() => ({ status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })).run))
    assert.equal(missing.exit, EXIT.MISSING)
    assert.match(text(missing), /npm install --save-dev wrangler/)
    const other = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ exportResult: { status: 1, stdout: '', stderr: '\u001b[31mX \u001b[41;31m[ERROR]\u001b[0m D1_ERROR: lỗi lạ\nchi tiết' } })).run))
    assert.equal(other.exit, EXIT.FAIL)
    assert.match(text(other), /X \[ERROR\] D1_ERROR: lỗi lạ/, 'màu terminal của wrangler đã được bỏ')
    const empty = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ sql: '' })).run))
    assert.equal(empty.exit, EXIT.FAIL)
    assert.equal(st(f).backup.lastBackup, undefined)
  })

  test('BUG-5 app dùng pnpm / yarn ⇒ lời cài wrangler và đăng nhập theo đúng trình quản lý gói; app npm giữ nguyên lời cũ', () => {
    const noWrangler = () => ({ status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
    const notLoggedIn = d1({ exportResult: { status: 1, stdout: '', stderr: 'You are not authenticated. Please run `wrangler login`.' } })
    for (const [lock, install, login] of [['pnpm-lock.yaml', /pnpm add -D wrangler --allow-build=workerd/, 'pnpm exec wrangler login'], ['yarn.lock', /yarn add -D wrangler/, 'yarn wrangler login'], [null, /npm install --save-dev wrangler/, 'npx wrangler login']]) {
      const f = fixture()
      if (lock) fs.writeFileSync(path.join(f.appDir, lock), '')
      enableD1(f)
      const missing = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(noWrangler).run))
      assert.equal(missing.exit, EXIT.MISSING)
      assert.match(text(missing), install, String(lock))
      if (lock) assert.doesNotMatch(text(missing), /\bnpm\b|npx/, String(lock))
      const auth = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(notLoggedIn).run))
      assert.equal(auth.exit, EXIT.MISSING)
      assert.ok(text(auth).includes(login), `${lock}: ${text(auth)}`)
    }
  })

  test('BUG-5 khôi phục thử cũng nói theo trình quản lý gói của app', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.appDir, 'pnpm-lock.yaml'), '')
    enableD1(f)
    assert.equal(runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run)).exit, 0)
    const noWrangler = () => ({ status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(noWrangler).run))
    assert.equal(r.exit, EXIT.MISSING)
    assert.match(text(r), /pnpm add -D wrangler --allow-build=workerd/)
  })
})

describe('chay (Postgres)', () => {
  test('release.json bị sửa tay thành tên schema/biến lạ ⇒ exit 1, không chạy lệnh nào (không nhét vào câu SQL)', () => {
    const f = fixture()
    enablePg(f)
    const fake = makeRun(pg())
    for (const patch of [{ schemas: ["public'; DROP TABLE x; --"] }, { urlEnv: 'A B' }]) {
      writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, ...patch } }, { logDir: f.logDir })
      const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
      assert.equal(r.exit, EXIT.FAIL)
      writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, schemas: ['public'], urlEnv: 'DATABASE_URL' } }, { logDir: f.logDir })
    }
    assert.equal(fake.calls.length, 0)
  })

  test('thiếu biến kết nối ⇒ exit 3; chuỗi không phải postgres ⇒ exit 1', () => {
    const f = fixture()
    enablePg(f)
    const none = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun().run, { env: { PATH: '' } }))
    assert.equal(none.exit, EXIT.MISSING)
    assert.match(text(none), /DATABASE_URL/)
    const bad = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun().run, { env: { DATABASE_URL: 'mysql://a/b' } }))
    assert.equal(bad.exit, EXIT.FAIL)
  })

  test('thành công: đếm trước + sau pg_dump (khoảng min–max), kết nối qua PG* env, chuỗi/mật khẩu không nằm trên dòng lệnh', () => {
    const f = fixture()
    enablePg(f, { schemas: ['public', 'auth'] })
    const fake = makeRun(pg({ before: { 'public.users': 3 }, after: { 'public.users': 5 } }))
    const env = { PATH: '/usr/bin', DATABASE_URL: URL_PG, PGHOST: 'cu.example.com', PGUSER: 'cu' }
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { env }))
    assert.equal(r.exit, 0, text(r))
    const dump = fake.calls.find((c) => c.cmd === 'pg_dump')
    assert.deepEqual(dump.args.filter((a) => a.startsWith('--schema')), ['--schema=public', '--schema=auth'])
    assert.ok(dump.args.includes('--format=custom') && dump.args.includes('--no-owner') && dump.args.includes('--no-password'))
    assert.equal(dump.env.PGHOST, 'db.example.com')
    assert.equal(dump.env.PGUSER, 'app_user')
    assert.equal(dump.env.PGPASSWORD, PASS_PG)
    assert.equal(dump.env.PATH, '/usr/bin')
    for (const c of fake.calls) assert.equal(c.args.join(' ').includes('example.com') || c.args.join(' ').includes(PASS_PG), false, `${c.cmd} lộ chuỗi kết nối trên dòng lệnh`)
    assert.equal(fake.calls.filter((c) => c.cmd === 'psql').length, 2)
    const file = path.join(f.dest, DAY, `ung-dung-thu-${STAMP}.dump`)
    const m = JSON.parse(fs.readFileSync(`${file}.manifest.json`, 'utf8'))
    assert.deepEqual(m.tables, { 'public.users': { min: 3, max: 5 } })
    assert.equal(st(f).backup.lastBackup, NOW.toISOString())
    assert.equal(text(r).includes(PASS_PG), false)
  })

  test('pg_dump hỏng ⇒ exit 1, lời báo che mật khẩu/chuỗi nếu lệnh con in ra; thiếu pg_dump ⇒ exit 3 + lệnh cài', () => {
    const f = fixture()
    enablePg(f)
    const leaky = { status: 1, stdout: '', stderr: `pg_dump: error: connection to ${URL_PG} failed: password ${PASS_PG} rejected` }
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(pg({ dumpResult: leaky })).run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.equal(text(r).includes(PASS_PG), false)
    assert.equal(text(r).includes('example.com'), false)
    assert.match(text(r), /\*\*\*/)
    assert.equal(fs.readFileSync(path.join(f.logDir, 'backup.log'), 'utf8').includes(PASS_PG), false)
    const miss = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun((cmd) => (cmd === 'pg_dump' ? { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : undefined), pg()).run))
    assert.equal(miss.exit, EXIT.MISSING)
    assert.match(text(miss), /winget install PostgreSQL/)
  })
})

// ===== khoi-phuc-thu =====

function backedUpD1(f, over = {}) {
  enableD1(f, over)
  const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run))
  assert.equal(r.exit, 0, text(r))
}

describe('khoi-phuc-thu (D1)', () => {
  test('chưa --dong-y ⇒ exit 4, không chạy gì', () => {
    const f = fixture()
    backedUpD1(f)
    const fake = makeRun(d1())
    const r = restoreCheck({ appDir: f.appDir, agreed: false }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.ASK)
    assert.equal(fake.calls.length, 0)
    assert.equal(st(f).backup.lastRestoreCheck, undefined)
  })

  test('chưa có bản sao lưu ⇒ exit 1', () => {
    const f = fixture()
    enableD1(f)
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /Chưa có bản sao lưu/)
  })

  test('đạt: nạp file .sql vào D1 --local trong thư mục tạm, so số dòng + truy vấn mẫu, ghi lastRestoreCheck + docs/BACKUP.md, dọn thư mục tạm', () => {
    const f = fixture()
    backedUpD1(f, { storage: true })
    let tomlSeen = null
    const fake = makeRun((cmd, args, o) => { if (args.includes('execute') && !tomlSeen) tomlSeen = fs.readFileSync(path.join(o.cwd, 'wrangler.toml'), 'utf8') }, d1())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    assert.match(text(r), /ĐẠT: 2 bảng, 3 dòng khớp bản gốc, 1 truy vấn mẫu đúng/)
    const first = fake.calls[0]
    assert.equal(first.cmd, 'node')
    assert.ok(first.args.includes('--local') && first.args.includes('--file'))
    assert.ok(first.args[first.args.indexOf('--file') + 1].endsWith(`kho-du-lieu-${STAMP}.sql`))
    assert.ok(first.cwd.startsWith(f.tmp), 'chạy trong thư mục tạm')
    assert.ok(!first.args.includes('--remote'))
    assert.match(tomlSeen, /database_name = "flow_restore_4242"/)
    assert.equal(fake.calls.some((c) => c.args.includes('--remote')), false)
    assert.equal(st(f).backup.lastRestoreCheck, NOW.toISOString())
    assert.deepEqual(fs.readdirSync(f.tmp), [], 'thư mục tạm đã dọn')
    const md = fs.readFileSync(path.join(f.appDir, 'docs', 'BACKUP.md'), 'utf8')
    assert.ok(md.startsWith(MARKER))
    for (const s of ['D1 "kho-du-lieu"', '~/kho sao lưu/<ngày>/', 'Time Travel', 'chưa cài lịch tự động', '2026-10-13 10:15', '2 bảng, 3 dòng', 'File đính kèm (Storage/R2): chưa sao lưu']) assert.ok(md.includes(s), s)
  })

  test('số dòng lệch ⇒ exit 1, nêu bảng nào, KHÔNG ghi lastRestoreCheck / BACKUP.md, vẫn dọn thư mục tạm', () => {
    const f = fixture()
    backedUpD1(f)
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ counts: { users: 2, notes: 0 } })).run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /bảng "users": cần 3 dòng, khôi phục được 2/)
    assert.equal(st(f).backup.lastRestoreCheck, undefined)
    assert.equal(fs.existsSync(path.join(f.appDir, 'docs', 'BACKUP.md')), false)
    assert.deepEqual(fs.readdirSync(f.tmp), [])
  })

  test('nạp .sql lỗi ⇒ exit 1; thiếu bảng sau khôi phục ⇒ exit 1', () => {
    const f = fixture()
    backedUpD1(f)
    const bad = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ fileResult: { status: 1, stdout: '', stderr: 'SQLITE_ERROR: near "x"' } })).run))
    assert.equal(bad.exit, EXIT.FAIL)
    assert.match(text(bad), /SQLITE_ERROR/)
    const miss = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ counts: { users: 3 } })).run))
    assert.equal(miss.exit, EXIT.FAIL)
    assert.match(text(miss), /"notes" không có/)
  })

  test('bản sao bị sửa sau khi lưu ⇒ mã kiểm tra lệch ⇒ exit 1, không chạy wrangler', () => {
    const f = fixture()
    backedUpD1(f)
    fs.appendFileSync(path.join(f.dest, DAY, `kho-du-lieu-${STAMP}.sql`), '-- bị sửa\n')
    const fake = makeRun(d1())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /đã bị đổi hoặc hỏng/)
    assert.equal(fake.calls.length, 0)
  })

  test('docs/restore-check.sql: expect đúng ⇒ đạt; expect sai ⇒ exit 1; câu ghi dữ liệu ⇒ từ chối trước khi chạy', () => {
    const f = fixture()
    backedUpD1(f)
    fs.mkdirSync(path.join(f.appDir, 'docs'))
    const sqlFile = path.join(f.appDir, 'docs', 'restore-check.sql')
    const rows = (q) => json([{ c: /users/.test(q) ? 3 : 0 }])
    fs.writeFileSync(sqlFile, '-- expect: 3\nSELECT count(*) AS c FROM users;\n')
    const ok = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ queryRows: rows })).run))
    assert.equal(ok.exit, 0, text(ok))
    fs.writeFileSync(sqlFile, '-- expect: 99\nSELECT count(*) AS c FROM users;\n')
    const wrong = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ queryRows: rows })).run))
    assert.equal(wrong.exit, EXIT.FAIL)
    assert.match(text(wrong), /Cần "99", nhận "3"/)
    fs.writeFileSync(sqlFile, 'DELETE FROM users;\n')
    const fake = makeRun(d1())
    const unsafe = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(unsafe.exit, EXIT.FAIL)
    assert.match(text(unsafe), /chỉ được là câu đọc/)
    assert.equal(fake.calls.length, 0)
  })

  test('truy vấn mẫu mặc định không ra dòng nào ⇒ exit 1; BACKUP.md viết tay không bị ghi đè', () => {
    const f = fixture()
    backedUpD1(f)
    const none = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1({ queryRows: () => json([]) })).run))
    assert.equal(none.exit, EXIT.FAIL)
    assert.match(text(none), /Không trả dòng nào/)
    fs.mkdirSync(path.join(f.appDir, 'docs'))
    fs.writeFileSync(path.join(f.appDir, 'docs', 'BACKUP.md'), '# Của tôi\n')
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run))
    assert.equal(r.exit, 0)
    assert.match(text(r), /không ghi đè/)
    assert.equal(fs.readFileSync(path.join(f.appDir, 'docs', 'BACKUP.md'), 'utf8'), '# Của tôi\n')
    assert.ok(st(f).backup.lastRestoreCheck)
  })
})

describe('khoi-phuc-thu (Postgres)', () => {
  function backedUpPg(f) {
    enablePg(f)
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, makeRun(pg()).run))
    assert.equal(r.exit, 0, text(r))
  }

  test('đạt: tạo DB tạm flow_restore_<pid> trên máy, pg_restore, đếm, rồi XOÁ DB tạm', () => {
    const f = fixture()
    backedUpPg(f)
    const fake = makeRun(pg())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { env: { PATH: '/usr/bin', DATABASE_URL: URL_PG, PGUSER: 'toi' } }))
    assert.equal(r.exit, 0, text(r))
    const sqls = fake.calls.filter((c) => c.cmd === 'psql').map((c) => c.args[c.args.indexOf('-c') + 1])
    assert.match(sqls[0], /^CREATE DATABASE flow_restore_4242$/)
    assert.match(sqls.at(-1), /^DROP DATABASE IF EXISTS flow_restore_4242$/)
    const restore = fake.calls.find((c) => c.cmd === 'pg_restore')
    assert.equal(restore.args[restore.args.indexOf('--dbname') + 1], 'flow_restore_4242')
    assert.equal(restore.env.PGUSER, 'toi')
    assert.equal(restore.env.PGPASSWORD, undefined)
    assert.ok(st(f).backup.lastRestoreCheck)
    assert.ok(fs.existsSync(path.join(f.appDir, 'docs', 'BACKUP.md')))
  })

  test('pg_restore hỏng ⇒ exit 1 nhưng vẫn xoá DB tạm; số dòng lệch ⇒ exit 1', () => {
    const f = fixture()
    backedUpPg(f)
    const fake = makeRun(pg({ restoreResult: { status: 1, stdout: '', stderr: 'pg_restore: error: could not execute query' } }))
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.ok(fake.calls.some((c) => c.cmd === 'psql' && /DROP DATABASE IF EXISTS flow_restore_4242/.test(c.args.join(' '))))
    const lech = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(pg({ restored: { 'public.users': 1 } })).run))
    assert.equal(lech.exit, EXIT.FAIL)
    assert.match(text(lech), /public\.users/)
  })

  test('PGHOST trỏ máy từ xa ⇒ từ chối, không chạy lệnh nào (không khôi phục thử lên máy thật)', () => {
    const f = fixture()
    backedUpPg(f)
    for (const env of [{ PGHOST: 'db.example.com' }, { PGHOSTADDR: '10.1.2.3' }, { FLOW_RESTORE_URL: 'postgres://u:p@db.example.com/x' }]) {
      const fake = makeRun(pg())
      const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { env: { PATH: '', ...env } }))
      assert.equal(r.exit, EXIT.FAIL)
      assert.match(text(r), /chính máy này/)
      assert.equal(fake.calls.length, 0)
    }
    const ok = makeRun(pg())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, ok.run, { env: { PATH: '', FLOW_RESTORE_URL: 'postgres://u:p@localhost:5433/postgres' } }))
    assert.equal(r.exit, 0, text(r))
    assert.equal(ok.calls[0].env.PGPORT, '5433')
  })

  const psqlCalls = (fake) => fake.calls.filter((c) => c.cmd === 'psql').map((c) => ({ db: c.args.includes('-d') ? c.args[c.args.indexOf('-d') + 1] : undefined, sql: c.args[c.args.indexOf('-c') + 1], env: c.env }))
  const withSample = (f, sql) => {
    fs.mkdirSync(path.join(f.appDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(f.appDir, 'docs', 'restore-check.sql'), sql)
  }

  test('truy vấn mẫu chạy trong phiên CHỈ ĐỌC (PGOPTIONS default_transaction_read_only=on, giữ PGOPTIONS của user); đếm/tạo/xoá DB thì không cần', () => {
    const f = fixture()
    backedUpPg(f)
    const fake = makeRun(pg())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { env: { PATH: '', DATABASE_URL: URL_PG, PGOPTIONS: '-c statement_timeout=5s' } }))
    assert.equal(r.exit, 0, text(r))
    const sample = psqlCalls(fake).find((c) => /^SELECT \* FROM "public"\."users" LIMIT 1;$/.test(c.sql))
    assert.ok(sample, 'có chạy truy vấn mẫu')
    assert.match(sample.env.PGOPTIONS, /-c statement_timeout=5s/)
    assert.match(sample.env.PGOPTIONS, /-c default_transaction_read_only=on/)
    assert.equal(sample.db, undefined)
    assert.equal(sample.env.PGDATABASE, 'flow_restore_4242')
  })

  test('docs/restore-check.sql có hàm đụng file (lo_export…) ⇒ từ chối TRƯỚC khi chạy, không tạo DB tạm, không chạy lệnh nào', () => {
    const f = fixture()
    backedUpPg(f)
    for (const bad of ["SELECT lo_export(16384, '/tmp/x');", "-- expect: 1\nSELECT * FROM pg_read_file('/etc/passwd');", "SELECT query_to_xml('select pg_ls_dir(''.'')', false, true, '');"]) {
      withSample(f, bad)
      const fake = makeRun(pg())
      const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
      assert.equal(r.exit, EXIT.FAIL, bad)
      assert.match(text(r), /restore-check\.sql: .*(hàm|lệnh)/)
      assert.equal(fake.calls.length, 0, bad)
    }
    assert.equal(st(f).backup.lastRestoreCheck, undefined)
  })

  test('DB quản trị lấy từ FLOW_RESTORE_URL nếu có, không thì postgres; tạo và xoá DB tạm cùng một DB quản trị', () => {
    const f = fixture()
    backedUpPg(f)
    const none = makeRun(pg())
    assert.equal(restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, none.run)).exit, 0)
    const a = psqlCalls(none)
    assert.deepEqual([a[0].db, a.at(-1).db], ['postgres', 'postgres'])
    const url = makeRun(pg())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, url.run, { env: { PATH: '', FLOW_RESTORE_URL: 'postgres://u:p@localhost:5433/maint' } }))
    assert.equal(r.exit, 0, text(r))
    const b = psqlCalls(url)
    assert.match(b[0].sql, /^CREATE DATABASE flow_restore_4242$/)
    assert.deepEqual([b[0].db, b.at(-1).db], ['maint', 'maint'])
    assert.match(b.at(-1).sql, /^DROP DATABASE IF EXISTS flow_restore_4242/)
  })

  test('DB quản trị không có/không vào được ⇒ thử template1 (tạo từ template0 vì template1 đang được dùng), xoá bằng đúng DB đó', () => {
    const f = fixture()
    backedUpPg(f)
    const fake = makeRun(pg({ createResult: (args) => (args[args.indexOf('-d') + 1] === 'postgres' ? { status: 2, stdout: '', stderr: 'psql: FATAL: database "postgres" does not exist' } : { ...OK }) }))
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    const c = psqlCalls(fake).filter((x) => /CREATE DATABASE/.test(x.sql))
    assert.deepEqual(c.map((x) => x.db), ['postgres', 'template1'])
    assert.equal(c[1].sql, 'CREATE DATABASE flow_restore_4242 TEMPLATE template0')
    assert.equal(psqlCalls(fake).at(-1).db, 'template1')
    assert.doesNotMatch(text(r), /không xoá được/)
  })

  test('DROP DB tạm: máy chủ ≥ 13 ⇒ WITH (FORCE); cũ hơn hoặc không biết ⇒ DROP thường', () => {
    const f = fixture()
    backedUpPg(f)
    for (const [version, forced] of [['160004', true], ['130000', true], ['120012', false], [undefined, false]]) {
      const fake = makeRun(pg({ version }))
      assert.equal(restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run)).exit, 0)
      const drop = psqlCalls(fake).at(-1).sql
      assert.equal(drop, forced ? 'DROP DATABASE IF EXISTS flow_restore_4242 WITH (FORCE)' : 'DROP DATABASE IF EXISTS flow_restore_4242', String(version))
    }
  })

  test('không xoá được DB tạm ⇒ báo rõ tên DB + cách xoá tay + ghi log (không âm thầm để DB rác); kết quả khôi phục thử giữ nguyên', () => {
    const f = fixture()
    backedUpPg(f)
    const fake = makeRun(pg({ dropResult: { status: 1, stdout: '', stderr: 'ERROR: database "flow_restore_4242" is being accessed by other users' } }))
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    assert.match(text(r), /Khôi phục thử ĐẠT/)
    assert.match(text(r), /Không xoá được cơ sở dữ liệu tạm "flow_restore_4242"/)
    assert.match(text(r), /DROP DATABASE flow_restore_4242/)
    assert.match(fs.readFileSync(path.join(f.logDir, 'backup.log'), 'utf8'), /flow_restore_4242/)
    const fail = makeRun(pg({ restoreResult: { status: 1, stdout: '', stderr: 'pg_restore: error' }, dropResult: { status: 1, stdout: '', stderr: 'ERROR: busy' } }))
    const r2 = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fail.run))
    assert.equal(r2.exit, EXIT.FAIL)
    assert.match(text(r2), /Không xoá được cơ sở dữ liệu tạm/)
  })

  test('không nối được Postgres local ⇒ exit 3 kèm hướng dẫn; thiếu psql ⇒ exit 3 + lệnh cài', () => {
    const f = fixture()
    backedUpPg(f)
    const noServer = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(pg({ createResult: { status: 2, stdout: '', stderr: 'psql: connection refused' } })).run))
    assert.equal(noServer.exit, EXIT.MISSING)
    assert.match(text(noServer), /Postgres đang chạy trên máy/)
    const noPsql = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun((cmd) => (cmd === 'psql' ? { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : undefined)).run, { platform: 'darwin' }))
    assert.equal(noPsql.exit, EXIT.MISSING)
    assert.match(text(noPsql), /brew install libpq/)
  })
})

// ===== lich + trang-thai =====

describe('lich', () => {
  test('chưa --dong-y ⇒ exit 4, không cài gì', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun()
    const r = schedule({ appDir: f.appDir, agreed: false }, deps(f, fake.run))
    assert.equal(r.exit, EXIT.ASK)
    assert.equal(fake.calls.length, 0)
  })

  test('Windows: schtasks /Create (mảng tham số, lệnh có đường dẫn dấu cách đặt trong nháy) rồi /Query; ghi scheduler vào release.json', () => {
    const f = fixture()
    enableD1(f, { every: 6 })
    const made = new Set()
    const fake = makeRun((cmd, args) => {
      if (cmd !== 'schtasks') return undefined
      if (args[0] === '/Create') { made.add(args[2]); return { ...OK } }
      if (args[0] === '/Query') return { status: made.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }
    })
    const r = schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    const id = scheduleId(f.appDir)
    const create = fake.calls[0].args
    assert.deepEqual(create.slice(0, 3), ['/Create', '/TN', id])
    assert.equal(create[create.indexOf('/TR') + 1], `"node" "${path.join(f.root, 'kit', 'hooks', 'backup.mjs')}" "chay" "${f.appDir}" "--dong-y"`)
    assert.deepEqual(create.slice(create.indexOf('/SC')), ['/SC', 'HOURLY', '/MO', '6', '/F'])
    assert.deepEqual(fake.calls[1].args, ['/Query', '/TN', id])
    assert.deepEqual(st(f).backup.scheduler, { kind: 'schtasks', id })
    assert.match(text(r), /Time Travel/)
  })

  test('đường dẫn dài quá 261 ký tự (giới hạn schtasks) ⇒ exit 1, không gọi schtasks', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun()
    const r = schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { script: path.join(f.root, 'x'.repeat(260), 'backup.mjs') }))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /quá dài/)
    assert.equal(fake.calls.length, 0)
  })

  test('Mac: ghi plist vào <home>/Library/LaunchAgents rồi launchctl bootstrap; kiểm bằng launchctl list', () => {
    const f = fixture()
    enableD1(f, { every: 2 })
    const fake = makeRun()
    const r = schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run, { platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' } }))
    assert.equal(r.exit, 0, text(r))
    const id = scheduleId(f.appDir)
    const plist = path.join(f.home, 'Library', 'LaunchAgents', `com.flow.${id}.plist`)
    const xml = fs.readFileSync(plist, 'utf8')
    assert.match(xml, /<integer>7200<\/integer>/)
    assert.ok(xml.includes(`<string>${f.appDir}</string>`))
    assert.ok(xml.includes('/opt/homebrew/bin:/usr/bin'))
    assert.deepEqual(fake.calls.map((c) => [c.cmd, ...c.args]), [
      ['launchctl', 'bootout', `gui/501/com.flow.${id}`],
      ['launchctl', 'bootstrap', 'gui/501', plist],
      ['launchctl', 'list', `com.flow.${id}`],
    ])
    assert.deepEqual(st(f).backup.scheduler, { kind: 'launchd', id })
  })

  test('Linux: crontab - nhận dòng có dấu hiệu flow-backup, giữ dòng cũ của người dùng, chạy lại không nhân đôi; tắt chỉ gỡ đúng dòng của kit', () => {
    const f = fixture()
    enableD1(f, { every: 6 })
    let cron = '0 1 * * * /usr/bin/việc-của-tôi\n'
    const fake = makeRun((cmd, args, o) => {
      if (cmd !== 'crontab') return undefined
      if (args[0] === '-l') return { status: 0, stdout: cron, stderr: '' }
      cron = o.input
      return { ...OK }
    })
    const d = deps(f, fake.run, { platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' } })
    for (let i = 0; i < 2; i++) assert.equal(schedule({ appDir: f.appDir, agreed: true }, d).exit, 0)
    const id = scheduleId(f.appDir)
    const lines = cron.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0], '0 1 * * * /usr/bin/việc-của-tôi')
    assert.ok(lines[1].startsWith('0 */6 * * * PATH='))
    assert.ok(lines[1].includes(`'chay' '${f.appDir}' '--dong-y'`))
    assert.ok(lines[1].endsWith(`# flow-backup:${id}`))
    assert.deepEqual(st(f).backup.scheduler, { kind: 'cron', id })
    const rm = removeSchedule({ kind: 'cron', id }, d)
    assert.equal(rm.ok, true)
    assert.equal(cron, '0 1 * * * /usr/bin/việc-của-tôi\n')
  })

  test('xuống dòng/ký tự điều khiển trong appDir, PATH, đường dẫn script hoặc node ⇒ từ chối trước khi hỏi/ghi crontab/plist (chống chèn job), không chạy lệnh nào', () => {
    const f = fixture()
    enableD1(f, { every: 6 })
    const INJECT = '* * * * * touch /tmp/pwned'
    const cases = [
      ['PATH', { env: { PATH: `/usr/bin\n${INJECT}` } }, f.appDir],
      ['PATH (CR)', { env: { PATH: `/usr/bin\r${INJECT}` } }, f.appDir],
      ['đường dẫn script', { script: `${path.join(f.root, 'kit', 'backup.mjs')}\n${INJECT}` }, f.appDir],
      ['đường dẫn node', { nodePath: `node\n${INJECT}` }, f.appDir],
      ['thư mục app', {}, `${f.appDir}\n${INJECT}`],
      ['ký tự điều khiển khác', { env: { PATH: '/usr/bin\u0007' } }, f.appDir],
    ]
    for (const platform of ['linux', 'darwin']) {
      for (const [ten, over, appDir] of cases) {
        for (const agreed of [true, false]) {
          const fake = makeRun()
          const r = schedule({ appDir, agreed }, deps(f, fake.run, { platform, ...over }))
          assert.equal(r.exit, EXIT.FAIL, `${platform}/${ten}/${agreed}`)
          assert.match(text(r), /xuống dòng|ký tự điều khiển/)
          assert.equal(fake.calls.length, 0, `${platform}/${ten}`)
        }
      }
    }
    assert.equal(fs.existsSync(path.join(f.home, 'Library')), false, 'không ghi plist')
    assert.equal(st(f).backup.scheduler, undefined)
    // Đường dẫn bình thường (dấu cách, tiếng Việt) vẫn cài được
    const made = []
    const ok = makeRun((cmd, args, o) => (cmd === 'crontab' ? (args[0] === '-l' ? { status: 0, stdout: made.join(''), stderr: '' } : (made.push(o.input), { ...OK })) : undefined))
    assert.equal(schedule({ appDir: f.appDir, agreed: true }, deps(f, ok.run, { platform: 'linux', env: { PATH: '/usr/bin:/opt/ứng dụng/bin' } })).exit, 0)
  })

  test('thiếu crontab ⇒ exit 3 + lệnh cài; sau khi cài hỏi lại hệ điều hành không thấy ⇒ exit 1, không ghi scheduler', () => {
    const f = fixture()
    enableD1(f)
    const miss = schedule({ appDir: f.appDir, agreed: true }, deps(f, makeRun((cmd) => (cmd === 'crontab' ? { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : undefined)).run, { platform: 'linux' }))
    assert.equal(miss.exit, EXIT.MISSING)
    assert.match(text(miss), /apt install cron/)
    const ghost = schedule({ appDir: f.appDir, agreed: true }, deps(f, makeRun((cmd, args) => (cmd === 'schtasks' && args[0] === '/Query' ? { status: 1, stdout: '', stderr: '' } : undefined)).run))
    assert.equal(ghost.exit, EXIT.FAIL)
    assert.equal(st(f).backup.scheduler, undefined)
  })

  test('sau khi đã có BACKUP.md do kit sinh, lich chỉ thay mục Lịch', () => {
    const f = fixture()
    backedUpD1(f, { every: 12 })
    assert.equal(restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run)).exit, 0)
    const mdFile = path.join(f.appDir, 'docs', 'BACKUP.md')
    assert.match(fs.readFileSync(mdFile, 'utf8'), /chưa cài lịch tự động/)
    const made = new Set()
    const fake = makeRun((cmd, args) => (cmd === 'schtasks' ? (args[0] === '/Create' ? (made.add(args[2]), { ...OK }) : { status: made.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }) : undefined))
    const r = schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    const md = fs.readFileSync(mdFile, 'utf8')
    assert.match(md, /Windows Task Scheduler "flow-backup-.+", mỗi 12 giờ/)
    assert.ok(md.includes('## Lần thử khôi phục gần nhất'))
    assert.ok(md.includes('2 bảng, 3 dòng'))
  })
})

// ===== không ghi đè trạng thái cũ (lệnh chạy lâu + `release cf` chạy song song) =====

describe('release.json: lệnh chạy lâu chỉ gộp trường của mình, không ghi đè cái người khác vừa ghi', () => {
  // Giả lập `release cf` ghi mốc phát hành đúng lúc backup đang chạy lệnh ngoài.
  const RELEASED = { at: '2026-10-13T09:00:00.000Z', version: 'v2', commit: 'abc1234', smoke: 'pass' }
  const CHECK_AT = ['2026-10-14T09:00:00.000Z', '2026-10-20T09:00:00.000Z']
  const releaseWrites = (f) => writeState(f.appDir, { ...st(f), platform: 'cloudflare-workers', lastRelease: RELEASED, checkAt: CHECK_AT, rollbackTested: true, logs: { source: 'workers-observability', retentionDays: 3 } }, { logDir: f.logDir })
  // chạy `during` đúng một lần, ở lần lệnh ngoài đầu tiên khớp `when`
  const once = (when, during) => { let done = false; return (cmd, args) => { if (!done && when(cmd, args)) { done = true; during(); } return undefined } }
  const keptRelease = (f) => {
    const s = st(f)
    assert.deepEqual(s.lastRelease, RELEASED)
    assert.deepEqual(s.checkAt, CHECK_AT)
    assert.equal(s.rollbackTested, true)
    assert.deepEqual(s.logs, { source: 'workers-observability', retentionDays: 3 })
    assert.equal(s.platform, 'cloudflare-workers')
  }

  test('chay (D1): release ghi trong lúc export ⇒ sau khi sao lưu xong lastRelease/checkAt/logs còn nguyên, lastBackup đã ghi', () => {
    const f = fixture()
    enableD1(f)
    const fake = makeRun(once((cmd, args) => args.includes('export'), () => releaseWrites(f)), d1())
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    keptRelease(f)
    assert.equal(st(f).backup.lastBackup, NOW.toISOString())
    assert.equal(st(f).backup.choice, 'on')
  })

  test('chay (Postgres): release ghi trong lúc pg_dump ⇒ không mất mốc phát hành', () => {
    const f = fixture()
    enablePg(f)
    const fake = makeRun(once((cmd) => cmd === 'pg_dump', () => releaseWrites(f)), pg())
    const r = runBackup({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    keptRelease(f)
    assert.equal(st(f).backup.lastBackup, NOW.toISOString())
  })

  test('khoi-phuc-thu: release ghi trong lúc khôi phục thử ⇒ không mất mốc phát hành; BACKUP.md vẫn sinh ra', () => {
    const f = fixture()
    backedUpD1(f)
    const fake = makeRun(once((cmd, args) => args.includes('--file'), () => releaseWrites(f)), d1())
    const r = restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    keptRelease(f)
    assert.equal(st(f).backup.lastRestoreCheck, NOW.toISOString())
    assert.equal(st(f).backup.lastBackup, NOW.toISOString())
    assert.ok(fs.existsSync(path.join(f.appDir, 'docs', 'BACKUP.md')))
  })

  test('lich: release ghi trong lúc cài lịch ⇒ không mất mốc phát hành; scheduler đã ghi', () => {
    const f = fixture()
    enableD1(f)
    const made = new Set()
    const fake = makeRun(
      once((cmd, args) => cmd === 'schtasks' && args[0] === '/Create', () => releaseWrites(f)),
      (cmd, args) => (cmd === 'schtasks' ? (args[0] === '/Create' ? (made.add(args[2]), { ...OK }) : { status: made.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }) : undefined),
    )
    const r = schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    keptRelease(f)
    assert.deepEqual(st(f).backup.scheduler, { kind: 'schtasks', id: scheduleId(f.appDir) })
  })

  test('release.json đang hỏng ⇒ chon/chay/khoi-phuc-thu/lich KHÔNG ghi đè file (exit 1, nói rõ file hỏng)', () => {
    const f = fixture()
    enableD1(f)
    const file = path.join(f.appDir, '.claude', 'release.json')
    fs.writeFileSync(file, '{ hỏng')
    const r = choose({ appDir: f.appDir, mode: 'off', agreed: true }, deps(f, makeRun().run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /release\.json.*hỏng/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{ hỏng')
  })
})

describe('trang-thai và nối với release-state', () => {
  const sched = (f, exists) => makeRun((cmd, args) => (cmd === 'schtasks' && args[0] === '/Query' ? { status: exists ? 0 : 1, stdout: '', stderr: '' } : undefined))

  test('chưa chọn / tắt ⇒ exit 0 (không áp dụng)', () => {
    const f = fixture()
    assert.match(text(status({ appDir: f.appDir }, deps(f, makeRun().run))), /chưa hỏi/)
    writeState(f.appDir, { backup: { choice: 'off' } }, { logDir: f.logDir })
    const r = status({ appDir: f.appDir }, deps(f, makeRun().run))
    assert.equal(r.exit, 0)
    assert.match(text(r), /TẮT/)
  })

  test('đủ bốn điều kiện (lịch có thật, bản mới, đã thử khôi phục) ⇒ ĐẠT; backupReady của release-state cũng đạt', () => {
    const f = fixture()
    backedUpD1(f, { every: 6 })
    assert.equal(restoreCheck({ appDir: f.appDir, agreed: true }, deps(f, makeRun(d1()).run)).exit, 0)
    assert.equal(backupReady(st(f), NOW).ready, false, 'chưa có lịch ⇒ preflight phải chặn')
    assert.deepEqual(backupReady(st(f), NOW).reasons.map((x) => x.code), ['no-scheduler'])
    const made = new Set()
    const fake = makeRun((cmd, args) => (cmd === 'schtasks' ? (args[0] === '/Create' ? (made.add(args[2]), { ...OK }) : { status: made.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }) : undefined))
    assert.equal(schedule({ appDir: f.appDir, agreed: true }, deps(f, fake.run)).exit, 0)
    assert.equal(backupReady(st(f), NOW).ready, true)
    const r = status({ appDir: f.appDir }, deps(f, fake.run))
    assert.equal(r.exit, 0, text(r))
    assert.match(text(r), /Kết luận: ĐẠT/)
    assert.match(text(r), /Lịch trên máy: có/)
  })

  test('lịch ghi trong file nhưng KHÔNG có thật trên máy này (vd file chép sang máy khác) ⇒ CHƯA ĐẠT', () => {
    const f = fixture()
    backedUpD1(f, { every: 6 })
    writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, scheduler: { kind: 'schtasks', id: 'flow-backup-ma' }, lastRestoreCheck: NOW.toISOString() } }, { logDir: f.logDir })
    const r = status({ appDir: f.appDir }, deps(f, sched(f, false).run))
    assert.equal(r.exit, EXIT.FAIL)
    assert.match(text(r), /KHÔNG thấy "flow-backup-ma"/)
    assert.match(text(r), /chưa cài lịch sao lưu tự động/)
  })

  test('bản gần nhất quá 2 × chu kỳ ⇒ CHƯA ĐẠT (quá cũ); chưa khôi phục thử ⇒ CHƯA ĐẠT', () => {
    const f = fixture()
    backedUpD1(f, { every: 6 })
    writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, scheduler: { kind: 'schtasks', id: 'x' }, lastRestoreCheck: NOW.toISOString() } }, { logDir: f.logDir })
    const later = new Date(NOW.getTime() + 13 * 3600 * 1000)
    const stale = status({ appDir: f.appDir }, deps(f, sched(f, true).run, { now: later }))
    assert.equal(stale.exit, EXIT.FAIL)
    assert.match(text(stale), /quá cũ/)
    assert.match(text(stale), /13 giờ trước/)
    writeState(f.appDir, { ...st(f), backup: { ...st(f).backup, lastRestoreCheck: undefined } }, { logDir: f.logDir })
    const none = status({ appDir: f.appDir }, deps(f, sched(f, true).run))
    assert.equal(none.exit, EXIT.FAIL)
    assert.match(text(none), /chưa khôi phục thử/)
  })

  test('trang-thai chỉ đọc: không ghi file nào', () => {
    const f = fixture()
    enableD1(f)
    const before = fs.readFileSync(path.join(f.appDir, '.claude', 'release.json'), 'utf8')
    status({ appDir: f.appDir }, deps(f, sched(f, true).run))
    assert.equal(fs.readFileSync(path.join(f.appDir, '.claude', 'release.json'), 'utf8'), before)
    assert.equal(fs.existsSync(path.join(f.appDir, 'docs')), false)
  })
})

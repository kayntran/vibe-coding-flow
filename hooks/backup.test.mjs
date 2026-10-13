// Test cho backup.mjs (CLI): node --test hooks/backup.test.mjs
// Lệnh ngoài (wrangler, schtasks…) đi qua `run` giả; không cài lịch thật, không gọi mạng. Riêng vài bài chạy CLI thật bằng node nhưng chỉ ở các nhánh
// dừng trước khi chạm lệnh ngoài (thiếu --dong-y, dùng sai) nên vẫn không có tác dụng phụ.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, main, parseArgs } from './backup.mjs'
import { readState } from './lib/release-state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'backup.mjs')
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

const NOW = new Date(2026, 9, 13, 10, 15, 30)
const OK = { status: 0, stdout: '', stderr: '' }
const SQL = 'CREATE TABLE users (id INTEGER);\nINSERT INTO "users" VALUES(1);\nINSERT INTO "users" VALUES(2);\n'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup cli thử '))
  tmpDirs.push(root)
  const repo = path.join(root, 'kho mã')
  const appDir = path.join(repo, 'ứng dụng')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(appDir)
  fs.writeFileSync(path.join(appDir, 'wrangler.toml'), 'database_name = "du-lieu"\n')
  const f = { root, appDir, home: path.join(root, 'nhà'), dest: path.join(root, 'kho sao lưu'), logDir: path.join(root, 'logs'), tmp: path.join(root, 'tmp') }
  fs.mkdirSync(f.home)
  fs.mkdirSync(f.tmp)
  return f
}
function stream() {
  const s = { buf: '', write(x) { s.buf += x } }
  return s
}
function makeRun(...handlers) {
  const calls = []
  const run = (cmd, args, o = {}) => {
    calls.push({ cmd, args })
    for (const h of handlers) { const r = h(cmd, args, o); if (r) return r }
    return { ...OK }
  }
  return { run, calls }
}
// d1 giả: export ghi file .sql; execute --local trả bảng users 2 dòng
const fakeD1 = (cmd, args) => {
  if (!args.includes('d1')) return undefined
  if (args.includes('export')) { fs.writeFileSync(args[args.indexOf('--output') + 1], SQL); return { ...OK } }
  if (args.includes('--file')) return { ...OK }
  const q = args[args.indexOf('--command') + 1]
  const rows = q.includes('sqlite_master') ? [{ name: 'users' }] : /count\(\*\) AS n/.test(q) ? [{ i: 0, n: 2 }] : [{ id: 1 }]
  return { status: 0, stdout: JSON.stringify([{ results: rows, success: true }]), stderr: '' }
}
function cli(f, argv, run, over = {}) {
  const out = stream()
  const err = stream()
  const code = main(argv, { stdout: out, stderr: err, run, now: NOW, platform: 'win32', env: { PATH: '' }, home: f.home, nodePath: 'node', pid: 7, logDir: f.logDir, tmpRoot: f.tmp, script: SCRIPT, ...over })
  return { code, out: out.buf, err: err.buf }
}

describe('parseArgs', () => {
  const dir = path.join(os.tmpdir(), 'Ứng dụng thử')

  test('chon on: đủ cờ, cả dạng --cờ=giá-trị', () => {
    const o = parseArgs(['chon', 'on', dir, '--method', 'pg', '--dest=~/kho', '--every', '6', '--url-env', 'DB_URL', '--schemas', 'public, auth', '--co-storage', '--dong-y'])
    assert.equal(o.cmd, 'chon')
    assert.equal(o.mode, 'on')
    assert.equal(o.appDir, path.resolve(dir))
    assert.equal(o.method, 'pg')
    assert.equal(o.dest, '~/kho')
    assert.equal(o.every, 6)
    assert.equal(o.urlEnv, 'DB_URL')
    assert.deepEqual(o.schemas, ['public', 'auth'])
    assert.equal(o.storage, true)
    assert.equal(o.agreed, true)
    assert.equal(parseArgs(['chon', 'off', dir]).mode, 'off')
    assert.equal(parseArgs(['chon', 'on', dir, '--method=d1', '--db=x']).db, 'x')
  })

  test('--supabase-free ngầm hiểu method pg; không có --dong-y thì agreed=false', () => {
    const o = parseArgs(['chon', 'on', dir, '--supabase-free'])
    assert.equal(o.supabaseFree, true)
    assert.equal(o.method, 'pg')
    assert.equal(o.agreed, false)
  })

  test('các lệnh còn lại nhận đúng một thư mục; cờ có thể đứng trước', () => {
    for (const c of ['chay', 'khoi-phuc-thu', 'lich', 'trang-thai']) assert.equal(parseArgs(['--dong-y', c, dir]).cmd, c)
    assert.equal(parseArgs(['-h']).help, true)
  })

  test('dùng sai ⇒ UsageError', () => {
    const bad = [
      [], ['bay', dir], ['chay'], ['chay', dir, 'thừa'], ['chon', dir], ['chon', 'maybe', dir], ['chay', dir, '--khong-co'],
      ['chon', 'on', dir, '--method', 'mysql'], ['chon', 'on', dir, '--every', 'abc'], ['chon', 'on', dir, '--every'], ['chon', 'on', dir, '--dest', '--dong-y'],
    ]
    for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv))
  })
})

describe('main', () => {
  test('dùng sai ⇒ exit 1 + cách dùng ở stderr, không chạy lệnh ngoài', () => {
    const f = fixture()
    const fake = makeRun()
    const r = cli(f, ['chay'], fake.run)
    assert.equal(r.code, 1)
    assert.match(r.err, /thiếu thư mục app/)
    assert.match(r.err, /dùng: backup\.mjs/)
    assert.equal(fake.calls.length, 0)
    const gone = cli(f, ['chay', path.join(f.root, 'không có')], fake.run)
    assert.equal(gone.code, 1)
    assert.match(gone.err, /không thấy thư mục app/)
    assert.equal(cli(f, ['--help'], fake.run).code, 0)
  })

  test('mọi lệnh ghi/chạy thiếu --dong-y ⇒ exit 4 + câu hỏi, không ghi gì, không chạy lệnh ngoài', () => {
    const f = fixture()
    const fake = makeRun(fakeD1)
    const enable = cli(f, ['chon', 'on', f.appDir, '--method', 'd1', '--dest', f.dest, '--dong-y'], fake.run)
    assert.equal(enable.code, 0, enable.out)
    const before = fs.readFileSync(path.join(f.appDir, '.claude', 'release.json'), 'utf8')
    for (const argv of [['chay', f.appDir], ['khoi-phuc-thu', f.appDir], ['lich', f.appDir], ['chon', 'off', f.appDir], ['chon', 'on', f.appDir, '--method', 'd1', '--every', '3'], ['chon', 'on', f.appDir, '--supabase-free']]) {
      const r = cli(f, argv, fake.run)
      assert.equal(r.code, 4, argv.join(' '))
      assert.match(r.out, /Cần hỏi người dùng trước/)
      assert.match(r.out, /thêm --dong-y/)
    }
    assert.equal(fake.calls.length, 0)
    assert.equal(fs.readFileSync(path.join(f.appDir, '.claude', 'release.json'), 'utf8'), before)
    assert.equal(fs.existsSync(f.dest), false)
  })

  test('đích nằm trong repo ⇒ exit 1 và nói rõ', () => {
    const f = fixture()
    const r = cli(f, ['chon', 'on', f.appDir, '--method', 'd1', '--dest', path.join(f.appDir, 'bk'), '--dong-y'], makeRun().run)
    assert.equal(r.code, 1)
    assert.match(r.out, /nằm trong thư mục dự án/)
    assert.equal(readState(f.appDir, { logDir: f.logDir }), null)
  })

  test('trọn luồng D1: chon → chay → khoi-phuc-thu → lich → trang-thai ĐẠT (lệnh ngoài giả)', () => {
    const f = fixture()
    const made = new Set()
    const sched = (cmd, args) => {
      if (cmd !== 'schtasks') return undefined
      if (args[0] === '/Create') { made.add(args[2]); return { ...OK } }
      return { status: made.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }
    }
    const fake = makeRun(fakeD1, sched)
    const step = (argv) => cli(f, argv, fake.run)
    assert.equal(step(['trang-thai', f.appDir]).code, 0)
    assert.match(step(['trang-thai', f.appDir]).out, /chưa hỏi/)
    assert.equal(step(['chon', 'on', f.appDir, '--method', 'd1', '--dest', f.dest, '--every', '12', '--dong-y']).code, 0)
    const notYet = step(['trang-thai', f.appDir])
    assert.equal(notYet.code, 1)
    assert.match(notYet.out, /CHƯA ĐẠT/)
    const chay = step(['chay', f.appDir, '--dong-y'])
    assert.equal(chay.code, 0, chay.out)
    assert.match(chay.out, /1 bảng, 2 dòng/)
    const kp = step(['khoi-phuc-thu', f.appDir, '--dong-y'])
    assert.equal(kp.code, 0, kp.out)
    assert.match(kp.out, /ĐẠT: 1 bảng, 2 dòng khớp/)
    assert.ok(fs.existsSync(path.join(f.appDir, 'docs', 'BACKUP.md')))
    const lich = step(['lich', f.appDir, '--dong-y'])
    assert.equal(lich.code, 0, lich.out)
    const end = step(['trang-thai', f.appDir])
    assert.equal(end.code, 0, end.out)
    assert.match(end.out, /Kết luận: ĐẠT/)
    const off = step(['chon', 'off', f.appDir, '--dong-y'])
    assert.equal(off.code, 0)
    assert.equal(made.size, 1)
    assert.ok(fake.calls.some((c) => c.cmd === 'schtasks' && c.args[0] === '/Delete'))
    assert.match(step(['trang-thai', f.appDir]).out, /TẮT/)
  })

  test('Supabase miễn phí qua CLI: exit 0, lời khuyên có phí; sau đó chay bị chặn exit 1', () => {
    const f = fixture()
    const fake = makeRun()
    const r = cli(f, ['chon', 'on', f.appDir, '--supabase-free', '--dong-y'], fake.run)
    assert.equal(r.code, 0)
    assert.match(r.out, /nâng gói Pro/)
    assert.match(r.out, /25 USD\/tháng/)
    const x = cli(f, ['chay', f.appDir, '--dong-y'], fake.run)
    assert.equal(x.code, 1)
    assert.equal(fake.calls.length, 0)
  })

  test('BUG-6 qua CLI: bật D1 rồi chuyển sang Supabase miễn phí ⇒ release.json không còn method/db/dest/everyHours của D1, trang-thai nói đúng', () => {
    const f = fixture()
    const fake = makeRun(fakeD1)
    assert.equal(cli(f, ['chon', 'on', f.appDir, '--method', 'd1', '--dest', f.dest, '--every', '12', '--dong-y'], fake.run).code, 0)
    assert.equal(cli(f, ['chay', f.appDir, '--dong-y'], fake.run).code, 0)
    assert.equal(cli(f, ['chon', 'on', f.appDir, '--supabase-free', '--dong-y'], fake.run).code, 0)
    const b = readState(f.appDir, { logDir: f.logDir }).backup
    assert.equal(b.choice, 'advise-pro')
    for (const k of ['method', 'db', 'dest', 'everyHours', 'scheduler', 'timeTravelDays']) assert.equal(k in b, false, k)
    assert.equal(typeof b.lastBackup, 'string', 'lịch sử bản sao vẫn giữ')
    const s = cli(f, ['trang-thai', f.appDir], fake.run)
    assert.equal(s.code, 0)
    assert.match(s.out, /nâng Pro/)
  })

  test('lỗi nội bộ (lệnh ngoài ném lỗi) ⇒ exit 1 một dòng, ghi vào log, không văng stack ra màn hình', () => {
    const f = fixture()
    assert.equal(cli(f, ['chon', 'on', f.appDir, '--method', 'd1', '--dest', f.dest, '--dong-y'], makeRun().run).code, 0)
    const boom = () => { throw new Error('hỏng bất ngờ') }
    const r = cli(f, ['chay', f.appDir, '--dong-y'], boom)
    assert.equal(r.code, 1)
    assert.match(r.out, /Lỗi nội bộ của backup: hỏng bất ngờ/)
    assert.equal(r.out.includes(' at '), false)
    assert.match(fs.readFileSync(path.join(f.logDir, 'backup.log'), 'utf8'), /lỗi nội bộ: .*hỏng bất ngờ/)
  })
})

describe('chạy CLI thật bằng node (chỉ nhánh dừng trước lệnh ngoài)', () => {
  const node = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true })

  test('chay không --dong-y ⇒ exit 4; chon on thiếu --dong-y ⇒ exit 4 và không tạo release.json', () => {
    const f = fixture()
    const bare = node(['chay', f.appDir])
    assert.equal(bare.status, 1)
    assert.match(bare.stdout, /Chưa bật sao lưu/)
    const r = node(['chon', 'on', f.appDir, '--method', 'd1', '--dest', f.dest])
    assert.equal(r.status, 4, r.stdout + r.stderr)
    assert.match(r.stdout, /Chỗ cất:/)
    assert.equal(fs.existsSync(path.join(f.appDir, '.claude', 'release.json')), false)
    assert.equal(fs.existsSync(f.dest), false)
  })

  test('không tham số ⇒ exit 1 + cách dùng; --help ⇒ exit 0', () => {
    const none = node([])
    assert.equal(none.status, 1)
    assert.match(none.stderr, /thiếu lệnh/)
    const help = node(['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /trang-thai/)
  })
})

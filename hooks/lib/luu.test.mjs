// Test cho lib/luu.mjs: node --test ~/.claude/hooks/lib/luu.test.mjs
// Dùng repo git tạm (đường dẫn có dấu cách + tiếng Việt), không mạng, không đụng cấu hình git của máy (GIT_CONFIG_GLOBAL trỏ file rỗng).
// Khoá giả được GHÉP chuỗi lúc chạy để file test này không tự bị máy quét khoá bắt.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lu from './luu.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luu thử đường dẫn ')))
const CFG = path.join(TMP, 'gitconfig')
const SAVED = { ...process.env }
before(() => {
  fs.writeFileSync(CFG, '')
  for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: CFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.t',
    // Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
  })
})
after(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]
  Object.assign(process.env, SAVED)
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const FAKE_KEY = ['gh', 'p_', 'Ab1Cd2Ef3G'.repeat(4)].join('')
let seq = 0
const mk = (name = 'dự án thử') => { const d = path.join(TMP, `${name} ${++seq}`); fs.mkdirSync(d, { recursive: true }); return d }
const wr = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
const rd = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const has = (root, rel) => fs.existsSync(path.join(root, rel))
function g(root, ...args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', env: process.env })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const gStatus = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: process.env }).status
const commit = (root, msg) => { g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', msg); return g(root, 'rev-parse', 'HEAD') }
const at = (min, hour = 10) => new Date(2026, 9, 12, hour, min)
const tagsOf = (root) => g(root, 'tag', '-l', 'luu/*').split('\n').filter(Boolean)
const caught = (fn) => { try { fn() } catch (e) { return e } return assert.fail('đáng lẽ phải ném LuuError') }
const noCheck = { runCheck: null }
const cliLuu = (...args) => spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'luu.mjs'), ...args], { encoding: 'utf8', env: process.env })
function snapshot(root) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(root, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

// Ba điểm lưu: p1 "Bắt đầu" → p2 "Thêm trang đăng nhập" (sửa/thêm/xoá file) → p3 "Thêm giỏ hàng" (đổi tên + thêm, hai commit).
// Dựng một lần rồi chép ra thư mục mới cho mỗi test (git chậm trên Windows).
let base = null
function scenario() {
  if (!base) {
    const root = mk('gốc')
    wr(root, 'README.md', 'v1\n'); wr(root, 'src/a.txt', 'a1\n'); wr(root, 'old.txt', 'old\n'); wr(root, 'notes/keep.txt', 'k\n')
    const p1 = lu.bat(root, { now: at(0) })
    wr(root, 'src/a.txt', 'a2\n'); wr(root, 'b.txt', 'b\n'); fs.rmSync(path.join(root, 'old.txt'))
    commit(root, 'Thêm trang đăng nhập')
    const p2 = lu.tao(root, 'Thêm trang đăng nhập', { now: at(10) })
    const snap2 = snapshot(root)
    g(root, 'mv', 'src/a.txt', 'src/renamed.txt'); wr(root, 'c.txt', 'c\n')
    commit(root, 'Thêm giỏ hàng')
    wr(root, 'd.txt', 'd\n')
    commit(root, 'Sửa nút thanh toán')
    const p3 = lu.tao(root, 'Thêm giỏ hàng', { now: at(20) })
    base = { root, p1, p2, p3, snap2, snap3: snapshot(root) }
  }
  const root = mk()
  fs.cpSync(base.root, root, { recursive: true })
  return { ...base, root }
}

describe('bat', () => {
  test('thư mục chưa có git ⇒ git init (nhánh main) + .gitignore + commit đầu + điểm "Bắt đầu"; .env không bị lưu', () => {
    const root = mk()
    wr(root, 'index.js', 'console.log(1)\n'); wr(root, '.env', 'SECRET_NOTE=1\n'); wr(root, '.env.example', 'SECRET_NOTE=\n'); wr(root, 'node_modules/x/y.js', 'x\n')
    wr(root, 'app.db', 'db'); wr(root, 'data/x.json', '{}')
    const r = lu.bat(root, { now: at(5) })
    assert.equal(r.created, true)
    assert.equal(r.initialized, true)
    assert.equal(r.tag, 'luu/20261012-1005-bat-dau')
    assert.equal(g(root, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.equal(g(root, 'log', '-1', '--format=%s'), 'Bắt đầu')
    assert.equal(g(root, 'cat-file', '-t', r.tag), 'tag')
    assert.equal(g(root, 'tag', '-l', r.tag, '--format=%(contents:subject)'), 'Bắt đầu')
    const files = g(root, 'ls-files').split('\n')
    assert.deepEqual(files.sort(), ['.env.example', '.gitignore', 'index.js'])
    const ignore = rd(root, '.gitignore').split('\n')
    for (const line of ['node_modules/', 'dist/', 'build/', '.env', '.env.*', '!.env.example', '*.db', '*.sqlite', '*.sqlite3', '*.db-wal', '*.db-shm', '/data/', '/uploads/', '/storage/']) {
      assert.ok(ignore.includes(line), `.gitignore thiếu ${line}`)
    }
    assert.ok(ignore.indexOf('!.env.example') > ignore.indexOf('.env.*'), '!.env.example phải đứng sau .env.*')
  })

  test('đã có git và có commit ⇒ không làm gì', () => {
    const { root } = scenario()
    const head = g(root, 'rev-parse', 'HEAD')
    const ignoreBefore = rd(root, '.gitignore')
    const r = lu.bat(root, { now: at(30) })
    assert.deepEqual({ created: r.created, initialized: r.initialized, nested: r.nested }, { created: false, initialized: false, nested: false })
    assert.equal(g(root, 'rev-parse', 'HEAD'), head)
    assert.equal(rd(root, '.gitignore'), ignoreBefore)
    assert.equal(tagsOf(root).length, 3)
  })

  test('repo mới git init chưa có commit nào ⇒ vẫn lập commit đầu + điểm lưu', () => {
    const root = mk()
    g(root, 'init', '-q'); wr(root, 'a.txt', 'a\n')
    const r = lu.bat(root, { now: at(1) })
    assert.equal(r.created, true)
    assert.equal(r.initialized, false)
    assert.ok(g(root, 'rev-parse', 'HEAD'))
    assert.deepEqual(tagsOf(root), [r.tag])
  })

  test('repo git init chưa có commit mà dữ liệu (app.db, data/, .claude/luu.json) đang stage ⇒ commit đầu KHÔNG chứa dữ liệu, dữ liệu vẫn đang stage nguyên nội dung như quay', () => {
    const root = mk()
    g(root, 'init', '-q'); wr(root, 'a.txt', 'a\n'); wr(root, '.claude/luu.json', JSON.stringify({ data: ['exports/**'] }))
    wr(root, 'app.db', 'db-v1'); wr(root, 'data/x.json', '{"v":1}'); wr(root, 'exports/r.csv', 'r1')
    g(root, 'add', '-f', 'a.txt', 'app.db', 'data/x.json', 'exports/r.csv')
    wr(root, 'app.db', 'db-v2') // working tree khác bản đã stage
    const staged = g(root, 'diff', '--cached', '--name-only').split('\n').sort()
    assert.deepEqual(staged, ['a.txt', 'app.db', 'data/x.json', 'exports/r.csv'])
    const blob = g(root, 'rev-parse', ':app.db')
    const r = lu.bat(root, { now: at(1) })
    assert.equal(r.created, true)
    assert.deepEqual(g(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), ['.claude/luu.json', '.gitignore', 'a.txt'], 'commit đầu chỉ có code')
    assert.deepEqual(g(root, 'diff', '--cached', '--name-only').split('\n').sort(), ['app.db', 'data/x.json', 'exports/r.csv'], 'dữ liệu vẫn đang stage')
    assert.equal(g(root, 'rev-parse', ':app.db'), blob, 'bản đã stage giữ nguyên')
    assert.equal(rd(root, 'app.db'), 'db-v2')
    assert.equal(rd(root, 'data/x.json'), '{"v":1}')
    assert.deepEqual(tagsOf(root), [r.tag])
  })

  test('commit đầu bị từ chối vì có khoá ⇒ dữ liệu đang stage cũng được trả về như cũ (không mất stage)', () => {
    const root = mk()
    g(root, 'init', '-q'); wr(root, 'src/config.js', `export const token = '${FAKE_KEY}'\n`); wr(root, 'app.db', 'db')
    g(root, 'add', '-f', 'app.db')
    caught(() => lu.bat(root, { now: at(1) }))
    assert.equal(g(root, 'diff', '--cached', '--name-only'), 'app.db')
    assert.equal(gStatus(root, 'rev-parse', '--verify', '--quiet', 'HEAD'), 1)
  })

  test('thư mục rỗng ⇒ commit đầu rỗng vẫn có điểm lưu', () => {
    const root = mk()
    const r = lu.bat(root, { now: at(2) })
    assert.equal(g(root, 'ls-files'), '.gitignore')
    assert.equal(r.tag, 'luu/20261012-1002-bat-dau')
  })

  test('dự án Wails (có wails.json) ⇒ bỏ build/bin/ chứ không bỏ cả build/ (icon, manifest được lưu)', () => {
    const root = mk()
    wr(root, 'wails.json', '{}'); wr(root, 'build/appicon.png', 'png'); wr(root, 'build/bin/app.exe', 'exe')
    lu.bat(root, { now: at(3) })
    const ignore = rd(root, '.gitignore').split('\n')
    assert.ok(ignore.includes('build/bin/'))
    assert.ok(!ignore.includes('build/'))
    const files = g(root, 'ls-files').split('\n')
    assert.ok(files.includes('build/appicon.png'))
    assert.ok(!files.includes('build/bin/app.exe'))
  })

  test('.gitignore có sẵn ⇒ nối thêm dòng còn thiếu, giữ dòng cũ, không lặp', () => {
    const root = mk()
    wr(root, '.gitignore', 'node_modules\n*.log\n.env')
    wr(root, 'a.txt', 'a\n')
    lu.bat(root, { now: at(1) })
    const lines = rd(root, '.gitignore').split('\n')
    assert.deepEqual(lines.slice(0, 3), ['node_modules', '*.log', '.env'])
    assert.equal(lines.filter((l) => l === 'node_modules' || l === 'node_modules/').length, 1)
    assert.equal(lines.filter((l) => l === '.env').length, 1)
    assert.ok(lines.includes('dist/') && lines.includes('!.env.example') && lines.includes('*.db') && lines.includes('/data/'))
  })

  test('.claude/luu.json thêm mẫu dữ liệu ⇒ vào .gitignore và không bị commit', () => {
    const root = mk()
    wr(root, '.claude/luu.json', JSON.stringify({ data: ['exports/**', '*.csv'] }))
    wr(root, 'exports/r.txt', 'x'); wr(root, 'sub/t.csv', 'a,b'); wr(root, 'code.js', 'x')
    lu.bat(root, { now: at(1) })
    const ignore = rd(root, '.gitignore').split('\n')
    assert.ok(ignore.includes('/exports/') && ignore.includes('*.csv'))
    assert.deepEqual(g(root, 'ls-files').split('\n').sort(), ['.claude/luu.json', '.gitignore', 'code.js'])
  })

  test('thư mục con của dự án git khác ⇒ nested, không tạo git lồng', () => {
    const { root } = scenario()
    const sub = path.join(root, 'notes')
    const r = lu.bat(sub, { now: at(1) })
    assert.equal(r.nested, true)
    assert.equal(r.created, false)
    assert.equal(has(sub, '.git'), false)
  })

  test('có khoá bí mật trong file ⇒ từ chối (exit 1), nêu file, không in khoá, không có commit; gỡ khoá rồi chạy lại được', () => {
    const root = mk()
    wr(root, 'ok.txt', 'ok\n'); wr(root, 'src/config.js', `export const token = '${FAKE_KEY}'\n`)
    const e = caught(() => lu.bat(root, { now: at(1) }))
    assert.equal(e.exit, 1)
    assert.match(e.message, /src\/config\.js:1/)
    assert.doesNotMatch(e.message, /ghp_/)
    assert.equal(e.message.includes(FAKE_KEY), false)
    assert.equal(gStatus(root, 'rev-parse', '--verify', '--quiet', 'HEAD'), 1)
    assert.equal(g(root, 'diff', '--cached', '--name-only'), '', 'chỉ mục phải về như cũ')
    fs.rmSync(path.join(root, 'src', 'config.js'))
    const r = lu.bat(root, { now: at(2) })
    assert.equal(r.created, true)
  })

  test('thư mục không tồn tại ⇒ lỗi đời thường', () => {
    const e = caught(() => lu.bat(path.join(TMP, 'khong-co-thu-muc')))
    assert.match(e.message, /Không thấy thư mục/)
  })
})

describe('tao', () => {
  test('tag có chú thích luu/<YYYYMMDD-HHmm>-<slug> trên HEAD, message = tên', () => {
    const root = mk()
    wr(root, 'a.txt', 'a'); lu.bat(root, { now: at(0) })
    wr(root, 'a.txt', 'b'); commit(root, 'đổi a')
    const r = lu.tao(root, 'Thêm  trang\tđăng nhập', { now: at(7, 9) })
    assert.equal(r.created, true)
    assert.equal(r.tag, 'luu/20261012-0907-them-trang-dang-nhap')
    assert.equal(r.name, 'Thêm trang đăng nhập')
    assert.equal(g(root, 'cat-file', '-t', r.tag), 'tag')
    assert.equal(g(root, 'rev-parse', `${r.tag}^{commit}`), g(root, 'rev-parse', 'HEAD'))
    assert.equal(g(root, 'tag', '-l', r.tag, '--format=%(contents:subject)'), 'Thêm trang đăng nhập')
  })

  test('HEAD đã có điểm lưu ⇒ không tạo trùng, trả tag cũ', () => {
    const { root, p3 } = scenario()
    const r = lu.tao(root, 'Tên khác hẳn', { now: at(40) })
    assert.equal(r.created, false)
    assert.equal(r.tag, p3.tag)
    assert.equal(r.name, 'Thêm giỏ hàng')
    assert.equal(tagsOf(root).length, 3)
  })

  describe('còn thay đổi chưa commit', () => {
    test('HEAD đã có điểm mà đĩa có sửa + file mới + file xoá ⇒ lưu thành commit mới rồi gắn điểm (không báo "đã là điểm lưu")', () => {
      const { root, p3 } = scenario()
      wr(root, 'README.md', 'v2 dở\n'); wr(root, 'moi.txt', 'mới\n'); fs.rmSync(path.join(root, 'notes/keep.txt'))
      const head = g(root, 'rev-parse', 'HEAD')
      const r = lu.tao(root, 'Giữa chừng', { now: at(40) })
      assert.equal(r.created, true)
      assert.notEqual(r.tag, p3.tag)
      assert.equal(r.name, 'Giữa chừng')
      assert.deepEqual([...r.files].sort(), ['README.md', 'moi.txt', 'notes/keep.txt'])
      assert.equal(g(root, 'rev-parse', `${r.tag}^{commit}`), g(root, 'rev-parse', 'HEAD'))
      assert.equal(g(root, 'rev-parse', 'HEAD~1'), head, 'commit mới nối ngay sau HEAD cũ')
      assert.equal(g(root, 'log', '-1', '--format=%s'), 'Giữa chừng')
      assert.equal(g(root, 'show', `${r.tag}:README.md`), 'v2 dở')
      assert.equal(g(root, 'show', `${r.tag}:moi.txt`), 'mới')
      assert.equal(gStatus(root, 'cat-file', '-e', `${r.tag}:notes/keep.txt`) === 0, false, 'file đã xoá không còn trong điểm lưu')
      assert.equal(g(root, 'status', '--porcelain'), '', 'sau khi lưu không còn gì dở')
      assert.equal(rd(root, 'README.md'), 'v2 dở\n', 'file trên đĩa giữ nguyên')
      assert.equal(tagsOf(root).length, 4)
    })

    test('HEAD chưa có điểm + còn thay đổi ⇒ điểm nằm trên commit mới chứa thay đổi', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); lu.bat(root, { now: at(0) })
      wr(root, 'a.txt', '2'); commit(root, 'đổi a')
      wr(root, 'a.txt', '3'); wr(root, 'b.txt', 'b')
      const r = lu.tao(root, 'Đang dở', { now: at(5) })
      assert.equal(r.created, true)
      assert.equal(g(root, 'show', `${r.tag}:a.txt`), '3')
      assert.equal(g(root, 'show', `${r.tag}:b.txt`), 'b')
      assert.equal(g(root, 'status', '--porcelain'), '')
    })

    test('bản đã stage (git add) mà đĩa trùng bản đã stage ⇒ cũng được lưu', () => {
      const { root } = scenario()
      wr(root, 'README.md', 'đã stage\n'); g(root, 'add', 'README.md')
      const r = lu.tao(root, 'Đã add', { now: at(41) })
      assert.equal(r.created, true)
      assert.equal(g(root, 'show', `${r.tag}:README.md`), 'đã stage')
    })

    test('chỉ có dữ liệu / file bị .gitignore thay đổi ⇒ không tính là thay đổi (trả điểm cũ); code đổi cùng lúc ⇒ commit chỉ chứa code', () => {
      const { root, p3 } = scenario()
      wr(root, 'app.db', 'db'); wr(root, 'data/x.json', '{}'); wr(root, 'node_modules/m/i.js', 'x')
      const same = lu.tao(root, 'Chỉ dữ liệu', { now: at(42) })
      assert.equal(same.created, false)
      assert.equal(same.tag, p3.tag)
      wr(root, 'README.md', 'code đổi\n')
      const r = lu.tao(root, 'Code và dữ liệu', { now: at(43) })
      assert.equal(r.created, true)
      assert.deepEqual(r.files, ['README.md'])
      assert.equal(g(root, 'show', '--name-only', '--format=', 'HEAD'), 'README.md')
      assert.equal(rd(root, 'app.db'), 'db')
      assert.equal(rd(root, 'data/x.json'), '{}')
    })

    test('thay đổi có khoá bí mật ⇒ từ chối, không commit, không tạo điểm, chỉ mục như cũ; gỡ khoá rồi chạy lại được', () => {
      const { root } = scenario()
      const head = g(root, 'rev-parse', 'HEAD')
      wr(root, 'src/secret.js', `const k = "${FAKE_KEY}"\n`)
      const e = caught(() => lu.tao(root, 'Có khoá', { now: at(44) }))
      assert.equal(e.exit, 1)
      assert.match(e.message, /src\/secret\.js:1/)
      assert.equal(e.message.includes(FAKE_KEY), false)
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(tagsOf(root).length, 3)
      assert.equal(g(root, 'diff', '--cached', '--name-only'), '')
      fs.rmSync(path.join(root, 'src/secret.js'))
      assert.equal(lu.tao(root, 'Hết khoá', { now: at(45) }).created, false, 'không còn gì dở, HEAD đã là điểm lưu')
    })

    test('đang dở gộp nhánh ⇒ không commit thay đổi, nói rõ lý do', () => {
      const { root } = scenario()
      wr(root, 'README.md', 'dở\n')
      fs.writeFileSync(path.join(g(root, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'), `${g(root, 'rev-parse', 'HEAD')}\n`)
      const e = caught(() => lu.tao(root, 'Giữa gộp', { now: at(46) }))
      assert.match(e.message, /đang dở một lần gộp nhánh/)
      assert.equal(tagsOf(root).length, 3)
    })

    test('CLI: còn thay đổi ⇒ "Đã lưu điểm … gồm N file", không in "đã là điểm lưu"', () => {
      const { root } = scenario()
      wr(root, 'README.md', 'dở\n'); wr(root, 'moi.txt', 'mới\n')
      const r = cliLuu('tao', root, 'Giữa chừng')
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^Đã lưu điểm "Giữa chừng" \(luu\/\S+, commit [0-9a-f]{7}\), gồm 2 file đang sửa dở\./)
      assert.doesNotMatch(r.stdout, /đã là điểm lưu/)
    })
  })

  test('tên trùng (cùng phút, cùng slug) ⇒ hậu tố -2, -3', () => {
    const root = mk()
    wr(root, 'a.txt', '0'); lu.bat(root, { now: at(0) })
    const tags = []
    for (let i = 1; i <= 3; i++) { wr(root, 'a.txt', String(i)); commit(root, `v${i}`); tags.push(lu.tao(root, 'Sửa lỗi', { now: at(15) }).tag) }
    assert.deepEqual(tags, ['luu/20261012-1015-sua-loi', 'luu/20261012-1015-sua-loi-2', 'luu/20261012-1015-sua-loi-3'])
  })

  test('tên dài ⇒ slug ≤ 40 ký tự; tên toàn ký tự lạ ⇒ slug mặc định; ký tự ẩn/điều khiển bị bỏ', () => {
    const root = mk()
    wr(root, 'a.txt', '0'); lu.bat(root, { now: at(0) })
    wr(root, 'a.txt', '1'); commit(root, 'x')
    const long = lu.tao(root, 'Đây là một cái tên rất rất dài để thử xem cách cắt slug có đúng ranh giới từ hay không nhé', { now: at(1) })
    assert.ok(long.tag.replace(/^luu\/\d{8}-\d{4}-/, '').length <= 40, long.tag)
    assert.match(long.tag, /^luu\/20261012-1001-day-la-mot-cai-ten/)
    wr(root, 'a.txt', '2'); commit(root, 'y')
    const odd = lu.tao(root, '★★★\u200b\u202e\x07', { now: at(2) })
    assert.equal(odd.tag, 'luu/20261012-1002-diem-luu')
    assert.equal(odd.name, '★★★')
  })

  test('tên rỗng ⇒ exit 2; không phải git ⇒ lỗi chưa dùng git; chưa có commit ⇒ lỗi', () => {
    const root = mk()
    assert.equal(caught(() => lu.tao(root, '   ')).exit, 2)
    assert.match(caught(() => lu.tao(root, 'x')).message, /chưa dùng git/)
    g(root, 'init', '-q')
    assert.match(caught(() => lu.tao(root, 'x')).message, /chưa có lần lưu nào/)
  })

  test('máy chưa có tên/email git ⇒ vẫn lưu được (danh tính chung "Flow")', () => {
    const cfg2 = path.join(TMP, `useconfigonly-${++seq}`)
    fs.writeFileSync(cfg2, '[user]\n\tuseConfigOnly = true\n')
    const keep = { ...process.env }
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k]
    process.env.GIT_CONFIG_GLOBAL = cfg2
    try {
      const root = mk()
      wr(root, 'a.txt', 'a')
      const r = lu.bat(root, { now: at(0) })
      assert.equal(r.created, true)
      assert.equal(g(root, 'log', '-1', '--format=%an <%ae>'), 'Flow <flow@localhost>')
    } finally {
      Object.assign(process.env, keep)
    }
  })
})

describe('ds', () => {
  test('mới nhất trước, có thời điểm/tên/tag/commit ngắn/số việc kể từ đó; chỉ điểm luu/*', () => {
    const { root, p1, p2, p3 } = scenario()
    g(root, 'tag', 'v1.0', 'HEAD')
    const list = lu.ds(root)
    assert.deepEqual(list.map((p) => p.tag), [p3.tag, p2.tag, p1.tag])
    assert.deepEqual(list.map((p) => p.since), [0, 2, 3])
    assert.deepEqual(list.map((p) => p.name), ['Thêm giỏ hàng', 'Thêm trang đăng nhập', 'Bắt đầu'])
    assert.match(list[0].time, /^\d{4}-\d\d-\d\d \d\d:\d\d$/)
    assert.match(list[0].commit, /^[0-9a-f]{7,}$/)
    assert.equal(JSON.parse(JSON.stringify(list))[1].tag, p2.tag)
  })

  test('chưa có điểm nào ⇒ danh sách rỗng; không phải git ⇒ lỗi', () => {
    const root = mk()
    assert.match(caught(() => lu.ds(root)).message, /chưa dùng git/)
    g(root, 'init', '-q', '-b', 'main'); wr(root, 'a', '1'); commit(root, 'một')
    assert.deepEqual(lu.ds(root), [])
  })

  test('điểm lưu trên nhánh khác chưa gộp không hiện trong danh sách của nhánh chính', () => {
    const { root, p3 } = scenario()
    g(root, 'switch', '-q', '-c', 'feature'); wr(root, 'f.txt', 'f'); commit(root, 'việc nhánh')
    lu.tao(root, 'Việc nhánh', { now: at(50) })
    g(root, 'switch', '-q', 'main')
    assert.equal(lu.ds(root)[0].tag, p3.tag)
    assert.equal(lu.ds(root).length, 3)
  })
})

describe('tim', () => {
  test('không dấu, không hoa thường, xếp hạng theo tên rồi tới tiêu đề commit giữa các điểm', () => {
    const { root, p2, p3 } = scenario()
    assert.equal(lu.tim(root, 'DANG NHAP')[0].tag, p2.tag)
    const gio = lu.tim(root, 'giỏ hàng')
    assert.equal(gio[0].tag, p3.tag)
    const tt = lu.tim(root, 'thanh toán') // chỉ có trong tiêu đề commit nằm giữa p2 và p3
    assert.deepEqual(tt.map((p) => p.tag), [p3.tag])
    assert.deepEqual(tt[0].matched.subjects, ['Sửa nút thanh toán'])
  })

  test('câu dài kiểu "quay về lúc …": bỏ chữ thừa, vẫn ra đúng điểm', () => {
    const { root, p2 } = scenario()
    const r = lu.tim(root, 'quay về lúc thêm trang đăng nhập')
    assert.equal(r[0].tag, p2.tag)
    assert.ok(r[0].score > (r[1]?.score ?? 0))
  })

  test('không khớp ⇒ rỗng; câu rỗng ⇒ rỗng; giới hạn số kết quả', () => {
    const { root } = scenario()
    assert.deepEqual(lu.tim(root, 'xyzzy'), [])
    assert.deepEqual(lu.tim(root, '  '), [])
    assert.equal(lu.tim(root, 'them', { limit: 1 }).length, 1)
  })

  test('tên điểm khớp nguyên văn (không dấu, không hoa thường) luôn đứng đầu: "trước khi sửa lần 2" không bị "sau khi sửa lần 2" (mới hơn, commit trùng chữ) chen lên; "trước"/"sau" phân biệt', () => {
    const root = mk()
    wr(root, 'a.txt', '1'); lu.bat(root, { now: at(0) })
    wr(root, 'a.txt', '2'); commit(root, 'Đổi màu nút')
    const truoc = lu.tao(root, 'Trước khi sửa lần 2', { now: at(10) })
    wr(root, 'a.txt', '3'); commit(root, 'Sửa lần 2: đổi nút')
    const sau = lu.tao(root, 'Sau khi sửa lần 2', { now: at(20) })
    for (const q of ['trước khi sửa lần 2', 'TRUOC KHI SUA LAN 2', '  Trước  khi sửa lần 2 ']) {
      const r = lu.tim(root, q)
      assert.equal(r[0].tag, truoc.tag, q)
      assert.ok(!r[1] || r[0].score > r[1].score, `${q}: nguyên văn phải hơn hẳn (${r.map((p) => p.score)})`)
    }
    assert.equal(lu.tim(root, 'sau khi sửa lần 2')[0].tag, sau.tag)
    assert.equal(lu.tim(root, 'Sau khi sửa lần 2')[0].tag, sau.tag)
  })

  test('khớp cụm từ liên tiếp nặng hơn khớp rời, kể cả khi điểm khớp rời mới hơn và có commit nhắc cùng từ', () => {
    const root = mk()
    wr(root, 'a.txt', '1'); lu.bat(root, { now: at(0) })
    wr(root, 'a.txt', '2'); commit(root, 'Thêm Google')
    const cum = lu.tao(root, 'Đăng nhập Google', { now: at(10) })
    wr(root, 'a.txt', '3'); commit(root, 'Sửa đăng nhập cho gọn')
    const roi = lu.tao(root, 'Nhập liệu đăng ký', { now: at(20) })
    const r = lu.tim(root, 'đăng nhập')
    assert.deepEqual(r.map((p) => p.tag), [cum.tag, roi.tag])
    assert.ok(r[0].score > r[1].score)
  })
})

describe('xem', () => {
  test('liệt kê điểm lưu/việc sau đó, file đổi, việc dở, worktree khác, nhánh chưa gộp', () => {
    const { root, p2, p3 } = scenario()
    wr(root, 'dang-do.txt', 'x'); wr(root, 'README.md', 'sửa dở\n')
    const wt = path.join(TMP, `worktree khác ${++seq}`)
    g(root, 'worktree', 'add', '-q', '-b', 'viec-khac', wt)
    wr(wt, 'w.txt', 'w'); commit(wt, 'việc ở nhánh khác')
    const r = lu.xem(root, p2.tag)
    assert.equal(r.target.name, 'Thêm trang đăng nhập')
    assert.deepEqual(r.after.map((p) => p.tag), [p3.tag])
    assert.equal(r.commitCount, 2)
    assert.deepEqual(r.commits.map((c) => c.subject), ['Sửa nút thanh toán', 'Thêm giỏ hàng'])
    assert.deepEqual(r.dirty.sort(), ['README.md', 'dang-do.txt'])
    assert.deepEqual(r.changes.map((c) => c.file).sort(), ['c.txt', 'd.txt', 'src/a.txt', 'src/renamed.txt'])
    assert.equal(r.worktrees.length, 1)
    assert.equal(fs.realpathSync(r.worktrees[0].path), fs.realpathSync(wt))
    assert.equal(r.worktrees[0].branch, 'viec-khac')
    assert.deepEqual(r.unmerged, ['viec-khac'])
    assert.equal(r.blocker, null)
  })

  test('liệt kê file luật sẽ đổi và dữ liệu giữ nguyên; chạy ở worktree thì có blocker', () => {
    const root = mk()
    wr(root, 'a.txt', '1'); wr(root, 'app.db', 'db1'); wr(root, 'eslint.config.js', 'old\n')
    const p1 = lu.bat(root, { now: at(0) })
    wr(root, 'eslint.config.js', 'looser\n'); wr(root, 'app.db', 'db2'); commit(root, 'nới luật')
    g(root, 'add', '-f', 'app.db')
    const r = lu.xem(root, p1.tag)
    assert.deepEqual(r.ruleFiles, ['eslint.config.js'])
    assert.deepEqual(r.keptData, [])
    const wt = path.join(TMP, `wt ${++seq}`)
    g(root, 'worktree', 'add', '-q', '-b', 'nhanh-w', wt)
    assert.match(lu.xem(wt, p1.tag).blocker, /bản làm việc riêng/)
  })

  test('điểm không tồn tại ⇒ lỗi đời thường', () => {
    const { root } = scenario()
    assert.match(caught(() => lu.xem(root, 'luu/khong-co')).message, /Không có điểm lưu/)
  })

  test('nhận cả tên đời thường (không dấu, không hoa thường, cụm từ nguyên cả từ) khi khớp DUY NHẤT một điểm; tag luu/… và tag ngắn vẫn dùng được', () => {
    const { root, p2, p3 } = scenario()
    for (const q of ['Thêm trang đăng nhập', 'them trang dang nhap', 'THÊM TRANG ĐĂNG NHẬP', 'trang đăng nhập', p2.tag, p2.tag.replace(/^luu\//, '')]) {
      assert.equal(lu.xem(root, q).target.tag, p2.tag, q)
    }
    assert.equal(lu.xem(root, 'giỏ hàng').target.tag, p3.tag)
  })

  test('tên đời thường khớp NHIỀU điểm ⇒ exit 2 liệt kê để chọn; khớp nửa từ hoặc không khớp ⇒ lỗi "Không có điểm lưu"; tag luu/… sai không bị đoán theo tên', () => {
    const { root, p2, p3 } = scenario()
    const e = caught(() => lu.xem(root, 'thêm'))
    assert.equal(e.exit, 2)
    assert.match(e.message, /^Có 2 điểm lưu khớp "thêm" — gõ rõ hơn hoặc dùng tên đầy đủ:$/)
    assert.doesNotMatch(e.message, /đúng một tag/)
    assert.equal(e.lines.length, 2)
    assert.ok(e.lines.some((l) => l.includes(p2.tag)) && e.lines.some((l) => l.includes(p3.tag)), e.lines.join(' | '))
    assert.ok(e.lines.some((l) => l.includes('"Thêm trang đăng nhập"')))
    for (const q of ['gi', 'giỏ hàn', 'xyzzy plugh', 'luu/them-gio-hang-sai', 'luu/Thêm giỏ hàng']) assert.match(caught(() => lu.xem(root, q)).message, /Không có điểm lưu/, q)
    // người dùng gõ tên (không phải tag) ⇒ báo đúng chữ họ gõ, không tự gắn tiền tố luu/
    assert.match(caught(() => lu.xem(root, 'xyzzy plugh')).message, /^Không có điểm lưu "xyzzy plugh"\./)
    assert.match(caught(() => lu.xem(root, 'luu/khong-co')).message, /^Không có điểm lưu "luu\/khong-co"\./)
  })

  test('tên trùng hệt nhau ở hai điểm ⇒ cũng exit 2 (không chọn bừa điểm mới nhất); tên khớp nguyên văn thắng tên chỉ chứa cụm đó', () => {
    const { root, p2 } = scenario()
    lu.quay(root, p2.tag, { ...noCheck, now: at(30) }) // thêm điểm "Quay lại: Thêm trang đăng nhập" chứa cụm của p2
    assert.equal(lu.xem(root, 'Thêm trang đăng nhập').target.tag, p2.tag, 'nguyên văn thắng')
    const root2 = mk()
    wr(root2, 'a.txt', '1'); lu.bat(root2, { now: at(0) })
    wr(root2, 'a.txt', '2'); commit(root2, 'x'); lu.tao(root2, 'Mốc', { now: at(5) })
    wr(root2, 'a.txt', '3'); commit(root2, 'y'); lu.tao(root2, 'mốc', { now: at(6) })
    assert.equal(caught(() => lu.xem(root2, 'MỐC')).exit, 2)
  })
})

describe('quay', () => {
  test('thêm/xoá/đổi tên file: cây làm việc về đúng điểm đích, lịch sử còn nguyên, thêm đúng MỘT commit + một điểm mới', () => {
    const { root, p2, p3, snap2 } = scenario()
    const headBefore = g(root, 'rev-parse', 'HEAD')
    const countBefore = Number(g(root, 'rev-list', '--count', 'HEAD'))
    const tagsBefore = tagsOf(root)
    const r = lu.quay(root, p2.tag, { ...noCheck, now: at(30) })
    assert.equal(r.status, 'done')
    assert.deepEqual(snapshot(root), snap2)
    assert.equal(g(root, 'status', '--porcelain'), '')
    assert.equal(Number(g(root, 'rev-list', '--count', 'HEAD')), countBefore + 1)
    assert.equal(g(root, 'rev-parse', 'HEAD^'), headBefore, 'commit mới nối tiếp, không reset')
    assert.equal(g(root, 'log', '-1', '--format=%s'), 'Quay lại: Thêm trang đăng nhập')
    assert.equal(gStatus(root, 'merge-base', '--is-ancestor', headBefore, 'HEAD'), 0)
    for (const t of tagsBefore) assert.ok(tagsOf(root).includes(t), `tag ${t} phải còn`)
    assert.equal(tagsOf(root).length, tagsBefore.length + 1, 'HEAD cũ đã có điểm lưu ⇒ chỉ thêm điểm "Quay lại"')
    assert.equal(r.tag, 'luu/20261012-1030-quay-lai-them-trang-dang-nhap')
    assert.equal(g(root, 'tag', '-l', r.tag, '--format=%(contents:subject)'), 'Quay lại: Thêm trang đăng nhập')
    assert.equal(g(root, 'rev-parse', `${r.tag}^{commit}`), g(root, 'rev-parse', 'HEAD'))
    assert.equal(r.left.tag, p3.tag, 'điểm vừa rời = điểm có sẵn trên HEAD cũ')
    assert.equal(g(root, 'symbolic-ref', '--short', 'HEAD'), 'main')
  })

  test('quay nhầm: quay về điểm vừa rời ⇒ cây về đúng như trước khi quay', () => {
    const { root, p2, snap3 } = scenario()
    wr(root, 'moi.txt', 'mới\n'); commit(root, 'việc chưa có điểm lưu')
    const snapBefore = snapshot(root)
    const r1 = lu.quay(root, p2.tag, { ...noCheck, now: at(31) })
    assert.match(r1.left.name, /^Trước khi quay lại: /, 'HEAD chưa có điểm ⇒ tạo điểm để quay nhầm có chỗ về')
    assert.notDeepEqual(snapshot(root), snapBefore)
    const r2 = lu.quay(root, r1.left.tag, { ...noCheck, now: at(32) })
    assert.deepEqual(snapshot(root), snapBefore)
    assert.equal(r2.target.name, r1.left.name)
    assert.equal(Number(g(root, 'rev-list', '--count', 'HEAD')) >= 3, true)
    assert.equal(gStatus(root, 'merge-base', '--is-ancestor', g(root, 'rev-parse', r1.left.tag + '^{commit}'), 'HEAD'), 0)
  })

  test('quay lại nhiều lần không làm tên dài ra ("Quay lại: Quay lại: …")', () => {
    const { root, p2 } = scenario()
    const r1 = lu.quay(root, p2.tag, { ...noCheck, now: at(31) })
    const r2 = lu.quay(root, r1.left.tag, { ...noCheck, now: at(32) })
    const r3 = lu.quay(root, r1.tag, { ...noCheck, now: at(33) })
    assert.equal(g(root, 'log', '-1', '--format=%s'), 'Quay lại: Thêm trang đăng nhập')
    assert.ok(r2.tag && r3.tag)
  })

  test('file bị .gitignore (.env, node_modules) không bị đụng và không bị tính là việc dở', () => {
    const { root, p2 } = scenario()
    wr(root, '.env', 'RIENG=1\n'); wr(root, 'node_modules/x/i.js', 'x\n')
    lu.quay(root, p2.tag, { ...noCheck, now: at(30) })
    assert.equal(rd(root, '.env'), 'RIENG=1\n')
    assert.equal(rd(root, 'node_modules/x/i.js'), 'x\n')
  })

  test('đã ở đúng điểm đó (cây giống nhau, không việc dở) ⇒ status same, không commit', () => {
    const { root, p3 } = scenario()
    const head = g(root, 'rev-parse', 'HEAD')
    const r = lu.quay(root, p3.tag, noCheck)
    assert.equal(r.status, 'same')
    assert.equal(g(root, 'rev-parse', 'HEAD'), head)
    assert.equal(tagsOf(root).length, 3)
  })

  test('chấp nhận tên ngắn không có tiền tố luu/', () => {
    const { root, p2, snap2 } = scenario()
    lu.quay(root, p2.tag.replace(/^luu\//, ''), { ...noCheck, now: at(30) })
    assert.deepEqual(snapshot(root), snap2)
  })

  test('chấp nhận tên đời thường khi khớp duy nhất một điểm; khớp nhiều điểm ⇒ exit 2 liệt kê và KHÔNG đổi gì', () => {
    const { root, p2, snap2, snap3 } = scenario()
    const head = g(root, 'rev-parse', 'HEAD')
    const e = caught(() => lu.quay(root, 'thêm', noCheck))
    assert.equal(e.exit, 2)
    assert.equal(e.lines.length, 2)
    assert.equal(g(root, 'rev-parse', 'HEAD'), head)
    assert.deepEqual(snapshot(root), snap3)
    const r = lu.quay(root, 'thêm trang đăng nhập', { ...noCheck, now: at(30) })
    assert.equal(r.target.tag, p2.tag)
    assert.deepEqual(snapshot(root), snap2)
  })

  describe('việc dở', () => {
    test('có việc dở mà thiếu cờ ⇒ exit 3 + danh sách file, KHÔNG đổi gì', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'sửa dở\n'); wr(root, 'moi.txt', 'mới')
      const head = g(root, 'rev-parse', 'HEAD')
      const e = caught(() => lu.quay(root, p2.tag, noCheck))
      assert.equal(e.exit, 3)
      assert.match(e.message, /Giữ hay bỏ/)
      assert.match(e.message, /--viec-do giu/)
      assert.deepEqual(e.lines.slice().sort(), ['- README.md', '- moi.txt'])
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(rd(root, 'README.md'), 'sửa dở\n')
      assert.equal(tagsOf(root).length, 3)
    })

    test('giu: cất việc dở thành điểm lưu như cũ RỒI đặt lại nội dung các file dở vào thư mục làm việc (chưa commit) sau khi quay; file xoá dở cũng bị xoá lại', () => {
      const { root, p2, snap2 } = scenario()
      wr(root, 'README.md', 'sửa dở\n'); wr(root, 'moi.txt', 'mới\n'); fs.rmSync(path.join(root, 'b.txt'))
      const dirtySnap = snapshot(root)
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu', now: at(35) })
      assert.equal(r.saved.name, 'Lưu tạm trước khi quay lại')
      assert.equal(r.left.tag, r.saved.tag)
      assert.deepEqual(r.restored.slice().sort(), ['README.md', 'b.txt', 'moi.txt'])
      const want = { ...snap2, 'README.md': 'sửa dở\n', 'moi.txt': 'mới\n' }
      delete want['b.txt']
      assert.deepEqual(snapshot(root), want, 'cây = điểm đích + các file dở đặt lại')
      assert.deepEqual(g(root, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? moi.txt', 'D b.txt', 'M README.md'])
      assert.equal(g(root, 'diff', '--cached', '--name-only'), '', 'chỉ mục sạch: việc dở nằm ở thư mục làm việc, chưa stage')
      assert.equal(g(root, 'log', '-1', '--format=%s'), 'Quay lại: Thêm trang đăng nhập')
      const inHead = g(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
      assert.ok(!inHead.includes('moi.txt') && inHead.includes('b.txt'), `cây của commit Quay lại là điểm đích, không có việc dở: ${inHead}`)
      assert.equal(g(root, 'show', 'HEAD:README.md'), 'v1')
      assert.equal(g(root, 'show', `${r.saved.tag}:README.md`), 'sửa dở')
      assert.equal(g(root, 'show', `${r.saved.tag}:moi.txt`), 'mới')
      lu.quay(root, r.saved.tag, { ...noCheck, viecDo: 'bo', now: at(36) }) // file dở vừa đặt lại là việc dở mới ⇒ phải chọn; về điểm lưu tạm = về đúng lúc trước khi quay
      assert.deepEqual(snapshot(root), dirtySnap)
    })

    test('giu: máy kiểm chạy trên cây vừa quay (chưa đặt việc dở lại) rồi mới đặt lại', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'sửa dở\n')
      let seen = null
      const r = lu.quay(root, p2.tag, { viecDo: 'giu', now: at(35), runCheck: (d) => { seen = rd(d, 'README.md'); return { exit: 0, lines: ['ok'] } } })
      assert.equal(seen, 'v1\n', 'lúc kiểm, README.md là bản của điểm đích')
      assert.equal(rd(root, 'README.md'), 'sửa dở\n')
      assert.deepEqual(r.restored, ['README.md'])
    })

    test('bo: cũng lưu (không bao giờ mất việc) nhưng tên ghi rõ là bỏ, và KHÔNG đặt lại gì vào thư mục làm việc', () => {
      const { root, p2, snap2 } = scenario()
      wr(root, 'README.md', 'sửa dở\n')
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo', now: at(35) })
      assert.match(r.saved.name, /đã bỏ/)
      assert.deepEqual(r.restored, [])
      assert.equal(g(root, 'status', '--porcelain'), '')
      assert.deepEqual(snapshot(root), snap2)
      assert.equal(g(root, 'show', `${r.saved.tag}:README.md`), 'sửa dở')
      assert.equal(g(root, 'tag', '-l', r.saved.tag, '--format=%(contents:subject)'), r.saved.name)
    })

    test('--viec-do lạ ⇒ exit 2', () => {
      const { root, p2 } = scenario()
      assert.equal(caught(() => lu.quay(root, p2.tag, { viecDo: 'xoa' })).exit, 2)
    })

    test('có cờ nhưng không có việc dở ⇒ chạy bình thường, không tạo điểm lưu tạm', () => {
      const { root, p2 } = scenario()
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu', now: at(35) })
      assert.equal(r.saved, null)
    })

    test('việc dở chứa khoá giả ⇒ từ chối (exit 1), không commit, chỉ mục và file về như cũ, không in giá trị khoá', () => {
      const { root, p2 } = scenario()
      wr(root, 'src/secret.js', `const k = "${FAKE_KEY}"\n`)
      const head = g(root, 'rev-parse', 'HEAD')
      const e = caught(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu' }))
      assert.equal(e.exit, 1)
      assert.match(e.message, /src\/secret\.js:1/)
      assert.match(e.message, /github/)
      assert.equal(`${e.message}\n${e.lines.join('\n')}`.includes('ghp_'), false)
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(g(root, 'diff', '--cached', '--name-only'), '')
      assert.equal(rd(root, 'src/secret.js').includes(FAKE_KEY), true)
      assert.equal(tagsOf(root).length, 3)
    })

    test('việc dở có khoá nằm ở file đã theo dõi (sửa dòng) cũng bị chặn; chỉ mục đã stage trước đó được giữ nguyên', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', `key=${FAKE_KEY}\n`)
      wr(root, 'staged.txt', 'đã stage\n'); g(root, 'add', 'staged.txt')
      const e = caught(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo' }))
      assert.match(e.message, /README\.md:1/)
      assert.equal(g(root, 'diff', '--cached', '--name-only'), 'staged.txt')
    })

    test('file nhạy cảm (.env chưa bị ignore) trong việc dở ⇒ từ chối', () => {
      const { root, p2 } = scenario()
      wr(root, '.gitignore', 'node_modules/\n') // .env không được ignore
      commit(root, 'ignore ít hơn')
      wr(root, '.env', 'A=1\n')
      const e = caught(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu' }))
      assert.match(e.message, /\.env — file nhạy cảm/)
    })

    test('dòng có dấu allow-secret được cho qua như ở cổng commit', () => {
      const { root, p2 } = scenario()
      wr(root, 'doc.txt', `mẫu: ${FAKE_KEY} // flow-gate: allow-secret\n`)
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu', now: at(35) })
      assert.equal(r.status, 'done')
    })

    test('chỉ file dữ liệu bị sửa ⇒ không tính là việc dở (không đòi cờ)', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'app.db', 'db1')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'a.txt', '2'); commit(root, 'đổi a')
      wr(root, 'app.db', 'db-đang-dùng') // chưa theo dõi, bị ignore + là dữ liệu
      const r = lu.quay(root, p1.tag, { ...noCheck, now: at(5) })
      assert.equal(r.status, 'done')
      assert.equal(rd(root, 'app.db'), 'db-đang-dùng')
    })
  })

  describe('bản đã stage khác cả HEAD lẫn đĩa', () => {
    // Có `rel` = `text` ở một commit nào đó trong lịch sử đi tới `rev`.
    const inHistory = (root, rev, rel, text) => g(root, 'rev-list', rev).split('\n').filter(Boolean).some((c) => {
      const r = spawnSync('git', ['show', `${c}:${rel}`], { cwd: root, encoding: 'utf8', env: process.env })
      return r.status === 0 && r.stdout === text
    })
    // HEAD có README.md = v1; stage v2; sửa đĩa về v1 (stageAll sẽ ghi đè bản v2 ở chỉ mục bằng v1 = HEAD).
    const stagedThenReverted = (root) => { wr(root, 'README.md', 'v2 đã stage\n'); g(root, 'add', 'README.md'); wr(root, 'README.md', 'v1\n') }

    for (const viecDo of ['giu', 'bo']) {
      test(`quay --viec-do ${viecDo}: bản đã stage (v2) mà đĩa đã về bản HEAD (v1) vẫn nằm trong lịch sử của điểm lưu tạm, lấy lại bằng git thường`, () => {
        const { root, p2 } = scenario()
        stagedThenReverted(root)
        const head = g(root, 'rev-parse', 'HEAD')
        const r = lu.quay(root, p2.tag, { ...noCheck, viecDo, now: at(35) })
        assert.ok(r.saved, 'phải có điểm lưu tạm')
        assert.equal(inHistory(root, r.saved.tag, 'README.md', 'v2 đã stage\n'), true, 'v2 phải còn trong lịch sử')
        assert.equal(g(root, 'show', `${r.saved.tag}:README.md`), 'v1', 'điểm lưu tạm = bản trên đĩa')
        assert.equal(g(root, 'rev-parse', `${r.saved.tag}~2`), head, 'bản đã stage nằm ngay trên HEAD cũ, điểm lưu tạm nằm trên nó')
        assert.equal(g(root, 'show', `${r.saved.tag}~1:README.md`), 'v2 đã stage')
        assert.equal(g(root, 'diff', '--cached', '--name-only'), '', 'chỉ mục sạch sau khi quay')
        assert.deepEqual(fs.readdirSync(path.join(root, '.git')).filter((f) => f.startsWith('luu-tmp')), [], 'không để lại chỉ mục tạm')
      })
    }

    test('file MỚI đã stage rồi bị xoá trên đĩa, và file đã theo dõi đã stage rồi xoá trên đĩa ⇒ nội dung đã stage của cả hai còn trong lịch sử', () => {
      const { root, p2 } = scenario()
      wr(root, 'moi.txt', 'mới đã stage\n'); wr(root, 'b.txt', 'b đã stage\n'); g(root, 'add', 'moi.txt', 'b.txt')
      fs.rmSync(path.join(root, 'moi.txt')); fs.rmSync(path.join(root, 'b.txt'))
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo', now: at(35) })
      assert.equal(inHistory(root, r.saved.tag, 'moi.txt', 'mới đã stage\n'), true)
      assert.equal(inHistory(root, r.saved.tag, 'b.txt', 'b đã stage\n'), true)
      assert.equal(g(root, 'ls-tree', '-r', '--name-only', r.saved.tag).split('\n').includes('moi.txt'), false, 'điểm lưu tạm = đĩa: không có moi.txt')
    })

    test('đĩa khác cả HEAD lẫn bản đã stage ⇒ bản đã stage (v2) và bản đĩa (v3) đều còn trong lịch sử', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'v2 đã stage\n'); g(root, 'add', 'README.md'); wr(root, 'README.md', 'v3 trên đĩa\n')
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo', now: at(35) })
      assert.equal(g(root, 'show', `${r.saved.tag}:README.md`), 'v3 trên đĩa')
      assert.equal(g(root, 'show', `${r.saved.tag}~1:README.md`), 'v2 đã stage')
    })

    test('bản đã stage chỉ có phần code: dữ liệu đã stage KHÔNG vào commit cất bản stage, vẫn đang stage sau khi quay', () => {
      const { root, p2 } = scenario()
      wr(root, 'app.db', 'db1'); g(root, 'add', '-f', 'app.db'); commit(root, 'có db')
      wr(root, 'app.db', 'db-đã-stage'); g(root, 'add', '-f', 'app.db')
      stagedThenReverted(root)
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu', now: at(35) })
      assert.equal(g(root, 'show', '--name-only', '--format=', `${r.saved.tag}~1`), 'README.md', 'commit cất bản stage chỉ có code')
      assert.equal(g(root, 'show', `${r.saved.tag}~1:app.db`), 'db1', 'dữ liệu trong commit đó vẫn là bản của HEAD')
      assert.equal(g(root, 'diff', '--cached', '--name-only'), 'app.db', 'dữ liệu vẫn đang stage')
      assert.equal(rd(root, 'app.db'), 'db-đã-stage')
    })

    test('bản đã stage có khoá giả mà đĩa đã sửa mất ⇒ vẫn từ chối (exit 1), HEAD/chỉ mục/đĩa về như cũ, không in giá trị khoá', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', `key=${FAKE_KEY}\n`); g(root, 'add', 'README.md'); wr(root, 'README.md', 'v1\n')
      const head = g(root, 'rev-parse', 'HEAD')
      const e = caught(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo' }))
      assert.equal(e.exit, 1)
      assert.match(e.message, /README\.md:1/)
      assert.equal(`${e.message}\n${e.lines.join('\n')}`.includes('ghp_'), false)
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(g(root, 'diff', '--cached', '--name-only'), 'README.md', 'bản stage vẫn ở chỉ mục')
      assert.equal(rd(root, 'README.md'), 'v1\n')
      assert.equal(tagsOf(root).length, 3)
    })

    test('nối commit cất bản stage vào nhánh bị lỗi (nhánh đang bị khoá) ⇒ chỉ mục trả về đúng bản stage cũ, HEAD không nhích', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'v2 đã stage\n'); g(root, 'add', 'README.md'); wr(root, 'README.md', 'v3 trên đĩa\n')
      const head = g(root, 'rev-parse', 'HEAD')
      const lock = path.join(root, '.git', 'refs', 'heads', `${g(root, 'symbolic-ref', '--short', 'HEAD')}.lock`)
      fs.writeFileSync(lock, '')
      try {
        assert.throws(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'bo', now: at(35) }))
      } finally { fs.rmSync(lock, { force: true }) }
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(g(root, 'show', ':README.md'), 'v2 đã stage', 'chỉ mục về đúng bản đã stage trước đó')
      assert.equal(rd(root, 'README.md'), 'v3 trên đĩa\n')
      assert.equal(tagsOf(root).length, 3)
    })

    test('khoá giả ở bản đĩa (bản stage sạch) ⇒ từ chối và HEAD không nhích (commit cất bản stage chưa được nối vào nhánh)', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'v2 đã stage\n'); g(root, 'add', 'README.md'); wr(root, 'README.md', `key=${FAKE_KEY}\n`)
      const head = g(root, 'rev-parse', 'HEAD')
      const e = caught(() => lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu' }))
      assert.equal(e.exit, 1)
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(g(root, 'show', ':README.md'), 'v2 đã stage')
    })

    test('ca bình thường không đổi: stage một file khớp đĩa + sửa dở file khác ⇒ đúng MỘT commit lưu tạm ngay trên HEAD cũ', () => {
      const { root, p2 } = scenario()
      wr(root, 'README.md', 'v2 khớp đĩa\n'); g(root, 'add', 'README.md'); wr(root, 'moi.txt', 'mới\n')
      const head = g(root, 'rev-parse', 'HEAD')
      const r = lu.quay(root, p2.tag, { ...noCheck, viecDo: 'giu', now: at(35) })
      assert.equal(g(root, 'rev-parse', `${r.saved.tag}~1`), head)
      assert.equal(g(root, 'show', `${r.saved.tag}:README.md`), 'v2 khớp đĩa')
    })

    test('tao không đụng chỉ mục: bản đã stage (v2) vẫn nguyên, điểm lưu nằm trên HEAD', () => {
      const root = mk()
      wr(root, 'a.txt', 'v1\n'); lu.bat(root, { now: at(0) })
      wr(root, 'a.txt', 'v2\n'); g(root, 'add', 'a.txt'); wr(root, 'a.txt', 'v1\n')
      const r = lu.tao(root, 'Giữa chừng', { now: at(5) })
      assert.equal(g(root, 'rev-parse', `${r.tag}^{commit}`), g(root, 'rev-parse', 'HEAD'))
      assert.equal(g(root, 'show', ':a.txt'), 'v2')
    })

    test('bat trên repo chưa có commit: bản đã stage (v2) khác đĩa (v1) vẫn nằm trong lịch sử của điểm "Bắt đầu"', () => {
      const root = mk()
      g(root, 'init', '-q'); wr(root, 'a.txt', 'v2 đã stage\n'); g(root, 'add', 'a.txt'); wr(root, 'a.txt', 'v1\n')
      const r = lu.bat(root, { now: at(1) })
      assert.equal(g(root, 'show', `${r.tag}:a.txt`), 'v1')
      assert.equal(inHistory(root, r.tag, 'a.txt', 'v2 đã stage\n'), true)
    })
  })

  describe('file luật', () => {
    const rulesCases = [
      ['docs/arch.json', '{"parts":[]}', '{"parts":[{"name":"x"}]}'],
      ['eslint.config.js', 'strict\n', 'loose\n'],
      ['kit/rules/sast/a.yml', 'id: a\n', 'id: b\n'],
      ['kit/checkers.json', '[]', '[1]'],
      ['.claude/flow.json', '{}', '{"x":1}'],
      ['.claude/ui.json', '{"a":1}', '{"a":2}'],
      ['docs/ui-baseline.json', '{"counts":{}}', '{"counts":{"a":1}}'],
      ['.claude/luu.json', '{"data":[]}', '{"data":["x/**"]}'],
      ['frontend/biome.json', '{"a":1}', '{"a":2}'],
    ]
    test('quay về trước lần đổi MỌI loại file luật ⇒ exit 4, liệt kê từng file, không đổi gì; --doi-luat thì chạy', () => {
      const root = mk()
      wr(root, 'a.txt', '1')
      for (const [file, before] of rulesCases) wr(root, file, before)
      const p1 = lu.bat(root, { now: at(0) })
      for (const [file, , after] of rulesCases) wr(root, file, after)
      wr(root, 'a.txt', '2'); commit(root, 'siết luật')
      const head = g(root, 'rev-parse', 'HEAD')
      const e = caught(() => lu.quay(root, p1.tag, noCheck))
      assert.equal(e.exit, 4)
      for (const [file] of rulesCases) assert.ok(e.lines.some((l) => l.includes(`- ${file} (`)), `${file} phải được nêu: ${e.lines.join(' | ')}`)
      assert.equal(e.lines.some((l) => l.includes('a.txt')), false, 'file thường không bị liệt kê')
      assert.match(e.message, /--doi-luat/)
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(rd(root, 'a.txt'), '2')
      assert.equal(tagsOf(root).length, 1)
      const r = lu.quay(root, p1.tag, { ...noCheck, doiLuat: true, now: at(5) })
      assert.equal(r.status, 'done')
      for (const [file, before] of rulesCases) assert.equal(rd(root, file), before, file)
      assert.equal(rd(root, 'a.txt'), '1')
    })

    test('file luật bị thêm/xoá giữa hai điểm cũng tính (A và D)', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, '.eslintrc.json', '{}')
      const p1 = lu.bat(root, { now: at(0) })
      fs.rmSync(path.join(root, '.eslintrc.json')); wr(root, 'biome.json', '{}'); commit(root, 'đổi công cụ lint')
      const e = caught(() => lu.quay(root, p1.tag, noCheck))
      assert.equal(e.exit, 4)
      assert.deepEqual(e.lines.slice(0, 2).sort(), ['- .eslintrc.json (sẽ được thêm lại)', '- biome.json (sẽ bị gỡ)'])
    })

    test('chỉ đổi file thường ⇒ không đòi --doi-luat', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'docs/arch.json', '{}')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'a.txt', '2'); commit(root, 'đổi thường')
      assert.equal(lu.quay(root, p1.tag, { ...noCheck, now: at(5) }).status, 'done')
    })

    test('file luật đang sửa dở (HEAD đã là đích, chưa commit) khác đích ⇒ cũng đòi --doi-luat (exit 4), dù chỉ stage hay chưa stage; không đổi gì', () => {
      for (const staged of [false, true]) {
        const root = mk()
        wr(root, 'a.txt', '1'); wr(root, 'eslint.config.js', 'loose\n')
        const p1 = lu.bat(root, { now: at(0) })
        wr(root, 'eslint.config.js', 'strict\n') // siết thêm, chưa commit
        if (staged) g(root, 'add', 'eslint.config.js')
        const head = g(root, 'rev-parse', 'HEAD')
        const e = caught(() => lu.quay(root, p1.tag, { ...noCheck, viecDo: 'bo' }))
        assert.equal(e.exit, 4, `staged=${staged}`)
        assert.deepEqual(e.lines, ['- eslint.config.js (sẽ đổi nội dung)'])
        assert.equal(g(root, 'rev-parse', 'HEAD'), head)
        assert.equal(rd(root, 'eslint.config.js'), 'strict\n', 'chưa đổi gì')
        assert.equal(tagsOf(root).length, 1, 'chưa tạo điểm lưu tạm')
        const r = lu.quay(root, p1.tag, { ...noCheck, viecDo: 'bo', doiLuat: true, now: at(5) })
        assert.equal(r.status, 'done')
        assert.equal(rd(root, 'eslint.config.js'), 'loose\n')
        assert.equal(g(root, 'show', `${r.saved.tag}:eslint.config.js`), 'strict', 'bản siết vẫn nằm trong điểm lưu tạm')
      }
    })

    test('file luật MỚI chưa theo dõi và file luật xoá dở (đích có) ⇒ liệt kê "sẽ bị gỡ" / "sẽ được thêm lại"; việc dở không phải file luật thì không đòi', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'biome.json', '{}')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, '.eslintrc.json', '{}'); wr(root, 'kit/rules/sast/n.yml', 'id: n\n') // mới, chưa theo dõi (thư mục mới)
      fs.rmSync(path.join(root, 'biome.json')) // xoá dở
      const e = caught(() => lu.quay(root, p1.tag, { ...noCheck, viecDo: 'giu' }))
      assert.equal(e.exit, 4)
      assert.deepEqual(e.lines.slice().sort(), ['- .eslintrc.json (sẽ bị gỡ)', '- biome.json (sẽ được thêm lại)', '- kit/rules/sast/n.yml (sẽ bị gỡ)'])
      const ok = mk()
      wr(ok, 'a.txt', '1'); wr(ok, 'eslint.config.js', 'x\n')
      const q1 = lu.bat(ok, { now: at(0) })
      wr(ok, 'a.txt', 'dở'); wr(ok, 'moi.txt', 'mới')
      assert.equal(lu.quay(ok, q1.tag, { ...noCheck, viecDo: 'giu', now: at(5) }).status, 'done')
    })

    test('xem: ruleFiles cũng nêu file luật đang sửa dở', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'eslint.config.js', 'loose\n')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'eslint.config.js', 'strict\n')
      assert.deepEqual(lu.xem(root, p1.tag).ruleFiles, ['eslint.config.js'])
    })

    test('vừa có file luật vừa có việc dở thiếu cờ ⇒ exit 4 kèm nhắc việc dở', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'eslint.config.js', 'a')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'eslint.config.js', 'b'); commit(root, 'đổi luật')
      wr(root, 'a.txt', 'dở')
      const e = caught(() => lu.quay(root, p1.tag, noCheck))
      assert.equal(e.exit, 4)
      assert.ok(e.lines.some((l) => /--viec-do/.test(l)))
    })
  })

  describe('ranh giới code / dữ liệu', () => {
    test('app.db và data/x.json đang được theo dõi: quay không đổi hai file đó; code trong src/data/ vẫn quay', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'src/data/consts.ts', 'export const A = 1\n')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'app.db', 'db-v1'); wr(root, 'data/x.json', '{"v":1}'); wr(root, 'uploads/u.png', 'png1'); wr(root, 'a.txt', '2')
      g(root, 'add', '-f', 'app.db', 'data/x.json', 'uploads/u.png'); commit(root, 'có dữ liệu')
      const p2 = lu.tao(root, 'Có dữ liệu', { now: at(10) })
      wr(root, 'app.db', 'db-v2'); wr(root, 'data/x.json', '{"v":2}'); wr(root, 'src/data/consts.ts', 'export const A = 2\n'); wr(root, 'a.txt', '3')
      g(root, 'add', '-f', 'app.db', 'data/x.json'); commit(root, 'đổi tiếp')
      for (const [target, kept, minute] of [[p1, ['app.db', 'data/x.json', 'uploads/u.png'], 20], [p2, ['app.db', 'data/x.json'], 21]]) {
        const before = { db: rd(root, 'app.db'), json: rd(root, 'data/x.json'), png: rd(root, 'uploads/u.png') }
        const r = lu.quay(root, target.tag, { ...noCheck, now: at(minute) })
        assert.equal(rd(root, 'app.db'), before.db, 'app.db không đổi')
        assert.equal(rd(root, 'data/x.json'), before.json, 'data/x.json không đổi')
        assert.equal(rd(root, 'uploads/u.png'), before.png, 'uploads/ không đổi')
        assert.deepEqual(r.keptData.sort(), kept)
      }
      assert.equal(rd(root, 'src/data/consts.ts'), 'export const A = 1\n', 'src/data/ là code, vẫn quay')
      assert.equal(rd(root, 'a.txt'), '2')
    })

    test('keptData liệt kê dữ liệu khác nhau giữa HEAD và điểm đích; commit quay không chứa file dữ liệu', () => {
      const root = mk()
      wr(root, 'a.txt', '1')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'app.db', 'db1'); wr(root, 'data/x.json', '{}'); wr(root, 'a.txt', '2')
      g(root, 'add', '-f', 'app.db', 'data/x.json'); commit(root, 'thêm dữ liệu vào git')
      const r = lu.quay(root, p1.tag, { ...noCheck, now: at(5) })
      assert.deepEqual(r.keptData.sort(), ['app.db', 'data/x.json'])
      assert.equal(has(root, 'app.db'), true)
      assert.equal(g(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes('app.db'), false)
      assert.equal(g(root, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt')
    })

    test('dữ liệu đang STAGE (chưa commit) không bị cuốn vào commit "Quay lại" và vẫn còn stage sau khi quay', () => {
      const root = mk()
      wr(root, 'a.txt', '1')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'app.db', 'db1'); wr(root, 'data/x.json', '{"v":1}'); wr(root, 'a.txt', '2')
      g(root, 'add', '-f', 'app.db', 'data/x.json'); commit(root, 'có dữ liệu')
      wr(root, 'app.db', 'db-đã-stage'); wr(root, 'data/x.json', '{"v":2}'); wr(root, 'data/moi.json', '{}')
      g(root, 'add', '-f', 'app.db', 'data/x.json', 'data/moi.json') // stage dữ liệu, chưa commit
      const staged = g(root, 'diff', '--cached', '--name-only').split('\n').sort()
      assert.deepEqual(staged, ['app.db', 'data/moi.json', 'data/x.json'])
      const r = lu.quay(root, p1.tag, { ...noCheck, now: at(5) })
      assert.equal(r.status, 'done')
      assert.equal(g(root, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt', 'commit Quay lại chỉ chứa code')
      assert.equal(rd(root, 'a.txt'), '1')
      assert.deepEqual(g(root, 'diff', '--cached', '--name-only').split('\n').sort(), staged, 'dữ liệu vẫn ở trạng thái đã stage')
      assert.equal(rd(root, 'app.db'), 'db-đã-stage')
      assert.equal(rd(root, 'data/x.json'), '{"v":2}')
    })

    test('chỉ có dữ liệu đang stage, code đã đúng điểm đích ⇒ không tạo commit "Quay lại" rỗng; việc dở + dữ liệu stage ⇒ commit lưu tạm cũng không chứa dữ liệu', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'app.db', 'db1')
      const p1 = lu.bat(root, { now: at(0) })
      g(root, 'add', '-f', 'app.db'); commit(root, 'db vào git')
      const p2 = lu.tao(root, 'Có db', { now: at(2) })
      wr(root, 'app.db', 'db2'); g(root, 'add', '-f', 'app.db')
      const head = g(root, 'rev-parse', 'HEAD')
      assert.equal(lu.quay(root, p2.tag, { ...noCheck, now: at(5) }).status, 'same')
      assert.equal(g(root, 'rev-parse', 'HEAD'), head)
      assert.equal(g(root, 'diff', '--cached', '--name-only'), 'app.db')
      wr(root, 'a.txt', 'dở') // thêm việc dở
      const r = lu.quay(root, p1.tag, { ...noCheck, viecDo: 'giu', now: at(6) })
      assert.equal(g(root, 'show', '--name-only', '--format=', `${r.saved.tag}^{commit}`), 'a.txt', 'lưu tạm chỉ chứa code')
      assert.equal(g(root, 'diff', '--cached', '--name-only'), 'app.db', 'dữ liệu vẫn đang stage')
      assert.equal(rd(root, 'app.db'), 'db2')
    })

    test('trạng thái phát hành (.claude/release.json) là dữ liệu: điểm lưu giữ bản cũ, hiện tại là bản mới ⇒ sau quay vẫn là bản mới, xem không liệt kê nó trong file sẽ đổi', () => {
      const root = mk()
      wr(root, 'a.txt', '1')
      lu.bat(root, { now: at(0) })
      wr(root, '.claude/release.json', '{"v":1,"rollbackTested":false}\n'); commit(root, 'phát hành lần 1')
      const p1 = lu.tao(root, 'Phát hành lần 1', { now: at(2) })
      wr(root, 'a.txt', '2'); wr(root, '.claude/release.json', '{"v":1,"rollbackTested":true}\n'); commit(root, 'phát hành lần 2')
      const x = lu.xem(root, p1.tag)
      assert.deepEqual(x.changes.map((c) => c.file), ['a.txt'], 'release.json không nằm trong file sẽ đổi')
      assert.deepEqual(x.keptData, ['.claude/release.json'])
      const r = lu.quay(root, p1.tag, { ...noCheck, now: at(5) })
      assert.equal(rd(root, '.claude/release.json'), '{"v":1,"rollbackTested":true}\n', 'rollbackTested vẫn true')
      assert.equal(rd(root, 'a.txt'), '1')
      assert.deepEqual(r.keptData, ['.claude/release.json'])
      assert.equal(g(root, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt', 'commit Quay lại không chứa release.json')
    })

    test('CLI xem · quay: lời "không quay theo" nhắc thêm trạng thái phát hành, vẫn đúng một câu "không quay theo"', () => {
      const root = mk()
      wr(root, 'a.txt', '1')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'a.txt', '2'); wr(root, '.claude/release.json', '{"v":1}\n'); commit(root, 'phát hành')
      const xem = cliLuu('xem', root, p1.tag)
      assert.equal(xem.status, 0, xem.stderr)
      assert.match(xem.stdout, /\n- giữ nguyên dữ liệu: \.claude\/release\.json\n/)
      assert.match(xem.stdout, /Dữ liệu trong app .* không quay theo\. Trạng thái phát hành cũng giữ nguyên\./)
      const quay = cliLuu('quay', root, p1.tag, '--khong-kiem')
      assert.equal(quay.status, 0, quay.stderr)
      assert.match(quay.stdout, /không quay theo; giữ nguyên: \.claude\/release\.json\. Trạng thái phát hành cũng giữ nguyên\./)
      assert.equal(quay.stdout.match(/không quay theo/g).length, 1)
    })

    test('release.json đang sửa dở không tính là việc dở và không vào .gitignore (health ghi mốc trong worktree rồi gộp nên vẫn phải commit được)', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); lu.bat(root, { now: at(0) })
      assert.equal(rd(root, '.gitignore').includes('release.json'), false)
      wr(root, '.claude/release.json', '{"v":1}\n'); wr(root, 'a.txt', '2'); g(root, 'add', '-f', '.claude/release.json'); commit(root, 'có release.json')
      wr(root, '.claude/release.json', '{"v":1,"health":{"lastAt":"x"}}\n')
      const p2 = lu.tao(root, 'Chỉ đổi mốc', { now: at(2) })
      assert.equal(p2.created, true, 'a.txt đã commit ⇒ HEAD chưa có điểm ⇒ gắn điểm; release.json dở không tạo commit')
      assert.equal(g(root, 'rev-parse', `${p2.tag}^{commit}`), g(root, 'rev-parse', 'HEAD'))
      const r = lu.quay(root, p2.tag, { ...noCheck, now: at(3) })
      assert.equal(r.status, 'same', 'không có việc dở nào ngoài release.json')
      assert.equal(rd(root, '.claude/release.json'), '{"v":1,"health":{"lastAt":"x"}}\n')
    })

    test('.claude/luu.json thêm mẫu dữ liệu của dự án', () => {
      const root = mk()
      wr(root, '.claude/luu.json', JSON.stringify({ data: ['exports/**', '*.csv'] })); wr(root, 'a.txt', '1')
      const p1 = lu.bat(root, { now: at(0) })
      wr(root, 'exports/r.txt', 'e1'); wr(root, 'sub/t.csv', 'c1'); wr(root, 'a.txt', '2')
      g(root, 'add', '-f', 'exports/r.txt', 'sub/t.csv'); commit(root, 'có xuất dữ liệu')
      wr(root, 'exports/r.txt', 'e2'); wr(root, 'sub/t.csv', 'c2'); g(root, 'add', '-f', '-A'); commit(root, 'đổi')
      lu.quay(root, p1.tag, { ...noCheck, now: at(5) })
      assert.equal(rd(root, 'exports/r.txt'), 'e2')
      assert.equal(rd(root, 'sub/t.csv'), 'c2')
      assert.equal(rd(root, 'a.txt'), '1')
    })

    test('.claude/luu.json hỏng hoặc có mẫu nguy hiểm ⇒ từ chối quay (không biết đâu là dữ liệu)', () => {
      const { root, p2 } = scenario()
      wr(root, '.claude/luu.json', '{ không phải json')
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /luu\.json không đọc được/)
      wr(root, '.claude/luu.json', JSON.stringify({ data: [':(top)src/**'] }))
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /không được bắt đầu bằng/)
      wr(root, '.claude/luu.json', JSON.stringify({ data: ['../ngoai/**'] }))
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /không được có "\.\."/)
      wr(root, '.claude/luu.json', JSON.stringify({ data: 'x' }))
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /danh sách/)
    })

    test('file riêng bị .gitignore mà điểm đích có sẵn trong git ⇒ dừng, không đè', () => {
      const root = mk()
      wr(root, 'a.txt', '1'); wr(root, 'notes.txt', 'bản trong git\n')
      const p1 = lu.bat(root, { now: at(0) })
      g(root, 'rm', '-q', '--cached', 'notes.txt'); wr(root, '.gitignore', `${rd(root, '.gitignore')}notes.txt\n`); commit(root, 'notes thành file riêng')
      wr(root, 'notes.txt', 'của riêng tôi\n')
      const e = caught(() => lu.quay(root, p1.tag, noCheck))
      assert.equal(e.exit, 1)
      assert.ok(e.lines.some((l) => l.includes('notes.txt')))
      assert.equal(rd(root, 'notes.txt'), 'của riêng tôi\n')
    })
  })

  describe('nơi chạy', () => {
    test('từ chối ở worktree (bản làm việc riêng)', () => {
      const { root, p2 } = scenario()
      const wt = path.join(TMP, `wt-quay ${++seq}`)
      g(root, 'worktree', 'add', '-q', '-b', 'nhanh-phu', wt)
      const e = caught(() => lu.quay(wt, p2.tag, noCheck))
      assert.match(e.message, /bản làm việc riêng/)
      assert.equal(has(wt, 'c.txt'), true, 'không đổi gì')
    })

    test('từ chối khi đang ở nhánh khác nhánh chính', () => {
      const { root, p2 } = scenario()
      g(root, 'switch', '-q', '-c', 'tinh-nang')
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /không phải nhánh chính/)
    })

    test('chấp nhận nhánh master và nhánh duy nhất bất kỳ tên', () => {
      const root = mk()
      g(root, 'init', '-q', '-b', 'master'); wr(root, 'a', '1'); commit(root, 'một')
      const p1 = lu.tao(root, 'Một', { now: at(0) })
      wr(root, 'a', '2'); commit(root, 'hai')
      assert.equal(lu.quay(root, p1.tag, { ...noCheck, now: at(1) }).status, 'done')
      const root2 = mk()
      g(root2, 'init', '-q', '-b', 'trunk'); wr(root2, 'a', '1'); commit(root2, 'một')
      const q1 = lu.tao(root2, 'Một', { now: at(0) })
      wr(root2, 'a', '2'); commit(root2, 'hai')
      assert.equal(lu.quay(root2, q1.tag, { ...noCheck, now: at(1) }).status, 'done')
    })

    test('từ chối khi HEAD tách rời', () => {
      const { root, p2 } = scenario()
      g(root, 'switch', '-q', '--detach', 'HEAD')
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /không đứng trên nhánh nào/)
    })

    test('từ chối khi đang gộp/rebase dở', () => {
      const { root, p2 } = scenario()
      const head = g(root, 'rev-parse', 'HEAD')
      fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), `${head}\n`)
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /gộp nhánh/)
      fs.rmSync(path.join(root, '.git', 'MERGE_HEAD'))
      fs.mkdirSync(path.join(root, '.git', 'rebase-merge'))
      assert.match(caught(() => lu.quay(root, p2.tag, noCheck)).message, /rebase/)
    })

    test('từ chối khi chạy ở thư mục con của dự án', () => {
      const { root, p2 } = scenario()
      assert.match(caught(() => lu.quay(path.join(root, 'notes'), p2.tag, noCheck)).message, /thư mục gốc của dự án/)
    })

    test('không phải git · điểm không tồn tại · điểm ngoài lịch sử nhánh chính · tên thiếu', () => {
      assert.match(caught(() => lu.quay(mk(), 'luu/x', noCheck)).message, /chưa dùng git/)
      const { root, p2 } = scenario()
      assert.match(caught(() => lu.quay(root, 'luu/khong-co', noCheck)).message, /Không có điểm lưu/)
      assert.match(caught(() => lu.quay(root, 'a b; rm -rf', noCheck)).message, /Không có điểm lưu/)
      assert.equal(caught(() => lu.quay(root, '', noCheck)).exit, 2)
      const wt = path.join(TMP, `wt-ngoai ${++seq}`)
      g(root, 'worktree', 'add', '-q', '-b', 'nhanh-ngoai', wt)
      wr(wt, 'z.txt', 'z'); commit(wt, 'việc nhánh ngoài')
      const out = lu.tao(wt, 'Điểm ở nhánh ngoài', { now: at(45) })
      assert.match(caught(() => lu.quay(root, out.tag, noCheck)).message, /không nằm trong lịch sử/)
      assert.ok(p2)
    })
  })

  describe('máy kiểm sau khi quay', () => {
    test('chạy runCheck với thư mục gốc và trả kết quả, lỗi của máy kiểm không làm hỏng quay', () => {
      const { root, p2 } = scenario()
      const seen = []
      const r = lu.quay(root, p2.tag, { runCheck: (d) => { seen.push(d); return { exit: 1, lines: ['KHÔNG x'] } }, now: at(30) })
      assert.equal(seen.length, 1)
      assert.equal(fs.realpathSync(seen[0]), fs.realpathSync(root))
      assert.deepEqual(r.check, { exit: 1, lines: ['KHÔNG x'] })
      assert.equal(r.status, 'done')
    })
    test('runCheck: null ⇒ bỏ qua', () => {
      const { root, p2 } = scenario()
      assert.equal(lu.quay(root, p2.tag, { runCheck: null, now: at(30) }).check, null)
    })
    test('checkSummary: chỉ MỘT dòng tổng — "đạt", hoặc "N mục chưa đạt" kèm lệnh xem chi tiết (nháy khi đường dẫn có dấu cách)', () => {
      const ctx = { script: '/kit/hooks/flow-check.mjs', root: '/dự án/x y' }
      assert.deepEqual(lu.checkSummary({ ok: true, summary: { pass: 9, fail: 0, missing: 1, skip: 3, missingRequired: 0 } }, ctx), { exit: 0, lines: ['Máy kiểm sau khi quay: đạt.'] })
      const bad = lu.checkSummary({ ok: false, summary: { pass: 4, fail: 2, missing: 3, skip: 0, missingRequired: 1 } }, ctx)
      assert.equal(bad.exit, 1)
      assert.deepEqual(bad.lines, ['Máy kiểm sau khi quay: 3 mục chưa đạt (không chặn). Xem chi tiết: node /kit/hooks/flow-check.mjs --dir "/dự án/x y"'])
      assert.match(lu.checkSummary({ ok: false, summary: { fail: 1, missingRequired: 0 } }, { script: '/k/flow-check.mjs', root: '/p' }).lines[0], /1 mục chưa đạt.*node \/k\/flow-check\.mjs --dir \/p$/)
      assert.match(lu.checkSummary({}, ctx).lines[0], /không cho ra kết quả/)
      assert.match(lu.checkSummary(null, ctx).lines[0], /không cho ra kết quả/)
    })
    test('defaultRunCheck (chạy flow-check thật): trả đúng một dòng, không có dòng bảng ĐẠT/KHÔNG/THIẾU', () => {
      const root = mk()
      wr(root, 'a.txt', 'x')
      const r = lu.defaultRunCheck(root)
      assert.equal(r.lines.length, 1, r.lines.join(' | '))
      assert.match(r.lines[0], /^Máy kiểm sau khi quay: (đạt\.|\d+ mục chưa đạt \(không chặn\)\. Xem chi tiết: node )/)
      assert.doesNotMatch(r.lines[0], /THIẾU|Kết quả/)
    })
  })
})

describe('chữ và đường dẫn', () => {
  test('slugOf · plain · oneLine', () => {
    assert.equal(lu.slugOf('Đăng nhập bằng Google!'), 'dang-nhap-bang-google')
    assert.equal(lu.slugOf('***'), 'diem-luu')
    assert.equal(lu.plain('Đảo Phú Quốc'), 'dao phu quoc')
    assert.equal(lu.oneLine('  a\u200b\tb\n\x01c  '), 'a b c')
    assert.equal(lu.oneLine('x'.repeat(10), 5), 'xxxx…')
    assert.equal(lu.oneLine('Tie\u0302\u0301ng'.normalize('NFD')), 'Tie\u0302\u0301ng'.normalize('NFC'))
  })
  test('dataGlobs: mặc định + luu.json; excludeSpecs chuẩn hoá mẫu', () => {
    const root = mk()
    assert.deepEqual(lu.dataGlobs(root), lu.DEFAULT_DATA)
    wr(root, '.claude/luu.json', JSON.stringify({ data: ['exports/', '*.csv', '/top.txt', 'a/b/**'] }))
    const specs = lu.excludeSpecs(lu.dataGlobs(root))
    assert.ok(specs.includes(':(exclude,glob,top)**/*.db'))
    assert.ok(specs.includes(':(exclude,glob,top)data/**'))
    assert.ok(specs.includes(':(exclude,glob,top)exports/**'))
    assert.ok(specs.includes(':(exclude,glob,top)**/*.csv'))
    assert.ok(specs.includes(':(exclude,glob,top)top.txt'))
    assert.ok(specs.includes(':(exclude,glob,top)a/b/**'))
  })
})

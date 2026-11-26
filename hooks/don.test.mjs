import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classify, don, quet } from './don.mjs'

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'don-')))
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
function repo() {
  const root = tmp()
  git(root, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'a.txt'), 'x')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'a')
  return root
}

describe('don: từ chối', () => {
  const cwd = tmp()
  const refused = (p, re, opts = { cwd }) => {
    const c = classify(p, opts)
    assert.ok(c.refuse, `phải từ chối ${p}: ${JSON.stringify(c)}`)
    if (re) assert.match(c.refuse, re)
  }
  test('ký tự đại diện, biến', () => {
    refused(path.join(cwd, '*'), /đại diện/)
    refused('$HOME/x', /đại diện/)
    refused('%USERPROFILE%\\x', /đại diện/)
  })
  test('gốc ổ đĩa, thư mục người dùng', () => {
    refused(path.parse(cwd).root, /gốc ổ đĩa/)
    refused(os.homedir(), /người dùng/)
  })
  test('đang đứng trong đó hoặc là cha của chỗ đang đứng', () => {
    const inner = path.join(cwd, 'con')
    fs.mkdirSync(inner)
    refused(cwd, /đang đứng/, { cwd: inner })
    refused(inner, /đang đứng/, { cwd: inner })
  })
  test('thư mục tạm gốc', () => refused(os.tmpdir(), /thư mục tạm|đang đứng|người dùng/))
  test('file thường', () => {
    const f = path.join(cwd, 'f.txt')
    fs.writeFileSync(f, 'x')
    refused(f, /không phải thư mục/)
  })
})

describe('don: thư mục tạm', () => {
  test('dọn được thư mục thường', () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'con'))
    fs.writeFileSync(path.join(d, 'con', 'x.txt'), 'x')
    const r = don(d, { cwd: os.homedir() })
    assert.equal(r.ok, true, r.line)
    assert.equal(fs.existsSync(d), false)
  })
  test('có repo git độc lập ngay đây hoặc ở thư mục con ⇒ từ chối, không mất gì', () => {
    const d = repo()
    assert.match(classify(d, { cwd: os.homedir() }).refuse, /repo git độc lập/)
    assert.equal(don(d, { cwd: os.homedir() }).ok, false)
    assert.equal(fs.existsSync(path.join(d, 'a.txt')), true)
    const cha = tmp()
    fs.mkdirSync(path.join(cha, 'a', 'b', '.git'), { recursive: true })
    assert.match(classify(cha, { cwd: os.homedir() }).refuse, /repo git độc lập/)
  })
  test('không có sẵn ⇒ coi như xong', () => {
    assert.equal(don(path.join(os.tmpdir(), 'don-khong-co-that-123')).ok, true)
  })
})

describe('don: thư mục build (coi như nằm ngoài thư mục tạm)', () => {
  test('dọn dist không bị git theo dõi; từ chối build có file đã theo dõi; từ chối thư mục thường', () => {
    const root = tmp()
    const opts = { cwd: root, temps: [] }
    git(root, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist\n')
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'dist', 'x.js'), 'x')
    fs.mkdirSync(path.join(root, 'build'))
    fs.writeFileSync(path.join(root, 'build', 'y.js'), 'y')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'z.js'), 'z')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'a')
    const r = don(path.join(root, 'dist'), opts)
    assert.equal(r.ok, true, r.line)
    assert.equal(fs.existsSync(path.join(root, 'dist')), false)
    assert.match(classify(path.join(root, 'build'), opts).refuse, /git đang theo dõi/)
    assert.match(classify(path.join(root, 'src'), opts).refuse, /không phải thư mục tạm/)
    assert.ok(classify(root, { cwd: os.homedir(), temps: [] }).refuse)
  })
  test('tên giống build nhưng git không bỏ qua (có thể là code chưa commit) ⇒ từ chối, không mất gì', () => {
    const root = repo()
    fs.mkdirSync(path.join(root, 'out'))
    fs.writeFileSync(path.join(root, 'out', 'moi.ts'), 'x')
    const opts = { cwd: root, temps: [] }
    assert.match(classify(path.join(root, 'out'), opts).refuse, /không bỏ qua/)
    assert.equal(don(path.join(root, 'out'), opts).ok, false)
    assert.equal(fs.existsSync(path.join(root, 'out', 'moi.ts')), true)
  })
  test('repo độc lập trong thư mục tên build ⇒ từ chối', () => {
    const root = repo()
    fs.writeFileSync(path.join(root, '.gitignore'), 'build\n')
    fs.mkdirSync(path.join(root, 'build', '.git'), { recursive: true })
    assert.match(classify(path.join(root, 'build'), { cwd: root, temps: [] }).refuse, /repo git độc lập/)
  })
  test('thư mục con của repo nằm trong thư mục tạm ⇒ xét như trong dự án, không xoá nhầm', () => {
    const root = repo() // repo() tạo trong thư mục tạm thật
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'moi.ts'), 'x')
    assert.ok(classify(path.join(root, 'src'), { cwd: root }).refuse)
    assert.equal(don(path.join(root, 'src'), { cwd: root }).ok, false)
    assert.equal(fs.existsSync(path.join(root, 'src', 'moi.ts')), true)
  })
  test('repo độc lập nằm sâu nhiều cấp ⇒ từ chối', () => {
    const cha = tmp()
    fs.mkdirSync(path.join(cha, 'a', 'b', 'c', 'd', '.git'), { recursive: true })
    assert.match(classify(cha, { cwd: os.homedir() }).refuse, /repo git độc lập/)
  })
  test('src/target bị .gitignore bỏ qua nhưng không ở gốc dự án ⇒ từ chối; cạnh package.json thì dọn được', () => {
    const root = repo()
    fs.writeFileSync(path.join(root, '.gitignore'), 'target/\ndist/\nnode_modules/\n')
    fs.mkdirSync(path.join(root, 'src', 'target'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'target', 'moi.ts'), 'x')
    fs.mkdirSync(path.join(root, 'apps', 'web', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps', 'web', 'package.json'), '{}')
    fs.mkdirSync(path.join(root, 'libs', 'x', 'node_modules'), { recursive: true })
    const opts = { cwd: root, temps: [] }
    assert.match(classify(path.join(root, 'src', 'target'), opts).refuse, /thư mục code/)
    assert.equal(classify(path.join(root, 'apps', 'web', 'dist'), opts).kind, 'build')
    assert.equal(classify(path.join(root, 'libs', 'x', 'node_modules'), opts).kind, 'build')
  })
  test('thư mục tên dist không nằm trong repo nào ⇒ từ chối', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'dist'))
    assert.match(classify(path.join(root, 'dist'), { cwd: root, temps: [] }).refuse, /git repo/)
  })
})

describe('don: worktree', () => {
  const addWt = (root, name) => {
    const wt = path.join(root, '.wt', name)
    git(root, 'worktree', 'add', '-q', '-b', name, wt)
    return fs.realpathSync.native(wt)
  }
  test('đã gộp sạch ⇒ gỡ, nhánh chính không đổi', () => {
    const root = repo()
    const wt = addWt(root, 'xong')
    const r = don(wt, { cwd: root })
    assert.equal(r.ok, true, r.line)
    assert.match(r.line, /worktree/)
    assert.equal(fs.existsSync(wt), false)
    assert.equal(git(root, 'worktree', 'list').includes('xong'), false)
    assert.equal(fs.existsSync(path.join(root, 'a.txt')), true)
  })
  test('còn thay đổi chưa commit ⇒ từ chối, không mất gì', () => {
    const root = repo()
    const wt = addWt(root, 'do')
    fs.writeFileSync(path.join(wt, 'moi.txt'), 'x')
    assert.match(classify(wt, { cwd: root }).refuse, /chưa commit/)
    assert.equal(don(wt, { cwd: root }).ok, false)
    assert.equal(fs.existsSync(path.join(wt, 'moi.txt')), true)
  })
  test('còn commit chưa gộp ⇒ từ chối', () => {
    const root = repo()
    const wt = addWt(root, 'chua')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'x')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'b')
    assert.match(classify(wt, { cwd: root }).refuse, /chưa gộp/)
  })
  test('đang khoá ⇒ từ chối', () => {
    const root = repo()
    const wt = addWt(root, 'khoa')
    git(root, 'worktree', 'lock', wt)
    assert.match(classify(wt, { cwd: root }).refuse, /khoá/)
  })
  test('nhánh chính theo origin/HEAD: repo dùng master mà có nhánh main phụ vẫn đối chiếu đúng', () => {
    const root = repo()
    git(root, 'branch', '-m', 'main', 'master')
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
    const wt = addWt(root, 'viec')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'x')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'b')
    git(root, 'branch', 'main', 'viec') // nhánh main phụ trùng HEAD của worktree
    assert.match(classify(wt, { cwd: root }).refuse, /chưa gộp vào master/)
  })
  test('có cả main lẫn master mà không có origin/HEAD ⇒ từ chối', () => {
    const root = repo()
    git(root, 'branch', 'master')
    const wt = addWt(root, 'hai')
    assert.match(classify(wt, { cwd: root }).refuse, /cả main lẫn master/)
  })
  test('worktree có repo hoặc worktree lồng bên trong phần bị ignore ⇒ từ chối, không mất gì', () => {
    const root = repo()
    fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'ignore')
    const wt = addWt(root, 'long')
    fs.mkdirSync(path.join(wt, '.claude', 'worktrees', 'b', '.git'), { recursive: true })
    assert.match(classify(wt, { cwd: root }).refuse, /lồng/)
    assert.equal(don(wt, { cwd: root }).ok, false)
    assert.equal(fs.existsSync(path.join(wt, '.claude', 'worktrees', 'b')), true)
  })
  test('repo bare trong thư mục tạm ⇒ từ chối', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'HEAD'), 'ref: refs/heads/main\n')
    fs.mkdirSync(path.join(d, 'objects'))
    fs.mkdirSync(path.join(d, 'refs'))
    assert.match(classify(d, { cwd: os.homedir() }).refuse, /repo git độc lập/)
  })
  test('thư mục con của repo mà git báo lỗi ⇒ từ chối, không coi là thư mục tạm', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, 'src'))
    assert.match(classify(path.join(root, 'src'), { cwd: os.homedir() }).refuse, /git đang báo lỗi/)
  })
  test('thư mục chính của repo không phải worktree phụ', () => {
    const root = repo()
    const c = classify(root, { cwd: os.homedir() })
    assert.notEqual(c.kind, 'worktree')
  })
})

describe('don --quet: đồ tạm cũ không ai đụng [12e1]', () => {
  const DAY = 86400000
  const cwd = os.homedir()
  const lamCu = (p) => { const t = new Date(Date.now() - 30 * DAY); fs.utimesSync(p, t, t) }
  const later = Date.now() + 30 * DAY // nhìn từ 30 ngày sau: mọi thứ vừa tạo đều đã cũ
  const names = (list) => list.map((x) => path.basename(x.path)).sort()

  function mixed() {
    const root = tmp()
    const cu = path.join(root, 'cu')
    fs.mkdirSync(cu)
    fs.writeFileSync(path.join(cu, 'a.log'), 'xyz')
    lamCu(path.join(cu, 'a.log'))
    lamCu(cu)
    fs.writeFileSync(path.join(root, 'le.png'), 'xx')
    lamCu(path.join(root, 'le.png'))
    fs.mkdirSync(path.join(root, 'moi'))
    const lai = path.join(root, 'lai') // thư mục cũ nhưng bên trong có file vừa sửa
    fs.mkdirSync(path.join(lai, 'con'), { recursive: true })
    fs.writeFileSync(path.join(lai, 'con', 'vua-sua.txt'), 'x')
    lamCu(path.join(lai, 'con'))
    lamCu(lai)
    return root
  }

  const theoGioSua = (st) => st.mtimeMs // các test dựng đồ "cũ" bằng cách chỉnh giờ sửa ⇒ chỉ nhìn giờ sửa

  test('thư mục cũ và file lẻ cũ bị dọn; mục còn mới và thư mục cũ có file vừa sửa bên trong thì giữ nguyên', () => {
    const root = mixed()
    const r = quet({ roots: [root], cwd, stamp: theoGioSua })
    assert.deepEqual(names(r.removed), ['cu', 'le.png'])
    assert.equal(r.fresh, 2)
    assert.equal(r.bytes, 5)
    assert.deepEqual(fs.readdirSync(root).sort(), ['lai', 'moi'])
    assert.equal(fs.existsSync(path.join(root, 'lai', 'con', 'vua-sua.txt')), true)
  })

  test('chạy thử (dry) kể đúng những mục sẽ dọn nhưng không xoá gì', () => {
    const root = mixed()
    const r = quet({ roots: [root], cwd, dry: true, stamp: theoGioSua })
    assert.deepEqual(names(r.removed), ['cu', 'le.png'])
    assert.deepEqual(fs.readdirSync(root).sort(), ['cu', 'lai', 'le.png', 'moi'])
  })

  test('đồ vừa đưa vào hôm nay nhưng giờ sửa cũ (vừa giải nén, vừa chép vào) ⇒ còn mới, không dọn', () => {
    const root = mixed() // mọi thứ vừa tạo; một số bị chỉnh giờ sửa lùi 30 ngày
    const r = quet({ roots: [root], cwd })
    assert.deepEqual(r.removed, [])
    assert.equal(r.fresh, 4)
    assert.deepEqual(fs.readdirSync(root).sort(), ['cu', 'lai', 'le.png', 'moi'])
  })

  test('bản tải về nguyên vẹn thì dọn; mọi repo còn thứ chỉ có ở máy này thì giữ và không mất gì', () => {
    const origin = repo()
    const root = tmp()
    const NET = 'https://example.invalid/x.git'
    const clone = (name, url = NET) => {
      const d = path.join(root, name)
      git(root, 'clone', '-q', origin, d)
      if (url) git(d, 'remote', 'set-url', 'origin', url)
      return d
    }
    clone('sach')
    const coCommit = clone('co-commit')
    fs.writeFileSync(path.join(coCommit, 'moi.txt'), 'x')
    git(coCommit, 'add', '.')
    git(coCommit, 'commit', '-qm', 'chua day')
    fs.writeFileSync(path.join(clone('co-file-moi'), 'nhap.txt'), 'việc dở chưa add')
    clone('noi-day-tai-may', null) // nơi đẩy lên là một đường dẫn trên máy
    const long = clone('long') // repo ngoài sạch, nhưng bên trong (phần bị bỏ qua) có repo riêng chỉ nằm trên máy
    fs.appendFileSync(path.join(long, '.git', 'info', 'exclude'), 'vendor/\n')
    fs.mkdirSync(path.join(long, 'vendor', 'lib'), { recursive: true })
    git(path.join(long, 'vendor', 'lib'), 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(long, 'vendor', 'lib', 'c.txt'), 'x')
    git(path.join(long, 'vendor', 'lib'), 'add', '.')
    git(path.join(long, 'vendor', 'lib'), 'commit', '-qm', 'c')
    const rieng = path.join(root, 'rieng')
    fs.mkdirSync(rieng)
    git(rieng, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(rieng, 'b.txt'), 'x')
    git(rieng, 'add', '.')
    git(rieng, 'commit', '-qm', 'b')
    git(origin, 'worktree', 'add', '-q', '-b', 'wt', path.join(root, 'wt'))
    const r = quet({ roots: [root], cwd, now: later })
    assert.deepEqual(names(r.removed), ['sach'])
    assert.deepEqual(fs.readdirSync(root).sort(), ['co-commit', 'co-file-moi', 'long', 'noi-day-tai-may', 'rieng', 'wt'])
    const why = Object.fromEntries(r.kept.map((x) => [path.basename(x.path), x.why]))
    assert.match(why['co-commit'], /chưa đẩy lên/)
    assert.match(why['co-file-moi'], /file mới/)
    assert.match(why['noi-day-tai-may'], /chỉ nằm trên máy/)
    assert.match(why.long, /chỉ nằm trên máy/)
    assert.match(why.rieng, /chỉ nằm trên máy/)
    assert.match(why.wt, /worktree/)
    for (const f of ['co-commit/moi.txt', 'co-file-moi/nhap.txt', 'long/vendor/lib/c.txt', 'rieng/b.txt', 'wt/a.txt']) assert.equal(fs.existsSync(path.join(root, f)), true, f)
  })

  test('thư mục cũ đang có tiến trình đứng bên trong ⇒ giữ nguyên, không mất file nào', { skip: process.platform !== 'win32' }, async () => {
    const root = tmp()
    const dang = path.join(root, 'dang-dung')
    fs.mkdirSync(path.join(dang, 'con'), { recursive: true })
    fs.writeFileSync(path.join(dang, 'con', 'a.txt'), 'x')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: dang, stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 500))
      const r = quet({ roots: [root], cwd, now: later })
      assert.deepEqual(r.removed, [])
      assert.match(r.kept[0].why, /đang được dùng/)
      assert.equal(fs.existsSync(path.join(dang, 'con', 'a.txt')), true)
    } finally {
      child.kill()
    }
  })

  test('liên kết tắt tới thư mục khác ⇒ giữ, thư mục đích không mất gì', () => {
    const dich = tmp()
    fs.writeFileSync(path.join(dich, 'quy.txt'), 'x')
    const root = tmp()
    fs.symlinkSync(dich, path.join(root, 'lk'), 'junction')
    const r = quet({ roots: [root], cwd, now: later })
    assert.deepEqual(r.removed, [])
    assert.match(r.kept[0].why, /liên kết tắt/)
    assert.equal(fs.existsSync(path.join(dich, 'quy.txt')), true)
  })

  test('có mốc bật (lượt tự quét): đồ có từ trước mốc không bao giờ bị đụng dù cũ tới đâu; đồ tạo sau mốc thì dọn như thường', () => {
    const root = mixed() // mọi thứ vừa tạo ra lúc này
    const truoc = quet({ roots: [root], cwd, now: later, since: Date.now() + 60000 }) // bật tự dọn SAU khi đống này đã có
    assert.deepEqual(truoc.removed, [])
    assert.deepEqual(truoc.kept, [])
    assert.equal(truoc.before, 4)
    assert.deepEqual(fs.readdirSync(root).sort(), ['cu', 'lai', 'le.png', 'moi'])
    const sau = quet({ roots: [root], cwd, now: later, since: Date.now() - 3600000 }) // đống này sinh ra sau khi bật
    assert.equal(sau.before, 0)
    assert.deepEqual(names(sau.removed), ['cu', 'lai', 'le.png', 'moi'])
    assert.deepEqual(fs.readdirSync(root), [])
  })

  test('mốc bật không phải số ⇒ không chạy (không bao giờ rơi về quét không mốc)', () => {
    assert.throws(() => quet({ roots: [mixed()], cwd, since: Number.NaN }), /mốc --tu/)
    // Gọi qua dòng lệnh luôn kèm --thu: lỡ phần kiểm mốc bị làm hỏng thì bài này cũng chỉ liệt kê, không xoá gì trên máy thật.
    const script = fileURLToPath(new URL('./don.mjs', import.meta.url))
    // Gọi hàm: 0 = không truyền mốc (user bảo dọn cả đồ cũ); mọi mốc khác trước ngày tính năng ra đời đều bị từ chối.
    for (const bad of [-5, 1, Date.UTC(2020, 0, 1), Number.POSITIVE_INFINITY]) {
      assert.throws(() => quet({ roots: [], cwd, since: bad }), /mốc --tu/, String(bad))
    }
    // '', ' ', '0', '0x0' qua Number() đều ra 0 ("không mốc"); mốc trước ngày tính năng ra đời cũng coi như không mốc ⇒ tất cả phải bị từ chối.
    const tails = [[], ['abc'], [''], [' '], ['0'], ['-0'], ['0x0'], ['1'], ['-5'], ['1e15'], [String(Date.UTC(2020, 0, 1))], ['--ngay', '7']]
    for (const args of tails.map((t) => ['--quet', '--thu', '--tu', ...t])) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true })
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.match(r.stderr, /mốc --tu/)
      assert.equal(r.stdout, '', 'không được liệt kê hay dọn gì khi mốc sai')
    }
  })

  test('số ngày dưới 1 ⇒ không chạy (tránh xoá đồ đang dùng)', () => {
    assert.throws(() => quet({ roots: [mixed()], cwd, days: 0 }), /từ 1 trở lên/)
    assert.throws(() => quet({ roots: [], cwd, days: Number.NaN }), /từ 1 trở lên/)
  })
})

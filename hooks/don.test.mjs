import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { classify, don } from './don.mjs'

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

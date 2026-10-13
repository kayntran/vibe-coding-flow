// Test cho CLI new-app.mjs: node --test hooks/new-app.test.mjs
// Không mạng: phần chạy trong tiến trình tiêm lệnh ngoài giả (io.run); phần spawn script thật chỉ thử những ca bị từ chối TRƯỚC khi chạy lệnh nào.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './new-app.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'new-app.mjs')
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-app cli thử ')))
const GITCFG = path.join(TMP, 'gitconfig')
fs.writeFileSync(GITCFG, '')
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.t' })
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

let seq = 0
const mk = () => { const d = path.join(TMP, `cha ${++seq}`); fs.mkdirSync(d, { recursive: true }); return d }
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: process.env })

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null })
const ENOENT = { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'không thấy' } }
function fakeRun({ missing = [] } = {}) {
  const calls = []
  const run = (cmd, args = [], o = {}) => {
    calls.push({ cmd, args, cwd: o.cwd })
    if (missing.includes(cmd)) return ENOENT
    if (cmd === 'git') return spawnSync('git', args, { cwd: o.cwd, encoding: 'utf8' })
    if (/^(--version|version)$/.test(args[0] ?? '')) return ok(cmd === 'pnpm' ? '12.9.1\n' : '11.19.0\n')
    if (args.some((a) => String(a).startsWith('shadcn@'))) {
      const d = path.join(o.cwd, args[args.indexOf('-n') + 1])
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'package.json'), '{ "name": "x", "scripts": { "dev": "vite" } }\n')
      fs.writeFileSync(path.join(d, 'components.json'), '{}\n')
      fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules\n')
    }
    return ok()
  }
  return { run, calls }
}

describe('dùng sai ⇒ exit 2', () => {
  test('không đối số: in cách dùng, exit 2', () => {
    const r = cli([])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /thiếu lệnh[\s\S]*dùng: new-app\.mjs/)
  })
  test('--help: exit 0', () => {
    const r = cli(['--help'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /doctor --type/)
    assert.match(r.stdout, /create --type/)
  })
  for (const [name, args, re] of [
    ['thiếu --type', ['doctor'], /thiếu --type/],
    ['loại chưa có mẫu', ['doctor', '--type', 'mobile'], /chưa có mẫu/],
    ['create thiếu --name', ['create', '--type', 'web'], /thiếu --name/],
    ['tên có dấu', ['create', '--type', 'web', '--name', 'Tên Có Dấu'], /chưa dùng được/],
    ['cờ lạ', ['doctor', '--type', 'web', '--xyz'], /cờ lạ/],
    ['cờ thiếu giá trị', ['create', '--type', 'web', '--name'], /cần một giá trị/],
    ['lệnh lạ', ['xoa', '--type', 'web'], /lệnh lạ/],
    ['thừa đối số', ['doctor', 'them', '--type', 'web'], /thừa đối số/],
  ]) {
    test(name, () => {
      const r = cli(args)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, re)
    })
  }
})

describe('từ chối trước khi chạy lệnh nào (spawn script thật)', () => {
  test('thư mục đích đã có đồ ⇒ exit 1, câu đời thường, file của người dùng còn nguyên', () => {
    const parent = mk()
    fs.mkdirSync(path.join(parent, 'don-hang'))
    fs.writeFileSync(path.join(parent, 'don-hang', 'ghi-chu.txt'), 'giữ lại')
    const r = cli(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /lỗi: Thư mục .*don-hang đã có đồ bên trong/)
    assert.equal(fs.readFileSync(path.join(parent, 'don-hang', 'ghi-chu.txt'), 'utf8'), 'giữ lại')
    assert.equal(r.stdout, '')
  })
})

describe('doctor (lệnh ngoài giả)', () => {
  test('đủ đồ ⇒ exit 0, một dòng; --json ra JSON', async () => {
    const r = await main(['doctor', '--type', 'web'], { run: fakeRun().run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(r.code, 0)
    assert.match(r.lines[0], /^Máy đủ phần mềm để tạo webapp \(.*pnpm 12\.9\.1.*\)\. Trình quản lý gói sẽ dùng: pnpm\.$/)
    const j = await main(['doctor', '--type', 'web', '--json'], { run: fakeRun().run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(JSON.parse(j.lines[0]).ok, true)
  })

  test('thiếu Go và Wails ⇒ exit 3, chỉ in lệnh cài của hệ điều hành đang chạy, không cài gì', async () => {
    const { run, calls } = fakeRun({ missing: ['go', 'wails'] })
    const r = await main(['doctor', '--type', 'desktop'], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(r.code, 3)
    const text = r.lines.join('\n')
    assert.match(text, /thiếu \d+ thứ để tạo app máy tính/)
    assert.match(text, /Windows: winget install GoLang\.Go/)
    assert.doesNotMatch(text, /Mac:/, 'chạy trên Windows ⇒ không in lệnh Mac')
    assert.match(text, /go install github\.com\/wailsapp\/wails\/v2\/cmd\/wails@v/)
    assert.ok(calls.every((c) => /^(--version|version|query)$/.test(c.args[0])))
    const mac = await main(['doctor', '--type', 'desktop'], { run: fakeRun({ missing: ['go', 'wails'] }).run, platform: 'darwin', nodeVersion: '26.8.1' })
    const macText = mac.lines.join('\n')
    assert.match(macText, /Mac: brew install go/)
    assert.doesNotMatch(macText, /Windows|winget/, 'chạy trên Mac ⇒ không in câu Windows')
  })

  test('Node cũ ⇒ exit 3', async () => {
    const r = await main(['doctor', '--type', 'extension'], { run: fakeRun().run, platform: 'win32', nodeVersion: '18.0.0' })
    assert.equal(r.code, 3)
    assert.match(r.lines.join('\n'), /node: Node 18\.0\.0 cũ hơn/)
  })
})

describe('create (lệnh ngoài giả)', () => {
  test('xong ⇒ exit 0, nói app ở đâu, điểm lưu, lệnh chạy thử và địa chỉ', async () => {
    const parent = mk()
    const { run } = fakeRun()
    const logs = []
    const r = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent], { run, platform: 'win32', log: (s) => logs.push(s) })
    assert.equal(r.code, 0, r.errLines.join('\n'))
    const text = r.lines.join('\n')
    assert.match(text, /^Đã tạo app "don-hang" \(webapp\) ở /)
    assert.match(text, /Điểm lưu: "Tạo app" \(luu\/\d{8}-\d{4}-tao-app\)/)
    assert.match(text, /Chạy thử: cd ".*don-hang" && pnpm dev/)
    assert.match(text, /Mở: http:\/\/localhost:5173/)
    assert.ok(logs.length >= 6)
    assert.ok(fs.existsSync(path.join(parent, 'don-hang', 'AI_RULES.md')))
  })

  test('--json ra đủ kết quả cho captain', async () => {
    const parent = mk()
    const r = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent, '--json'], { run: fakeRun().run, platform: 'win32' })
    const j = JSON.parse(r.lines[0])
    assert.equal(j.name, 'don-hang')
    assert.equal(j.pm, 'pnpm')
    assert.match(j.luu.tag, /tao-app$/)
    assert.equal(j.next.url, 'http://localhost:5173')
  })

  test('đã có đồ ⇒ exit 1; thiếu phần mềm ⇒ exit 3 và nêu lệnh cài; --pm npm dùng npx', async () => {
    const parent = mk()
    fs.mkdirSync(path.join(parent, 'don-hang'))
    fs.writeFileSync(path.join(parent, 'don-hang', 'a.txt'), 'x')
    const busy = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent], { run: fakeRun().run })
    assert.equal(busy.code, 1)
    assert.match(busy.errLines.join('\n'), /đã có đồ bên trong/)

    const none = await main(['create', '--type', 'web', '--name', 'moi', '--dir', parent], { run: fakeRun({ missing: ['git'] }).run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(none.code, 3)
    assert.match(none.errLines.join('\n'), /Windows: winget install Git\.Git/)

    const { run, calls } = fakeRun()
    const npm = await main(['create', '--type', 'web', '--name', 'dung-npm', '--dir', parent, '--pm', 'npm'], { run, platform: 'win32' })
    assert.equal(npm.code, 0, npm.errLines.join('\n'))
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args[0] === '--yes'))
  })

  test('lệnh tạo lỗi mạng ⇒ exit 1, một câu đời thường + chi tiết ngắn (JSON có kind)', async () => {
    const parent = mk()
    const run = (cmd, args = []) => {
      if (/^(--version|version)$/.test(args[0] ?? '')) return cmd === 'git' ? spawnSync('git', args, { encoding: 'utf8' }) : ok('1.0.0\n')
      return { status: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org', error: null }
    }
    const r = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(r.code, 1)
    assert.match(r.errLines[0], /^lỗi: Không tải được thư viện từ mạng/)
    assert.match(r.errLines[0], /Chi tiết: getaddrinfo ENOTFOUND/)
    const j = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent, '--json'], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(JSON.parse(j.lines[0]).kind, 'network')
  })
})

// Test cho CLI new-app.mjs: node --test hooks/new-app.test.mjs
// Không mạng: phần chạy trong tiến trình tiêm lệnh ngoài giả (io.run); phần spawn script thật chỉ thử những ca bị từ chối TRƯỚC khi chạy lệnh nào.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as mainReal } from './new-app.mjs'
import { KIT_DIR, TYPES, loadTemplate, loadVersions } from './lib/new-app.mjs'

// doctor tìm công cụ của máy kiểm (osv-scanner, ast-grep…) bằng findTool của flow-check trên máy THẬT; test mặc định coi mọi công cụ là "có" (kết quả không phụ thuộc máy chạy test).
const main = (argv, io = {}) => mainReal(argv, { which: (name) => `/fake/bin/${name}`, ...io })

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
// Dự án mà create-cloudflare (--framework react-router) sinh ra: mã app ở app/, Worker ở workers/, welcome mẫu, chưa có git (--no-git).
function fakeCloudflare(cwd, name) {
  const d = path.join(cwd, name)
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text) }
  w('package.json', '{ "name": "x", "scripts": { "build": "react-router build", "dev": "react-router dev", "cf-typegen": "wrangler types" } }\n')
  for (const f of ['react-router.config.ts', 'wrangler.jsonc', 'vite.config.ts', 'tsconfig.json', 'tsconfig.cloudflare.json', 'workers/app.ts', 'app/root.tsx', 'app/routes.ts', 'app/routes/home.tsx', 'app/welcome/welcome.tsx']) w(f, '// do create-cloudflare sinh\n')
  w('app/welcome/logo-dark.svg', '<svg/>')
  w('app/welcome/logo-light.svg', '<svg/>')
  w('app/app.css', '@import "tailwindcss";\n')
  w('public/favicon.ico', 'ico')
  w('.gitignore', 'node_modules\n')
}
const ENOENT ={ status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'không thấy' } }
function fakeRun({ missing = [] } = {}) {
  const calls = []
  const run = (cmd, args = [], o = {}) => {
    calls.push({ cmd, args, cwd: o.cwd })
    if (missing.includes(cmd)) return ENOENT
    if (cmd === 'git') return spawnSync('git', args, { cwd: o.cwd, encoding: 'utf8' })
    if (/[\\/]ast-grep$/.test(cmd) && args[0] === '--version') return ok('ast-grep 0.40.0\n')
    if (/^(--version|version)$/.test(args[0] ?? '')) return ok(cmd === 'pnpm' ? '12.9.1\n' : '11.19.0\n')
    const c3 = args.findIndex((a) => String(a).startsWith('create-cloudflare@'))
    if (c3 >= 0) fakeCloudflare(o.cwd, args[c3 + 1])
    if (args.some((a) => String(a).startsWith('shadcn@')) && args.includes('-n')) {
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

  test('thiếu công cụ bắt buộc của máy kiểm (osv-scanner, ast-grep) ⇒ exit 3, in lệnh cài của hệ điều hành đang chạy, --json có missing', async () => {
    const which = (name) => (['osv-scanner', 'ast-grep', 'sg'].includes(name) ? null : `/fake/bin/${name}`)
    const io = { run: fakeRun().run, platform: 'win32', nodeVersion: '26.8.1', which }
    const r = await main(['doctor', '--type', 'extension'], io)
    assert.equal(r.code, 3)
    const text = r.lines.join('\n')
    assert.match(text, /thiếu \d+ thứ để tạo extension trình duyệt/)
    assert.match(text, /- osv-scanner: /)
    assert.match(text, /Windows: go install github\.com\/google\/osv-scanner\/v2\/cmd\/osv-scanner@latest/)
    assert.match(text, /- ast-grep: [\s\S]*Windows: npm i -g @ast-grep\/cli/)
    assert.doesNotMatch(text, /Mac:/)
    const j = JSON.parse((await main(['doctor', '--type', 'extension', '--json'], io)).lines[0])
    assert.equal(j.ok, false)
    assert.deepEqual(j.missing.map((m) => m.tool), ['osv-scanner', 'ast-grep'])
  })

  test('git CÓ nhưng không chạy được (EPERM) ⇒ exit 3, nói "không chạy được" chứ không nói "chưa có git"', async () => {
    const run = (cmd, args = []) => (cmd === 'git' ? { status: null, stdout: '', stderr: '', error: { code: 'EPERM', message: 'spawn git EPERM' } } : fakeRun().run(cmd, args))
    const r = await main(['doctor', '--type', 'web'], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(r.code, 3)
    const text = r.lines.join('\n')
    assert.match(text, /- git: .*không chạy được/)
    assert.doesNotMatch(text, /Chưa có git|thiếu \d+ thứ|winget/)
    const j = JSON.parse((await main(['doctor', '--type', 'web', '--json'], { run, platform: 'win32', nodeVersion: '26.8.1' })).lines[0])
    assert.deepEqual([j.missing.length, j.blocked.map((b) => b.tool)], [0, ['git']])
    const none = await main(['create', '--type', 'web', '--name', 'moi', '--dir', mk()], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(none.code, 3)
    assert.match(none.errLines.join('\n'), /không chạy được[\s\S]*- git: /)
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
      if (/[\\/]ast-grep$/.test(cmd) && args[0] === '--version') return ok('ast-grep 0.40.0\n')
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

  test('mạng bị chặn (EACCES kèm địa chỉ:cổng) ⇒ nói mạng, KHÔNG nói "quyền ghi vào thư mục"', async () => {
    const parent = mk()
    const run = (cmd, args = []) => {
      if (/[\\/]ast-grep$/.test(cmd) && args[0] === '--version') return ok('ast-grep 0.40.0\n')
      if (/^(--version|version)$/.test(args[0] ?? '')) return cmd === 'git' ? spawnSync('git', args, { encoding: 'utf8' }) : ok('1.0.0\n')
      return { status: 1, stdout: '', stderr: 'ERR_PNPM_META_FETCH_FAIL request to https://registry.npmjs.org/shadcn failed, reason: connect EACCES 104.16.6.34:443', error: null }
    }
    const r = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(r.code, 1)
    assert.match(r.errLines[0], /^lỗi: Không kết nối được mạng để tải thư viện/)
    assert.doesNotMatch(r.errLines[0], /quyền ghi/)
    const j = await main(['create', '--type', 'web', '--name', 'don-hang', '--dir', parent, '--json'], { run, platform: 'win32', nodeVersion: '26.8.1' })
    assert.equal(JSON.parse(j.lines[0]).kind, 'network')
  })
})

// ---------- web-public: webapp có trang công khai (React Router trên Cloudflare Workers) ----------

describe('web-public: loại app, bản ghim, Node theo loại', () => {
  test('TYPES có web-public; --help và lỗi loại lạ nhắc tới nó; mẫu nạp được và khai đủ lệnh sau khi tạo', () => {
    assert.deepEqual(TYPES, ['web', 'desktop', 'extension', 'web-public'])
    assert.match(cli(['--help']).stdout, /web\|desktop\|extension\|web-public/)
    assert.match(cli(['doctor', '--type', 'mobile']).stderr, /web-public/)
    const t = loadTemplate('web-public')
    assert.deepEqual([t.type, t.stack, t.install, t.build, t.browser], ['web-public', 'web', false, true, true])
    assert.deepEqual(t.after.map((s) => [s.runner, s.package ?? s.script ?? s.args.join(' ')]), [['pm-exec', 'shadcn'], ['pm-run', 'cf-typegen'], ['pm-bin', 'react-router typegen']])
    assert.deepEqual(t.after[0].args, ['init', '-d', '-t', 'react-router', '-y'])
    assert.equal(t.generate.package, 'create-cloudflare')
    assert.equal(t.generate.version, 'createCloudflare')
    assert.ok(t.generate.args.includes('--no-deploy') && t.generate.args.includes('--accept-defaults') && t.generate.args.includes('--no-git'), 'lệnh tạo không hỏi, không deploy, không git')
  })

  test('versions.json: createCloudflare + reactRouter ghim đúng dạng, reactRouter từ 8.5.1 (bản vá lỗ hổng); Node tối thiểu theo loại, ba loại cũ vẫn 22.12.0', () => {
    const v = loadVersions()
    assert.match(v.createCloudflare, /^\d+\.\d+\.\d+$/)
    assert.match(v.reactRouter, /^\d+\.\d+\.\d+$/)
    const [a, b, c] = v.reactRouter.split('.').map(Number)
    assert.ok(a > 8 || (a === 8 && (b > 5 || (b === 5 && c >= 1))), `reactRouter ${v.reactRouter} phải từ 8.5.1`)
    assert.equal(v.node.min, '22.12.0')
    assert.equal(v.node.byType['web-public'], '22.22.0')
    assert.ok(!('web' in v.node.byType) && !('desktop' in v.node.byType) && !('extension' in v.node.byType), 'ba loại cũ không bị nâng Node')
  })

  test('loadVersions từ chối reactRouter dưới 8.5.1 và byType trỏ loại không có / số bản sai', () => {
    const kit = path.join(mk(), 'kit')
    fs.mkdirSync(path.join(kit, 'templates'), { recursive: true })
    const real = JSON.parse(fs.readFileSync(path.join(KIT_DIR, 'templates', 'versions.json'), 'utf8'))
    const put = (v) => fs.writeFileSync(path.join(kit, 'templates', 'versions.json'), JSON.stringify(v))
    put({ ...real, reactRouter: '8.5.0' })
    assert.throws(() => loadVersions(kit), /ghim "reactRouter" 8\.5\.0, thấp hơn 8\.5\.1/)
    put({ ...real, node: { ...real.node, byType: { 'loai-la': '22.22.0' } } })
    assert.throws(() => loadVersions(kit), /node\.byType "loai-la"/)
    put({ ...real, node: { ...real.node, byType: { 'web-public': 'moi' } } })
    assert.throws(() => loadVersions(kit), /node\.byType "web-public"/)
    put(real)
    assert.doesNotThrow(() => loadVersions(kit))
  })

  test('doctor: Node 22.12.0 đủ cho web và extension nhưng CHƯA đủ cho web-public (cần 22.22.0); Node 22.22.0 thì đủ', async () => {
    const io = (nodeVersion) => ({ run: fakeRun().run, platform: 'win32', nodeVersion })
    for (const type of ['web', 'extension']) assert.equal((await main(['doctor', '--type', type], io('22.12.0'))).code, 0, type)
    const old = await main(['doctor', '--type', 'web-public'], io('22.12.0'))
    assert.equal(old.code, 3)
    assert.match(old.lines.join('\n'), /node: Node 22\.12\.0 cũ hơn bản cần \(22\.22\.0\)/)
    const fine = await main(['doctor', '--type', 'web-public'], io('22.22.0'))
    assert.equal(fine.code, 0, fine.lines.join('\n'))
    assert.match(fine.lines[0], /^Máy đủ phần mềm để tạo webapp có trang công khai/)
  })
})

describe('web-public: create (lệnh ngoài giả)', () => {
  const IO = { platform: 'win32', nodeVersion: '26.8.1' }
  const created = async (name = 'cua-hang') => {
    const parent = mk()
    const { run, calls } = fakeRun()
    const r = await main(['create', '--type', 'web-public', '--name', name, '--dir', parent, '--json'], { ...IO, run })
    assert.equal(r.code, 0, r.errLines.join('\n'))
    return { parent, dir: path.join(parent, name), calls, json: JSON.parse(r.lines[0]) }
  }
  const at = (calls, pred) => calls.findIndex(pred)

  test('đúng thứ tự: lệnh tạo create-cloudflare (ghim bản, không hỏi) → lớp phủ → shadcn init → cf-typegen → ghim React Router → công cụ kiểm → trình duyệt → dựng thử; chạy trong thư mục app', async () => {
    const { dir, calls, json } = await created()
    const v = loadVersions()
    const gen = at(calls, (c) => c.args.includes(`create-cloudflare@${v.createCloudflare}`))
    assert.deepEqual(calls[gen].args, ['dlx', `create-cloudflare@${v.createCloudflare}`, 'cua-hang', '--framework', 'react-router', '--no-deploy', '--no-git', '--no-open', '--no-agents', '--no-auto-update', '--accept-defaults'])
    const shadcn = at(calls, (c) => c.args.includes(`shadcn@${v.shadcn}`))
    const typegen = at(calls, (c) => c.cmd === 'pnpm' && c.args.join(' ') === 'run cf-typegen')
    const routeTypes = at(calls, (c) => c.cmd === 'pnpm' && c.args.join(' ') === 'exec react-router typegen')
    const router = at(calls, (c) => c.cmd === 'pnpm' && c.args[0] === 'add' && !c.args.includes('-D') && c.args.includes(`react-router@${v.reactRouter}`))
    const dev = at(calls, (c) => c.cmd === 'pnpm' && c.args[0] === 'add' && c.args.includes('-D'))
    const browser = at(calls, (c) => c.args.includes('playwright') && c.args.includes('install'))
    const build = at(calls, (c) => c.cmd === 'pnpm' && c.args.join(' ') === 'run build')
    assert.ok([gen, shadcn, typegen, routeTypes, router, dev, browser, build].every((i) => i >= 0), JSON.stringify([gen, shadcn, typegen, routeTypes, router, dev, browser, build]))
    assert.ok(gen < shadcn && shadcn < typegen && typegen < routeTypes && routeTypes < router && router < dev && dev < browser && browser < build, 'thứ tự các bước')
    assert.deepEqual(calls[shadcn].args, ['dlx', `shadcn@${v.shadcn}`, 'init', '-d', '-t', 'react-router', '-y'])
    for (const i of [shadcn, typegen, routeTypes, router, dev, browser, build]) assert.equal(path.resolve(calls[i].cwd), path.resolve(dir), 'lệnh sau khi tạo chạy trong thư mục app')
    assert.ok(calls[dev].args.includes(`@react-router/dev@${v.reactRouter}`), 'công cụ dev của React Router cùng số bản')
    assert.ok(calls[dev].args.includes(`@playwright/test@${v.playwright}`) && calls[dev].args.includes(`eslint@${v.eslint}`), 'công cụ kiểm + ESLint (create-cloudflare không cài ESLint)')
    assert.ok(json.steps.some((s) => s.id === 'after'), 'có bước "lệnh sau khi tạo"')
    assert.equal(json.next.url, 'http://localhost:5173')
  })

  test('lớp phủ: app/ chuyển sang src/, bỏ welcome mẫu, file của kit thay file của create-cloudflare, ảnh og-default.png sao chép nguyên byte, token điền đủ', async () => {
    const { dir } = await created()
    const has = (rel) => fs.existsSync(path.join(dir, rel))
    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8')
    assert.ok(!has('app') && !has('src/welcome'), 'app/ đã chuyển, welcome mẫu đã gỡ')
    for (const f of ['src/root.tsx', 'src/routes.ts', 'src/routes/home.tsx', 'src/routes/sitemap.xml.ts', 'src/routes/robots.txt.ts', 'src/entry.server.tsx', 'src/shared/server-context.ts', 'src/shared/security/headers.ts', 'src/shared/seo/seo-meta.ts', 'src/shared/seo/sitemap.ts', 'src/features/home/ui/home-screen.tsx', 'workers/app.ts', 'wrangler.jsonc', 'react-router.config.ts', 'e2e/seo.spec.ts', 'e2e/first-screen.spec.ts', 'playwright.config.ts', 'AI_RULES.md', 'public/_headers', 'pnpm-workspace.yaml', '.ignore']) assert.ok(has(f), `thiếu ${f}`)
    assert.doesNotMatch(read('src/root.tsx'), /do create-cloudflare sinh/, 'root.tsx là bản của kit')
    assert.match(read('react-router.config.ts'), /appDirectory: "src"/)
    assert.match(read('wrangler.jsonc'), /"name": "cua-hang"/)
    assert.match(read('wrangler.jsonc'), /"SITE_URL": "https:\/\/cua-hang\.example\.com"/)
    assert.match(read('src/features/home/ui/home-screen.tsx'), /<h1[^>]*>cua-hang<\/h1>/)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'public', 'og-default.png')), fs.readFileSync(path.join(KIT_DIR, 'templates', 'web-public', 'overlay', 'public', 'og-default.png')), 'ảnh không bị hỏng khi phủ')
    for (const f of ['AI_RULES.md', 'playwright.config.ts', 'wrangler.jsonc', 'src/features/home/ui/home-screen.tsx']) assert.doesNotMatch(read(f), /\{\{[A-Z_]+\}\}/, `${f}: còn token chưa điền`)
    assert.match(read('AI_RULES.md'), /seoMeta/)
    const pkg = JSON.parse(read('package.json'))
    assert.equal(pkg.scripts.postinstall, 'wrangler types && react-router typegen', 'cài lại ở đâu cũng sinh kiểu route (tsc-build, knip cần)')
    assert.equal(pkg.scripts['test:e2e'], 'playwright test')
  })

  test('bản đồ kiến trúc: docs/arch.json có module routes + features/home + shared, ghép các route vào luật; Codemap khớp', async () => {
    const { dir } = await created()
    const arch = JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'arch.json'), 'utf8'))
    const mods = Object.fromEntries(arch.parts[0].modules.map((m) => [m.name, m]))
    assert.ok(mods.routes && mods['features/home'] && mods.shared, Object.keys(mods).join(', '))
    assert.match(mods.routes.desc, /sitemap\.xml/)
    assert.ok(mods.routes.mayDependOn.includes('features/home') && mods.routes.mayDependOn.includes('shared'), 'route được import tính năng và shared')
    assert.ok(!mods['features/home'].mayDependOn.includes('routes'), 'tính năng không import route')
    assert.ok(arch.parts[0].forbidden.some((f) => f.to === 'src/routes/**'), 'luật: tính năng và shared không import route')
    assert.match(fs.readFileSync(path.join(dir, 'docs', 'ARCHITECTURE.md'), 'utf8'), /`src\/routes` — Route/)
  })

  test('kết quả nói việc còn phải làm: đặt SITE_URL thật, thay ảnh chia sẻ tạm', async () => {
    const { json } = await created()
    assert.ok(json.notes.some((n) => /SITE_URL/.test(n)))
    assert.ok(json.notes.some((n) => /og-default\.png/.test(n)))
    const text = (await main(['create', '--type', 'web-public', '--name', 'thu-hai', '--dir', mk()], { ...IO, run: fakeRun().run })).lines.join('\n')
    assert.match(text, /Lưu ý: Trước khi phát hành: đặt SITE_URL thật/)
    assert.match(text, /\(webapp có trang công khai\)/)
  })

  test('--pm npm: lệnh tạo và shadcn chạy bằng npx --yes, ghim React Router bằng npm install, cf-typegen bằng npm run; patch overrides minimatch cho npm', async () => {
    const parent = mk()
    const { run, calls } = fakeRun()
    const r = await main(['create', '--type', 'web-public', '--name', 'dung-npm', '--dir', parent, '--pm', 'npm'], { ...IO, run })
    assert.equal(r.code, 0, r.errLines.join('\n'))
    const v = loadVersions()
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args[0] === '--yes' && c.args[1] === `create-cloudflare@${v.createCloudflare}`))
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args[1] === `shadcn@${v.shadcn}`))
    assert.ok(calls.some((c) => c.cmd === 'npm' && c.args.join(' ') === 'run cf-typegen'))
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args.join(' ') === '--yes react-router typegen'))
    assert.ok(calls.some((c) => c.cmd === 'npm' && c.args[0] === 'install' && !c.args.includes('-D') && c.args.includes(`react-router@${v.reactRouter}`)))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(parent, 'dung-npm', 'package.json'), 'utf8')).overrides, { minimatch: '^11.0.1' })
  })

  test('shadcn init lỗi mạng ⇒ exit 1, câu đời thường + nói app đã tạo ở đâu + lệnh chạy lại; các lệnh sau không chạy', async () => {
    const parent = mk()
    const base = fakeRun()
    const run = (cmd, args = [], o = {}) => (args.some((a) => String(a).startsWith('shadcn@')) ? { status: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org', error: null } : base.run(cmd, args, o))
    const r = await main(['create', '--type', 'web-public', '--name', 'loi-mang', '--dir', parent, '--json'], { ...IO, run })
    assert.equal(r.code, 1)
    const j = JSON.parse(r.lines[0])
    assert.equal(j.kind, 'network')
    assert.match(j.error, /App đã tạo ở .*loi-mang; chạy lại "pnpm dlx shadcn@[\d.]+ init -d -t react-router -y"/)
    assert.ok(!base.calls.some((c) => c.args.join(' ') === 'run cf-typegen'), 'dừng ở bước lỗi')
  })

  test('web, desktop, extension không có bước "lệnh sau khi tạo" và không bị đổi hành vi (không ghim deps chạy)', () => {
    for (const type of ['web', 'desktop', 'extension']) {
      const t = loadTemplate(type)
      assert.deepEqual([t.after, t.deps, t.notes], [[], [], []], type)
    }
  })
})

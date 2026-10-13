// Test cho lib/new-app.mjs: node --test hooks/lib/new-app.test.mjs
// Không mạng: lệnh tạo chính hãng, pnpm/npm, go, wails được GIẢ (tiêm io.run); git chạy thật trên thư mục tạm (đường dẫn có dấu cách + tiếng Việt).
// Mẫu kit (kit/templates/**) là mẫu THẬT: test phủ overlay thật lên thư mục do lệnh tạo giả dựng, rồi soi bằng máy kiểm của kit (ui-check config, header, mã S-nn, kiến trúc).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../ui-check.mjs'
import { extensionPermProblems, headerProblems } from './app-safety.mjs'
import { syncCheck } from './arch.mjs'
import { scanHiddenPaths, scanText } from './secrets.mjs'
import { traceCodes } from './spec-codes.mjs'
import { KIT_DIR, NewAppError, TOKEN_NAMES, TYPES, applyOverlay, classifyFailure, create as createReal, defaultRun, doctor as doctorReal, generatorCommand, installLines, loadTemplate, loadVersions, requiredTools, validateName } from './new-app.mjs'

// doctor tìm công cụ của máy kiểm (osv-scanner, ast-grep…) bằng findTool của flow-check trên máy THẬT; test mặc định coi mọi công cụ là "có" (kết quả không phụ thuộc máy chạy test).
// Ca cần máy thiếu công cụ truyền io.which riêng (hoặc `which: undefined` để dùng findTool thật).
const FAKE_BIN = (name) => `/fake/bin/${name}`
const withWhich = (o = {}) => ({ ...o, io: { which: FAKE_BIN, ...o.io } })
const create = (o) => createReal(withWhich(o))
const doctor = (o) => doctorReal(withWhich(o))

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-app thử ')))
const GITCFG = path.join(TMP, 'gitconfig')
fs.writeFileSync(GITCFG, '')
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.t' })
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

let seq = 0
const mk = (label = 'thư mục cha') => { const d = path.join(TMP, `${label} ${++seq}`); fs.mkdirSync(d, { recursive: true }); return d }
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const has = (root, rel) => fs.existsSync(path.join(root, rel))
function g(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function walkFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git') return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walkFiles(p, base) : [path.relative(base, p).replace(/\\/g, '/')]
  })
}

// ---------- lệnh ngoài giả ----------

const ENOENT = { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'không thấy' } }
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null })
const PROBES = {
  pnpm: ok('12.9.1\n'),
  npm: ok('11.19.0\n'),
  go: ok('go version go1.25.5 windows/amd64\n'),
  wails: ok('v2.12.0\n\n ♥  If Wails is useful to you...\n'),
  reg: ok('    pv    REG_SZ    155.0.4283.45\n'),
  'xcode-select': ok('/Library/Developer/CommandLineTools\n'),
}

// Dựng "kết quả lệnh tạo" như công cụ thật làm (kể cả git init + commit của shadcn).
const GEN = {
  web(parent, name) {
    const d = path.join(parent, name)
    put(d, 'package.json', `${JSON.stringify({ name, private: true, scripts: { dev: 'vite', build: 'tsc -b && vite build' } }, null, 2)}\n`)
    put(d, 'components.json', '{}\n')
    put(d, 'index.html', '<!doctype html>\n<html lang="en"><head><title>vite-app</title></head></html>\n')
    put(d, 'src/App.tsx', 'export default function App() { return null }\n')
    put(d, '.gitignore', 'node_modules\ndist\n')
    g(d, 'init', '-q', '-b', 'main')
    g(d, 'add', '-A')
    g(d, 'commit', '-q', '-m', 'feat: initial commit')
  },
  desktop(parent, name) {
    const d = path.join(parent, name)
    put(d, 'wails.json', `${JSON.stringify({ $schema: 'https://wails.io/schemas/config.v2.json', name, 'frontend:install': 'npm install', 'frontend:build': 'npm run build', 'frontend:dev:watcher': 'npm run dev', 'frontend:dev:serverUrl': 'auto' }, null, 2)}\n`)
    put(d, 'go.mod', `module ${name}\n\ngo 1.23.0\n`)
    put(d, 'app.go', 'package main\n')
    put(d, 'main.go', 'package main\n')
    put(d, 'build/appicon.png', 'png')
    put(d, 'build/windows/info.json', '{}\n')
    put(d, 'frontend/package.json', `${JSON.stringify({ name: 'frontend', scripts: { dev: 'vite', build: 'tsc && vite build' } }, null, 2)}\n`)
    put(d, 'frontend/src/App.tsx', 'export default function App() { return null }\n')
    put(d, 'frontend/src/style.css', 'body { color: white }\n')
    put(d, 'frontend/tsconfig.json', '{ "compilerOptions": { "moduleResolution": "Node", "esModuleInterop": false }, "include": ["src"], "references": [{ "path": "./tsconfig.node.json" }] }\n')
    put(d, 'frontend/tsconfig.node.json', '{ "compilerOptions": { "composite": true, "moduleResolution": "Node" }, "include": ["vite.config.ts"] }\n')
    put(d, 'frontend/vite.config.ts', "import {defineConfig} from 'vite'\nexport default defineConfig({})\n")
    put(d, '.gitignore', 'build/bin\nnode_modules\nfrontend/dist\n')
  },
  extension(parent, name) {
    const d = path.join(parent, name)
    put(d, 'package.json', `${JSON.stringify({ name: 'wxt-react-starter', private: true, scripts: { dev: 'wxt', 'dev:firefox': 'wxt -b firefox', build: 'wxt build', 'build:firefox': 'wxt build -b firefox', zip: 'wxt zip', 'zip:firefox': 'wxt zip -b firefox', compile: 'tsc --noEmit', postinstall: 'wxt prepare' } }, null, 2)}\n`)
    put(d, 'tsconfig.json', '{ "extends": "./.wxt/tsconfig.json", "compilerOptions": { "allowImportingTsExtensions": true, "jsx": "react-jsx" } }\n')
    put(d, 'wxt.config.ts', "import { defineConfig } from 'wxt'\nexport default defineConfig({ modules: ['@wxt-dev/module-react'] })\n")
    put(d, 'entrypoints/background.ts', 'export default defineBackground(() => {})\n')
    put(d, 'entrypoints/content.ts', "export default defineContentScript({ matches: ['*://*.google.com/*'], main() {} })\n")
    put(d, 'entrypoints/popup/App.tsx', 'export default function App() { return null }\n')
    put(d, 'entrypoints/popup/App.css', 'a {}\n')
    put(d, 'entrypoints/popup/index.html', '<html></html>\n')
    put(d, 'entrypoints/popup/main.tsx', 'export {}\n')
    put(d, 'entrypoints/popup/style.css', ':root { color: white }\n')
    put(d, 'assets/react.svg', '<svg/>')
    put(d, '.gitignore', 'node_modules\n.output\n.wxt\n')
  },
}

function makeRun({ missing = [], fail = {}, genResult = {}, probes = {} } = {}) {
  const calls = []
  const run = (cmd, args = [], o = {}) => {
    calls.push({ cmd, args, cwd: o.cwd })
    const key = `${cmd} ${args.join(' ')}`
    for (const [re, res] of Object.entries(fail)) if (new RegExp(re).test(key)) return res
    if (missing.includes(cmd)) return ENOENT
    if (/[\\/]ast-grep(?:\.\w+)?$/.test(cmd) && args[0] === '--version') return ok('ast-grep 0.40.0\n') // doctor xác nhận đúng ast-grep (không phải lệnh `sg` khác) như flow-check
    if (cmd === 'git') return defaultRun(cmd, args, o)
    const p = { ...PROBES, ...probes }[cmd]
    if (p && /^(--version|version|-p|query)$/.test(args[0] ?? '')) return p
    const isShadcn = args.some((a) => String(a).startsWith('shadcn@'))
    const isWxt = args.some((a) => String(a).startsWith('wxt@'))
    if (isShadcn || isWxt || (cmd === 'wails' && args[0] === 'init')) {
      const type = isShadcn ? 'web' : isWxt ? 'extension' : 'desktop'
      const name = isWxt ? args[args.indexOf('init') + 1] : args[args.indexOf('-n') + 1]
      if (genResult[type] !== 'none') GEN[type](o.cwd, name)
      return ok('created\n')
    }
    return ok()
  }
  return { run, calls }
}

const sample = (calls, pred) => calls.findIndex(pred)
const isAdd = (c) => (c.cmd === 'pnpm' || c.cmd === 'npm') && (c.args[0] === 'add' || (c.cmd === 'npm' && c.args[0] === 'install' && c.args.includes('-D')))
const isBrowser = (c) => c.args.includes('playwright') && c.args.includes('install')
const isBuild = (c) => (c.cmd === 'pnpm' || c.cmd === 'npm') && c.args[0] === 'run' && c.args[1] === 'build'
// [tên gói, khoá bản ghim trong versions.json] theo thứ tự devDeps của mẫu web
const WEB_DEV_DEPS = [
  ['@playwright/test', 'playwright'], ['@axe-core/playwright', 'axe'], ['@shadcn/lint', 'shadcnLint'], ['knip', 'knip'], ['jscpd', 'jscpd'],
  ['size-limit', 'sizeLimit'], ['@size-limit/file', 'sizeLimit'], ['dependency-cruiser', 'depcruise'],
]

// ---------- đọc cấu hình kit ----------

describe('kit/templates', () => {
  test('versions.json: bản ghim đủ và đúng dạng', () => {
    const v = loadVersions()
    for (const k of ['shadcn', 'wxt', 'playwright', 'axe', 'shadcnLint', 'knip', 'jscpd', 'sizeLimit', 'depcruise', 'eslint', 'eslintJs', 'tsEslint', 'reactHooks', 'globals', 'vite', 'pluginReact', 'typescript', 'typesNode']) assert.match(v[k], /^\d+\.\d+\.\d+$/, k)
    for (const k of ['node', 'git', 'go', 'wails']) assert.match(v[k].min, /^\d+\.\d+\.\d+$/, k)
  })

  test('mọi devDeps của 3 mẫu trỏ tới bản ghim có thật; không ghim preset-app (kéo puppeteer có lỗ hổng chưa vá)', () => {
    const v = loadVersions()
    for (const type of TYPES) {
      const t = loadTemplate(type)
      assert.ok(t.devDeps.length >= 8, `${type}: đủ công cụ của máy kiểm`)
      for (const d of t.devDeps) assert.match(v[d.version] ?? '', /^\d+\.\d+\.\d+$/, `${type}: ${d.name} → ${d.version}`)
      assert.ok(!t.devDeps.some((d) => d.name === '@size-limit/preset-app'), type)
      for (const need of ['knip', 'jscpd', 'size-limit', '@size-limit/file', 'dependency-cruiser', '@playwright/test', '@axe-core/playwright']) assert.ok(t.devDeps.some((d) => d.name === need), `${type}: thiếu ${need}`)
    }
  })

  test('loadTemplate: archDeps / patch sai dạng ⇒ báo rõ', () => {
    const kit = mk('kit giả 2')
    fs.mkdirSync(path.join(kit, 'templates/web/overlay'), { recursive: true })
    const base = { type: 'web', stack: 'web', generate: { runner: 'bin', bin: 'x', args: [] }, next: { dev: 'x', url: 'y' } }
    for (const [over, re] of [
      [{ archDeps: { 'src/a': 'b' } }, /archDeps/],
      [{ archDeps: { 'src/a': [1] } }, /archDeps/],
      [{ patch: [{ file: 'package.json', set: { a: 1 } }] }, /"set" phải là/],
      [{ patch: [{ file: 'package.json', set: { a: { b: 2 } } }] }, /"set" phải là/],
      [{ patch: [{ file: 'package.json', pm: 'yarn', set: { a: 'b' } }] }, /"pm" chỉ nhận/],
    ]) {
      put(kit, 'templates/web/template.json', JSON.stringify({ ...base, ...over }))
      assert.throws(() => loadTemplate('web', kit), re, JSON.stringify(over))
    }
    put(kit, 'templates/web/template.json', JSON.stringify({ ...base, archDeps: { 'src/a': ['b'] }, patch: [{ file: 'package.json', pm: 'npm', set: { o: { 'x': ['y', { z: 'w' }] } } }] }))
    assert.doesNotThrow(() => loadTemplate('web', kit))
  })

  test('cả 3 mẫu nạp được; overlay chỉ dùng {{TOKEN}} đã biết; không ký tự ẩn', () => {
    // {{modeSuffix}} là chỗ trống của WXT (outDirTemplate trong wxt.config.ts), không phải token của kit: kit chỉ điền {{CHỮ_HOA}} nên để nguyên.
    const known = new Set([...TOKEN_NAMES, 'modeSuffix'])
    for (const type of TYPES) {
      const t = loadTemplate(type)
      assert.equal(t.type, type)
      for (const rel of walkFiles(t.overlayDir)) {
        const text = read(t.overlayDir, rel)
        for (const m of text.matchAll(/\{\{([A-Za-z_]+)\}\}/g)) assert.ok(known.has(m[1]), `${type}/${rel}: token lạ {{${m[1]}}}`)
      }
      for (const r of t.replace) assert.ok(t.markers.length, `${type}: replace ${r}`)
    }
    const hidden = scanHiddenPaths([path.join(KIT_DIR, 'templates')])
    assert.deepEqual([hidden.findings, hidden.errors], [[], []])
  })

  test('loadTemplate: loại lạ ⇒ exit 2; template.json hỏng ⇒ báo rõ, không im lặng', () => {
    assert.throws(() => loadTemplate('mobile'), (e) => e instanceof NewAppError && e.exit === 2)
    const kit = mk('kit giả')
    put(kit, 'templates/web/template.json', JSON.stringify({ type: 'web', stack: 'web', generate: { runner: 'bin', bin: 'x', args: [] }, replace: ['../ngoai'], next: { dev: 'x', url: 'y' } }))
    fs.mkdirSync(path.join(kit, 'templates/web/overlay'), { recursive: true })
    assert.throws(() => loadTemplate('web', kit), /không hợp lệ/)
    put(kit, 'templates/web/template.json', '{ không phải json')
    assert.throws(() => loadTemplate('web', kit), /sai cú pháp/)
  })
})

// ---------- AC-30: hàm ghi log an toàn của mẫu web + desktop ----------

describe('safe-log.ts của mẫu (AC-30)', () => {
  const WEB = path.join(KIT_DIR, 'templates', 'web', 'overlay', 'src', 'shared', 'safe-log.ts')
  const DESKTOP = path.join(KIT_DIR, 'templates', 'desktop', 'overlay', 'frontend', 'src', 'shared', 'safe-log.ts')
  const GHP = 'ghp_' + 'a'.repeat(36)
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const JWT = [b64u({ alg: 'HS256', typ: 'JWT' }), b64u({ role: 'authenticated', sub: 'u1' }), 'x'.repeat(43)].join('.')

  test('web và desktop dùng CÙNG một bản (sửa một nơi phải sửa cả hai)', () => {
    assert.equal(fs.readFileSync(WEB, 'utf8'), fs.readFileSync(DESKTOP, 'utf8'))
  })

  // Node đọc thẳng .ts (gỡ kiểu) từ 22.18/23.6; bản cũ hơn thì bỏ qua phần chạy thử hành vi. Chép sang thư mục tạm có package.json "type": "module" cho chắc cách nạp.
  test('chỉ ghi trường trong danh sách cho phép; phần còn lại chỉ được đếm; giá trị trông như bí mật bị che; log không còn thứ scanText thấy là bí mật', { skip: !process.features.typescript && 'Node này chưa đọc được file .ts' }, async (t) => {
    const d = mk('safe log')
    put(d, 'package.json', '{"type":"module"}')
    fs.copyFileSync(WEB, path.join(d, 'safe-log.ts'))
    const { LOG_ALLOW, redact, safeLog } = await import(pathToFileURL(path.join(d, 'safe-log.ts')).href)
    const out = { log: [], warn: [], error: [] }
    for (const k of Object.keys(out)) t.mock.method(console, k, (s) => { out[k].push(s) })

    safeLog('order_saved', { feature: 'orders', status: 201, durationMs: 42, email: 'an@example.com', password: 'hunter2', token: GHP, body: { a: 1 } })
    assert.deepEqual(out.log.map((s) => JSON.parse(s)), [{ event: 'order_saved', feature: 'orders', status: 201, durationMs: 42, che: 4 }])
    assert.ok(!/email|password|token|hunter2|example\.com/.test(out.log[0]), 'tên trường bị che cũng không lộ')

    safeLog('x_failed', { level: 'error', code: 'E_DB', route: '/u/an@example.com', requestId: JWT, errorName: GHP, count: Number.NaN })
    safeLog('x_slow', { level: 'warn', durationMs: 900, feature: undefined })
    assert.deepEqual(JSON.parse(out.error[0]), { event: 'x_failed', level: 'error', code: 'E_DB', route: '[che]', requestId: '[che]', errorName: '[che]', che: 1 })
    assert.deepEqual(JSON.parse(out.warn[0]), { event: 'x_slow', level: 'warn', durationMs: 900 })

    safeLog('mật khẩu của an@example.com là hunter2', { feature: 'login' })
    assert.deepEqual(JSON.parse(out.log[1]), { event: '[che]', feature: 'login' }, 'tên sự kiện phải là mã ngắn, không phải câu chứa dữ liệu')
    safeLog('long_text', { route: 'a b '.repeat(100) })
    assert.equal(JSON.parse(out.log[2]).route.length, 200)
    safeLog(GHP, { feature: 'login' })
    assert.deepEqual(JSON.parse(out.log[3]), { event: '[che]', feature: 'login' }, 'tên sự kiện trông như token cũng bị che')

    assert.deepEqual(redact({ a: 1, status: 5 }, ['a']), { kept: { a: 1 }, hidden: 1 }, 'danh sách cho phép tự chọn')
    assert.ok(LOG_ALLOW.includes('status') && !LOG_ALLOW.some((k) => /pass|token|secret|key|email|body/i.test(k)), 'danh sách mặc định không có trường nhạy cảm')

    for (const line of [...out.log, ...out.warn, ...out.error]) assert.deepEqual(scanText(line), [], line)
  })
})

describe('công thức nền dữ liệu: nhật ký an toàn + nguồn log (AC-30, AC-48e)', () => {
  const recipe = (name) => fs.readFileSync(path.join(KIT_DIR, '..', 'skills', 'flow-new-app', 'recipes', `${name}.md`), 'utf8')
  // Nguồn log hợp lệ theo hợp đồng .claude/release.json (PLAN dot4, mục Hợp đồng): logs.source
  const SOURCES = ['workers-observability', 'supabase', 'vps-journald', 'none']
  const loggedSource = (text) => /"logs": \{ "source": "([a-z-]+)", "retentionDays": (\d+) \}/.exec(text)

  test('cả 3 công thức dặn code máy chủ (Worker, Edge/hàm Supabase, API VPS) ghi log chỉ qua safeLog hoặc hàm tương đương, và ghi nguồn log vào release.json', () => {
    for (const name of ['cloudflare-d1', 'supabase', 'postgres-vps']) {
      const text = recipe(name)
      assert.match(text, /\*\*Nhật ký \(log\):\*\*/, name)
      assert.match(text, /safeLog/, name)
      assert.match(text, /\.claude\/release\.json/, name)
      assert.match(text, /log-secrets/, name)
      const m = loggedSource(text)
      assert.ok(m && SOURCES.includes(m[1]), `${name}: nguồn log ${m?.[1]} không thuộc ${SOURCES.join(' | ')}`)
    }
  })

  test('cloudflare-d1 bật Workers Logs (observability.enabled) và ghi nguồn workers-observability giữ 3 ngày (Free); supabase giữ 1 ngày; VPS ghi journald với số ngày đã đặt', () => {
    assert.match(recipe('cloudflare-d1'), /"observability": \{ "enabled": true \}/)
    assert.deepEqual(loggedSource(recipe('cloudflare-d1')).slice(1), ['workers-observability', '3'])
    assert.deepEqual(loggedSource(recipe('supabase')).slice(1), ['supabase', '1'])
    assert.match(recipe('supabase'), /"observability": \{ "enabled": true \}/, 'web tĩnh chạy trên Workers cũng bật Workers Logs')
    const vps = recipe('postgres-vps')
    assert.deepEqual(loggedSource(vps).slice(1), ['vps-journald', '30'])
    assert.match(vps, /MaxRetentionSec=30day/, 'số ngày ghi trong release.json khớp cấu hình journald đã dặn')
    assert.match(vps, /journalctl -u/)
  })

  test('postgres-vps: giới hạn tần suất dùng nginx limit_req (có sẵn); Caddy rate_limit được nói rõ là module ngoài, không coi là có sẵn', () => {
    const vps = recipe('postgres-vps')
    assert.match(vps, /nginx `limit_req` \(module có sẵn/)
    assert.match(vps, /KHÔNG dựa vào Caddy `rate_limit`/)
    assert.match(vps, /module ngoài/)
    assert.ok(!/nginx `limit_req`, Caddy rate_limit/.test(vps), 'câu cũ coi Caddy rate_limit là có sẵn đã bỏ')
  })
})

describe('validateName', () => {
  test('chấp nhận tên thư mục an toàn', () => {
    for (const n of ['quan-ly-don-hang', 'app1', 'abc']) assert.equal(validateName(n), null, n)
  })
  test('từ chối dấu, hoa, khoảng trắng, đường dẫn, quá ngắn/dài', () => {
    for (const n of ['Quản-lý', 'My App', '../x', 'a/b', 'ab', '1abc', '-abc', 'abc-', 'a'.repeat(41), '', undefined, 'a;b', 'x&y']) assert.ok(validateName(n), String(n))
  })
})

describe('generatorCommand', () => {
  const v = loadVersions()
  test('web: shadcn ghim bản, đúng cờ không hỏi (-d -t vite -n)', () => {
    const t = loadTemplate('web')
    assert.deepEqual(generatorCommand(t, { name: 'x-app', pm: 'pnpm', versions: v }), { cmd: 'pnpm', args: ['dlx', `shadcn@${v.shadcn}`, 'init', '-d', '-t', 'vite', '-n', 'x-app'] })
    assert.deepEqual(generatorCommand(t, { name: 'x-app', pm: 'npm', versions: v }), { cmd: 'npx', args: ['--yes', `shadcn@${v.shadcn}`, 'init', '-d', '-t', 'vite', '-n', 'x-app'] })
  })
  test('extension: wxt ghim bản, mẫu react, --pm theo trình quản lý gói', () => {
    const t = loadTemplate('extension')
    assert.deepEqual(generatorCommand(t, { name: 'ext-1', pm: 'pnpm', versions: v }).args, ['dlx', `wxt@${v.wxt}`, 'init', 'ext-1', '-t', 'react', '--pm', 'pnpm'])
    assert.deepEqual(generatorCommand(t, { name: 'ext-1', pm: 'npm', versions: v }).args, ['--yes', `wxt@${v.wxt}`, 'init', 'ext-1', '-t', 'react', '--pm', 'npm'])
  })
  test('desktop: wails v2 mẫu react-ts, im lặng (-q)', () => {
    assert.deepEqual(generatorCommand(loadTemplate('desktop'), { name: 'may-1', pm: 'pnpm', versions: v }), { cmd: 'wails', args: ['init', '-n', 'may-1', '-t', 'react-ts', '-q'] })
  })
})

// ---------- phân loại lỗi ----------

describe('classifyFailure', () => {
  const r = (stderr, extra = {}) => ({ status: 1, stdout: '', stderr, error: null, ...extra })
  const cases = [
    ['getaddrinfo ENOTFOUND registry.npmjs.org', 'network', /mạng/],
    ['ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/shadcn: fetch failed', 'network', /mạng/],
    ['npm error code ECONNRESET\nnpm error network aborted', 'network', /mạng/],
    ['EACCES: permission denied, mkdir', 'permission', /quyền/],
    ['Access is denied.', 'permission', /quyền/],
    ['ENOSPC: no space left on device, write', 'disk', /ổ đĩa/i],
    ['There is not enough space on the disk', 'disk', /ổ đĩa/i],
    ["EPERM: operation not permitted, rename 'C:\\x\\node_modules\\.pnpm'", 'antivirus', /diệt virus/],
    ['Operation did not complete successfully because the file contains a virus or potentially unwanted software', 'antivirus', /diệt virus/],
    ['EBUSY: resource busy or locked', 'antivirus', /khoá/],
    ["error: unknown option '--pm'", 'flags', /đổi cách dùng/],
    ['Error: Unknown command "init"', 'flags', /đổi cách dùng/],
    ['flag provided but not defined: -q', 'flags', /đổi cách dùng/],
    ['╰─▶ Ignored build scripts: esbuild@0.15.18\nhelp: Run "pnpm approve-builds"', 'build-scripts', /allowBuilds/],
    ['Segmentation fault', 'error', /báo lỗi/],
  ]
  for (const [stderr, kind, say] of cases) {
    test(`${kind}: ${stderr.split('\n')[0].slice(0, 50)}`, () => {
      const c = classifyFailure(r(stderr), 'pnpm')
      assert.equal(c.kind, kind)
      assert.match(c.say, say)
      assert.ok(c.detail.length <= 300)
    })
  }
  // Lỗi #2 (nghiệm thu rút gọn): máy bị chặn kết nối ra ngoài báo EACCES kèm địa chỉ:cổng — đó là MẠNG, không phải quyền ghi thư mục.
  const connectDenied = [
    'npm error code EACCES\nnpm error syscall connect\nnpm error errno EACCES\nnpm error connect EACCES 104.16.6.34:443',
    'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/shadcn: request to https://registry.npmjs.org/shadcn failed, reason: connect EACCES 104.16.6.34:443',
    'Error: connect EACCES [2606:4700::6810:84e5]:443',
    "node:internal/process: { errno: -13, code: 'EACCES', syscall: 'connect', address: '104.16.6.34', port: 443 }",
    'npm error code EACCES\nnpm error syscall getaddrinfo\nnpm error errno EACCES',
    'getaddrinfo EACCES registry.npmjs.org',
    'Get "https://proxy.golang.org/x": dial tcp 142.250.1.1:443: connect: permission denied',
    'dial tcp 142.250.1.1:443: connectex: An attempt was made to access a socket in a way forbidden by its access permissions.',
    'connect EPERM 10.0.0.5:8080 - Local (0.0.0.0:0)',
  ]
  for (const stderr of connectDenied) {
    test(`kết nối bị chặn ⇒ network, không phải quyền ghi: ${stderr.split('\n').at(-1).slice(0, 50)}`, () => {
      const c = classifyFailure(r(stderr), 'pnpm')
      assert.equal(c.kind, 'network')
      assert.match(c.say, /Không kết nối được mạng để tải thư viện/)
      assert.doesNotMatch(c.say, /quyền ghi/)
    })
  }
  test('lỗi mạng khác (ENOTFOUND, ECONNREFUSED, ETIMEDOUT có địa chỉ:cổng) vẫn là network', () => {
    for (const s of ['getaddrinfo ENOTFOUND registry.npmjs.org', 'connect ECONNREFUSED 127.0.0.1:8080', 'connect ETIMEDOUT 104.16.6.34:443', 'npm error network request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT 104.16.6.34:443']) {
      assert.equal(classifyFailure(r(s), 'pnpm').kind, 'network', s)
    }
  })
  test('quyền ghi thật (lỗi trên đường dẫn file) vẫn là permission, kể cả khi log có dòng mạng', () => {
    for (const s of [
      "EACCES: permission denied, mkdir 'C:\\Users\\Admin\\Documents\\app'",
      "npm error code EACCES\nnpm error syscall mkdir\nnpm error path C:\\Program Files\\x\nnpm error errno -4048",
      "npm warn retry connect ETIMEDOUT 104.16.6.34:443\nnpm error EACCES: permission denied, open '/usr/lib/node_modules/x/package.json'",
      "npm error connect EACCES 104.16.6.34:443 (đã thử lại)\nnpm error syscall mkdir\nnpm error path /usr/local/lib",
      'sh: line 1: ./node_modules/.bin/vite: Permission denied',
    ]) {
      const c = classifyFailure(r(s), 'pnpm')
      assert.equal(c.kind, 'permission', s)
      assert.match(c.say, /quyền ghi/)
    }
  })
  test('thiếu phần mềm (ENOENT), quá giờ, đối số không an toàn', () => {
    assert.equal(classifyFailure(ENOENT, 'wails').kind, 'missing-tool')
    assert.equal(classifyFailure({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }, 'pnpm').kind, 'timeout')
    assert.equal(classifyFailure({ status: null, stdout: '', stderr: '', error: { code: 'EUNSAFE', message: 'x' } }, 'pnpm').kind, 'unsafe')
  })
  test('lệnh không chạy được ngay lúc khởi động (spawn EPERM/EACCES, không có log) ⇒ blocked, không rơi về lỗi chung', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const c = classifyFailure({ status: null, stdout: '', stderr: '', error: { code, message: `spawn ${code}` } }, 'pnpm')
      assert.equal(c.kind, 'blocked')
      assert.match(c.say, /bị chặn quyền hoặc môi trường cô lập/)
    }
  })
  test('lời đời thường: không in lại nguyên log thô dài', () => {
    const c = classifyFailure(r(`${'dòng log dài\n'.repeat(200)}ENOTFOUND`), 'pnpm')
    assert.ok(c.say.length < 300 && c.detail.length <= 300)
  })
})

// ---------- doctor ----------

describe('doctor', () => {
  const base = (over = {}) => {
    const { run, calls } = makeRun(over.run)
    return { io: { run, platform: 'win32', nodeVersion: '26.8.1', ...over.io }, calls }
  }

  test('web đủ đồ ⇒ ok, ưu tiên pnpm khi có', () => {
    const { io } = base()
    const r = doctor({ type: 'web', io })
    assert.equal(r.ok, true)
    assert.deepEqual(r.missing, [])
    assert.equal(r.pm, 'pnpm')
    assert.equal(r.found.node, '26.8.1')
  })

  test('không có pnpm ⇒ dùng npm; ép --pm pnpm mà thiếu ⇒ báo thiếu pnpm', () => {
    const { io } = base({ run: { missing: ['pnpm'] } })
    assert.equal(doctor({ type: 'web', io }).pm, 'npm')
    const r = doctor({ type: 'web', io, pm: 'pnpm' })
    assert.equal(r.ok, false)
    assert.equal(r.missing[0].tool, 'pnpm')
  })

  test('Node cũ, thiếu git ⇒ missing kèm lệnh cài cho Windows và Mac, không cài gì', () => {
    const { io, calls } = base({ io: { nodeVersion: '18.19.0' }, run: { missing: ['git'] } })
    const r = doctor({ type: 'web', io })
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing.map((m) => m.tool), ['node', 'git'])
    for (const m of r.missing) {
      assert.match(m.install.win, /^winget install /)
      assert.match(m.install.mac, /^brew install /)
      assert.ok(m.why.length > 10)
    }
    assert.match(r.missing[0].why, /18\.19\.0/)
    // chỉ HỎI phiên bản, không chạy lệnh cài nào
    for (const c of calls) assert.ok(/^(--version|version|-p|query)$/.test(c.args[0]), `${c.cmd} ${c.args.join(' ')}`)
  })

  test('desktop: thiếu Go, Wails, WebView2 ⇒ liệt kê đủ; Wails v3/quá cũ ⇒ báo', () => {
    const miss = base({ run: { missing: ['go', 'wails'], fail: { '^reg ': { status: 1, stdout: '', stderr: 'ERROR', error: null } } } })
    const r = doctor({ type: 'desktop', io: miss.io })
    assert.deepEqual(r.missing.map((m) => m.tool), ['go', 'wails', 'webview2'])
    assert.equal(r.missing[2].install.win, 'winget install Microsoft.EdgeWebView2Runtime')
    assert.match(r.missing[1].install.win, /go install github\.com\/wailsapp\/wails\/v2\/cmd\/wails@v\d+\.\d+\.\d+$/)
    const old = doctor({ type: 'desktop', io: base({ run: { probes: { wails: ok('v2.5.0\n') } } }).io })
    assert.deepEqual(old.missing.map((m) => m.tool), ['wails'])
    const v3 = doctor({ type: 'desktop', io: base({ run: { probes: { wails: ok('v3.0.0-alpha\n') } } }).io })
    assert.deepEqual(v3.missing.map((m) => m.tool), ['wails'])
    const oldGo = doctor({ type: 'desktop', io: base({ run: { probes: { go: ok('go version go1.19.2 windows/amd64\n') } } }).io })
    assert.deepEqual(oldGo.missing.map((m) => m.tool), ['go'])
  })

  test('desktop đủ đồ trên Windows ⇒ ok; Mac: không hỏi WebView2, hỏi công cụ dòng lệnh Apple', () => {
    assert.equal(doctor({ type: 'desktop', io: base().io }).ok, true)
    const mac = base({ io: { platform: 'darwin' }, run: { missing: ['xcode-select'] } })
    const r = doctor({ type: 'desktop', io: mac.io })
    assert.deepEqual(r.missing.map((m) => m.tool), ['xcode'])
    assert.equal(r.missing[0].install.mac, 'xcode-select --install')
    assert.ok(!mac.calls.some((c) => c.cmd === 'reg'))
  })

  test('installLines: chỉ lệnh cài của hệ điều hành đang chạy (Windows ⇒ Windows, Mac ⇒ Mac, hệ khác ⇒ cả hai)', () => {
    const both = { win: 'winget install X', mac: 'brew install x' }
    assert.deepEqual(installLines(both, 'win32'), ['    Windows: winget install X'])
    assert.deepEqual(installLines(both, 'darwin'), ['    Mac: brew install x'])
    assert.deepEqual(installLines(both, 'linux'), ['    Windows: winget install X', '    Mac: brew install x'])
    assert.deepEqual(installLines({ win: null, mac: 'xcode-select --install' }, 'darwin'), ['    Mac: xcode-select --install'])
    assert.deepEqual(installLines({ win: null, mac: 'xcode-select --install' }, 'win32'), [])
    assert.equal(doctor({ type: 'web', io: base({ io: { platform: 'darwin' } }).io }).platform, 'darwin')
  })

  test('extension không cần Go/Wails', () => {
    const { io, calls } = base({ run: { missing: ['go', 'wails'] } })
    assert.equal(doctor({ type: 'extension', io }).ok, true)
    assert.ok(!calls.some((c) => c.cmd === 'go' || c.cmd === 'wails'))
  })

  test('--pm lạ ⇒ exit 2', () => {
    assert.throws(() => doctor({ type: 'web', io: base().io, pm: 'yarn' }), (e) => e.exit === 2)
  })
})

// Lỗi #3 (nghiệm thu rút gọn): lệnh CÓ trên máy nhưng KHÔNG CHẠY ĐƯỢC (spawn EPERM/EACCES: bị chặn quyền/sandbox) không được báo là "chưa có".
describe('doctor — lệnh có nhưng không chạy được', () => {
  const blockedWith = (code) => ({ status: null, stdout: '', stderr: '', error: { code, message: `spawn ${code}` } })
  const base = (over = {}) => {
    const { run, calls } = makeRun(over.run)
    return { io: { run, platform: 'win32', nodeVersion: '26.8.1', ...over.io }, calls }
  }

  test('git bị chặn (EPERM) ⇒ blocked, KHÔNG nằm trong missing, lời nói "có nhưng không chạy được", không bảo cài', () => {
    const { io } = base({ run: { fail: { '^git ': blockedWith('EPERM') } } })
    const r = doctor({ type: 'web', io })
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing, [])
    assert.deepEqual(r.blocked.map((b) => b.tool), ['git'])
    assert.match(r.blocked[0].why, /git/)
    assert.match(r.blocked[0].why, /không chạy được/)
    assert.match(r.blocked[0].why, /EPERM/)
    assert.doesNotMatch(r.blocked[0].why, /Chưa có/)
  })

  test('ENOENT vẫn là chưa cài (missing), EACCES là bị chặn', () => {
    const gone = doctor({ type: 'web', io: base({ run: { missing: ['git'] } }).io })
    assert.deepEqual(gone.missing.map((m) => m.tool), ['git'])
    assert.match(gone.missing[0].why, /Chưa có git/)
    assert.deepEqual(gone.blocked, [])
    const denied = doctor({ type: 'web', io: base({ run: { fail: { '^git ': blockedWith('EACCES') } } }).io })
    assert.deepEqual(denied.blocked.map((b) => b.tool), ['git'])
    assert.deepEqual(denied.missing, [])
  })

  test('npm bị chặn khi không có pnpm ⇒ blocked npm; pnpm bị chặn nhưng npm chạy được ⇒ vẫn ok, dùng npm', () => {
    const noPnpm = base({ run: { missing: ['pnpm'], fail: { '^npm ': blockedWith('EPERM') } } })
    const r = doctor({ type: 'web', io: noPnpm.io })
    assert.equal(r.ok, false)
    assert.deepEqual(r.blocked.map((b) => b.tool), ['npm'])
    assert.deepEqual(r.missing, [])
    const pnpmOnly = doctor({ type: 'web', io: base({ run: { fail: { '^pnpm ': blockedWith('EPERM') } } }).io })
    assert.equal(pnpmOnly.ok, true)
    assert.equal(pnpmOnly.pm, 'npm')
    assert.deepEqual(pnpmOnly.blocked, [])
  })

  test('desktop: go, wails, reg (WebView2) bị chặn ⇒ blocked từng cái, không bắt cài', () => {
    const { io } = base({ run: { fail: { '^go ': blockedWith('EPERM'), '^wails ': blockedWith('EACCES'), '^reg ': blockedWith('EPERM') } } })
    const r = doctor({ type: 'desktop', io })
    assert.deepEqual(r.missing, [])
    assert.deepEqual(r.blocked.map((b) => b.tool), ['go', 'wails', 'webview2'])
  })

  test('create: máy có phần mềm nhưng bị chặn ⇒ exit 3, nói "không chạy được" (không nói thiếu/cài), không tạo gì', () => {
    const parent = mk()
    const { run, calls } = makeRun({ fail: { '^git ': blockedWith('EPERM') } })
    const e = (() => { try { create({ type: 'web', name: 'don-hang', parent, io: { run, platform: 'win32' } }) } catch (x) { return x } return null })()
    assert.equal(e.exit, 3)
    assert.equal(e.kind, 'blocked')
    assert.match(e.message, /không chạy được/)
    assert.doesNotMatch(e.message, /thiếu phần mềm/)
    assert.ok(e.lines.some((l) => /^- git: .*không chạy được/.test(l)))
    assert.ok(!e.lines.some((l) => /winget|brew/.test(l)), 'không bắt cài thứ đã có')
    assert.ok(!calls.some((c) => c.args.some((a) => String(a).startsWith('shadcn@'))))
    assert.ok(!has(parent, 'don-hang'))
  })
})

// Lỗi #1 (nghiệm thu rút gọn): doctor phải kiểm cả công cụ mà flow-check coi là BẮT BUỘC (kit/checkers.json), không thì app vừa tạo luôn đỏ.
describe('doctor — công cụ bắt buộc của máy kiểm (kit/checkers.json)', () => {
  const lacking = (...names) => (name) => (names.includes(name) ? null : FAKE_BIN(name))
  const base = (over = {}) => {
    const { run, calls } = makeRun(over.run)
    return { io: { run, platform: 'win32', nodeVersion: '26.8.1', ...over.io }, calls }
  }
  const OSV_WIN = 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest'

  test('requiredTools: chỉ công cụ CẦN CÀI TRÊN MÁY của loại app đó (không tính thứ app tự cài bằng npm i -D, không tính checker chỉ chạy khi có OpenAPI/migration…)', () => {
    const names = (type) => requiredTools(loadTemplate(type)).map((t) => t.names[0])
    assert.deepEqual(names('web'), ['osv-scanner', 'ast-grep'])
    assert.deepEqual(names('extension'), ['osv-scanner', 'web-ext', 'ast-grep'])
    assert.deepEqual(names('desktop'), ['osv-scanner', 'golangci-lint', 'govulncheck', 'ast-grep'])
    const sg = requiredTools(loadTemplate('web')).find((t) => t.names.includes('sg'))
    assert.deepEqual(sg.names, ['ast-grep', 'sg'])
    assert.equal(sg.id, 'sast-ast-grep')
  })

  test('web: máy thiếu osv-scanner + ast-grep (và Go để cài osv-scanner) ⇒ missing kèm lệnh cài theo máy; không chạy lệnh cài nào', () => {
    const { io, calls } = base({ io: { which: lacking('osv-scanner', 'ast-grep', 'sg', 'go') } })
    const r = doctor({ type: 'web', io })
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing.map((m) => m.tool), ['go', 'osv-scanner', 'ast-grep'])
    const [go, osv, sg] = r.missing
    assert.equal(go.install.win, 'winget install GoLang.Go')
    assert.match(go.why, /osv-scanner/)
    assert.deepEqual(osv.install, { win: OSV_WIN, mac: 'brew install osv-scanner' })
    assert.match(osv.why, /flow-check/)
    assert.deepEqual(sg.install, { win: 'npm i -g @ast-grep/cli', mac: 'npm i -g @ast-grep/cli' })
    assert.deepEqual(installLines(osv.install, 'win32'), [`    Windows: ${OSV_WIN}`])
    assert.deepEqual(installLines(osv.install, 'darwin'), ['    Mac: brew install osv-scanner'])
    for (const c of calls) assert.ok(/^(--version|version|-p|query)$/.test(c.args[0]), `${c.cmd} ${c.args.join(' ')}`)
  })

  test('chỉ thiếu ast-grep ⇒ chỉ báo ast-grep (không đòi Go khi osv-scanner đã có)', () => {
    const r = doctor({ type: 'web', io: base({ io: { which: lacking('ast-grep', 'sg') } }).io })
    assert.deepEqual(r.missing.map((m) => m.tool), ['ast-grep'])
    assert.equal(r.found['osv-scanner'], true)
  })

  test('đủ công cụ ⇒ ok và liệt kê trong found', () => {
    const r = doctor({ type: 'web', io: base().io })
    assert.equal(r.ok, true)
    assert.equal(r.found['osv-scanner'], true)
    assert.equal(r.found['ast-grep'], true)
  })

  test('ast-grep: lệnh `sg` của hệ điều hành (không phải ast-grep) không tính là có — giống flow-check', () => {
    const run = (cmd, args = []) => (cmd.endsWith('/sg') && args[0] === '--version' ? ok('sg from shadow-utils 4.13\n') : cmd.endsWith('/ast-grep') ? ok('ast-grep 0.40.0\n') : makeRun().run(cmd, args))
    const onlySg = doctor({ type: 'web', io: { run, platform: 'win32', nodeVersion: '26.8.1', which: lacking('ast-grep') } })
    assert.deepEqual(onlySg.missing.map((m) => m.tool), ['ast-grep'])
    const realSg = (cmd, args = []) => (cmd.endsWith('/sg') && args[0] === '--version' ? ok('ast-grep 0.40.0\n') : run(cmd, args))
    const okSg = doctor({ type: 'web', io: { run: realSg, platform: 'win32', nodeVersion: '26.8.1', which: lacking('ast-grep') } })
    assert.equal(okSg.ok, true)
  })

  test('công cụ bắt buộc có trên máy nhưng chạy bị chặn (EPERM/EACCES) ⇒ blocked, không báo thiếu, không bảo cài lại', () => {
    const blockedWith = (code) => ({ status: null, stdout: '', stderr: '', error: { code, message: `spawn ${code}` } })
    const r = doctor({ type: 'web', io: base({ run: { fail: { 'ast-grep --version': blockedWith('EPERM'), 'osv-scanner --version': blockedWith('EACCES') } } }).io })
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing, [])
    assert.deepEqual(r.blocked.map((b) => b.tool).sort(), ['ast-grep', 'osv-scanner'])
    assert.match(r.blocked.find((b) => b.tool === 'ast-grep').why, /EPERM/)
  })

  test('extension thêm web-ext; desktop thêm golangci-lint + govulncheck (Go đã có nên không đòi lại) — lệnh cài lấy từ checkers.json', () => {
    const ext = doctor({ type: 'extension', io: base({ io: { which: lacking('web-ext') } }).io })
    assert.deepEqual(ext.missing.map((m) => m.tool), ['web-ext'])
    assert.deepEqual(ext.missing[0].install, { win: 'npm i -g web-ext', mac: 'npm i -g web-ext' })
    const desk = doctor({ type: 'desktop', io: base({ io: { which: lacking('golangci-lint', 'govulncheck') } }).io })
    assert.deepEqual(desk.missing.map((m) => m.tool), ['golangci-lint', 'govulncheck'])
    assert.deepEqual(desk.missing[0].install, { win: 'scoop install main/golangci-lint', mac: 'brew install golangci-lint' })
    assert.deepEqual(desk.missing[1].install, { win: 'go install golang.org/x/vuln/cmd/govulncheck@latest', mac: 'go install golang.org/x/vuln/cmd/govulncheck@latest' })
  })

  test('tìm công cụ bằng which của flow-check với cwd/env/platform đúng; create tìm từ thư mục cha (nơi app sẽ nằm)', () => {
    const seen = []
    const spy = (name, o) => { seen.push({ name, ...o }); return FAKE_BIN(name) }
    const env = { PATH: 'p' }
    doctor({ type: 'web', cwd: '/x/y', io: { ...base().io, which: spy, env, platform: 'win32' } })
    assert.ok(seen.length >= 2)
    for (const s of seen) assert.deepEqual([s.cwd, s.platform, s.env], ['/x/y', 'win32', env])
    seen.length = 0
    const parent = mk()
    create({ type: 'web', name: 'don-hang', parent, io: { ...base().io, which: spy } })
    assert.ok(seen.length >= 2)
    for (const s of seen) assert.equal(s.cwd, path.resolve(parent))
  })

  test('mặc định dùng findTool THẬT của flow-check: thấy công cụ trong node_modules/.bin mà PATH không có', () => {
    const dir = mk('thư mục có công cụ')
    const bin = path.join(dir, 'node_modules', '.bin')
    const ext = process.platform === 'win32' ? '.cmd' : ''
    for (const t of ['osv-scanner', 'ast-grep']) { put(bin, `${t}${ext}`, '@echo off\n'); fs.chmodSync(path.join(bin, `${t}${ext}`), 0o755) }
    const io = { run: makeRun().run, platform: process.platform, nodeVersion: '26.8.1', env: { PATH: '' }, which: undefined }
    const r = doctor({ type: 'web', cwd: dir, io })
    assert.equal(r.found['osv-scanner'], true)
    assert.equal(r.found['ast-grep'], true)
    assert.ok(!r.missing.some((m) => m.tool === 'osv-scanner' || m.tool === 'ast-grep'), JSON.stringify(r.missing))
  })

  test('kit không có checkers.json ⇒ báo rõ (không lặng lẽ bỏ qua bước kiểm)', () => {
    const kit = mk('kit thiếu checkers')
    fs.cpSync(path.join(KIT_DIR, 'templates'), path.join(kit, 'templates'), { recursive: true })
    const e = (() => { try { doctor({ type: 'web', io: { ...base().io, kit } }) } catch (x) { return x } return null })()
    assert.ok(e instanceof NewAppError)
    assert.match(e.message, /checkers\.json/)
  })

  test('create: thiếu công cụ bắt buộc ⇒ exit 3 kèm lệnh cài đúng hệ điều hành, không tạo gì', () => {
    const parent = mk()
    const { run, calls } = makeRun()
    const e = (() => { try { create({ type: 'web', name: 'don-hang', parent, io: { run, platform: 'win32', which: lacking('osv-scanner') } }) } catch (x) { return x } return null })()
    assert.equal(e.exit, 3)
    assert.ok(e.lines.some((l) => l.startsWith('- osv-scanner:')))
    assert.ok(e.lines.includes(`    Windows: ${OSV_WIN}`))
    assert.ok(!e.lines.some((l) => /Mac:/.test(l)))
    assert.ok(!calls.some((c) => c.args.some((a) => String(a).startsWith('shadcn@'))))
    assert.ok(!has(parent, 'don-hang'))
  })
})

// ---------- lớp phủ ----------

describe('applyOverlay', () => {
  function fakeTemplate(over = {}) {
    const overlayDir = mk('overlay')
    return { overlayDir, replace: [], remove: [], move: [], scripts: {}, patch: [], pkgDir: '.', ...over }
  }

  test('thêm file mới, giữ file sinh sẵn, chỉ đè file trong replace; điền token', () => {
    const t = fakeTemplate({ replace: ['a.txt'] })
    put(t.overlayDir, 'a.txt', 'mới {{APP_NAME}}\n')
    put(t.overlayDir, 'b.txt', 'khác\n')
    put(t.overlayDir, 'sub/c.txt', 'cổng {{PORT}} và {{KHONG_BIET}}\n')
    const app = mk('app')
    put(app, 'a.txt', 'cũ\n')
    put(app, 'b.txt', 'của lệnh tạo\n')
    const r = applyOverlay({ template: t, appDir: app, tokens: { APP_NAME: 'x', PORT: '5173' } })
    assert.equal(read(app, 'a.txt'), 'mới x\n')
    assert.equal(read(app, 'b.txt'), 'của lệnh tạo\n')
    assert.equal(read(app, 'sub/c.txt'), 'cổng 5173 và {{KHONG_BIET}}\n')
    assert.deepEqual([r.added, r.replaced, r.kept], [['sub/c.txt'], ['a.txt'], ['b.txt']])
  })

  test('scripts: chỉ thêm script chưa có; patch: đặt lại khoá cấp cao nhất; giữ thụt lề', () => {
    const t = fakeTemplate({ scripts: { 'test:e2e': 'playwright test', dev: 'KHÔNG ĐÈ' }, patch: [{ file: 'package.json', set: { name: '{{APP_NAME}}' } }] })
    const app = mk('app')
    put(app, 'package.json', '{\n    "name": "wxt-react-starter",\n    "scripts": { "dev": "vite" }\n}\n')
    const r = applyOverlay({ template: t, appDir: app, tokens: { APP_NAME: 'ten-moi' } })
    const pkg = JSON.parse(read(app, 'package.json'))
    assert.equal(pkg.name, 'ten-moi')
    assert.deepEqual(pkg.scripts, { dev: 'vite', 'test:e2e': 'playwright test' })
    assert.deepEqual(r.scripts, ['test:e2e'])
    assert.match(read(app, 'package.json'), /^\{\n {4}"name"/)
  })

  test('patch: giá trị có thể là object (vd overrides) và được điền token; mục có "pm" chỉ áp cho đúng trình quản lý gói', () => {
    const t = fakeTemplate({
      patch: [
        { file: 'package.json', pm: 'npm', set: { overrides: { 'shell-quote': '^1.11.0', ten: '{{APP_NAME}}' }, danhSach: ['{{APP_NAME}}', 'b'] } },
        { file: 'package.json', pm: 'pnpm', set: { chiPnpm: 'x' } },
      ],
    })
    const app = mk('app')
    put(app, 'package.json', '{ "name": "a" }\n')
    const r = applyOverlay({ template: t, appDir: app, tokens: { APP_NAME: 'ten-moi', PM: 'npm' } })
    const pkg = JSON.parse(read(app, 'package.json'))
    assert.deepEqual(pkg.overrides, { 'shell-quote': '^1.11.0', ten: 'ten-moi' })
    assert.deepEqual(pkg.danhSach, ['ten-moi', 'b'])
    assert.equal(pkg.chiPnpm, undefined, 'mục pm=pnpm bị bỏ khi dùng npm')
    assert.deepEqual(r.patched, ['package.json'])
    assert.equal(applyOverlay({ template: t, appDir: app, tokens: { APP_NAME: 'ten-moi', PM: 'npm' } }).patched.length, 0, 'áp lần hai không đổi gì')
    const pnpm = mk('app pnpm')
    put(pnpm, 'package.json', '{ "name": "a" }\n')
    applyOverlay({ template: t, appDir: pnpm, tokens: { APP_NAME: 'x', PM: 'pnpm' } })
    assert.deepEqual(JSON.parse(read(pnpm, 'package.json')), { name: 'a', chiPnpm: 'x' })
  })

  test('move + remove: dời thư mục sinh sẵn; chỉ gỡ file khi đúng nội dung mẫu', () => {
    const t = fakeTemplate({ move: [{ from: 'entrypoints', to: 'src/entrypoints' }], remove: [{ path: 'src/entrypoints/content.ts', contains: 'google.com' }, { path: 'src/entrypoints/mine.ts', contains: 'google.com' }] })
    const app = mk('app')
    put(app, 'entrypoints/content.ts', "matches: ['*://*.google.com/*']\n")
    put(app, 'entrypoints/mine.ts', 'việc của người dùng\n')
    const r = applyOverlay({ template: t, appDir: app, tokens: {} })
    assert.deepEqual(r.removed, ['src/entrypoints/content.ts'])
    assert.ok(!has(app, 'entrypoints'))
    assert.ok(has(app, 'src/entrypoints/mine.ts'))
    assert.ok(r.kept.includes('src/entrypoints/mine.ts'))
  })

  test('đích đã có khi move ⇒ không đè', () => {
    const t = fakeTemplate({ move: [{ from: 'assets', to: 'src/assets' }] })
    const app = mk('app')
    put(app, 'assets/a.svg', 'cũ')
    put(app, 'src/assets/b.svg', 'có sẵn')
    const r = applyOverlay({ template: t, appDir: app, tokens: {} })
    assert.deepEqual(r.moved, [])
    assert.ok(has(app, 'assets/a.svg') && has(app, 'src/assets/b.svg'))
  })
})

// ---------- create ----------

const SPEC = `# SPEC thử

## Bạn duyệt

### Ai dùng
Chủ cửa hàng.

### Các màn hình

#### Màn đầu

Không tải dữ liệu

| mã | khi | thấy gì | làm được gì |
|---|---|---|---|
| S-01 | có dữ liệu | danh sách | thêm |

### Làm được gì
Xem.

### Để sau
Không có.

### Phí phát sinh
Không.

### Ai thấy/sửa được dữ liệu gì
Không áp dụng — chỉ dùng trên máy.
`

function leftoverTokens(dir) {
  return walkFiles(dir).filter((f) => !/\.(png|ico)$/.test(f) && /\{\{[A-Z_]+\}\}/.test(read(dir, f)))
}

// App vừa tạo mở ra MÀN TRỐNG (sổ chốt t7s69eke): S-01 chỉ có tên app + một câu mời, không nút, không dữ liệu mẫu; e2e kiểm đúng tên app.
function assertEmptyHome(dir, name, homeRel, specRel) {
  const home = read(dir, homeRel)
  assert.match(home, /<main data-s="S-01"/)
  assert.match(home, new RegExp(`<h1[^>]*>${name}</h1>`), 'h1 là tên app (token APP_NAME đã điền)')
  assert.match(home, /<p[^>]*>Chưa có màn nào — bảo AI làm màn đầu tiên\.<\/p>/)
  assert.ok(!/<button|<Button|<svg|<img/i.test(home), 'màn trống: không nút, không icon')
  const spec = read(dir, specRel)
  assert.ok(spec.includes(`toHaveText('${name}')`), 'e2e kiểm h1 có tên app')
  assert.ok(spec.split('\n').some((l) => /^test\('S-01.*a11y.*axe/.test(l)), 'test axe có chữ a11y trong tên')
}

describe('create — web (repo git do lệnh tạo lập sẵn, như shadcn)', () => {
  const parent = mk()
  const { run, calls } = makeRun()
  const logs = []
  const r = create({ type: 'web', name: 'don-hang', parent, io: { run, platform: 'win32', log: (s) => logs.push(s) } })
  const dir = r.dir
  const v = loadVersions()

  test('thứ tự bước: kiểm máy → lệnh tạo (cwd = thư mục cha) → công cụ kiểm thử + máy kiểm → trình duyệt → dựng thử; stdin/không hỏi', () => {
    const iGen = sample(calls, (c) => c.args.includes(`shadcn@${v.shadcn}`))
    const iAdd = sample(calls, isAdd)
    const iBrowser = sample(calls, isBrowser)
    const iBuild = sample(calls, isBuild)
    assert.ok(iGen > 0 && iGen < iAdd && iAdd < iBrowser && iBrowser < iBuild, `${iGen} ${iAdd} ${iBrowser} ${iBuild}`)
    assert.deepEqual(calls[iGen].args, ['dlx', `shadcn@${v.shadcn}`, 'init', '-d', '-t', 'vite', '-n', 'don-hang'])
    assert.equal(calls[iGen].cwd, parent)
    assert.deepEqual(calls[iAdd].args, ['add', '-D', ...WEB_DEV_DEPS.map(([name, key]) => `${name}@${v[key]}`)])
    assert.equal(calls[iAdd].cwd, dir)
    assert.deepEqual(calls[iBuild].args, ['run', 'build'])
    assert.equal(calls[iBuild].cwd, dir)
    assert.ok(!calls.some((c) => c.args[0] === 'install' && c.cmd === 'pnpm'), 'shadcn đã cài thư viện, kit không cài lần nữa')
    assert.deepEqual(r.steps.map((s) => s.id), ['doctor', 'generate', 'luu', 'overlay', 'devdeps', 'browser', 'arch', 'build', 'save'])
    assert.equal(logs.length, r.steps.length)
  })

  test('máy kiểm chạy được ngay: mỗi checker bắt buộc của web có công cụ + cấu hình (không bước tay)', () => {
    const pkg = JSON.parse(read(dir, 'package.json'))
    const have = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
    // devDeps ghi vào đúng dòng add (mock không cài thật) — soi qua lệnh đã gọi
    const added = new Set(calls.find(isAdd).args.slice(2).map((p) => p.replace(/@[^@/]+$/, '')))
    for (const need of ['@shadcn/lint', 'knip', 'jscpd', 'size-limit', '@size-limit/file', 'dependency-cruiser', '@playwright/test', '@axe-core/playwright']) assert.ok(added.has(need) || have.has(need), need)
    assert.ok(!added.has('@size-limit/preset-app'), 'preset-app kéo puppeteer có lỗ hổng chưa vá')
    for (const f of ['knip.jsonc', '.size-limit.json', 'osv-scanner.toml', 'eslint.config.js', 'vite.config.ts', '.dependency-cruiser.cjs']) assert.ok(has(dir, f), f)
    assert.match(read(dir, 'eslint.config.js'), /@shadcn\/lint/, 'bật plugin shadcn trong ESLint')
    assert.match(read(dir, '.size-limit.json'), /dist\/assets\/\*\.js/)
    assert.match(read(dir, 'osv-scanner.toml'), /ignoreUntil = \d{4}-\d{2}-\d{2}/, 'miễn lỗ hổng chưa có bản vá phải có hạn')
  })

  test('cổng đọc từ biến PORT (mặc định 5173) ở vite.config.ts và playwright.config.ts; ui.json dùng {PORT}', () => {
    assert.match(read(dir, 'vite.config.ts'), /port: Number\(process\.env\.PORT\) \|\| 5173/)
    const pw = read(dir, 'playwright.config.ts')
    assert.match(pw, /const port = Number\(process\.env\.PORT\) \|\| 5173/)
    assert.ok(!pw.includes('http://localhost:5173'), 'không viết cứng cổng trong URL')
    const ui = JSON.parse(read(dir, '.claude/ui.json'))
    assert.equal(ui.url, 'http://localhost:{PORT}')
    assert.ok(!/--port/.test(ui.start) && ui.start.includes('--strictPort'))
  })

  test('test axe có chữ "a11y" trong tên (checker chạy playwright test --grep=a11y)', () => {
    const titles = [...read(dir, 'e2e/first-screen.spec.ts').matchAll(/^test\('([^']+)'/gm)].map((m) => m[1])
    assert.ok(titles.some((t) => /a11y/.test(t) && /axe/.test(t)), titles.join(' | '))
  })

  test('git: dùng repo có sẵn, thêm MỘT commit lớp phủ và điểm lưu "Tạo app"; cây sạch', () => {
    assert.deepEqual(g(dir, 'log', '--format=%s').split('\n'), ['Tạo app từ mẫu của kit', 'feat: initial commit'])
    assert.equal(g(dir, 'status', '--porcelain'), '')
    const tags = g(dir, 'tag', '--list', 'luu/*').split('\n')
    assert.equal(tags.length, 1)
    assert.match(tags[0], /^luu\/\d{8}-\d{4}-tao-app$/)
    assert.equal(r.luu.tag, tags[0])
    assert.equal(r.luu.name, 'Tạo app')
    assert.ok(r.notes.some((n) => /đã lập git sẵn/.test(n)))
  })

  test('lớp phủ: luật AI, ui.json, header, màn đầu trống, test có mã S-01; không sót {{token}}', () => {
    for (const f of ['AI_RULES.md', '.claude/ui.json', '.env.example', 'public/_headers', 'src/features/home/ui/home-screen.tsx', 'e2e/first-screen.spec.ts', 'playwright.config.ts', 'docs/arch.json', 'docs/ARCHITECTURE.md']) assert.ok(has(dir, f), f)
    assert.deepEqual(leftoverTokens(dir), [])
    assert.match(read(dir, 'AI_RULES.md'), /don-hang/)
    assert.match(read(dir, 'index.html'), /lang="vi"/)
    assertEmptyHome(dir, 'don-hang', 'src/features/home/ui/home-screen.tsx', 'e2e/first-screen.spec.ts')
    for (const f of ['src/features/orders', 'src/shared/format.ts']) assert.ok(!has(dir, f), `${f}: mẫu cũ đã bỏ`)
    assert.equal(JSON.parse(read(dir, 'package.json')).scripts['test:e2e'], 'playwright test')
    assert.match(read(dir, '.gitignore'), /^\.env$/m)
  })

  test('khớp máy kiểm của kit: ui.json nạp được, header đủ, mã S-01 có trong app + test, kiến trúc khớp', () => {
    const cfg = loadConfig(dir, undefined, {})
    assert.deepEqual(cfg.targets.map((t) => [t.label, t.s]), [['/', 'S-01']])
    assert.equal(cfg.url, 'http://localhost:5173')
    assert.equal(cfg.start, 'pnpm dev --strictPort')
    assert.equal(loadConfig(dir, undefined, { PORT: '4400' }).url, 'http://localhost:4400', 'PORT đổi cổng cho cả máy kiểm giao diện')
    assert.deepEqual(headerProblems(dir), [])
    const spec = path.join(dir, 'SPEC.md')
    fs.writeFileSync(spec, SPEC)
    const t = traceCodes(dir, [spec])
    assert.deepEqual(t.problems, [])
    fs.rmSync(spec)
    assert.deepEqual(syncCheck(dir).problems, [])
  })

  test('bài thử nhanh @smoke (hợp đồng với `release`): có test @smoke CHỈ ĐỌC ở màn đầu; playwright.config.ts đọc BASE_URL + SMOKE_EXTRA_HTTP_HEADERS', () => {
    const pw = read(dir, 'playwright.config.ts')
    assert.match(pw, /const baseURL = process\.env\.BASE_URL \|\| `http:\/\/localhost:\$\{port\}`/)
    assert.match(pw, /process\.env\.SMOKE_EXTRA_HTTP_HEADERS \? \(JSON\.parse\(process\.env\.SMOKE_EXTRA_HTTP_HEADERS\)/)
    assert.match(pw, /use: \{ baseURL, extraHTTPHeaders \}/)
    const smoke = read(dir, 'e2e/first-screen.spec.ts').split(/^test\(/m).slice(1).filter((body) => body.includes("tag: '@smoke'"))
    assert.ok(smoke.length >= 1, 'ít nhất một test @smoke')
    for (const body of smoke) {
      assert.match(body, /data-s="S-01"/, 'mở màn đầu, thấy S-01')
      assert.doesNotMatch(body, /\.(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|dragTo|dispatchEvent)\(|\.(post|put|patch|delete)\(|\.route\(|\.evaluate\(/, 'test @smoke không được ghi/bấm gì')
    }
    assert.match(read(dir, 'AI_RULES.md'), /@smoke.*BASE_URL.*SMOKE_EXTRA_HTTP_HEADERS/)
  })

  // Chạy THẬT cấu hình (Node gỡ kiểu .ts) với @playwright/test giả: không đặt env ⇒ như cũ; có BASE_URL ⇒ không bật server trên máy, header thêm vào use.
  test('playwright.config.ts: không đặt env ⇒ localhost:PORT + bật server; BASE_URL ⇒ địa chỉ đó, không bật server; SMOKE_EXTRA_HTTP_HEADERS (JSON) ⇒ use.extraHTTPHeaders', { skip: !process.features.typescript && 'Node này chưa đọc được file .ts' }, async () => {
    const d = mk('pw config')
    put(d, 'package.json', '{"type":"module"}')
    put(d, 'node_modules/@playwright/test/package.json', '{"name":"@playwright/test","type":"module","main":"index.js"}')
    put(d, 'node_modules/@playwright/test/index.js', "export const defineConfig = (c) => c\nexport const devices = { 'Desktop Chrome': { browserName: 'chromium' } }\n")
    fs.writeFileSync(path.join(d, 'playwright.config.ts'), read(dir, 'playwright.config.ts'))
    const KEYS = ['PORT', 'BASE_URL', 'SMOKE_EXTRA_HTTP_HEADERS']
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    let n = 0
    const load = async (env) => {
      for (const k of KEYS) delete process.env[k]
      Object.assign(process.env, env)
      return (await import(`${pathToFileURL(path.join(d, 'playwright.config.ts')).href}?c=${++n}`)).default
    }
    try {
      const local = await load({})
      assert.equal(local.use.baseURL, 'http://localhost:5173')
      assert.equal(local.use.extraHTTPHeaders, undefined)
      assert.deepEqual([local.webServer.url, local.webServer.reuseExistingServer], ['http://localhost:5173', true])
      assert.match(local.webServer.command, /dev .*--strictPort$/)
      assert.equal((await load({ PORT: '4150' })).use.baseURL, 'http://localhost:4150')
      const headers = { 'x-chon-ban': 'moi', 'cf-access-token': 'abc' }
      const remote = await load({ PORT: '4150', BASE_URL: 'https://thu.example.workers.dev', SMOKE_EXTRA_HTTP_HEADERS: JSON.stringify(headers) })
      assert.equal(remote.use.baseURL, 'https://thu.example.workers.dev')
      assert.deepEqual(remote.use.extraHTTPHeaders, headers)
      assert.equal(remote.webServer, undefined, 'chạy vào bản trên mạng thì không bật server trên máy')
      await assert.rejects(load({ SMOKE_EXTRA_HTTP_HEADERS: '{ hỏng' }), /JSON|Expected|Unexpected/, 'JSON header hỏng phải báo lỗi, không im lặng bỏ qua')
    } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  })

  test('AC-30: app có src/shared/safe-log.ts (module shared trong docs/arch.json), AI_RULES dặn ghi log qua safeLog, knip miễn file này', () => {
    assert.ok(has(dir, 'src/shared/safe-log.ts'))
    const arch = JSON.parse(read(dir, 'docs/arch.json'))
    assert.ok(arch.parts[0].modules.some((m) => m.path === 'src/shared' && m.mayDependOn.length === 0), 'shared là module không phụ thuộc ai')
    assert.match(read(dir, 'docs/ARCHITECTURE.md'), /`src\/shared`/)
    assert.match(read(dir, 'AI_RULES.md'), /safeLog.*src\/shared\/safe-log\.ts/)
    assert.match(read(dir, 'knip.jsonc'), /"ignore": \[[^\]]*"src\/shared\/safe-log\.ts"/)
  })

  test('kết quả cho captain: lệnh chạy thử + địa chỉ', () => {
    assert.equal(r.pm, 'pnpm')
    assert.equal(r.next.dev, 'pnpm dev')
    assert.equal(r.next.url, 'http://localhost:5173')
    assert.equal(r.next.cwd, dir)
  })
})

describe('create — web bằng npm', () => {
  test('npx --yes shadcn@bản-ghim, npm install -D, token theo npm', () => {
    const parent = mk()
    const { run, calls } = makeRun()
    const r = create({ type: 'web', name: 'app-npm', parent, pm: 'npm', io: { run, platform: 'win32' } })
    const v = loadVersions()
    const gen = calls.find((c) => c.args.includes(`shadcn@${v.shadcn}`))
    assert.deepEqual([gen.cmd, gen.args[0]], ['npx', '--yes'])
    const add = calls.find(isAdd)
    assert.deepEqual(add.args.slice(0, 2), ['install', '-D'])
    assert.equal(loadConfig(r.dir, undefined, {}).start, 'npm run dev -- --strictPort')
    assert.ok(read(r.dir, 'playwright.config.ts').includes("command: 'npm run dev -- --strictPort'"))
    assert.ok(calls.some((c) => c.cmd === 'npm' && c.args[0] === 'run' && c.args[1] === 'build'), 'dựng thử bằng npm run build')
    assert.match(read(r.dir, 'AI_RULES.md'), /npm run test:e2e/)
    assert.equal(r.next.dev, 'npm run dev --')
  })
})

describe('create — desktop (Wails v2, chưa có git)', () => {
  const parent = mk()
  const { run, calls } = makeRun()
  const r = create({ type: 'desktop', name: 'may-tinh', parent, io: { run, platform: 'win32' } })
  const dir = r.dir

  test('lệnh tạo Wails v2 react-ts; cài thư viện và công cụ kiểm thử trong frontend/', () => {
    const gen = calls.find((c) => c.cmd === 'wails' && c.args[0] === 'init')
    assert.deepEqual(gen.args, ['init', '-n', 'may-tinh', '-t', 'react-ts', '-q'])
    assert.equal(gen.cwd, parent)
    const inst = calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')
    assert.equal(inst.cwd, path.join(dir, 'frontend'))
    assert.equal(calls.find(isAdd).cwd, path.join(dir, 'frontend'))
    assert.ok(calls.indexOf(inst) < calls.indexOf(calls.find(isAdd)))
  })

  test('máy kiểm chạy được ngay: frontend nâng bản + tsconfig/vite/eslint/knip/size-limit trong frontend/, dựng thử trong frontend/, cổng đọc từ PORT', () => {
    const v = loadVersions()
    const added = calls.find(isAdd).args.slice(2)
    for (const [name, key] of [['vite', 'vite'], ['@vitejs/plugin-react', 'pluginReact'], ['typescript', 'typescript'], ['knip', 'knip'], ['dependency-cruiser', 'depcruise'], ['eslint', 'eslint']]) assert.ok(added.includes(`${name}@${v[key]}`), name)
    const build = calls.find(isBuild)
    assert.equal(build.cwd, path.join(dir, 'frontend'))
    assert.deepEqual(r.steps.map((s) => s.id).slice(-3), ['arch', 'build', 'save'])
    for (const f of ['eslint.config.js', 'knip.jsonc', '.size-limit.json', 'tsconfig.json', 'vite.config.ts']) assert.ok(has(dir, `frontend/${f}`), f)
    assert.ok(!has(dir, 'frontend/tsconfig.node.json'), 'tsconfig.node.json cũ (composite, moduleResolution Node) bị gỡ')
    const tsconfig = read(dir, 'frontend/tsconfig.json')
    assert.match(tsconfig, /"moduleResolution": "bundler"/)
    assert.ok(!/references/.test(tsconfig), 'một tsconfig, không references (checker tsc chạy thẳng)')
    assert.match(read(dir, 'frontend/vite.config.ts'), /port: Number\(process\.env\.PORT\) \|\| 5173/)
    assert.ok(read(dir, 'frontend/playwright.config.ts').includes('const port = Number(process.env.PORT) || 5173'))
    assert.ok(read(dir, 'frontend/e2e/first-screen.spec.ts').split('\n').some((l) => /^test\('.*a11y.*axe/.test(l)), 'test axe có chữ a11y trong tên')
    assert.match(read(dir, 'frontend/eslint.config.js'), /wailsjs/)
  })

  test('git do kit lập: điểm "Bắt đầu" (bản vừa tạo) rồi "Tạo app" (có lớp phủ); build/ vẫn được theo dõi', () => {
    const tags = g(dir, 'tag', '--list', 'luu/*', '--sort=creatordate').split('\n')
    assert.equal(tags.length, 2)
    assert.match(tags[0], /bat-dau$/)
    assert.match(tags[1], /tao-app$/)
    assert.equal(g(dir, 'status', '--porcelain'), '')
    assert.ok(g(dir, 'ls-files', 'build').includes('build/appicon.png'), 'build/appicon.png phải nằm trong git')
    assert.ok(!/^build\/?$/m.test(read(dir, '.gitignore')))
    assert.match(read(dir, '.gitignore'), /^build\/bin\/?$/m)
    assert.ok(!g(dir, 'ls-tree', '-r', '--name-only', tags[0]).includes('AI_RULES.md'), 'điểm Bắt đầu chưa có lớp phủ')
  })

  test('màn đầu trống: frontend/src/features/home; Go chỉ còn struct App rỗng, chưa có miền internal/', () => {
    assertEmptyHome(dir, 'may-tinh', 'frontend/src/features/home/ui/home-screen.tsx', 'frontend/e2e/first-screen.spec.ts')
    for (const f of ['frontend/src/features/orders', 'frontend/src/shared/format.ts', 'internal']) assert.ok(!has(dir, f), `${f}: mẫu cũ đã bỏ`)
    const app = read(dir, 'app.go')
    assert.match(app, /func NewApp\(\) \*App/)
    assert.ok(!/internal\//.test(app.replace(/\/\/.*$/gm, '')), 'app.go không import miền nào')
    const arch = JSON.parse(read(dir, 'docs/arch.json'))
    const go = arch.parts.find((p) => p.stack === 'go')
    assert.deepEqual(go.modules, [], 'phần Go chưa có miền')
    assert.deepEqual(arch.parts.find((p) => p.stack === 'web').modules.map((m) => m.path), ['frontend/src/features/home', 'frontend/src/shared'], 'shared có sẵn safe-log.ts (AC-30)')
  })

  test('AC-30: giao diện có frontend/src/shared/safe-log.ts, AI_RULES dặn ghi log qua safeLog, knip miễn file này', () => {
    assert.ok(has(dir, 'frontend/src/shared/safe-log.ts'))
    assert.match(read(dir, 'AI_RULES.md'), /safeLog.*frontend\/src\/shared\/safe-log\.ts/)
    assert.match(read(dir, 'frontend/knip.jsonc'), /"ignore": \[[^\]]*"src\/shared\/safe-log\.ts"/)
  })

  test('wails.json đổi sang trình quản lý gói đang dùng; Go dùng đúng module', () => {
    const w = JSON.parse(read(dir, 'wails.json'))
    assert.equal(w['frontend:install'], 'pnpm install')
    assert.equal(w['frontend:build'], 'pnpm build')
    assert.equal(w['frontend:dev:watcher'], 'pnpm dev')
    assert.equal(w['frontend:dev:serverUrl'], 'auto')
    assert.equal(w.name, 'may-tinh')
    assert.match(read(dir, 'go.mod'), /^module may-tinh$/m)
    assert.deepEqual(leftoverTokens(dir), [])
  })

  test('AI_RULES dặn đuôi App/Service/Bindings cho struct bind (luật ai-wails-binding-exec-write)', () => {
    const rules = read(dir, 'AI_RULES.md')
    assert.match(rules, /`App`, `Service` hoặc `Bindings`/)
    assert.match(rules, /ai-wails-binding-exec-write/)
    assert.match(read(dir, 'app.go'), /type App struct/)
    assert.ok(!/os\.WriteFile|exec\.Command/.test(read(dir, 'app.go').replace(/\/\/.*$/gm, '')), 'hàm bind không ghi file / chạy lệnh')
  })

  test('khớp máy kiểm: ui.json ở frontend/ nạp được (Playwright cài trong frontend); kiến trúc web + go khớp; mã S-01', () => {
    const cfg = loadConfig(path.join(dir, 'frontend'), undefined, {})
    assert.deepEqual(cfg.targets.map((t) => [t.label, t.s]), [['/', 'S-01']])
    assert.equal(cfg.start, 'pnpm dev --strictPort')
    assert.equal(cfg.url, 'http://localhost:5173')
    assert.deepEqual(syncCheck(dir).problems, [])
    const spec = path.join(dir, 'SPEC.md')
    fs.writeFileSync(spec, SPEC)
    assert.deepEqual(traceCodes(dir, [spec]).problems, [])
    fs.rmSync(spec)
  })
})

describe('create — extension (WXT)', () => {
  const parent = mk()
  const { run, calls } = makeRun()
  const r = create({ type: 'extension', name: 'luu-trang', parent, io: { run, platform: 'win32' } })
  const dir = r.dir

  test('lệnh tạo WXT ghim bản; cài thư viện TRƯỚC khi thêm công cụ kiểm thử; dựng thử cuối cùng', () => {
    const v = loadVersions()
    const gen = calls.find((c) => c.args.includes(`wxt@${v.wxt}`))
    assert.deepEqual(gen.args, ['dlx', `wxt@${v.wxt}`, 'init', 'luu-trang', '-t', 'react', '--pm', 'pnpm'])
    const iInstall = calls.findIndex((c) => c.cmd === 'pnpm' && c.args[0] === 'install')
    assert.ok(iInstall > calls.indexOf(gen) && iInstall < calls.findIndex(isAdd))
    const added = calls.find(isAdd).args.slice(2).map((p) => p.replace(/@[^@/]+$/, ''))
    for (const need of ['@playwright/test', '@axe-core/playwright', 'eslint', '@eslint/js', 'typescript-eslint', 'eslint-plugin-react-hooks', 'globals', 'knip', 'jscpd', 'size-limit', '@size-limit/file', 'dependency-cruiser']) assert.ok(added.includes(need), need)
    assert.ok(calls.findIndex(isBuild) > calls.findIndex(isBrowser), 'dựng thử sau khi đủ công cụ')
    assert.deepEqual(r.steps.map((s) => s.id).slice(-3), ['arch', 'build', 'save'])
  })

  test('máy kiểm chạy được ngay: bản build ra dist/, ESLint + knip + size-limit + osv có cấu hình, import "@/" dò được, quyền không đổi', () => {
    const cfg = read(dir, 'wxt.config.ts')
    assert.match(cfg, /outDir: 'dist'/)
    assert.ok(cfg.includes("outDirTemplate: '.{{modeSuffix}}'"), 'bản dev ra dist/.-dev, không đè bản build')
    assert.ok(cfg.includes('port: Number(process.env.PORT) || 5173'), 'cổng chạy thử đọc từ PORT')
    assert.match(read(dir, 'tsconfig.json'), /"@\/\*": \["\.\/src\/\*"\]/)
    assert.match(read(dir, 'pnpm-workspace.yaml'), /^overrides:\n {2}shell-quote: \^1\.11\.0$/m)
    for (const f of ['eslint.config.js', 'knip.jsonc', '.size-limit.json', 'osv-scanner.toml', '.dependency-cruiser.cjs']) assert.ok(has(dir, f), f)
    assert.match(read(dir, '.size-limit.json'), /dist\/chunks\/\*\.js/)
    assert.match(read(dir, 'knip.jsonc'), /src\/entrypoints/)
    assert.match(read(dir, 'osv-scanner.toml'), /ignoreUntil = \d{4}-\d{2}-\d{2}/)
    assert.match(read(dir, 'e2e/popup.spec.ts'), /resolve\('dist'\)/)
    assert.ok(read(dir, 'e2e/popup.spec.ts').split('\n').some((l) => /^test\('.*a11y.*axe/.test(l)), 'test axe có chữ a11y trong tên')
    const scripts = JSON.parse(read(dir, 'package.json')).scripts
    assert.deepEqual(Object.keys(scripts).sort(), ['build', 'compile', 'dev', 'lint', 'postinstall', 'test:e2e', 'zip'], 'bỏ script *:firefox (bản Firefox sẽ đè dist/ của bản Chrome)')
    assert.equal(JSON.parse(read(dir, 'package.json')).overrides, undefined, 'pnpm dùng pnpm-workspace.yaml, không ghi overrides vào package.json')
    const ui = JSON.parse(read(dir, '.claude/ui.json'))
    assert.deepEqual([ui.url, ui.start], ['http://localhost:{PORT}', 'pnpm dev'])
  })

  test('docs/arch.json: popup (entrypoints) được import features/home; mô tả không còn "(điền…)"', () => {
    const arch = JSON.parse(read(dir, 'docs/arch.json'))
    const mods = Object.fromEntries(arch.parts[0].modules.map((m) => [m.path, m]))
    assert.deepEqual(Object.keys(mods).sort(), ['src/entrypoints', 'src/features/home'])
    assert.deepEqual(mods['src/entrypoints'].mayDependOn, ['features/home'])
    assert.ok(arch.parts[0].modules.every((m) => !/^\(điền/.test(m.desc)), 'mô tả đã điền hết')
    assert.match(read(dir, '.dependency-cruiser.cjs'), /features\/home/)
  })

  test('màn đầu trống: popup chỉ hiện tên extension; mẫu cũ (trang đã lưu, activeTab) đã bỏ', () => {
    assertEmptyHome(dir, 'luu-trang', 'src/features/home/ui/home-screen.tsx', 'e2e/popup.spec.ts')
    for (const f of ['src/features/pages', 'src/shared/url.ts']) assert.ok(!has(dir, f), `${f}: mẫu cũ đã bỏ`)
    assert.match(read(dir, 'e2e/popup.spec.ts'), /extension chưa xin quyền nào/)
  })

  test('--pm npm: ép shell-quote bản vá qua "overrides" của package.json (pnpm-workspace.yaml không có tác dụng với npm)', () => {
    const r2 = create({ type: 'extension', name: 'luu-npm', parent: mk(), pm: 'npm', io: { run: makeRun().run, platform: 'win32' } })
    assert.deepEqual(JSON.parse(read(r2.dir, 'package.json')).overrides, { 'shell-quote': '^1.11.0' })
    assert.equal(JSON.parse(read(r2.dir, 'package.json')).scripts['test:e2e'], 'wxt build && playwright test')
  })

  test('gỡ content script mẫu *.google.com; mã chuyển vào src/; chưa xin quyền nào', () => {
    assert.ok(!has(dir, 'src/entrypoints/content.ts') && !has(dir, 'entrypoints'))
    assert.ok(has(dir, 'src/entrypoints/background.ts') && has(dir, 'src/assets/react.svg'))
    assert.match(read(dir, 'src/entrypoints/popup/App.tsx'), /HomeScreen/)
    const cfg = read(dir, 'wxt.config.ts')
    assert.match(cfg, /srcDir: 'src'/)
    assert.ok(!/permissions|<all_urls>|google\.com/.test(cfg.replace(/\/\/.*$/gm, '')), 'không khai permissions / host_permissions')
    assert.equal(JSON.parse(read(dir, 'package.json')).name, 'luu-trang')
    assert.deepEqual(extensionPermProblems(dir), [])
    assert.deepEqual(leftoverTokens(dir), [])
  })

  test('khớp máy kiểm: ui.json trỏ đúng trang popup của máy chủ dev; kiến trúc khớp; mã S-01', () => {
    const cfg = loadConfig(dir)
    assert.deepEqual(cfg.targets.map((t) => [t.label, t.s]), [['/src/entrypoints/popup/index.html', 'S-01']])
    assert.deepEqual(syncCheck(dir).problems, [])
    const spec = path.join(dir, 'SPEC.md')
    fs.writeFileSync(spec, SPEC)
    assert.deepEqual(traceCodes(dir, [spec]).problems, [])
    fs.rmSync(spec)
  })
})

describe('create — an toàn', () => {
  const thrown = (fn) => { try { fn(); } catch (e) { return e } return null }

  test('thư mục đích đã có đồ ⇒ exit 1, không chạy lệnh nào, không đè', () => {
    const parent = mk()
    put(parent, 'don-hang/việc-của-tôi.txt', 'đừng đè')
    const { run, calls } = makeRun()
    const e = thrown(() => create({ type: 'web', name: 'don-hang', parent, io: { run } }))
    assert.ok(e instanceof NewAppError)
    assert.equal(e.exit, 1)
    assert.match(e.message, /đã có đồ bên trong/)
    assert.equal(calls.length, 0)
    assert.equal(read(parent, 'don-hang/việc-của-tôi.txt'), 'đừng đè')
  })

  test('đích là một file ⇒ từ chối', () => {
    const parent = mk()
    put(parent, 'don-hang', 'file')
    const e = thrown(() => create({ type: 'web', name: 'don-hang', parent, io: { run: makeRun().run } }))
    assert.equal(e.exit, 1)
    assert.equal(read(parent, 'don-hang'), 'file')
  })

  test('thư mục cha là một file ⇒ từ chối', () => {
    const parent = mk()
    put(parent, 'cha', 'file')
    const e = thrown(() => create({ type: 'web', name: 'don-hang', parent: path.join(parent, 'cha'), io: { run: makeRun().run } }))
    assert.equal(e.exit, 1)
  })

  test('thư mục đích RỖNG dùng lại được; thư mục cha chưa có thì tạo', () => {
    const parent = path.join(mk(), 'chưa có', 'sâu hơn')
    fs.mkdirSync(path.join(parent, 'don-hang'), { recursive: true })
    const r = create({ type: 'web', name: 'don-hang', parent, io: { run: makeRun().run, platform: 'win32' } })
    assert.ok(has(r.dir, 'AI_RULES.md'))
    const p2 = path.join(mk(), 'cha mới')
    assert.ok(has(create({ type: 'extension', name: 'ext-moi', parent: p2, io: { run: makeRun().run, platform: 'win32' } }).dir, 'wxt.config.ts'))
  })

  test('tên hoặc loại sai ⇒ exit 2, không chạy lệnh', () => {
    const { run, calls } = makeRun()
    for (const bad of [{ name: 'Tên Có Dấu' }, { name: '../ngoai' }, { name: 'a b' }, { type: 'mobile' }, { type: undefined }]) {
      const e = thrown(() => create({ type: 'web', name: 'ten-dung', parent: mk(), io: { run }, ...bad }))
      assert.equal(e?.exit, 2, JSON.stringify(bad))
    }
    assert.equal(calls.length, 0)
  })

  test('máy thiếu phần mềm ⇒ exit 3, nêu lệnh cài, không tạo gì', () => {
    const parent = mk()
    const { run, calls } = makeRun({ missing: ['go', 'wails'] })
    const e = thrown(() => create({ type: 'desktop', name: 'may-tinh', parent, io: { run, platform: 'win32' } }))
    assert.equal(e.exit, 3)
    assert.ok(e.lines.some((l) => /Windows: winget install GoLang\.Go/.test(l)))
    assert.ok(!e.lines.some((l) => /Mac:/.test(l)), 'đang chạy Windows ⇒ không in lệnh Mac')
    assert.ok(!calls.some((c) => c.cmd === 'wails' && c.args[0] === 'init'))
    assert.ok(!has(parent, 'may-tinh'))
    const mac = thrown(() => create({ type: 'desktop', name: 'may-tinh', parent, io: { run: makeRun({ missing: ['go', 'wails'] }).run, platform: 'darwin' } }))
    assert.ok(mac.lines.some((l) => /Mac: brew install go/.test(l)))
    assert.ok(!mac.lines.some((l) => /Windows:/.test(l)), 'đang chạy Mac ⇒ không in câu Windows')
  })

  test('lệnh tạo lỗi mạng ⇒ lời đời thường, kind=network; chưa có điểm lưu nào', () => {
    const parent = mk()
    const fail = { '^pnpm dlx': { status: 1, stdout: '', stderr: 'ERR_PNPM_META_FETCH_FAIL fetch failed ENOTFOUND registry.npmjs.org', error: null } }
    const e = thrown(() => create({ type: 'web', name: 'don-hang', parent, io: { run: makeRun({ fail }).run, platform: 'win32' } }))
    assert.equal(e.kind, 'network')
    assert.equal(e.exit, 1)
    assert.match(e.message, /Kiểm tra kết nối internet/)
    assert.ok(e.lines[0].startsWith('Chi tiết: '))
    assert.ok(!has(parent, 'don-hang'))
  })

  test('lệnh tạo đổi cờ ⇒ kind=flags, nói đây là lỗi của kit', () => {
    const fail = { '^wails init': { status: 1, stdout: '', stderr: 'flag provided but not defined: -q', error: null } }
    const e = thrown(() => create({ type: 'desktop', name: 'may-tinh', parent: mk(), io: { run: makeRun({ fail }).run, platform: 'win32' } }))
    assert.equal(e.kind, 'flags')
    assert.match(e.message, /lỗi của kit/)
  })

  test('lệnh tạo xong mà không ra kết quả như mong đợi ⇒ báo, không đi tiếp', () => {
    const parent = mk()
    const { run, calls } = makeRun({ genResult: { web: 'none' } })
    const e = thrown(() => create({ type: 'web', name: 'don-hang', parent, io: { run, platform: 'win32' } }))
    assert.equal(e.kind, 'flags')
    assert.match(e.message, /không thấy kết quả/)
    assert.ok(!calls.some(isAdd))
  })

  test('cài công cụ kiểm thử lỗi ⇒ báo kèm lệnh chạy lại; tải trình duyệt lỗi ⇒ chỉ ghi chú, app vẫn tạo xong', () => {
    const failAdd = { '^pnpm add': { status: 1, stdout: '', stderr: 'ENOTFOUND', error: null } }
    const e = thrown(() => create({ type: 'web', name: 'app-a', parent: mk(), io: { run: makeRun({ fail: failAdd }).run, platform: 'win32' } }))
    assert.equal(e.kind, 'network')
    assert.match(e.message, /pnpm add -D @playwright\/test@/)
    const failBrowser = { 'playwright install': { status: 1, stdout: '', stderr: 'ENOTFOUND cdn.playwright.dev', error: null } }
    const r = create({ type: 'web', name: 'app-b', parent: mk(), io: { run: makeRun({ fail: failBrowser }).run, platform: 'win32' } })
    assert.ok(r.notes.some((n) => /Chưa tải được trình duyệt kiểm thử \(network\)\. Khi mạng ổn chạy: .*pnpm exec playwright install chromium/.test(n)))
    assert.equal(g(r.dir, 'status', '--porcelain'), '')
    // Lỗi không phải mạng (vd sandbox chặn quyền) ⇒ không khuyên "khi mạng ổn"
    const permBrowser = { 'playwright install': { status: 1, stdout: '', stderr: 'EACCES: permission denied, mkdir /Users/x/Library/Caches/ms-playwright', error: null } }
    const p = create({ type: 'web', name: 'app-c', parent: mk(), io: { run: makeRun({ fail: permBrowser }).run, platform: 'win32' } })
    const note = p.notes.find((n) => n.startsWith('Chưa tải được trình duyệt'))
    assert.match(note, /\(permission\)/)
    assert.doesNotMatch(note, /mạng ổn/)
    assert.match(note, /Không có quyền ghi.*Sửa xong chạy: .*playwright install chromium/)
  })

  test('dựng thử lỗi ⇒ báo kèm lệnh chạy lại, thư mục app giữ nguyên (không tự xoá, chưa có điểm lưu)', () => {
    const failBuild = { '^pnpm run build': { status: 1, stdout: '', stderr: 'error TS2304: Cannot find name', error: null } }
    const parent = mk()
    const e = thrown(() => create({ type: 'web', name: 'app-c', parent, io: { run: makeRun({ fail: failBuild }).run, platform: 'win32' } }))
    assert.equal(e.exit, 1)
    assert.match(e.message, /pnpm run build/)
    assert.match(e.message, /App đã tạo ở /)
    assert.ok(has(parent, 'app-c/AI_RULES.md') && has(parent, 'app-c/.dependency-cruiser.cjs'))
    assert.equal(g(path.join(parent, 'app-c'), 'tag', '--list', 'luu/*').includes('tao-app'), false, 'chưa lưu điểm "Tạo app" khi dựng lỗi')
  })

  test('thiếu bản ghim (versions.json) hoặc devDeps trỏ tới bản ghim không có ⇒ báo rõ, không chạy lệnh nào', () => {
    const kit = mk('kit thiếu bản ghim')
    fs.cpSync(path.join(KIT_DIR, 'templates'), path.join(kit, 'templates'), { recursive: true })
    fs.copyFileSync(path.join(KIT_DIR, 'checkers.json'), path.join(kit, 'checkers.json')) // doctor đọc danh sách công cụ bắt buộc ở đây
    const versions = JSON.parse(read(kit, 'templates/versions.json'))
    const { knip: _bo, ...thieu } = versions
    put(kit, 'templates/versions.json', JSON.stringify(thieu))
    const a = makeRun()
    const e1 = thrown(() => create({ type: 'web', name: 'app-d', parent: mk(), io: { run: a.run, kit } }))
    assert.match(e1.message, /thiếu bản ghim "knip"/)
    assert.equal(a.calls.length, 0)
    put(kit, 'templates/versions.json', JSON.stringify(versions))
    const tpl = JSON.parse(read(kit, 'templates/web/template.json'))
    tpl.devDeps.push({ name: 'goi-la', version: 'khongCoBanGhim' })
    put(kit, 'templates/web/template.json', JSON.stringify(tpl))
    const b = makeRun()
    const e2 = thrown(() => create({ type: 'web', name: 'app-e', parent: mk(), io: { run: b.run, kit, platform: 'win32' } }))
    assert.match(e2.message, /devDeps "goi-la" trỏ tới bản ghim "khongCoBanGhim"/)
    assert.ok(!b.calls.some(isAdd), 'chưa chạy lệnh cài')
  })

  test('mọi lệnh ngoài chạy với cwd trong thư mục cha / thư mục app, không ghép đường dẫn vào đối số', () => {
    const parent = mk('cha có dấu cách')
    const { run, calls } = makeRun()
    create({ type: 'extension', name: 'ext-x', parent, io: { run, platform: 'win32' } })
    for (const c of calls.filter((x) => x.cmd !== 'git')) {
      assert.ok(!c.args.some((a) => String(a).includes(parent)), `${c.cmd} ${c.args.join(' ')}`)
      assert.ok(!c.cwd || c.cwd.startsWith(parent), c.cwd)
    }
  })
})

describe('defaultRun', () => {
  test('stdin đóng (lệnh không thể hỏi) và trả mã thoát + đầu ra', () => {
    const r = defaultRun(process.execPath, ['-e', "process.stdin.on('end', () => console.log('stdin-dong')); process.stdin.resume()"], { timeoutMs: 20000 })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /stdin-dong/)
  })
  test('lệnh không có ⇒ ENOENT; quá giờ ⇒ ETIMEDOUT', () => {
    assert.equal(defaultRun('lenh-khong-ton-tai-xyz', []).error.code, 'ENOENT')
    const slow = defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })
    assert.equal(slow.error?.code, 'ETIMEDOUT')
  })
})

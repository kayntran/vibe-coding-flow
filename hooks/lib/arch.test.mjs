// Test cho lib/arch.mjs: node --test ~/.claude/hooks/lib/arch.test.mjs
// Mọi thứ chạy trong thư mục tạm (fs.mkdtempSync). Công cụ ngoài (depcruise, eslint, go-arch-lint) được thay bằng runner giả;
// máy có sẵn golangci-lint/go/git thì chạy thêm test thật (mốc new-from-rev, depguard), máy có depcruise/eslint ≥ 9.24 thì chạy thêm
// test thật của chúng — không có thì skip kèm lý do.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from './arch.mjs'

const require = createRequire(import.meta.url)
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })
const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'))); roots.push(d); return d }
const put = (dir, rel, text = '') => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')))
const nLines = (n, tag = 'x') => `${Array.from({ length: n }, (_, i) => `// ${tag}${i}`).join('\n')}\n`

const LIMITS = { fileLines: 400, fnLines: 60, complexity: 15 }
const webPart = (o = {}) => ({
  name: 'web', stack: 'web', root: 'src',
  modules: [
    { name: 'features/a', path: 'src/features/a', desc: 'Tính năng A', mayDependOn: ['shared'] },
    { name: 'features/b', path: 'src/features/b', desc: 'Tính năng B', mayDependOn: ['shared'] },
    { name: 'shared', path: 'src/shared', desc: 'Dùng chung', mayDependOn: [] },
  ],
  shared: ['src/shared'],
  limits: { ...LIMITS },
  forbidden: [{ from: 'src/features/*/model/**', to: 'src/features/*/ui/**', reason: 'model không biết giao diện', fix: 'Đưa phần dùng chung sang shared' }],
  ...o,
})
const goPart = (o = {}) => ({
  name: 'go', stack: 'go', root: 'internal',
  modules: [
    { name: 'billing', path: 'internal/billing', desc: 'Thanh toán', mayDependOn: [] },
    { name: 'orders', path: 'internal/orders', desc: 'Đơn hàng', mayDependOn: ['billing'] },
  ],
  shared: [],
  limits: { ...LIMITS },
  forbidden: [
    { from: 'internal/*/domain/**', to: 'database/sql', reason: 'domain không biết DB', fix: 'Gọi qua interface, cài đặt trong store' },
    { from: 'internal/*/domain/**', to: 'internal/*/{service,store,transport}', reason: 'domain không import ai', fix: 'Định nghĩa interface trong domain' },
  ],
  ...o,
})
const writeArch = (dir, parts) => put(dir, 'docs/arch.json', JSON.stringify({ version: 1, parts }, null, 2))
const codemap = (paths) => `# Kiến trúc\n\n## Codemap\n\n${paths.map((p) => `- \`${p}\` — làm gì; KHÔNG làm gì`).join('\n')}\n\n## Bất biến\n\n- không có\n`
// dự án web mẫu: hai tính năng A, B + shared, đã có arch.json và ARCHITECTURE.md khớp
const webProject = (partOver = {}) => {
  const dir = tmp()
  put(dir, 'src/features/a/ui/A.ts', 'export const a = 1\n')
  put(dir, 'src/features/b/ui/B.ts', 'export const b = 1\n')
  put(dir, 'src/shared/util.ts', 'export const u = 1\n')
  writeArch(dir, [webPart(partOver)])
  put(dir, 'docs/ARCHITECTURE.md', codemap(['src/features/a', 'src/features/b', 'src/shared']))
  return dir
}
const goProject = () => {
  const dir = tmp()
  put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
  put(dir, 'internal/billing/domain/d.go', 'package domain\n')
  put(dir, 'internal/orders/service/s.go', 'package service\n')
  writeArch(dir, [goPart()])
  put(dir, 'docs/ARCHITECTURE.md', codemap(['internal/billing', 'internal/orders']))
  return dir
}
const ENOENT = { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'không thấy công cụ' } }
// runner giả: handlers[cmd](args, opts) → {status, stdout, stderr}; lệnh không có handler ⇒ công cụ THIẾU (ENOENT)
const fakeRun = (handlers = {}) => {
  const calls = []
  const run = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd, from: opts.from })
    const h = handlers[cmd]
    if (!h) return ENOENT
    const r = h(args, opts)
    return { status: 0, stdout: '', stderr: '', error: null, ...r }
  }
  run.calls = calls
  return run
}
const git = (dir, ...args) => A.defaultRun('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir })
const have = (name) => A.findBin(name, process.cwd()) !== null
// golangci-lint lưu kết quả theo NỘI DUNG gói chứ không theo đường dẫn: hai thư mục có code giống hệt nhau thì new-from-rev lọc nhầm mất cả lỗi mới
// (test chạy lại sẽ xanh giả/đỏ giả). Mỗi lần chạy thật dùng cache riêng.
// --allow-parallel-runners: golangci-lint giữ một khoá chung cả máy, hai bộ test chạy song song (arch + flow-check) sẽ đụng nhau ("parallel golangci-lint is running").
const glc = (dir, args) => A.defaultRun('golangci-lint', ['run', '--allow-parallel-runners', ...args, './...'], { cwd: dir, timeoutMs: 120000, env: { ...process.env, GOLANGCI_LINT_CACHE: tmp() } })

// depcruise 18 chỉ chạy trên Node 22 / 24 / 26+. Node của máy không đủ ⇒ tìm một Node đủ (thư mục trong FLOW_DEPCRUISE_NODE_DIR, hoặc bộ chạy sẵn có của Codex) đặt lên đầu PATH;
// không có ⇒ DC.skip nêu lý do và các test depcruise THẬT bỏ qua. DC.env = môi trường để chạy depcruise.
const pathKey = (env) => Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
const envWithNodeDir = (d) => { const env = { ...process.env }; const k = pathKey(env); env[k] = `${d}${path.delimiter}${env[k] ?? ''}`; return env }
const DC = (() => {
  if (A.findBin('depcruise', process.cwd()) === null) return { skip: 'máy không có depcruise (npm i -D dependency-cruiser) — bỏ qua test thật' }
  const works = (env) => { const v = A.defaultRun('depcruise', ['--version'], { cwd: os.tmpdir(), env }); return v.status === 0 && !A.nodeEngineProblem(`${v.stdout}\n${v.stderr}`) }
  if (works(process.env)) return { env: process.env }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const dirs = [process.env.FLOW_DEPCRUISE_NODE_DIR, path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin')].filter(Boolean)
  for (const d of dirs) if (fs.existsSync(path.join(d, exe)) && works(envWithNodeDir(d))) return { env: envWithNodeDir(d) }
  return { skip: `depcruise không chạy trên Node ${process.versions.node} (cần Node 22/24/26+); đặt FLOW_DEPCRUISE_NODE_DIR = thư mục chứa Node đủ mới để chạy test thật — bỏ qua test thật` }
})()
const dcRun = (dir, args) => A.defaultRun('depcruise', args, { cwd: dir, env: DC.env, timeoutMs: 240000 })

describe('globToRegex / expandBraces', () => {
  const m = (glob, p) => new RegExp(A.globToRegex(glob)).test(p)
  test('* không vượt dấu /, ** vượt; khớp cả thư mục lẫn file bên dưới', () => {
    assert.ok(m('src/features/*/ui/**', 'src/features/a/ui/x.tsx'))
    assert.ok(m('src/features/*/ui/**', 'src/features/a/ui'))
    assert.ok(!m('src/features/*/ui/**', 'src/features/a/api/x.tsx'))
    assert.ok(!m('src/features/*/ui/**', 'src/features/a/b/ui/x.tsx'))
    assert.ok(!m('src/features/*/ui', 'src/features/a/uix/x.ts'))
    assert.ok(m('src/features/*/ui', 'src/features/a/ui/deep/x.ts'))
  })
  test('{a,b}, **/ ở giữa, ký tự đặc biệt được escape', () => {
    assert.ok(m('src/features/*/{ui,model}/**', 'src/features/a/model/x.ts'))
    assert.ok(m('src/features/*/{ui,model}/**', 'src/features/a/ui/x.ts'))
    assert.ok(!m('src/features/*/{ui,model}/**', 'src/features/a/api/x.ts'))
    assert.ok(m('src/**/x.ts', 'src/x.ts') && m('src/**/x.ts', 'src/a/b/x.ts'))
    assert.ok(!m('src/a.b/**', 'src/aXb/y.ts'))
  })
  test('glob của gói node_modules khớp cả đường dẫn pnpm (không neo đầu)', () => {
    const re = new RegExp(A.globToRegex('node_modules/@supabase/**', { anywhere: true }))
    assert.ok(re.test('node_modules/@supabase/supabase-js/dist/x.js'))
    assert.ok(re.test('node_modules/.pnpm/@supabase+supabase-js@2/node_modules/@supabase/supabase-js/dist/x.js'))
    assert.ok(!re.test('src/node_modules_x/@supabase/a.js'))
  })
  test('expandBraces', () => {
    assert.deepEqual(A.expandBraces('a/{b,c}/d'), ['a/b/d', 'a/c/d'])
    assert.deepEqual(A.expandBraces('x'), ['x'])
    assert.deepEqual(A.expandBraces('{a,b}/{c,d}').sort(), ['a/c', 'a/d', 'b/c', 'b/d'])
  })
})

describe('loadArch', () => {
  test('chưa có docs/arch.json ⇒ arch null + lỗi chỉ lệnh init', () => {
    const r = A.loadArch(tmp())
    assert.equal(r.arch, null)
    assert.match(r.errors[0], /docs\/arch\.json/)
    assert.match(r.errors[0], /arch\.mjs init/)
  })
  test('JSON hỏng ⇒ lỗi đời thường', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', '{ không phải json')
    const r = A.loadArch(dir)
    assert.equal(r.arch, null)
    assert.match(r.errors[0], /không đọc được/)
  })
  test('hợp lệ: điền mặc định limits, shared, forbidden; giữ nguyên trường lạ', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', JSON.stringify({ version: 1, $comment: 'x', parts: [{ name: 'web', stack: 'web', root: 'src/', modules: [{ name: 'shared', path: 'src/shared', mayDependOn: [] }] }] }))
    const r = A.loadArch(dir)
    assert.deepEqual(r.errors, [])
    const p = r.arch.parts[0]
    assert.deepEqual(p.limits, LIMITS)
    assert.deepEqual([p.shared, p.forbidden, p.root], [[], [], 'src'])
    assert.equal(r.arch.$comment, 'x')
  })
  test('forbidden thiếu reason hoặc fix ⇒ không hợp lệ, nói rõ luật số mấy thiếu gì', () => {
    const dir = tmp()
    writeArch(dir, [webPart({ forbidden: [{ from: 'src/a/**', to: 'src/b/**', fix: 'đổi' }, { from: 'src/a/**', to: 'src/c/**', reason: 'vì', fix: '  ' }] })])
    const r = A.loadArch(dir)
    assert.equal(r.arch, null)
    assert.ok(r.errors.some((e) => /forbidden\[0\]/.test(e) && /reason/.test(e)), r.errors.join('|'))
    assert.ok(r.errors.some((e) => /forbidden\[1\]/.test(e) && /fix/.test(e)), r.errors.join('|'))
  })
  test('lỗi cấu trúc: mayDependOn tên lạ, trùng tên module, path ngoài root, stack lạ, root tuyệt đối/.., limits sai, version, parts rỗng', () => {
    const bad = (mut) => { const dir = tmp(); writeArch(dir, mut); return A.loadArch(dir).errors.join('\n') }
    assert.match(bad([webPart({ modules: [{ name: 'a', path: 'src/a', mayDependOn: ['ma'] }] })]), /"ma"/)
    assert.match(bad([webPart({ modules: [{ name: 'a', path: 'src/a', mayDependOn: [] }, { name: 'a', path: 'src/b', mayDependOn: [] }] })]), /trùng/)
    assert.match(bad([webPart({ modules: [{ name: 'a', path: 'lib/a', mayDependOn: [] }] })]), /ngoài/)
    assert.match(bad([webPart({ stack: 'python' })]), /stack/)
    assert.match(bad([webPart({ root: '../src' })]), /root/)
    assert.match(bad([webPart({ root: '/abs/src' })]), /root/)
    assert.match(bad([webPart({ limits: { fileLines: 0, fnLines: 60, complexity: 15 } })]), /fileLines/)
    assert.match(bad([]), /parts/)
    assert.match(bad([webPart(), webPart()]), /trùng tên phần/)
    const dir = tmp(); put(dir, 'docs/arch.json', JSON.stringify({ version: 2, parts: [webPart()] }))
    assert.match(A.loadArch(dir).errors.join('\n'), /version/)
  })
  test('root là dữ liệu KHÔNG tin cậy: giống option CLI ("--exclude", "-x"), thoát ra ngoài ("../x", "src/../../x"), tuyệt đối ("C:/x", "C:\\x", "/etc", "//srv/share"), có ký tự điều khiển ⇒ KHÔNG hợp lệ kèm lời dặn; tên thư mục lạ (dấu cách, tiếng Việt, "a/-b") thì vẫn được', () => {
    const load = (part) => { const dir = tmp(); writeArch(dir, [part]); return A.loadArch(dir) }
    const noMods = { modules: [], shared: [], forbidden: [] }
    for (const root of ['--exclude', '-x', '../x', 'src/../../x', 'C:/x', 'C:\\x', '/etc', '//srv/share', '\\\\srv\\share', './--exclude', 'sr\nc', 'src\u0000', 'src\u0085x']) {
      const r = load(webPart({ root, ...noMods }))
      assert.equal(r.arch, null, `root ${JSON.stringify(root)} phải bị từ chối`)
      assert.match(r.errors.join('\n'), /"root".*không dùng được/, JSON.stringify(root))
      assert.match(r.errors.join('\n'), /thư mục con của dự án/, 'có lời dặn sửa')
    }
    for (const root of ['src', 'frontend/src', 'mã nguồn/giao diện', 'my app/src', 'src-x', 'a/-b', 'a..b/src']) {
      const r = load(webPart({ root, ...noMods }))
      assert.deepEqual(r.errors, [], `root ${JSON.stringify(root)} phải hợp lệ`)
    }
  })
  test('modules[].path, shared, forbidden.from/to cũng là dữ liệu không tin cậy: cùng bộ luật như root (glob {a,b} xét từng nhánh)', () => {
    const load = (over) => { const dir = tmp(); writeArch(dir, [webPart(over)]); return A.loadArch(dir) }
    const mod = (p) => ({ modules: [{ name: 'm', path: p, mayDependOn: [] }], shared: [] })
    for (const p of ['src/../../etc', 'src/a/../../../x', 'src/a\nb']) assert.match(load(mod(p)).errors.join('\n'), /modules\[0\].*path/, p)
    for (const s of ['--x', '../x', '/etc', 'C:/x', 'src/sh\u0000']) assert.match(load({ shared: [s] }).errors.join('\n'), /shared/, s)
    const fb = (from, to) => load({ forbidden: [{ from, to, reason: 'vì', fix: 'sửa' }] })
    for (const [from, to] of [['../x', 'src/b/**'], ['src/a/**', '/abs'], ['-x', 'src/b/**'], ['src/a/**', '--exclude'], ['src/{a,../b}/**', 'src/c/**'], ['src/a/**', '{/y,src/z}'],['src/a\n/**', 'src/b/**']]) {
      const r = fb(from, to)
      assert.equal(r.arch, null, `${from} → ${to}`)
      assert.match(r.errors.join('\n'), /forbidden\[0\]/, `${from} → ${to}`)
    }
    assert.deepEqual(fb('src/features/*/{ui,model}/**', 'node_modules/@supabase/**').errors, [], 'glob hợp lệ không bị chặn')
    assert.deepEqual(fb('internal/*/domain/**', 'database/sql').errors, [])
  })
  test('Wails = hai phần (web ở frontend/src + go) đều hợp lệ', () => {
    const dir = tmp()
    writeArch(dir, [webPart({ root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', mayDependOn: [] }], shared: ['frontend/src/shared'], forbidden: [] }), goPart()])
    const r = A.loadArch(dir)
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.arch.parts.map((p) => p.name), ['web', 'go'])
  })
})

describe('syncCheck', () => {
  test('khớp ba bên (arch.json ↔ thư mục ↔ codemap) ⇒ ok', () => {
    const r = A.syncCheck(webProject())
    assert.deepEqual(r.problems, [])
    assert.equal(r.ok, true)
  })
  test('thư mục có code mà chưa khai báo ⇒ báo thư mục lạ kèm lời dặn sửa', () => {
    const dir = webProject()
    put(dir, 'src/features/billing/ui/Pay.ts', 'export const p = 1\n')
    put(dir, 'src/lib/fmt.ts', 'export const f = 1\n')
    const r = A.syncCheck(dir)
    assert.equal(r.ok, false)
    const files = r.problems.map((p) => p.file).sort()
    assert.deepEqual(files, ['src/features/billing', 'src/lib'])
    const p = r.problems.find((x) => x.file === 'src/features/billing')
    assert.match(p.msg, /chưa có trong docs\/arch\.json/)
    assert.match(p.fix, /modules/)
    assert.match(p.fix, /ARCHITECTURE\.md/)
  })
  test('thư mục chỉ có ảnh/css/.gitkeep (không có code) không bị coi là module lạ', () => {
    const dir = webProject()
    put(dir, 'src/assets/logo.svg', '<svg/>')
    put(dir, 'src/styles/app.css', 'a{}')
    put(dir, 'src/features/empty/.gitkeep', '')
    put(dir, 'src/node_modules/x/index.js', 'x')
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('module ma: có trong arch.json nhưng thư mục không còn', () => {
    const dir = webProject()
    fs.rmSync(path.join(dir, 'src', 'features', 'b'), { recursive: true })
    const r = A.syncCheck(dir)
    const p = r.problems.find((x) => /features\/b/.test(x.msg))
    assert.ok(p, JSON.stringify(r.problems))
    assert.match(p.msg, /không còn thư mục/)
    assert.match(p.fix, /xoá|bỏ/)
  })
  test('codemap thiếu một module hoặc nhắc module không có trong arch.json', () => {
    const dir = webProject()
    put(dir, 'docs/ARCHITECTURE.md', codemap(['src/features/a', 'src/shared', 'src/features/zzz']))
    const r = A.syncCheck(dir)
    assert.ok(r.problems.some((p) => p.file === 'docs/ARCHITECTURE.md' && /src\/features\/b/.test(p.msg) && /thiếu/.test(p.msg)), JSON.stringify(r.problems))
    assert.ok(r.problems.some((p) => p.file === 'docs/ARCHITECTURE.md' && /src\/features\/zzz/.test(p.msg)), JSON.stringify(r.problems))
  })
  test('không có ARCHITECTURE.md hoặc thiếu mục Codemap ⇒ báo', () => {
    const dir = webProject()
    fs.rmSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))
    assert.match(A.syncCheck(dir).problems[0].msg, /Chưa có docs\/ARCHITECTURE\.md/)
    put(dir, 'docs/ARCHITECTURE.md', '# Kiến trúc\n\nkhông có mục nào\n')
    assert.match(A.syncCheck(dir).problems[0].msg, /Codemap/)
  })
  test('feature A và B là hai module độc lập: thêm B vào arch.json mà quên A ⇒ chỉ A bị báo', () => {
    const dir = webProject()
    const p = webPart({ modules: webPart().modules.filter((m) => m.name !== 'features/a') })
    writeArch(dir, [p])
    put(dir, 'docs/ARCHITECTURE.md', codemap(['src/features/b', 'src/shared']))
    assert.deepEqual(A.syncCheck(dir).problems.map((x) => x.file), ['src/features/a'])
  })
  test('Go: mỗi thư mục cấp 1 của internal là một miền; miền lạ và miền ma đều bị báo', () => {
    const dir = goProject()
    assert.deepEqual(A.syncCheck(dir).problems, [])
    put(dir, 'internal/users/domain/u.go', 'package domain\n')
    fs.rmSync(path.join(dir, 'internal', 'orders'), { recursive: true })
    const r = A.syncCheck(dir)
    assert.ok(r.problems.some((p) => p.file === 'internal/users'), JSON.stringify(r.problems))
    assert.ok(r.problems.some((p) => /orders/.test(p.msg) && /không còn thư mục/.test(p.msg)), JSON.stringify(r.problems))
  })
  test('Wails: hai phần cùng một codemap; thiếu dòng của phần Go vẫn bị bắt', () => {
    const dir = tmp()
    put(dir, 'frontend/src/shared/u.ts', 'export {}\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n')
    writeArch(dir, [
      webPart({ root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', mayDependOn: [] }], shared: ['frontend/src/shared'], forbidden: [] }),
      goPart({ modules: [{ name: 'billing', path: 'internal/billing', mayDependOn: [] }] }),
    ])
    put(dir, 'docs/ARCHITECTURE.md', codemap(['frontend/src/shared']))
    const r = A.syncCheck(dir)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0].msg, /internal\/billing/)
    put(dir, 'docs/ARCHITECTURE.md', codemap(['frontend/src/shared', 'internal/billing']))
    assert.equal(A.syncCheck(dir).ok, true)
  })
  test('root chưa có (dự án chưa dựng code) ⇒ không đỏ, chỉ ghi chú', () => {
    const dir = tmp()
    writeArch(dir, [webPart({ modules: [{ name: 'shared', path: 'src/shared', mayDependOn: [] }], shared: ['src/shared'] })])
    put(dir, 'docs/ARCHITECTURE.md', codemap(['src/shared']))
    const r = A.syncCheck(dir)
    assert.equal(r.ok, true)
    assert.match(r.notes.join('\n'), /src/)
  })
  test('arch.json hỏng ⇒ sync đỏ với chính các lỗi đó', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', '{')
    const r = A.syncCheck(dir)
    assert.equal(r.ok, false)
    assert.equal(r.problems[0].file, 'docs/arch.json')
  })
})

describe('sizeCheck', () => {
  test('đúng trần 400 thì qua, 401 thì báo kèm lời dặn tách file', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Ok.ts', nLines(400))
    put(dir, 'src/features/a/ui/Big.ts', nLines(401))
    const r = A.sizeCheck(dir)
    assert.equal(r.ok, false)
    assert.deepEqual(r.problems.map((p) => p.file), ['src/features/a/ui/Big.ts'])
    assert.match(r.problems[0].msg, /401/)
    assert.match(r.problems[0].msg, /400/)
    assert.match(r.problems[0].fix, /tách/)
  })
  test('bỏ file test, file sinh (tên, thư mục, dòng đầu), vendor; Go dùng .go và trần riêng', () => {
    const dir = webProject()
    for (const f of ['src/features/a/ui/A.test.ts', 'src/features/a/ui/A.spec.tsx', 'src/shared/types.d.ts', 'src/shared/api.generated.ts', 'src/shared/wailsjs/go/App.ts', 'src/shared/node_modules/x/i.js', 'src/shared/__tests__/t.ts']) put(dir, f, nLines(900))
    put(dir, 'src/shared/auto.ts', `// Code generated by tool. DO NOT EDIT.\n${nLines(900)}`)
    assert.equal(A.sizeCheck(dir).ok, true)
    const g = goProject()
    writeArch(g, [goPart({ limits: { ...LIMITS, fileLines: 100 } })])
    put(g, 'internal/billing/domain/big.go', `package domain\n${nLines(120)}`)
    put(g, 'internal/billing/domain/big_test.go', `package domain\n${nLines(500)}`)
    put(g, 'internal/billing/domain/x.pb.go', `package domain\n${nLines(500)}`)
    const r = A.sizeCheck(g)
    assert.deepEqual(r.problems.map((p) => p.file), ['internal/billing/domain/big.go'])
  })
  test('changedOnly: chỉ xét file có trong danh sách (dấu \\ hay / đều nhận)', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Big1.ts', nLines(500))
    put(dir, 'src/features/b/ui/Big2.ts', nLines(500))
    assert.equal(A.sizeCheck(dir).problems.length, 2)
    assert.deepEqual(A.sizeCheck(dir, { changedOnly: ['src\\features\\b\\ui\\Big2.ts'] }).problems.map((p) => p.file), ['src/features/b/ui/Big2.ts'])
    assert.equal(A.sizeCheck(dir, { changedOnly: [] }).ok, true)
  })
  test('arch.json hỏng ⇒ sizeCheck đỏ với chính các lỗi đó', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', '{')
    const r = A.sizeCheck(dir)
    assert.equal(r.ok, false)
    assert.equal(r.problems[0].file, 'docs/arch.json')
  })
  test('trần theo từng phần (Wails: web và go có trần khác nhau)', () => {
    const dir = tmp()
    writeArch(dir, [webPart({ root: 'frontend/src', modules: [], shared: [], forbidden: [], limits: { ...LIMITS, fileLines: 50 } }), goPart({ modules: [], limits: { ...LIMITS, fileLines: 200 } })])
    put(dir, 'frontend/src/a.ts', nLines(60))
    put(dir, 'internal/x/y.go', `package x\n${nLines(60)}`)
    assert.deepEqual(A.sizeCheck(dir).problems.map((p) => p.file), ['frontend/src/a.ts'])
  })
  test('file đã quá trần lúc chốt chỉ đỏ khi dài THÊM; file mới quá trần đỏ ngay', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Old.ts', nLines(500))
    put(dir, 'docs/arch-baseline.json', JSON.stringify({ base: 'abc', size: { 'src/features/a/ui/Old.ts': 500 } }))
    assert.equal(A.sizeCheck(dir).ok, true)
    put(dir, 'src/features/a/ui/Old.ts', nLines(501))
    assert.match(A.sizeCheck(dir).problems[0].msg, /501.*500|500.*501/)
    put(dir, 'src/features/a/ui/Old.ts', nLines(450))
    assert.equal(A.sizeCheck(dir).ok, true)
    put(dir, 'src/features/b/ui/New.ts', nLines(401))
    assert.deepEqual(A.sizeCheck(dir).problems.map((p) => p.file), ['src/features/b/ui/New.ts'])
  })
})

describe('ruleFiles / isRuleFile', () => {
  test('liệt kê file luật thực có (kể cả trong thư mục web của Wails), không liệt kê file không có', () => {
    const dir = tmp()
    writeArch(dir, [webPart({ root: 'frontend/src', modules: [], shared: [], forbidden: [] })])
    put(dir, 'frontend/package.json', '{}')
    for (const f of ['docs/arch-baseline.json', '.dependency-cruiser.cjs', '.dependency-cruiser-known-violations.json', '.go-arch-lint.yml', '.golangci.yml', 'eslint.config.mjs', '.eslintrc.json', 'eslint-suppressions.json', 'biome.jsonc', 'sgconfig.yml', 'frontend/eslint.config.js', 'frontend/eslint-suppressions.json', 'README.md', 'src/app.ts']) put(dir, f, '{}')
    const got = A.ruleFiles(dir)
    assert.deepEqual(got, [...got].sort())
    for (const f of ['docs/arch.json', 'docs/arch-baseline.json', '.dependency-cruiser.cjs', '.dependency-cruiser-known-violations.json', '.go-arch-lint.yml', '.golangci.yml', 'eslint.config.mjs', '.eslintrc.json', 'eslint-suppressions.json', 'biome.jsonc', 'sgconfig.yml', 'frontend/eslint.config.js', 'frontend/eslint-suppressions.json']) assert.ok(got.includes(f), f)
    assert.ok(!got.includes('README.md') && !got.includes('src/app.ts'))
    assert.ok(!got.includes('.golangci.toml'))
  })
  test('isRuleFile nhận cả file chưa tồn tại (để cổng gộp soi diff)', () => {
    for (const f of ['docs/arch.json', 'docs/arch-baseline.json', '.dependency-cruiser.cjs', '.dependency-cruiser-known-violations.json', '.go-arch-lint.yml', '.golangci.yaml', 'eslint.config.ts', '.eslintrc.cjs', 'eslint-suppressions.json', 'biome.json', 'sgconfig.yml', 'frontend/eslint.config.js']) assert.ok(A.isRuleFile(f), f)
    for (const f of ['src/app.ts', 'docs/ARCHITECTURE.md', 'package.json', 'src/eslint.config.notes.txt.bak']) assert.ok(!A.isRuleFile(f), f)
  })
})

describe('init', () => {
  test('web mới: tạo arch.json hợp lệ + ARCHITECTURE.md ≤ 80 dòng, rồi sync không đỏ', () => {
    const dir = tmp()
    const r = A.init(dir, { stack: 'web' })
    assert.deepEqual(r.written.sort(), ['docs/ARCHITECTURE.md', 'docs/arch.json'])
    const l = A.loadArch(dir)
    assert.deepEqual(l.errors, [])
    assert.equal(l.arch.parts.length, 1)
    assert.equal(l.arch.parts[0].root, 'src')
    assert.ok(read(dir, 'docs/ARCHITECTURE.md').split('\n').length <= 80)
    assert.match(read(dir, 'docs/ARCHITECTURE.md'), /`src\/shared`/)
    assert.equal(A.syncCheck(dir).ok, true)
  })
  test('dự án có sẵn arch.json / ARCHITECTURE.md ⇒ không ghi đè, báo "đã có"', () => {
    const dir = webProject()
    const before = [read(dir, 'docs/arch.json'), read(dir, 'docs/ARCHITECTURE.md')]
    const r = A.init(dir, { stack: 'web' })
    assert.deepEqual(r.written, [])
    assert.deepEqual(r.kept.map((k) => k.file).sort(), ['docs/ARCHITECTURE.md', 'docs/arch.json'])
    assert.match(r.kept[0].why, /đã có/)
    assert.deepEqual([read(dir, 'docs/arch.json'), read(dir, 'docs/ARCHITECTURE.md')], before)
  })
  test('có sẵn thư mục: suy module từ thư mục cấp 1; feature A, B là hai module riêng, không gọi nhau', () => {
    const dir = tmp()
    for (const f of ['src/features/a/ui/A.ts', 'src/features/b/api/B.ts', 'src/shared/u.ts', 'src/lib/l.ts', 'src/components/C.tsx', 'src/app/main.ts']) put(dir, f, 'export {}\n')
    put(dir, 'src/assets/logo.svg', '<svg/>')
    put(dir, 'package.json', '{"name":"x"}')
    A.init(dir, { stack: 'web' })
    const part = A.loadArch(dir).arch.parts[0]
    assert.deepEqual(part.modules.map((m) => m.name).sort(), ['app', 'components', 'features/a', 'features/b', 'lib', 'shared'])
    const mod = (n) => part.modules.find((m) => m.name === n)
    assert.equal(mod('features/a').path, 'src/features/a')
    assert.ok(!mod('features/a').mayDependOn.includes('features/b'))
    assert.ok(!mod('features/b').mayDependOn.includes('features/a'))
    assert.ok(mod('features/a').mayDependOn.includes('shared') && mod('features/a').mayDependOn.includes('lib'))
    assert.ok(!mod('shared').mayDependOn.some((n) => n.startsWith('features/')))
    assert.ok(mod('app').mayDependOn.includes('features/a'))
    assert.deepEqual(part.shared, ['src/shared'])
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('Go có sẵn: mỗi internal/<miền> một module, mayDependOn rỗng; stack tự nhận khi không truyền', () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n')
    put(dir, 'internal/orders/store/s.go', 'package store\n')
    const r = A.init(dir, {})
    assert.ok(r.written.includes('docs/arch.json'))
    const part = A.loadArch(dir).arch.parts[0]
    assert.deepEqual([part.stack, part.root], ['go', 'internal'])
    assert.deepEqual(part.modules.map((m) => [m.name, m.mayDependOn]), [['billing', []], ['orders', []]])
    assert.ok(part.forbidden.length >= 3)
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('wails: tạo cả phần web (frontend/src) lẫn phần go', () => {
    const dir = tmp()
    A.init(dir, { stack: 'wails' })
    const { arch, errors } = A.loadArch(dir)
    assert.deepEqual(errors, [])
    assert.deepEqual(arch.parts.map((p) => [p.name, p.stack, p.root]), [['web', 'web', 'frontend/src'], ['go', 'go', 'internal']])
    const web = arch.parts[0]
    assert.ok(web.modules.every((m) => m.path.startsWith('frontend/src')))
    assert.ok(web.forbidden.every((f) => f.from.startsWith('frontend/src')))
    assert.deepEqual(web.shared, ['frontend/src/shared'])
    assert.equal(A.syncCheck(dir).ok, true)
  })
  test('wails có sẵn (wails.json + frontend/package.json) tự nhận khi không truyền stack', () => {
    const dir = tmp()
    put(dir, 'wails.json', '{}')
    put(dir, 'go.mod', 'module example.com/app\n\nrequire github.com/wailsapp/wails/v2 v2.9.0\n')
    put(dir, 'frontend/package.json', '{}')
    put(dir, 'frontend/src/features/a/ui/A.tsx', 'export {}\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n')
    A.init(dir, {})
    const { arch } = A.loadArch(dir)
    assert.deepEqual(arch.parts.map((p) => [p.stack, p.root]), [['web', 'frontend/src'], ['go', 'internal']])
    assert.deepEqual(arch.parts[0].modules.map((m) => m.name), ['features/a'])
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('extension: mẫu riêng, ranh giới content/background', () => {
    const dir = tmp()
    A.init(dir, { stack: 'extension' })
    const part = A.loadArch(dir).arch.parts[0]
    assert.equal(part.stack, 'extension')
    assert.ok(part.forbidden.some((f) => /content/.test(f.from) && /background/.test(f.to)))
  })
  test('có arch.json mà thiếu ARCHITECTURE.md ⇒ chỉ tạo ARCHITECTURE.md từ arch.json đó, codemap khớp', () => {
    const dir = webProject()
    fs.rmSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))
    const r = A.init(dir, {})
    assert.deepEqual(r.written, ['docs/ARCHITECTURE.md'])
    assert.deepEqual(r.kept.map((k) => k.file), ['docs/arch.json'])
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('ARCHITECTURE.md ở gốc dự án (không phải docs/) cũng được tính là đã có', () => {
    const dir = webProject()
    fs.rmSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))
    put(dir, 'ARCHITECTURE.md', codemap(['src/features/a', 'src/features/b', 'src/shared']))
    assert.deepEqual(A.init(dir, {}).written, [])
    assert.deepEqual(A.syncCheck(dir).problems, [])
  })
  test('stack lạ ⇒ ném lỗi; không nhận ra stack mà không truyền ⇒ ném lỗi chỉ cách truyền', () => {
    assert.throws(() => A.init(tmp(), { stack: 'cobol' }), /web.*go.*extension.*wails/s)
    assert.throws(() => A.init(tmp(), {}), /--stack/)
  })
})

describe('gen — dependency-cruiser', () => {
  const genWeb = (dir) => { const r = A.gen(dir); return { r, cfg: require(path.join(dir, '.dependency-cruiser.cjs')) } }
  const rule = (cfg, name) => cfg.forbidden.find((x) => x.name === name)
  test('có no-circular, not-to-unresolvable; mỗi luật có comment', () => {
    const { r, cfg } = genWeb(webProject())
    assert.ok(r.written.includes('.dependency-cruiser.cjs'))
    assert.equal(rule(cfg, 'no-circular').to.circular, true)
    assert.equal(rule(cfg, 'not-to-unresolvable').to.couldNotResolve, true)
    assert.ok(cfg.forbidden.every((x) => x.severity === 'error' && x.comment.length > 20))
  })
  test('not-to-unresolvable miễn module ảo của nền tảng (cloudflare:, astro:, node:, bun:, virtual:) và hậu tố ?raw/?url; đường dẫn thường vẫn bị xét', () => {
    const { cfg } = genWeb(webProject())
    const skip = [].concat(rule(cfg, 'not-to-unresolvable').to.pathNot).map((p) => new RegExp(p))
    const exempt = (s) => skip.some((re) => re.test(s))
    for (const s of ['cloudflare:workers', 'astro:middleware', 'node:fs', 'bun:sqlite', 'virtual:pwa-register', './a.css?raw', './w.js?worker']) assert.equal(exempt(s), true, s)
    for (const s of ['./thieu.js', '@scope/goi-thieu', 'src/cloudflare:x', 'nodemailer', 'astro']) assert.equal(exempt(s), false, s)
  })
  test('feature A import feature B bị luật ranh giới bắt; A import shared thì không; comment = lý do + cách sửa', () => {
    const { cfg } = genWeb(webProject())
    const hit = (from, to) => cfg.forbidden.filter((x) => x.from.path && x.to.path && new RegExp(x.from.path).test(from) && new RegExp(x.to.path).test(to) && !(x.to.pathNot && new RegExp(x.to.pathNot).test(to)))
    const ab = hit('src/features/a/ui/A.ts', 'src/features/b/ui/B.ts')
    assert.equal(ab.length, 1)
    assert.match(ab[0].comment, /features\/a/)
    assert.match(ab[0].comment, /features\/b/)
    assert.match(ab[0].comment, /Cách sửa/)
    assert.equal(hit('src/features/a/ui/A.ts', 'src/shared/util.ts').length, 0)
    assert.equal(hit('src/features/a/ui/A.ts', 'src/features/a/ui/Other.ts').length, 0)
    assert.equal(hit('src/shared/util.ts', 'src/features/a/ui/A.ts').length, 1)
    assert.equal(hit('src/main.ts', 'src/features/a/ui/A.ts').length, 0)
  })
  test('forbidden trong arch.json thành luật depcruise: comment gồm reason + fix, glob thành regex', () => {
    const { cfg } = genWeb(webProject())
    const r = cfg.forbidden.find((x) => /model không biết giao diện/.test(x.comment))
    assert.ok(r)
    assert.match(r.comment, /Đưa phần dùng chung sang shared/)
    assert.ok(new RegExp(r.from.path).test('src/features/a/model/m.ts'))
    assert.ok(!new RegExp(r.from.path).test('src/features/a/ui/m.ts'))
    assert.ok(new RegExp(r.to.path).test('src/features/b/ui/B.ts'))
  })
  test('luật cấm gói ngoài (node_modules/…) không neo đầu để khớp đường dẫn pnpm', () => {
    const dir = webProject({ forbidden: [{ from: 'src/features/*/ui/**', to: 'node_modules/@supabase/**', reason: 'ui không gọi Supabase', fix: 'Gọi qua api của tính năng' }] })
    const { cfg } = genWeb(dir)
    const r = cfg.forbidden.find((x) => /ui không gọi Supabase/.test(x.comment))
    assert.ok(new RegExp(r.to.path).test('node_modules/.pnpm/@supabase+x@1/node_modules/@supabase/x/index.js'))
  })
  test('nhiều phần web (web + extension / Wails): mỗi phần một bộ luật theo root của nó', () => {
    const dir = tmp()
    writeArch(dir, [
      webPart({ root: 'frontend/src', modules: [{ name: 'features/a', path: 'frontend/src/features/a', mayDependOn: [] }, { name: 'features/b', path: 'frontend/src/features/b', mayDependOn: [] }], shared: [], forbidden: [] }),
      { name: 'ext', stack: 'extension', root: 'ext/src', modules: [{ name: 'content', path: 'ext/src/content', mayDependOn: [] }, { name: 'background', path: 'ext/src/background', mayDependOn: [] }], shared: [], forbidden: [], limits: { ...LIMITS } },
    ])
    const { cfg } = genWeb(dir)
    const reFrom = (n) => cfg.forbidden.filter((x) => x.from.path).map((x) => new RegExp(x.from.path)).some((re) => re.test(n))
    assert.ok(reFrom('frontend/src/features/a/x.ts') && reFrom('ext/src/content/x.ts'))
    assert.ok(!reFrom('src/features/a/x.ts'))
    const args = A.depcruiseArgs(dir).args
    assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'frontend/src', 'ext/src'], 'option trước, `--`, rồi các root')
  })
  test('tsConfig.fileName tính từ vị trí file cấu hình lúc chạy (không phụ thuộc cwd, file commit lên git không dính đường dẫn máy): tsconfig.json trong thư mục của phần (Wails: frontend/) và ở gốc dự án đều ra đường dẫn tuyệt đối đúng', () => {
    const wails = tmp()
    put(wails, 'frontend/package.json', '{}')
    put(wails, 'frontend/tsconfig.json', '{"include":["src"]}')
    put(wails, 'frontend/src/shared/u.ts', 'export const u = 1\n')
    writeArch(wails, [webPart({ root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', mayDependOn: [] }], shared: ['frontend/src/shared'], forbidden: [] })])
    const { cfg } = genWeb(wails)
    assert.ok(path.isAbsolute(cfg.options.tsConfig.fileName), cfg.options.tsConfig.fileName)
    assert.equal(path.resolve(cfg.options.tsConfig.fileName), path.join(wails, 'frontend', 'tsconfig.json'))
    const text = read(wails, '.dependency-cruiser.cjs')
    assert.ok(text.includes('__dirname'), 'đường dẫn dựng từ __dirname')
    assert.ok(!text.includes(wails) && !text.includes(wails.replace(/\\/g, '/')), 'không ghi đường dẫn của máy vào file')
    const flat = webProject()
    put(flat, 'tsconfig.json', '{}')
    assert.equal(path.resolve(genWeb(flat).cfg.options.tsConfig.fileName), path.join(flat, 'tsconfig.json'))
    assert.equal(genWeb(webProject()).cfg.options.tsConfig, undefined, 'không có tsconfig ⇒ không đặt')
  })
  test('gen lặp lại cho cùng kết quả; file có sẵn không phải do kit sinh thì giữ nguyên', () => {
    const dir = webProject()
    A.gen(dir)
    const first = read(dir, '.dependency-cruiser.cjs')
    const r2 = A.gen(dir)
    assert.equal(read(dir, '.dependency-cruiser.cjs'), first)
    assert.ok(r2.written.includes('.dependency-cruiser.cjs'))
    put(dir, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
    const r3 = A.gen(dir)
    assert.equal(read(dir, '.dependency-cruiser.cjs'), 'module.exports = { forbidden: [] }\n')
    assert.ok(r3.kept.some((k) => k.file === '.dependency-cruiser.cjs' && /không phải do kit sinh/.test(k.why)))
  })
  test('arch.json hỏng ⇒ gen ném lỗi nêu rõ, không ghi gì', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', '{')
    assert.throws(() => A.gen(dir), /docs\/arch\.json/)
    assert.equal(has(dir, '.dependency-cruiser.cjs'), false)
  })
  test('mọi regex sinh ra qua được kiểm "an toàn" của dependency-cruiser: không có nhóm lặp chứa phép lặp (`(?:.*/)?`, `(?:/.*)?$` bị depcruise từ chối và DỪNG HẲN); khớp đúng như trước', () => {
    const quantifiedGroupWithQuantifier = /\((?:\?:)?[^()]*[*+][^()]*\)[*+?{]/
    const globs = ['src/shared', 'src/features/*/ui/**', 'src/**/x.ts', 'src/**/a/**/b', 'src/features/*/{ui,model}/**', 'src/a?/**', 'node_modules/@supabase/**', 'database/sql', '**/gen/**']
    for (const g of globs) for (const opt of [{}, { anywhere: true }]) {
      const re = A.globToRegex(g, opt)
      assert.doesNotMatch(re, quantifiedGroupWithQuantifier, `${g} → ${re}`)
    }
    const m = (glob, p) => new RegExp(A.globToRegex(glob)).test(p)
    assert.ok(m('src/**/x.ts', 'src/x.ts') && m('src/**/x.ts', 'src/a/b/x.ts') && !m('src/**/x.ts', 'src/a/b/xx.ts') && !m('src/**/x.ts', 'other/src/x.ts'))
    assert.ok(m('src/shared', 'src/shared') && m('src/shared', 'src/shared/a/b.ts') && !m('src/shared', 'src/shared2/a.ts') && !m('src/shared', 'src/sharedX'))
  })
  test('depcruise thật: vòng + feature→feature ⇒ đỏ kèm lời dặn; dự án sạch ⇒ xanh', { skip: DC.skip ?? false }, () => {
    const dir = tmp()
    put(dir, 'src/features/a/ui/A.js', "import '../../b/ui/B.js'\nexport const a = 1\n")
    put(dir, 'src/features/b/ui/B.js', "import '../../a/ui/A.js'\nexport const b = 1\n")
    put(dir, 'src/shared/u.js', 'export const u = 1\n')
    writeArch(dir, [webPart({ forbidden: [] })])
    A.gen(dir)
    const { args } = A.depcruiseArgs(dir)
    const bad = dcRun(dir, args)
    assert.notEqual(bad.status, 0, bad.stdout)
    assert.match(bad.stdout, /Cách sửa/)
    assert.match(bad.stdout, /no-circular/)
    put(dir, 'src/features/a/ui/A.js', "import '../../../shared/u.js'\nexport const a = 1\n")
    put(dir, 'src/features/b/ui/B.js', "import '../../../shared/u.js'\nexport const b = 1\n")
    const ok = dcRun(dir, args)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  })
})

// depcruise THẬT với mẫu mặc định của kit (có luật forbidden) cho cả ba kiểu dự án. Luật sinh ra mà depcruise từ chối ("unsafe regular expression") thì cả bộ luật không chạy.
describe('depcruise THẬT — mẫu web / tiện ích trình duyệt / Wails frontend', () => {
  const clean = (r) => { assert.doesNotMatch(`${r.stdout}${r.stderr}`, /unsafe regular expression|Bailing out/i, r.stdout + r.stderr) }
  const init = (dir, stack) => { const r = A.init(dir, { stack }); A.gen(dir); return r }
  test('web: mẫu mặc định chạy được; dự án sạch ⇒ xanh; model import ui / feature import feature / shared import feature ⇒ đỏ kèm lời dặn', { skip: DC.skip ?? false }, () => {
    const dir = tmp()
    put(dir, 'package.json', '{}')
    for (const f of ['a', 'b']) { put(dir, `src/features/${f}/ui/U.js`, 'export const u = 1\n'); put(dir, `src/features/${f}/model/m.js`, 'export const m = 1\n') }
    put(dir, 'src/shared/s.js', 'export const s = 1\n')
    init(dir, 'web')
    const { args } = A.depcruiseArgs(dir)
    const ok = dcRun(dir, args)
    clean(ok)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    put(dir, 'src/features/a/model/m.js', "import '../ui/U.js'\nexport const m = 1\n")
    const m2ui = dcRun(dir, args)
    assert.notEqual(m2ui.status, 0, m2ui.stdout)
    assert.match(m2ui.stdout, /arch-web-cam-1/)
    assert.match(m2ui.stdout, /Cách sửa/)
    put(dir, 'src/features/a/model/m.js', "import '../../b/ui/U.js'\nexport const m = 1\n")
    const f2f = dcRun(dir, args)
    assert.notEqual(f2f.status, 0, f2f.stdout)
    assert.match(f2f.stdout, /arch-web-features-a/)
    put(dir, 'src/features/a/model/m.js', 'export const m = 1\n')
    put(dir, 'src/shared/s.js', "import '../features/a/ui/U.js'\nexport const s = 1\n")
    const s2f = dcRun(dir, args)
    assert.notEqual(s2f.status, 0, s2f.stdout)
    assert.match(s2f.stdout, /arch-web-cam-3|arch-web-shared/)
  })
  test('luật tự thêm có `**/` giữa đường dẫn (src/**/ui/** → src/**/legacy/**) cũng chạy được và bắt đúng', { skip: DC.skip ?? false }, () => {
    const dir = tmp()
    put(dir, 'package.json', '{}')
    put(dir, 'src/features/a/ui/deep/U.js', "import '../../legacy/old/L.js'\nexport const u = 1\n")
    put(dir, 'src/features/a/legacy/old/L.js', 'export const l = 1\n')
    put(dir, 'src/shared/s.js', 'export const s = 1\n')
    writeArch(dir, [webPart({ modules: [{ name: 'features/a', path: 'src/features/a', mayDependOn: ['shared'] }, { name: 'shared', path: 'src/shared', mayDependOn: [] }], forbidden: [{ from: 'src/**/ui/**', to: 'src/**/legacy/**', reason: 'giao diện không dùng code cũ', fix: 'Dùng bản mới trong shared' }] })])
    A.gen(dir)
    const r = dcRun(dir, A.depcruiseArgs(dir).args)
    clean(r)
    assert.notEqual(r.status, 0, r.stdout)
    assert.match(r.stdout, /giao diện không dùng code cũ/)
  })
  test('tiện ích trình duyệt: mayDependOn suy ra đúng (môi trường chỉ → shared, shared → không ai); popup import background / content import background ⇒ đỏ; sạch ⇒ xanh', { skip: DC.skip ?? false }, () => {
    const dir = tmp()
    put(dir, 'package.json', '{}')
    put(dir, 'manifest.json', '{"manifest_version":3,"name":"x","version":"1"}')
    for (const e of ['background', 'content', 'popup']) put(dir, `src/${e}/index.js`, 'export const e = 1\n')
    put(dir, 'src/shared/msg.js', 'export const m = 1\n')
    init(dir, 'extension')
    const mods = Object.fromEntries(JSON.parse(read(dir, 'docs/arch.json')).parts[0].modules.map((m) => [m.name, m.mayDependOn]))
    assert.deepEqual(mods, { background: ['shared'], content: ['shared'], popup: ['shared'], shared: [] })
    const { args } = A.depcruiseArgs(dir)
    const ok = dcRun(dir, args)
    clean(ok)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    put(dir, 'src/popup/index.js', "import '../background/index.js'\nexport const e = 1\n")
    const bad = dcRun(dir, args)
    assert.notEqual(bad.status, 0, bad.stdout)
    assert.match(bad.stdout, /arch-extension-popup|arch-extension-cam/)
    put(dir, 'src/popup/index.js', "import '../shared/msg.js'\nexport const e = 1\n")
    put(dir, 'src/content/index.js', "import '../background/index.js'\nexport const e = 1\n")
    const bad2 = dcRun(dir, args)
    assert.notEqual(bad2.status, 0, bad2.stdout)
    assert.match(bad2.stdout, /arch-extension-content|arch-extension-cam/)
  })
  test('Wails (frontend + Go): phần web ở frontend/src chạy được với mẫu mặc định; feature→feature ⇒ đỏ', { skip: DC.skip ?? false }, () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'wails.json', '{}')
    put(dir, 'frontend/package.json', '{}')
    for (const f of ['a', 'b']) put(dir, `frontend/src/features/${f}/ui/U.js`, 'export const u = 1\n')
    put(dir, 'frontend/src/shared/s.js', 'export const s = 1\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n')
    init(dir, 'wails')
    const { args } = A.depcruiseArgs(dir)
    assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'frontend/src'])
    const ok = dcRun(dir, args)
    clean(ok)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    put(dir, 'frontend/src/features/a/ui/U.js', "import '../../b/ui/U.js'\nexport const u = 1\n")
    const bad = dcRun(dir, args)
    assert.notEqual(bad.status, 0, bad.stdout)
    assert.match(bad.stdout, /arch-web-features-a/)
  })
})

// parser YAML tối giản đủ cho file .go-arch-lint.yml của kit: map lồng bằng thụt 2 dấu cách, danh sách "- x", chuỗi/inline
function miniYaml(text) {
  const root = {}
  const stack = [{ indent: -1, node: root }]
  const scalar = (s) => { s = s.trim(); if (/^".*"$/.test(s)) return JSON.parse(s); if (/^(true|false)$/.test(s)) return s === 'true'; if (/^\d+$/.test(s)) return Number(s); return s }
  const rows = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => ({ indent: l.length - l.trimStart().length, body: l.trim() }))
  rows.forEach((row, i) => {
    while (stack.at(-1).indent >= row.indent) stack.pop()
    const top = stack.at(-1).node
    if (row.body.startsWith('- ')) { top.push(scalar(row.body.slice(2))); return }
    const m = /^("[^"]+"|[^:]+):\s*(.*)$/.exec(row.body)
    assert.ok(m, `dòng YAML lạ: ${row.body}`)
    const key = scalar(m[1])
    if (m[2] !== '') { top[key] = scalar(m[2]); return }
    const next = rows[i + 1]
    const child = next && next.indent > row.indent && next.body.startsWith('- ') ? [] : {}
    top[key] = child
    stack.push({ indent: row.indent, node: child })
  })
  return root
}

describe('gen — go-arch-lint, golangci, eslint', () => {
  test('.go-arch-lint.yml đúng schema v3: version, workdir, components.in, deps.mayDependOn ⊆ components', () => {
    const dir = goProject()
    const r = A.gen(dir)
    assert.ok(r.written.includes('.go-arch-lint.yml'))
    const y = miniYaml(read(dir, '.go-arch-lint.yml'))
    assert.equal(y.version, 3)
    assert.equal(y.workdir, 'internal')
    assert.deepEqual(Object.keys(y.components).sort(), ['billing', 'orders'])
    assert.deepEqual(y.components.billing.in, ['billing', 'billing/domain', 'billing/**'])
    assert.deepEqual(y.components.orders.in, ['orders', 'orders/service', 'orders/**'])
    assert.deepEqual(y.deps.orders.mayDependOn, ['orders', 'billing'], 'tự liệt kê chính mình rồi tới các miền được phép')
    assert.deepEqual(y.deps.billing.mayDependOn, ['billing'])
    const known = new Set(['version', 'workdir', 'allow', 'excludeFiles', 'components', 'vendors', 'commonComponents', 'commonVendors', 'deps'])
    assert.ok(Object.keys(y).every((k) => known.has(k)), Object.keys(y).join())
    for (const d of Object.values(y.deps ?? {})) for (const n of d.mayDependOn ?? []) assert.ok(n in y.components, n)
    assert.equal(y.allow.depOnAnyVendor, true)
  })
  test('mọi miền không phụ thuộc ai ⇒ VẪN có khối deps, mỗi miền một mục tự trỏ vào chính nó (go-arch-lint thật báo "deps is required" nếu thiếu và từ chối mục rỗng; import giữa các gói cùng miền cũng cần tên miền trong mayDependOn)', () => {
    const dir = goProject()
    writeArch(dir, [goPart({ modules: goPart().modules.map((m) => ({ ...m, mayDependOn: [] })) })])
    A.gen(dir)
    const y = miniYaml(read(dir, '.go-arch-lint.yml'))
    assert.deepEqual(Object.keys(y.deps).sort(), ['billing', 'orders'])
    assert.deepEqual(y.deps.billing.mayDependOn, ['billing'])
    assert.deepEqual(y.deps.orders.mayDependOn, ['orders'])
  })
  test('thư mục con có code của miền được liệt kê rõ trong `in` (go-arch-lint trên Windows suy sai đường dẫn import của thư mục con do `**` tạo ra)', () => {
    const dir = goProject()
    put(dir, 'internal/billing/domain/money/m.go', 'package money\n')
    put(dir, 'internal/billing/docs/readme.txt', 'không phải code')
    put(dir, 'internal/billing/testdata/x.go', 'package x\n')
    put(dir, 'internal/billing/domain/only_test.go', 'package domain\n')
    A.gen(dir)
    const y = miniYaml(read(dir, '.go-arch-lint.yml'))
    assert.deepEqual(y.components.billing.in, ['billing', 'billing/domain', 'billing/domain/money', 'billing/**'])
  })
  test('khối ESLint in ra có `ignores` cho .dependency-cruiser.cjs (file kit sinh dùng module.exports); root lạ không phá được chuỗi trong khối; workdir của go-arch-lint được nháy khi cần', () => {
    const dir = webProject()
    const block = A.gen(dir).blocks.find((b) => /ESLint/.test(b.title)).text
    assert.match(block, /\{ ignores: \['\.dependency-cruiser\.cjs'\] \},/)
    const odd = tmp()
    const root = "it's #b"
    put(odd, `${root}/x/a.ts`, 'export const a = 1\n')
    writeArch(odd, [webPart({ root, modules: [{ name: 'x', path: `${root}/x`, mayDependOn: [] }], shared: [], forbidden: [] })])
    const oddBlock = A.gen(odd).blocks.find((b) => /ESLint/.test(b.title)).text
    assert.ok(oddBlock.includes("files: ['it\\'s #b/**/*.{ts,tsx,js,jsx,mjs,cjs}'],"), oddBlock)
    const go = tmp()
    put(go, 'go.mod', 'module example.com/app\n')
    put(go, 'my pkg/billing/b.go', 'package billing\n')
    writeArch(go, [goPart({ root: 'my pkg', modules: [{ name: 'billing', path: 'my pkg/billing', mayDependOn: [] }], forbidden: [] })])
    A.gen(go)
    assert.match(read(go, '.go-arch-lint.yml'), /^workdir: "my pkg"$/m)
  })
  test('ESLint THẬT: cấu hình dự án bắt no-undef (sourceType module) ⇒ .dependency-cruiser.cjs làm đỏ (không có ignores); ghép khối do gen in ra ⇒ xanh', { skip: have('eslint') ? false : 'máy không có eslint — bỏ qua test thật' }, () => {
    const dir = webProject()
    const block = A.gen(dir).blocks.find((b) => /ESLint/.test(b.title)).text
    const base = "{ files: ['**/*.{js,cjs}'], languageOptions: { sourceType: 'module' }, rules: { 'no-undef': 'error' } },"
    put(dir, 'eslint.config.mjs', `export default [\n  ${base}\n]\n`)
    const before = A.defaultRun('eslint', ['--', '.'], { cwd: dir, timeoutMs: 120000 })
    assert.notEqual(before.status, 0, 'không có ignores thì phải đỏ — nếu xanh thì test này không chứng minh gì')
    assert.match(before.stdout, /'module' is not defined/)
    put(dir, 'eslint.config.mjs', `export default [\n  ${base}\n${block}]\n`)
    const after = A.defaultRun('eslint', ['--', '.'], { cwd: dir, timeoutMs: 120000 })
    assert.equal(after.status, 0, after.stdout + after.stderr)
  })
  const galReal = { skip: have('go-arch-lint') && have('go') ? false : 'máy không có go-arch-lint (go install github.com/fe3dback/go-arch-lint@latest) — bỏ qua test thật' }
  const galRun = (dir) => {
    const r = A.defaultRun('go-arch-lint', A.goArchLintRuns(dir)[0].args, { cwd: dir })
    const j = JSON.parse(r.stdout)
    return { status: r.status, exec: j.Payload.ExecutionWarnings.map((w) => w.Text), deps: j.Payload.ArchWarningsDeps, notMatched: j.Payload.ArchWarningsNotMatched }
  }
  const nested = (mayBilling) => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n\nimport "example.com/app/internal/orders/service"\n\nvar _ = service.X\n')
    put(dir, 'internal/billing/store/s.go', 'package store\n\nimport "example.com/app/internal/billing/domain"\n\nvar _ = domain.Z\n')
    put(dir, 'internal/billing/domain/z.go', 'package domain\n\nvar Z = 1\n')
    put(dir, 'internal/orders/service/s.go', 'package service\n\nvar X = 1\n')
    writeArch(dir, [goPart({ forbidden: [], modules: [{ name: 'billing', path: 'internal/billing', mayDependOn: mayBilling }, { name: 'orders', path: 'internal/orders', mayDependOn: [] }] })])
    A.gen(dir)
    return dir
  }
  test('go-arch-lint THẬT: cấu hình do kit sinh được công cụ chấp nhận (không lỗi cấu hình) khi mọi miền không phụ thuộc ai', galReal, () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n\nvar D = 1\n')
    put(dir, 'internal/orders/service/s.go', 'package service\n\nvar X = 1\n')
    writeArch(dir, [goPart({ forbidden: [], modules: goPart().modules.map((m) => ({ ...m, mayDependOn: [] })) })])
    A.gen(dir)
    const r = galRun(dir)
    assert.deepEqual(r.exec, [])
    assert.equal(r.status, 0)
  })
  test('go-arch-lint THẬT: import sang thư mục con của miền khác được mayDependOn cho phép ⇒ xanh (kể cả Windows); không cho phép ⇒ báo đúng một vi phạm; import trong cùng miền ⇒ xanh', galReal, () => {
    const ok = galRun(nested(['orders']))
    assert.deepEqual(ok.exec, [])
    assert.deepEqual(ok.deps.map((d) => d.ResolvedImportName), [], JSON.stringify(ok.deps))
    assert.equal(ok.status, 0)
    const bad = galRun(nested([]))
    assert.deepEqual(bad.exec, [])
    assert.deepEqual(bad.deps.map((d) => [d.ComponentName, d.ResolvedImportName]), [['billing', 'example.com/app/internal/orders/service']])
    assert.equal(bad.status, 1)
  })
  test('shared của phần Go ⇒ commonComponents; không có miền nào ⇒ không sinh file go-arch-lint', () => {
    const dir = goProject()
    writeArch(dir, [goPart({ shared: ['internal/billing'] })])
    A.gen(dir)
    assert.deepEqual(miniYaml(read(dir, '.go-arch-lint.yml')).commonComponents, ['billing'])
    const e = tmp()
    writeArch(e, [goPart({ modules: [] })])
    const r = A.gen(e)
    assert.equal(has(e, '.go-arch-lint.yml'), false)
    assert.ok(r.notes.some((n) => /go-arch-lint/.test(n)))
  })
  test('.golangci.yml chưa có ⇒ sinh mới (depguard desc = reason + fix, funlen, gocyclo theo limits); loại test khỏi funlen/gocyclo', () => {
    const dir = goProject()
    writeArch(dir, [goPart({ limits: { fileLines: 400, fnLines: 45, complexity: 12 } })])
    const r = A.gen(dir)
    assert.ok(r.written.includes('.golangci.yml'))
    const t = read(dir, '.golangci.yml')
    assert.match(t, /^version: "2"/m)
    assert.match(t, /lines: 45/)
    assert.match(t, /min-complexity: 12/)
    assert.match(t, /pkg: "database\/sql"/)
    assert.match(t, /desc: "domain không biết DB\. Cách sửa: Gọi qua interface, cài đặt trong store"/)
    assert.match(t, /_test\\\.go/)
  })
  test('depguard: `*` mở rộng theo từng miền, {a,b} tách ra, đường dẫn nội bộ nối tên module trong go.mod', () => {
    const dir = goProject()
    A.gen(dir)
    const t = read(dir, '.golangci.yml')
    for (const m of ['billing', 'orders']) for (const l of ['service', 'store', 'transport']) assert.match(t, new RegExp(`pkg: "example\\.com/app/internal/${m}/${l}"`), `${m}/${l}`)
    assert.match(t, /"\*\*\/internal\/\*\/domain\/\*\*"/)
  })
  test('chưa có go.mod ⇒ vẫn sinh luật cấm gói ngoài, luật đường dẫn nội bộ chờ go mod init (có ghi chú)', () => {
    const dir = goProject()
    fs.rmSync(path.join(dir, 'go.mod'))
    const r = A.gen(dir)
    const t = read(dir, '.golangci.yml')
    assert.match(t, /pkg: "database\/sql"/)
    assert.ok(!/internal\/billing\/store/.test(t))
    assert.ok(r.notes.some((n) => /go\.mod/.test(n)), r.notes.join('|'))
  })
  test('chưa có miền nào ⇒ luật cấm theo miền chưa áp dụng (ghi chú), luật gói ngoài vẫn có', () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    writeArch(dir, [goPart({ modules: [] })])
    const r = A.gen(dir)
    assert.match(read(dir, '.golangci.yml'), /pkg: "database\/sql"/)
    assert.ok(r.notes.some((n) => /chưa có module khớp/.test(n)), r.notes.join('|'))
  })
  test('.golangci.yml có sẵn (yml/yaml/toml/json) ⇒ KHÔNG ghi đè, in khối để ghép', () => {
    for (const name of ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']) {
      const dir = goProject()
      put(dir, name, '# của người dùng\n')
      const r = A.gen(dir)
      assert.equal(read(dir, name), '# của người dùng\n', name)
      assert.ok(!r.written.some((w) => w.startsWith('.golangci')))
      assert.ok(r.kept.some((k) => k.file === name && /không ghi đè/.test(k.why)))
      const block = r.blocks.find((b) => /golangci/.test(b.title))
      assert.match(block.text, /depguard/)
      assert.match(block.text, /funlen/)
    }
  })
  test('.golangci.yml do kit sinh (có dấu) được cập nhật khi gen lại', () => {
    const dir = goProject()
    A.gen(dir)
    writeArch(dir, [goPart({ limits: { fileLines: 400, fnLines: 30, complexity: 15 } })])
    A.gen(dir)
    assert.match(read(dir, '.golangci.yml'), /lines: 30/)
  })
  test('ESLint: in khối max-lines-per-function/complexity theo limits, không ghi đè eslint.config.*', () => {
    const dir = webProject({ limits: { fileLines: 400, fnLines: 55, complexity: 9 } })
    put(dir, 'eslint.config.js', '// của người dùng\n')
    const r = A.gen(dir)
    assert.equal(read(dir, 'eslint.config.js'), '// của người dùng\n')
    const b = r.blocks.find((x) => /ESLint/.test(x.title))
    assert.match(b.text, /max-lines-per-function/)
    assert.match(b.text, /max: 55/)
    assert.match(b.text, /complexity: \['error', 9\]/)
    assert.match(b.text, /src\/\*\*\/\*\.\{ts,tsx,js,jsx,mjs,cjs\}/)
    assert.equal(has(dir, 'eslint.config.mjs'), false)
  })
  test('golangci-lint thật: depguard bắt domain import store/database/sql, desc hiện lời dặn', { skip: have('golangci-lint') && have('go') ? false : 'máy không có golangci-lint hoặc go — bỏ qua test thật' }, () => {
    const dir = goProject()
    put(dir, 'internal/billing/store/s.go', 'package store\n\nvar X = 1\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n\nimport (\n\t"database/sql"\n\n\t"example.com/app/internal/billing/store"\n)\n\nvar _ = sql.ErrNoRows\nvar _ = store.X\n')
    A.gen(dir)
    const r = glc(dir, [])
    const out = (r.stdout + r.stderr).replace(/\\/g, '/')
    assert.notEqual(r.status, 0, out)
    assert.match(out, /database\/sql/)
    assert.match(out, /Cách sửa: Gọi qua interface/)
    const clean = goProject()
    put(clean, 'internal/billing/domain/d.go', 'package domain\n\nvar Y = 1\n')
    A.gen(clean)
    const ok = glc(clean, [])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  })
})

describe('baseline', () => {
  const rev = (hash) => ({ git: (args) => (args[0] === 'rev-parse' ? { stdout: `${hash}\n` } : { status: 1 }) })
  test('ghi docs/arch-baseline.json: base, size (chỉ file đã quá trần), depcruise, go, eslint — đủ mọi loại', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Big.ts', nLines(520))
    put(dir, 'src/features/a/ui/Ok.ts', nLines(100))
    put(dir, 'eslint.config.mjs', 'export default []\n')
    A.gen(dir)
    const run = fakeRun({
      ...rev('abc1234'),
      depcruise: () => ({ status: 0, stdout: '[{"type":"dependency","from":"src/a.ts","to":"src/b.ts","rule":{"name":"x","severity":"error"}}]' }),
      eslint: (_a, o) => { fs.writeFileSync(path.join(o.cwd, 'eslint-suppressions.json'), '{}'); return { status: 0 } },
    })
    const r = A.baseline(dir, { run })
    const data = JSON.parse(read(dir, 'docs/arch-baseline.json'))
    assert.equal(data.base, 'abc1234')
    assert.deepEqual(data.size, { 'src/features/a/ui/Big.ts': 520 })
    assert.equal(data.depcruise, '.dependency-cruiser-known-violations.json')
    assert.equal(JSON.parse(read(dir, '.dependency-cruiser-known-violations.json')).length, 1)
    assert.equal(data.eslint, true)
    assert.equal(data.go, null)
    assert.deepEqual(r.missing, [])
    assert.deepEqual(r.data, data)
    const dc = run.calls.find((c) => c.cmd === 'depcruise')
    assert.deepEqual(dc.args, ['--config', '.dependency-cruiser.cjs', '--output-type', 'baseline', '--', 'src'])
    const es = run.calls.find((c) => c.cmd === 'eslint')
    assert.ok(es.args.includes('--suppress-rule'))
    assert.ok(es.args.includes('max-lines-per-function') && es.args.includes('complexity'))
    assert.deepEqual(es.args.slice(-2), ['--', '.'], 'đích quét đứng sau `--`')
  })
  test('công cụ THIẾU ⇒ không ném lỗi, vẫn ghi mốc phần còn lại, nêu lệnh cài', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Big.ts', nLines(520))
    put(dir, 'eslint.config.mjs', 'export default []\n')
    A.gen(dir)
    const r = A.baseline(dir, { run: fakeRun(rev('abc1234')) })
    assert.deepEqual(r.missing.map((m) => m.tool).sort(), ['depcruise', 'eslint'])
    assert.match(r.missing.find((m) => m.tool === 'depcruise').install, /npm i -D dependency-cruiser/)
    const data = JSON.parse(read(dir, 'docs/arch-baseline.json'))
    assert.equal(data.depcruise, null)
    assert.equal(data.eslint, false)
    assert.deepEqual(data.size, { 'src/features/a/ui/Big.ts': 520 })
  })
  test('dự án không dùng ESLint ⇒ không chạy eslint, eslint=false, không tính là thiếu', () => {
    const dir = webProject()
    A.gen(dir)
    const run = fakeRun({ ...rev('abc'), depcruise: () => ({ stdout: '[]' }) })
    const r = A.baseline(dir, { run })
    assert.equal(run.calls.some((c) => c.cmd === 'eslint'), false)
    assert.equal(r.data.eslint, false)
    assert.deepEqual(r.missing, [])
  })
  test('chưa gen (thiếu .dependency-cruiser.cjs) ⇒ ghi chú chạy gen trước, depcruise null', () => {
    const dir = webProject()
    const r = A.baseline(dir, { run: fakeRun({ ...rev('abc'), depcruise: () => ({ stdout: '[]' }) }) })
    assert.equal(r.data.depcruise, null)
    assert.ok(r.notes.some((n) => /gen/.test(n)))
  })
  test('depcruise in ra thứ không phải JSON ⇒ không ghi file known-violations, báo lỗi', () => {
    const dir = webProject()
    A.gen(dir)
    const r = A.baseline(dir, { run: fakeRun({ ...rev('abc'), depcruise: () => ({ status: 1, stdout: 'ERROR: boom', stderr: 'boom' }) }) })
    assert.equal(r.data.depcruise, null)
    assert.equal(has(dir, '.dependency-cruiser-known-violations.json'), false)
    assert.ok(r.notes.some((n) => /depcruise/.test(n)))
  })
  test('Go: newFromRev = commit chốt; danh sách vi phạm go-arch-lint lúc chốt; lọc vi phạm MỚI', () => {
    const dir = goProject()
    A.gen(dir)
    const viol = (file, imp) => ({ ComponentName: 'orders', FileRelativePath: file, ResolvedImportName: imp, Reference: { Valid: true, File: `/x/${file}`, Line: 3, Offset: 2 } })
    const out = (items) => JSON.stringify({ Type: 'models.Check', Payload: { ArchHasWarnings: true, ArchWarningsDeps: items, ArchWarningsNotMatched: [] } })
    const run = fakeRun({ ...rev('feed123'), 'go-arch-lint': () => ({ status: 1, stdout: out([viol('orders/service/s.go', 'example.com/app/internal/users')]) }) })
    const r = A.baseline(dir, { run })
    assert.equal(r.data.go.newFromRev, 'feed123')
    assert.equal(r.data.go.archLint.length, 1)
    const gl = run.calls.find((c) => c.cmd === 'go-arch-lint')
    assert.deepEqual(gl.args.slice(0, 2), ['check', '--json'])
    // vi phạm cũ (dù đổi số dòng) không tính, vi phạm mới (file khác / gói khác) thì tính
    const oldMoved = JSON.parse(out([{ ...viol('orders/service/s.go', 'example.com/app/internal/users'), Reference: { Line: 99 } }]))
    assert.deepEqual(A.newGoArchViolations(dir, JSON.stringify(oldMoved)), [])
    const fresh = A.newGoArchViolations(dir, out([viol('orders/service/s.go', 'example.com/app/internal/users'), viol('orders/store/t.go', 'example.com/app/internal/users')]))
    assert.equal(fresh.length, 1)
    assert.match(fresh[0], /orders\/store\/t\.go/)
    // chưa có mốc ⇒ mọi vi phạm đều mới
    const clean = goProject()
    assert.equal(A.newGoArchViolations(clean, out([viol('a.go', 'b')])).length, 1)
  })
  test('Go: go-arch-lint in text thường (không --json) vẫn so được, bỏ số dòng', () => {
    const dir = goProject()
    A.gen(dir)
    const text = "Component 'orders' shouldn't depend on 'users' in orders/service/s.go:12:3\n"
    A.baseline(dir, { run: fakeRun({ ...rev('feed'), 'go-arch-lint': () => ({ status: 1, stdout: text }) }) })
    assert.deepEqual(A.newGoArchViolations(dir, text.replace(':12:3', ':40:1')), [])
    assert.equal(A.newGoArchViolations(dir, `${text}Component 'orders' shouldn't depend on 'misc' in orders/service/s.go:5:1\n`).length, 1)
  })
  test('chốt lại mốc KHÔNG dùng --ignore-known (nếu không vi phạm cũ rơi khỏi mốc); flow-check xin riêng ignoreKnown', () => {
    const dir = webProject()
    A.gen(dir)
    const run1 = fakeRun({ ...rev('a'), depcruise: () => ({ stdout: '[{"x":1}]' }) })
    A.baseline(dir, { run: run1 })
    const run2 = fakeRun({ ...rev('b'), depcruise: () => ({ stdout: '[{"x":1}]' }) })
    A.baseline(dir, { run: run2 })
    assert.ok(!run2.calls.find((c) => c.cmd === 'depcruise').args.includes('--ignore-known'))
    assert.equal(A.depcruiseArgs(dir).args.includes('--ignore-known'), false)
    const strict = A.depcruiseArgs(dir, { ignoreKnown: true }).args
    assert.deepEqual(strict.slice(0, strict.indexOf('--')), ['--config', '.dependency-cruiser.cjs', '--ignore-known', '.dependency-cruiser-known-violations.json', '--output-type', 'err-long'])
    assert.deepEqual(strict.slice(-2), ['--', 'src'])
    fs.rmSync(path.join(dir, '.dependency-cruiser-known-violations.json'))
    assert.equal(A.depcruiseArgs(dir, { ignoreKnown: true }).args.includes('--ignore-known'), false)
  })
  test('depcruiseArgs null khi không có phần web; goArchLintRuns nêu lệnh, tệp và có/không có tệp', () => {
    const g = goProject()
    assert.equal(A.depcruiseArgs(g), null)
    let runs = A.goArchLintRuns(g)
    assert.deepEqual(runs.map((r) => [r.file, r.exists, r.args]), [['.go-arch-lint.yml', false, ['check', '--json']]])
    A.gen(g)
    runs = A.goArchLintRuns(g)
    assert.equal(runs[0].exists, true)
    assert.equal(runs[0].cwd, g)
    const two = tmp()
    writeArch(two, [goPart(), goPart({ name: 'tools', root: 'tools', modules: [{ name: 'gen', path: 'tools/gen', mayDependOn: [] }], forbidden: [] })])
    assert.deepEqual(A.goArchLintRuns(two).map((r) => r.args), [['check', '--json'], ['check', '--json', '--arch-file', '.go-arch-lint.tools.yml']])
  })
  test('baseline: depcruise tìm công cụ ở thư mục của phần web trước (Wails: frontend/), lệnh cài in ra ghim typescript bản depcruise đọc được (dưới 7)', () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n')
    put(dir, 'frontend/package.json', '{}')
    put(dir, 'frontend/src/shared/u.ts', 'export const u = 1\n')
    put(dir, 'internal/billing/b.go', 'package billing\n')
    writeArch(dir, [webPart({ root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', mayDependOn: [] }], shared: ['frontend/src/shared'], forbidden: [] }), goPart({ modules: [{ name: 'billing', path: 'internal/billing', mayDependOn: [] }], forbidden: [] })])
    A.gen(dir)
    const run = fakeRun({ ...rev('abc'), depcruise: () => ({ stdout: '[]' }), 'go-arch-lint': () => ({ stdout: '{}' }) })
    A.baseline(dir, { run })
    assert.deepEqual(run.calls.find((c) => c.cmd === 'depcruise').from, [path.join(dir, 'frontend')])
    const none = A.baseline(dir, { run: fakeRun(rev('abc')) })
    const dc = none.missing.find((m) => m.tool === 'depcruise')
    assert.match(dc.install, /^npm i -D dependency-cruiser@\^18 typescript@\^6$/)
    assert.equal(A.DEPCRUISE_PKGS, 'dependency-cruiser@^18 typescript@^6')
  })
  test('depcruiseArgs: đường dẫn mốc đọc từ docs/arch-baseline.json cũng không tin cậy — tuyệt đối / ".." / bắt đầu bằng "-" ⇒ không đưa vào --ignore-known (nghiêm hơn, không nới); outputType đổi được', () => {
    const dir = webProject()
    put(dir, '-k.json', '[]')
    put(dir, 'k.json', '[]')
    const withKnown = (v) => { put(dir, 'docs/arch-baseline.json', JSON.stringify({ base: 'a', size: {}, depcruise: v, go: null, eslint: false })); return A.depcruiseArgs(dir, { ignoreKnown: true }).args }
    assert.deepEqual(withKnown('k.json').slice(0, 4), ['--config', '.dependency-cruiser.cjs', '--ignore-known', 'k.json'])
    for (const bad of ['-k.json', '../k.json', path.join(dir, 'k.json'), 'k.json\nx']) assert.equal(withKnown(bad).includes('--ignore-known'), false, JSON.stringify(bad))
    const args = A.depcruiseArgs(dir, { outputType: 'baseline' }).args
    assert.deepEqual(args, ['--config', '.dependency-cruiser.cjs', '--output-type', 'baseline', '--', 'src'])
  })
  test('init tiện ích trình duyệt: background / content / popup chỉ được dùng shared (không import nhau), shared không phụ thuộc ai; web vẫn như cũ', () => {
    const dir = tmp()
    put(dir, 'manifest.json', '{"manifest_version":3,"name":"x","version":"1"}')
    for (const e of ['background', 'content', 'popup', 'options']) put(dir, `src/${e}/index.ts`, 'export const e = 1\n')
    put(dir, 'src/shared/msg.ts', 'export const m = 1\n')
    A.init(dir, { stack: 'extension' })
    const mods = Object.fromEntries(JSON.parse(read(dir, 'docs/arch.json')).parts[0].modules.map((m) => [m.name, m.mayDependOn]))
    assert.deepEqual(mods, { background: ['shared'], content: ['shared'], options: ['shared'], popup: ['shared'], shared: [] })
    const web = tmp()
    put(web, 'package.json', '{}')
    put(web, 'src/features/a/ui/A.ts', 'export const a = 1\n')
    put(web, 'src/lib/l.ts', 'export const l = 1\n')
    put(web, 'src/shared/s.ts', 'export const s = 1\n')
    A.init(web, { stack: 'web' })
    const wm = Object.fromEntries(JSON.parse(read(web, 'docs/arch.json')).parts[0].modules.map((m) => [m.name, m.mayDependOn]))
    assert.deepEqual(wm, { 'features/a': ['lib', 'shared'], lib: ['shared'], shared: ['lib'] })
  })
  test('usesTypeScript: phần web có .ts/.tsx (không tính .d.ts, file test) ⇒ true; thuần JS ⇒ false; chỉ Go ⇒ false', () => {
    const ts = webProject()
    assert.equal(A.usesTypeScript(ts), true)
    const js = tmp()
    put(js, 'src/features/a/index.js', 'export const a = 1\n')
    put(js, 'src/features/a/types.d.ts', 'export {}\n')
    put(js, 'src/features/a/a.test.ts', 'export {}\n')
    writeArch(js, [webPart({ modules: [{ name: 'features/a', path: 'src/features/a', mayDependOn: [] }], shared: [], forbidden: [] })])
    assert.equal(A.usesTypeScript(js), false)
    assert.equal(A.usesTypeScript(goProject()), false)
    assert.equal(A.usesTypeScript(tmp()), false, 'chưa có arch.json')
  })
  const galOut = (file, imp ='example.com/app/internal/users') => JSON.stringify({ Type: 'models.Check', Payload: { ArchHasWarnings: true, ArchWarningsDeps: [{ ComponentName: 'orders', FileRelativePath: file, ResolvedImportName: imp }], ArchWarningsNotMatched: [] } })
  test('khoá vi phạm go-arch-lint chuẩn hoá về "/": mốc chốt trên Windows (\\internal\\...) và Mac (/internal/...) là một', () => {
    const win = galOut('\\internal\\orders\\service\\s.go')
    const mac = galOut('/internal/orders/service/s.go')
    const dir = goProject()
    A.gen(dir)
    const r = A.baseline(dir, { run: fakeRun({ ...rev('feed'), 'go-arch-lint': () => ({ status: 1, stdout: win }) }) })
    assert.deepEqual(r.data.go.archLint, ['ArchWarningsDeps | orders | /internal/orders/service/s.go | example.com/app/internal/users'])
    assert.ok(!JSON.stringify(r.data.go.archLint).includes('\\\\'), 'mốc ghi ra không còn dấu \\')
    assert.deepEqual(A.newGoArchViolations(dir, win), [])
    assert.deepEqual(A.newGoArchViolations(dir, mac), [], 'chốt ở Windows, kiểm ở Mac')
    assert.equal(A.newGoArchViolations(dir, galOut('/internal/orders/service/other.go')).length, 1, 'file khác vẫn là vi phạm mới')
  })
  test('mốc cũ đã ghi với dấu "\\" vẫn khớp khi so (kiểm ở Mac hoặc Windows)', () => {
    const dir = goProject()
    put(dir, 'docs/arch-baseline.json', JSON.stringify({ base: 'a', size: {}, depcruise: null, eslint: false, go: { newFromRev: 'a', archLint: ['ArchWarningsDeps | orders | \\internal\\orders\\service\\s.go | example.com/app/internal/users'] } }))
    assert.deepEqual(A.newGoArchViolations(dir, galOut('/internal/orders/service/s.go')), [])
    assert.deepEqual(A.newGoArchViolations(dir, galOut('\\internal\\orders\\service\\s.go')), [])
    assert.equal(A.newGoArchViolations(dir, galOut('/internal/orders/service/new.go')).length, 1)
  })
  test('đầu ra chữ của go-arch-lint có đường dẫn tuyệt đối của máy ⇒ khoá bỏ phần thư mục dự án, nên khớp giữa các máy', () => {
    const dir = goProject()
    A.gen(dir)
    const abs = path.join(dir, 'internal', 'orders', 'service', 's.go')
    A.baseline(dir, { run: fakeRun({ ...rev('feed'), 'go-arch-lint': () => ({ status: 1, stdout: `Component orders shouldn't depend on example.com/app/internal/users in ${abs}:12\n` }) }) })
    const stored = JSON.parse(read(dir, 'docs/arch-baseline.json')).go.archLint
    assert.equal(stored.length, 1)
    assert.ok(!stored[0].includes(dir) && !stored[0].includes('\\'), stored[0])
    assert.deepEqual(A.newGoArchViolations(dir, `Component orders shouldn't depend on example.com/app/internal/users in /home/dev/app/internal/orders/service/s.go:99\n`), [], 'máy khác, thư mục khác')
  })
  test('nodeEngineProblem: nhận ra công cụ từ chối chạy vì phiên bản Node (dependency-cruiser, npm EBADENGINE)', () => {
    const dc = 'ERROR: Your node version (25.2.1) is not supported. dependency-cruiser\n       follows the node.js release cycle and runs on these node versions:\n       ^22||^24||>=26\n'
    assert.deepEqual(A.nodeEngineProblem(dc), { version: '25.2.1' })
    assert.equal(A.nodeEngineProblem('npm warn EBADENGINE Unsupported engine { package: "x" }').version, process.versions.node)
    assert.equal(A.nodeEngineProblem('error arch-web-features-a: src/a.ts → src/b.ts'), null)
    assert.equal(A.nodeEngineProblem(''), null)
    assert.match(A.nodeEngineMessage('25.2.1'), /^Máy kiểm kiến trúc web cần Node 22, Node 24 LTS hoặc Node 26 trở lên; máy đang dùng Node 25\.2\.1\.$/)
  })
  test('depcruise từ chối vì phiên bản Node ⇒ THIẾU (không phải lỗi JSON), kèm lời đời thường; không ghi file vi phạm cũ', () => {
    const dir = webProject()
    A.gen(dir)
    const msg = 'ERROR: Your node version (25.2.1) is not supported. dependency-cruiser\n follows the node.js release cycle and runs on these node versions:\n ^22||^24||>=26\n'
    const r = A.baseline(dir, { run: fakeRun({ ...rev('abc'), depcruise: () => ({ status: 1, stdout: msg }) }) })
    assert.equal(r.data.depcruise, null)
    assert.deepEqual(r.missing.map((m) => m.tool), ['depcruise'])
    assert.match(r.missing[0].why, /Node 22, Node 24 LTS hoặc Node 26 trở lên; máy đang dùng Node 25\.2\.1/)
    assert.ok(!r.notes.some((n) => /không xuất được/.test(n)), r.notes.join('|'))
    assert.equal(has(dir, '.dependency-cruiser-known-violations.json'), false)
  })
  test('không phải repo git / chưa commit ⇒ base null kèm ghi chú, không ném lỗi', () => {
    const dir = webProject()
    const r = A.baseline(dir, { run: fakeRun({ git: () => ({ status: 128, stderr: 'fatal: not a git repository' }) }) })
    assert.equal(r.data.base, null)
    assert.ok(r.notes.some((n) => /git/.test(n)))
  })
  test('ESLint cũ (không biết --suppress-rule) ⇒ ghi chú nâng cấp ≥ 9.24', () => {
    const dir = webProject()
    put(dir, 'eslint.config.mjs', 'export default []\n')
    A.gen(dir)
    const r = A.baseline(dir, { run: fakeRun({ ...rev('a'), depcruise: () => ({ stdout: '[]' }), eslint: () => ({ status: 2, stderr: "Invalid option '--suppress-rule' - perhaps you meant" }) }) })
    assert.equal(r.data.eslint, false)
    assert.ok(r.notes.some((n) => /9\.24/.test(n)))
  })
  test('mốc + sizeCheck: file cũ quá trần xanh, dài thêm đỏ, file mới quá trần đỏ', () => {
    const dir = webProject()
    put(dir, 'src/features/a/ui/Big.ts', nLines(520))
    A.baseline(dir, { run: fakeRun(rev('abc')) })
    assert.equal(A.sizeCheck(dir).ok, true)
    put(dir, 'src/features/a/ui/Big.ts', nLines(521))
    assert.equal(A.sizeCheck(dir).ok, false)
    put(dir, 'src/features/a/ui/Big.ts', nLines(520))
    put(dir, 'src/features/b/ui/Other.ts', nLines(450))
    assert.deepEqual(A.sizeCheck(dir).problems.map((p) => p.file), ['src/features/b/ui/Other.ts'])
  })
  test('golangci-lint thật + git thật: hàm dài / phức tạp CŨ xanh với newFromRev, hàm MỚI cùng loại đỏ', { skip: have('golangci-lint') && have('go') && have('git') ? false : 'máy không có golangci-lint/go/git — bỏ qua test thật' }, () => {
    const longFn = (name) => `func ${name}() int {\n\tx := 0\n${'\tx++\n'.repeat(70)}\treturn x\n}\n`
    const cyclo = (name) => `func ${name}(a int) int {\n${Array.from({ length: 18 }, (_, i) => `\tif a == ${i} {\n\t\treturn ${i}\n\t}\n`).join('')}\treturn a\n}\n`
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/billing/domain/old.go', `package domain\n\n${longFn('LegacyLong')}\n${cyclo('LegacyCyclo')}`)
    writeArch(dir, [goPart({ modules: [{ name: 'billing', path: 'internal/billing', mayDependOn: [] }] })])
    put(dir, 'docs/ARCHITECTURE.md', codemap(['internal/billing']))
    A.gen(dir)
    git(dir, 'init', '-q'); git(dir, 'add', '-A')
    assert.equal(git(dir, 'commit', '-q', '-m', 'goc').status, 0)
    const hybrid = (cmd, args, opts) => (cmd === 'go-arch-lint' ? ENOENT : A.defaultRun(cmd, args, opts))
    const b = A.baseline(dir, { run: hybrid })
    const rev0 = b.data.go.newFromRev
    assert.match(rev0, /^[0-9a-f]{40}$/)
    const lint = () => glc(dir, [`--new-from-rev=${rev0}`])
    const old = lint()
    assert.equal(old.status, 0, old.stdout + old.stderr)
    // chạy KHÔNG có mốc: hai lỗi cũ lộ ra ⇒ chứng minh mốc có tác dụng chứ không phải luật lỏng
    const raw = glc(dir, [])
    assert.notEqual(raw.status, 0)
    assert.match(raw.stdout, /funlen/)
    assert.match(raw.stdout, /gocyclo/)
    put(dir, 'internal/billing/service/new.go', `package service\n\n${longFn('FreshLong')}\n${cyclo('FreshCyclo')}`)
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'moi')
    const fresh = lint()
    const out = fresh.stdout.replace(/\\/g, '/')
    assert.notEqual(fresh.status, 0, out)
    const rows = out.split('\n')
    assert.ok(rows.some((l) => /service\/new\.go/.test(l) && /funlen/.test(l)), out)
    assert.ok(rows.some((l) => /service\/new\.go/.test(l) && /gocyclo/.test(l)), out)
    assert.ok(!/domain\/old\.go/.test(out), out)
  })
  test('eslint thật (≥ 9.24): hàm dài/phức tạp cũ được chốt, hàm mới đỏ', { skip: (() => { if (!have('eslint')) return 'máy không có eslint — bỏ qua test thật'; const v = A.defaultRun('eslint', ['--version'], { cwd: process.cwd() }).stdout.match(/v?(\d+)\.(\d+)/); return v && (Number(v[1]) > 9 || (Number(v[1]) === 9 && Number(v[2]) >= 24)) ? false : 'eslint cũ hơn 9.24 (không có --suppress-rule) — bỏ qua test thật' })() }, () => {
    const dir = webProject()
    writeArch(dir, [webPart({ limits: { fileLines: 400, fnLines: 5, complexity: 3 } })])
    put(dir, 'package.json', '{"type":"module"}')
    put(dir, 'eslint.config.mjs', "export default [{ files: ['**/*.js'], rules: { 'max-lines-per-function': ['error', { max: 5 }], complexity: ['error', 3] } }]\n")
    const fn = (n) => `export function ${n}(a) {\n  if (a === 1) return 1\n  if (a === 2) return 2\n  if (a === 3) return 3\n  if (a === 4) return 4\n  return a\n}\n`
    put(dir, 'src/shared/old.js', fn('legacy'))
    A.gen(dir)
    const b = A.baseline(dir, { run: (cmd, args, o) => (cmd === 'depcruise' || cmd === 'go-arch-lint' ? ENOENT : A.defaultRun(cmd, args, o)) })
    assert.equal(b.data.eslint, true, JSON.stringify(b.notes))
    assert.equal(A.defaultRun('eslint', ['.'], { cwd: dir }).status, 0)
    put(dir, 'src/shared/fresh.js', fn('fresh'))
    assert.notEqual(A.defaultRun('eslint', ['.'], { cwd: dir }).status, 0)
  })
})

describe('defaultRun / findBin', () => {
  test('chạy được công cụ có thật; công cụ không có ⇒ error.code ENOENT, không ném', () => {
    const r = A.defaultRun(process.execPath, ['--version'], { cwd: os.tmpdir() })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^v\d+/)
    const none = A.defaultRun('khong-co-cong-cu-nay-xyz', ['--version'], { cwd: os.tmpdir() })
    assert.equal(none.error.code, 'ENOENT')
    assert.equal(none.status, null)
  })
  test('defaultRun `from`: công cụ cài trong thư mục phần (frontend/node_modules/.bin) thắng bản cùng tên ở PATH; không có `from` thì lấy bản ở PATH', () => {
    const win = process.platform === 'win32'
    const project = tmp()
    const globalDir = tmp()
    const exe = win ? 'fake-dc-xyz.cmd' : 'fake-dc-xyz'
    const body = (who) => (win ? `@echo ${who}\r\n` : `#!/bin/sh\necho ${who}\n`)
    put(project, `frontend/node_modules/.bin/${exe}`, body('local'))
    put(globalDir, exe, body('global'))
    if (!win) { fs.chmodSync(path.join(project, 'frontend', 'node_modules', '.bin', exe), 0o755); fs.chmodSync(path.join(globalDir, exe), 0o755) }
    const env = { ...process.env }
    env[pathKey(env)] = `${globalDir}${path.delimiter}${env[pathKey(env)] ?? ''}`
    const run = (opts) => A.defaultRun('fake-dc-xyz', [], { cwd: project, env, ...opts }).stdout.trim()
    assert.equal(run({}), 'global')
    assert.equal(run({ from: [path.join(project, 'frontend')] }), 'local')
  })
  test('findBin tìm node_modules/.bin của thư mục chạy trước PATH', () => {
    const dir = tmp()
    const name = process.platform === 'win32' ? 'fake-tool-xyz.cmd' : 'fake-tool-xyz'
    put(dir, `node_modules/.bin/${name}`, '#!/bin/sh\n')
    assert.ok(A.findBin('fake-tool-xyz', dir).endsWith(name))
    assert.equal(A.findBin('fake-tool-xyz', os.tmpdir()), null)
  })
})

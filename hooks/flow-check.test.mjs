// Test cho flow-check (máy kiểm theo stack): node --test hooks/flow-check.test.mjs
// Hai tầng (PLAN làn G):
//   1) Logic chạy: dự án mẫu tạm + checker GIẢ + exec/which giả (và vài lần chạy `node` thật cho timeout, cwd, CLI).
//   2) Đối chiếu trên kit/checkers.json THẬT: mỗi stack có đủ checker bắt buộc theo AC-11/43 — thiếu là đỏ.
// Luật SAST (ast-grep): máy có ast-grep/sg ⇒ chạy thật từng luật trên fixture đỏ/xanh; không có ⇒ kiểm cú pháp YAML (lite) + fixture tồn tại.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { INTERNALS, KIT_DIR, OPENAPI_FILES, PLANNERS, changedFiles, exitCode, findTool, formatReport, loadCheckers, main, mv3Problems, resolveBase, runChecks, validateCheckers } from './flow-check.mjs'
import { gen, init, newGoArchViolations } from './lib/arch.mjs'
import { STACKS, detect, matches, roots } from './lib/stack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'flow-check.mjs')
const IS_WIN = process.platform === 'win32'
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })

const tmpDirs = []
// Thư mục tạm có dấu cách + tiếng Việt: bắt lỗi quote đường dẫn.
function project(files = {}, prefix = 'flow check dự án ') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(d, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return d
}
// Xoá cây thư mục bằng unlink/rmdir từng cái: rmSync của Node trên Windows lặng lẽ KHÔNG xoá đường dẫn có chữ có dấu (như thư mục "dự án" ở trên) và không báo lỗi,
// làm %TEMP% đầy rác; file của .git là chỉ-đọc nên bỏ cờ chỉ-đọc trước.
function rmTree(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) rmTree(path.join(p, n))
    try { fs.rmdirSync(p) } catch { /* còn tiến trình giữ thư mục thì thôi */ }
  } else {
    try { fs.chmodSync(p, 0o666) } catch { /* không đổi được quyền thì cứ thử xoá */ }
    try { fs.unlinkSync(p) } catch { /* như trên */ }
  }
}
after(() => { for (const d of tmpDirs) rmTree(d) })

// Khoá giả dựng lúc chạy (không nằm nguyên văn trong file test để cổng quét secret không báo nhầm).
const FAKE_SECRET = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('_')

const OK = { code: 0, stdout: '', stderr: '', timedOut: false, error: null }
const mk = (o = {}) => ({ id: 't', stack: 'web', title: 'Kiểm thử', cmd: 'faketool', args: ['ok'], hint: 'Sửa theo dòng báo.', required: true, install: 'npm i -D faketool', ...o })
const whichAll = (name) => `/fake/bin/${name}`
const whichNone = () => null
const bareCmd = (n) => n

// --- stack.mjs ---------------------------------------------------------------------------------------------------------------------

test('stack.detect: nhận web / go / wails / extension theo file đánh dấu, thứ tự cố định, thư mục trống ⇒ []', () => {
  assert.deepEqual(STACKS, ['web', 'extension', 'go', 'wails'])
  assert.deepEqual(detect(project()), [])
  assert.deepEqual(detect(project({ 'package.json': '{}' })), ['web'])
  assert.deepEqual(detect(project({ 'go.mod': 'module x\n' })), ['go'])
  assert.deepEqual(detect(project({ 'go.mod': 'module x\n', 'wails.json': '{}' })), ['go', 'wails'])
  assert.deepEqual(detect(project({ 'go.mod': 'module x\nrequire github.com/wailsapp/wails/v3 v3.0.0\n' })), ['go', 'wails'], 'Wails v3 không có wails.json: nhận qua go.mod')
  assert.deepEqual(detect(project({ 'manifest.json': { manifest_version: 3, name: 'x' } })), ['extension'])
  assert.deepEqual(detect(project({ 'package.json': '{}', 'public/manifest.json': { manifest_version: 3 } })), ['web', 'extension'])
  assert.deepEqual(detect(project({ 'manifest.json': { name: 'không phải extension' } })), [], 'manifest.json không có manifest_version ⇒ không phải extension')
  assert.deepEqual(detect(project({ 'package.json': '{"devDependencies":{"wxt":"1"}}' })), ['web', 'extension'], 'WXT/Plasmo ⇒ extension dù chưa build manifest')
})

test('stack.roots: Wails có frontend/package.json ⇒ web chạy ở frontend; extension chạy ở thư mục chứa manifest', () => {
  const w = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}' })
  assert.deepEqual(detect(w), ['web', 'go', 'wails'])
  const r = roots(w)
  assert.equal(r.web, path.join(w, 'frontend'))
  assert.equal(r.go, w)
  const e = project({ 'package.json': '{}', 'public/manifest.json': { manifest_version: 3 } })
  assert.equal(roots(e).extension, path.join(e, 'public'))
  assert.equal(roots(e).web, e)
})

test('stack.matches: files (có *), deps, pkgKeys, grep, not/any/all; khoá lạ ⇒ ném lỗi (gõ sai cấu hình không được lặng lẽ thành "áp dụng")', () => {
  const d = project({
    'package.json': { devDependencies: { eslint: '9' }, eslintConfig: {} },
    'eslint.config.mjs': 'export default []',
    'tsconfig.json': '{ // chú thích\n "references": [{"path":"./a"}] }',
  })
  assert.equal(matches(undefined, d), true)
  assert.equal(matches({ files: ['tsconfig.json'] }, d), true)
  assert.equal(matches({ files: ['eslint.config.*'] }, d), true)
  assert.equal(matches({ files: ['.eslintrc*', 'biome.json'] }, d), false)
  assert.equal(matches({ deps: ['eslint'] }, d), true)
  assert.equal(matches({ deps: ['biome'] }, d), false)
  assert.equal(matches({ pkgKeys: ['eslintConfig'] }, d), true)
  assert.equal(matches({ grep: { file: 'tsconfig.json', re: '"references"\\s*:' } }, d), true)
  assert.equal(matches({ grep: { file: 'khong-co.json', re: 'x' } }, d), false)
  assert.equal(matches({ not: { files: ['biome.json'] } }, d), true)
  assert.equal(matches({ any: [{ files: ['biome.json'] }, { deps: ['eslint'] }] }, d), true)
  assert.equal(matches({ all: [{ files: ['tsconfig.json'] }, { files: ['biome.json'] }] }, d), false)
  assert.equal(matches({ files: ['tsconfig.json'], deps: ['eslint'] }, d), true, 'nhiều khoá trong cùng object = VÀ')
  assert.throws(() => matches({ fils: ['x'] }, d), /fils/)
})

// --- validateCheckers ----------------------------------------------------------------------------------------------------------------

test('validateCheckers: bắt cấu hình sai (id trùng, thiếu lời dặn, stack lạ, args không phải mảng, detect lạ, regex hỏng…)', () => {
  const good = { checkers: [mk({ id: 'a' }), mk({ id: 'b', cmd: undefined, internal: 'secret-scan-build', args: undefined, install: undefined })] }
  assert.deepEqual(validateCheckers(good), [])
  const bad = (o, re) => assert.match(validateCheckers({ checkers: [mk(o)] }).join('\n'), re)
  bad({ id: 'Sai Id' }, /id/)
  bad({ stack: 'rust' }, /stack/)
  bad({ hint: '' }, /hint/)
  bad({ title: undefined }, /title/)
  bad({ required: 'yes' }, /required/)
  bad({ args: 'x' }, /args/)
  bad({ cmd: undefined }, /cmd|internal/)
  bad({ install: undefined }, /install/)
  bad({ detect: { fils: ['x'] } }, /detect/)
  bad({ passOn: { exit: [] } }, /passOn/)
  bad({ passOn: { match: '(' } }, /passOn/)
  bad({ timeoutMs: -1 }, /timeoutMs/)
  assert.match(validateCheckers({ checkers: [mk({ id: 'x' }), mk({ id: 'x' })] }).join('\n'), /trùng/)
  assert.match(validateCheckers({}).join('\n'), /checkers/)
})

// --- findTool ------------------------------------------------------------------------------------------------------------------------

test('findTool: node_modules/.bin của dự án (kể cả thư mục cha) thắng PATH; không thấy ⇒ null; đường dẫn tuyệt đối dùng thẳng', () => {
  const ext = IS_WIN ? '.cmd' : ''
  const d = project({ [`node_modules/.bin/mytool${ext}`]: '@echo off\r\n', 'sub/src/.keep': '' })
  if (!IS_WIN) fs.chmodSync(path.join(d, 'node_modules', '.bin', 'mytool'), 0o755)
  const env = { ...process.env }
  assert.equal(findTool('mytool', { cwd: d, env }), path.join(d, 'node_modules', '.bin', `mytool${ext}`))
  assert.equal(findTool('mytool', { cwd: path.join(d, 'sub', 'src'), env }), path.join(d, 'node_modules', '.bin', `mytool${ext}`), 'đi ngược lên thư mục cha như npm')
  assert.equal(findTool('khong-co-cong-cu-nay-xyz', { cwd: d, env }), null)
  assert.equal(findTool(process.execPath, { cwd: d, env }), process.execPath)
  assert.ok(findTool('node', { cwd: d, env }), 'node có trên PATH của chính test')
})

test('findTool: PATH thiếu thì thử thư mục cài quen thuộc (~/go/bin của `go install`, GOBIN, ~/.cargo/bin); PATH vẫn đứng trước', () => {
  const ext = IS_WIN ? '.exe' : ''
  const home = project({ [`go/bin/gotool-xyz${ext}`]: 'x', [`.cargo/bin/cargotool-xyz${ext}`]: 'x' })
  const gobin = project({ [`gobintool-xyz${ext}`]: 'x' })
  const onPath = project({ [`gotool-xyz${ext}`]: 'x' })
  if (!IS_WIN) for (const f of [path.join(home, 'go', 'bin', 'gotool-xyz'), path.join(home, '.cargo', 'bin', 'cargotool-xyz'), path.join(gobin, 'gobintool-xyz'), path.join(onPath, 'gotool-xyz')]) fs.chmodSync(f, 0o755)
  const cwd = project()
  const env = { PATH: '', PATHEXT: '.EXE', GOBIN: gobin }
  assert.equal(findTool('gotool-xyz', { cwd, env, home }), path.join(home, 'go', 'bin', `gotool-xyz${ext}`))
  assert.equal(findTool('cargotool-xyz', { cwd, env, home }), path.join(home, '.cargo', 'bin', `cargotool-xyz${ext}`))
  assert.equal(findTool('gobintool-xyz', { cwd, env, home }), path.join(gobin, `gobintool-xyz${ext}`))
  assert.equal(findTool('gotool-xyz', { cwd, env: { ...env, PATH: onPath }, home }), path.join(onPath, `gotool-xyz${ext}`), 'PATH đứng trước thư mục quen thuộc')
  assert.equal(findTool('khong-co-xyz', { cwd, env, home }), null)
})

test('findTool win32 (PATH giả): chỉ nhận .exe/.com/.cmd/.bat theo PATHEXT, bỏ file sh không đuôi của npm', () => {
  const files = new Set(['C:\\p\\tsc', 'C:\\p\\tsc.cmd', 'C:\\p\\go.exe'])
  const ctx = { cwd: 'C:\\proj', platform: 'win32', env: { Path: 'C:\\p', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, exists: (f) => files.has(f) }
  assert.equal(findTool('tsc', ctx), 'C:\\p\\tsc.cmd')
  assert.equal(findTool('go', ctx), 'C:\\p\\go.exe')
  files.delete('C:\\p\\tsc.cmd')
  assert.equal(findTool('tsc', ctx), null)
})

// --- runChecks: logic với checker giả --------------------------------------------------------------------------------------------------

test('trạng thái: pass / fail / missing(bắt buộc) / missing(tuỳ chọn) / skip; stack không có mặt thì không liệt kê; exit theo luật', async () => {
  const dir = project({ 'package.json': '{}' })
  const checkers = [
    mk({ id: 'ok' }),
    mk({ id: 'bad', args: ['bad'], hint: 'Sửa lỗi kiểu.' }),
    mk({ id: 'nocli', cmd: 'ghost', install: 'npm i -D ghost' }),
    mk({ id: 'opt', cmd: 'ghost2', required: false, install: 'npm i -D ghost2' }),
    mk({ id: 'cond', detect: { files: ['tsconfig.json'] }, skipWhy: 'dự án không có tsconfig.json' }),
    mk({ id: 'gocheck', stack: 'go' }),
    mk({ id: 'every', stack: 'all' }),
  ]
  const which = (n) => (n.startsWith('ghost') ? null : `/fake/${n}`)
  const exec = async (file, args) => ({ ...OK, code: args[0] === 'bad' ? 1 : 0, stdout: args[0] === 'bad' ? 'src/a.ts(3,1): error TS2322: Type string is not assignable\n' : '' })
  const rep = await runChecks({ dir, checkers, which, exec })
  const by = Object.fromEntries(rep.results.map((r) => [r.id, r]))
  assert.deepEqual(rep.stacks, ['web'])
  assert.deepEqual(rep.results.map((r) => r.id), ['ok', 'bad', 'nocli', 'opt', 'cond', 'every'], 'giữ thứ tự khai báo; checker go không có mặt')
  assert.equal(by.ok.status, 'pass')
  assert.equal(by.bad.status, 'fail')
  assert.match(by.bad.fix, /Sửa lỗi kiểu/)
  assert.ok(by.bad.detail.some((l) => /TS2322/.test(l)), 'chép vài dòng báo lỗi của công cụ')
  assert.equal(by.nocli.status, 'missing')
  assert.match(by.nocli.fix, /npm i -D ghost/, 'thiếu công cụ ⇒ kèm lệnh cài, không cài ngầm')
  assert.equal(by.opt.status, 'missing')
  assert.equal(by.opt.required, false)
  assert.equal(by.cond.status, 'skip')
  assert.match(by.cond.message, /tsconfig/)
  assert.equal(by.every.status, 'pass')
  assert.deepEqual(rep.summary, { pass: 2, fail: 1, missing: 2, skip: 1, missingRequired: 1 })
  assert.equal(rep.ok, false)
  assert.equal(exitCode(rep), 1)
})

test('lệnh cài theo máy: install {win32, posix, darwin} ⇒ Mac dùng darwin, Windows/Linux giữ như cũ; osv-scanner thật dùng brew trên Mac', async () => {
  const dir = project({ 'package.json': '{}' })
  const fixOf = async (checker, platform) => (await runChecks({ dir, checkers: [checker], platform, which: () => null })).results[0].fix
  const c = mk({ id: 'x', install: { win32: 'win-cmd', posix: 'posix-cmd', darwin: 'mac-cmd' } })
  assert.match(await fixOf(c, 'darwin'), /mac-cmd/)
  assert.match(await fixOf(c, 'win32'), /win-cmd/)
  assert.match(await fixOf(c, 'linux'), /posix-cmd/)
  assert.match(await fixOf(mk({ id: 'y', install: { win32: 'win-cmd', posix: 'posix-cmd' } }), 'darwin'), /posix-cmd/, 'không có darwin ⇒ rơi về posix')
  const osv = REAL.checkers.find((x) => x.id === 'osv-scanner')
  assert.match(await fixOf(osv, 'darwin'), /brew install osv-scanner/)
  assert.match(await fixOf(osv, 'win32'), /go install github\.com\/google\/osv-scanner/)
  assert.match(await fixOf(osv, 'linux'), /go install github\.com\/google\/osv-scanner/)
})

test('exit: chỉ thiếu công cụ KHÔNG bắt buộc ⇒ 0 (vẫn báo THIẾU, không tính đạt); thiếu công cụ bắt buộc ⇒ 1; không có gì để kiểm ⇒ 0', async () => {
  const dir = project({ 'package.json': '{}' })
  const exec = async () => OK
  const onlyOpt = await runChecks({ dir, checkers: [mk({ id: 'a' }), mk({ id: 'o', cmd: 'ghost', required: false })], which: (n) => (n === 'ghost' ? null : '/f'), exec })
  assert.equal(exitCode(onlyOpt), 0)
  assert.equal(onlyOpt.summary.pass, 1, 'missing không được cộng vào pass')
  assert.equal(onlyOpt.summary.missing, 1)
  const reqMiss = await runChecks({ dir, checkers: [mk({ id: 'a', cmd: 'ghost' })], which: whichNone, exec })
  assert.equal(exitCode(reqMiss), 1)
  const empty = await runChecks({ dir: project(), checkers: [mk({ id: 'a' })], which: whichAll, exec })
  assert.equal(exitCode(empty), 0)
  assert.deepEqual(empty.results, [])
})

test('passOn: mã thoát cho phép + chuỗi bắt buộc trong output (wails doctor: exit 0 mà thiếu dòng SUCCESS vẫn là không đạt)', async () => {
  const dir = project({ 'package.json': '{}' })
  const c = mk({ id: 'w', passOn: { exit: [0, 3], match: 'ready for Wails' } })
  const run = (res) => runChecks({ dir, checkers: [c], which: whichAll, exec: async () => ({ ...OK, ...res }) }).then((r) => r.results[0])
  assert.equal((await run({ code: 0, stdout: 'SUCCESS Your system is ready for Wails development!' })).status, 'pass')
  assert.equal((await run({ code: 3, stdout: 'ready for Wails' })).status, 'pass', 'mã 3 nằm trong danh sách cho phép')
  assert.equal((await run({ code: 0, stdout: 'ERROR 2 dependencies missing' })).status, 'fail', 'thiếu chuỗi bắt buộc')
  assert.equal((await run({ code: 1, stdout: 'ready for Wails' })).status, 'fail', 'mã thoát lạ')
})

test('lỗi chạy: ENOENT ⇒ missing; quá giờ ⇒ fail ghi rõ; lỗi khác ⇒ fail (không bao giờ pass im lặng)', async () => {
  const dir = project({ 'package.json': '{}' })
  const run = (res) => runChecks({ dir, checkers: [mk()], which: whichAll, exec: async () => ({ ...OK, ...res }) }).then((r) => r.results[0])
  assert.equal((await run({ code: null, error: { code: 'ENOENT', message: 'x' } })).status, 'missing')
  const t = await run({ code: null, timedOut: true })
  assert.equal(t.status, 'fail')
  assert.match(t.message, /quá|giờ|thời gian/i)
  const u = await run({ code: null, error: { code: 'EUNSAFE', message: 'đối số không an toàn' } })
  assert.equal(u.status, 'fail')
  assert.match(u.message, /đối số không an toàn/)
})

test('requires.pkgs: thiếu gói trong package.json ⇒ missing + lệnh cài của requires (công cụ có nhưng gói bổ trợ chưa có)', async () => {
  const c = mk({ id: 'axe', cmd: 'playwright', requires: { pkgs: ['@axe-core/playwright'], install: 'npm i -D @axe-core/playwright' } })
  const without = await runChecks({ dir: project({ 'package.json': { devDependencies: { '@playwright/test': '1' } } }), checkers: [c], which: whichAll, exec: async () => OK })
  assert.equal(without.results[0].status, 'missing')
  assert.match(without.results[0].fix, /@axe-core\/playwright/)
  const withPkg = await runChecks({ dir: project({ 'package.json': { devDependencies: { '@axe-core/playwright': '4' } } }), checkers: [c], which: whichAll, exec: async () => OK })
  assert.equal(withPkg.results[0].status, 'pass')
})

test('lời dặn: output của công cụ chứa khoá bí mật ⇒ không bao giờ in lại (detail thay bằng thông báo), kể cả trong JSON', async () => {
  const dir = project({ 'package.json': '{}' })
  const exec = async () => ({ ...OK, code: 1, stdout: `Error: bad config key=${FAKE_SECRET}\nline2\n` })
  const rep = await runChecks({ dir, checkers: [mk()], which: whichAll, exec })
  assert.equal(rep.results[0].status, 'fail')
  assert.ok(!JSON.stringify(rep).includes(FAKE_SECRET))
  assert.ok(!formatReport(rep).includes(FAKE_SECRET))
  assert.match(rep.results[0].detail.join('\n'), /khoá|bí mật/)
})

test('detail: bỏ mã màu ANSI, tối đa vài dòng + "còn N dòng nữa"; dòng quá dài bị cắt', async () => {
  const dir = project({ 'package.json': '{}' })
  const lines = Array.from({ length: 40 }, (_, i) => `\u001b[31mlỗi ${i}\u001b[0m ${'x'.repeat(i === 0 ? 900 : 5)}`)
  const rep = await runChecks({ dir, checkers: [mk()], which: whichAll, exec: async () => ({ ...OK, code: 1, stdout: lines.join('\n') }) })
  const d = rep.results[0].detail
  assert.ok(d.length <= 12, `detail dài ${d.length}`)
  assert.ok(!d.join('').includes('\u001b['))
  assert.ok(d.every((l) => l.length <= 240))
  assert.match(d.at(-1), /còn \d+ dòng/)
})

test('detail: bỏ cả liên kết bấm được OSC 8 (squawk in URL kèm theo dù đã đặt NO_COLOR)', async () => {
  const dir = project({ 'package.json': '{}' })
  const osc = 'warning[\u001b]8;;https://squawkhq.example/docs/rule\u001b\\prefer-robust\u001b]8;;\u001b\\]: thiếu IF NOT EXISTS\u0007x'
  const rep = await runChecks({ dir, checkers: [mk()], which: whichAll, exec: async () => ({ ...OK, code: 1, stdout: osc }) })
  const text = rep.results[0].detail.join('\n')
  assert.match(text, /warning\[prefer-robust\]: thiếu IF NOT EXISTS/)
  assert.ok(!text.includes('https://') && !text.includes('\u001b'), text)
})

test('detail: dòng quá dài mà có "Cách sửa: …" ⇒ giữ nguyên phần lời dặn (cắt phần đầu thay vì cắt mất lời dặn); vị trí lỗi vẫn còn', async () => {
  const dir = project({ 'package.json': '{}' })
  const advice = 'Cách sửa: Khai báo interface ngay trong domain, cài đặt nó trong store, rồi truyền vào qua tham số của service.'
  const line = `internal/billing/domain/x.go:3:2: import '${'example.com/app/internal/billing/store/'.repeat(4)}' is not allowed from list 'arch-go-1': domain là lõi nghiệp vụ, không được biết cách lưu trữ. ${advice} (depguard)`
  assert.ok(line.indexOf('Cách sửa:') > 200, 'dòng mẫu phải dài hơn trần để thử')
  const rep = await runChecks({ dir, checkers: [mk()], which: whichAll, exec: async () => ({ ...OK, code: 1, stdout: line }) })
  const text = rep.results[0].detail.join('\n')
  assert.ok(text.includes(advice), text)
  assert.ok(text.includes('internal/billing/domain/x.go:3:2'), text)
  assert.ok(rep.results[0].detail[0].length <= 700, `dòng quá dài: ${rep.results[0].detail[0].length}`)
})

test('{kit} trong args được thay bằng đường dẫn thư mục kit (dấu / kể cả Windows ⇒ qua được bộ lọc đối số của .cmd)', async () => {
  const dir = project({ 'package.json': '{}' })
  let seen
  const exec = async (file, args) => { seen = args; return OK }
  await runChecks({ dir, checkers: [mk({ args: ['--config', '{kit}/rules/sgconfig.yml', '.'] })], which: whichAll, exec })
  assert.equal(seen[0], '--config')
  assert.ok(!seen[1].includes('\\'), seen[1])
  assert.ok(!seen[1].includes('{kit}'))
  assert.ok(fs.existsSync(seen[1]), `không thấy ${seen[1]}`)
  assert.equal(seen[2], '.')
})

test('identify: ứng viên thứ hai (vd `sg`) chỉ dùng khi --version nhận ra đúng công cụ (tránh nhầm với `sg` của hệ điều hành)', async () => {
  const dir = project({ 'package.json': '{}' })
  const c = mk({ cmd: ['ast-grep', 'sg'], identify: 'ast-grep', args: ['scan'] })
  const which = (n) => (n === 'sg' ? '/usr/bin/sg' : null)
  const calls = []
  const wrong = await runChecks({ dir, checkers: [c], which, exec: async (f, a) => { calls.push([f, a]); return { ...OK, stdout: 'sg: usage: sg group' } } })
  assert.equal(wrong.results[0].status, 'missing', '`sg` của hệ điều hành không phải ast-grep')
  assert.deepEqual(calls[0][1], ['--version'])
  const right = await runChecks({ dir, checkers: [c], which, exec: async (f, a) => ({ ...OK, stdout: a[0] === '--version' ? 'ast-grep 0.40.0' : 'quét xong' }) })
  assert.equal(right.results[0].status, 'pass')
})

// --- runChecks: chạy tiến trình thật --------------------------------------------------------------------------------------------------

test('chạy `node` thật: thư mục chạy đúng root từng stack (Wails: web ở frontend/, go ở gốc) kể cả khi chạy song song; quá giờ bị diệt', async () => {
  const dir = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}' })
  const pwd = ['-e', 'console.log(process.cwd())']
  const checkers = [
    { id: 'w', stack: 'web', title: 'W', cmd: 'node', args: pwd, hint: 'h', required: true, install: 'x', passOn: { exit: [0], match: 'frontend\\s*$' } },
    { id: 'g', stack: 'go', title: 'G', cmd: 'node', args: pwd, hint: 'h', required: true, install: 'x', passOn: { exit: [0], match: '^(?!.*frontend)' } },
    { id: 'slow', stack: 'wails', title: 'S', cmd: 'node', args: ['-e', 'setTimeout(()=>{},30000)'], hint: 'h', required: true, install: 'x', timeoutMs: 400 },
  ]
  const t0 = Date.now()
  const rep = await runChecks({ dir, checkers })
  const by = Object.fromEntries(rep.results.map((r) => [r.id, r]))
  assert.equal(by.w.status, 'pass', JSON.stringify(by.w))
  assert.equal(by.g.status, 'pass', JSON.stringify(by.g))
  assert.equal(by.slow.status, 'fail')
  assert.match(by.slow.message, /quá|thời gian|giờ/i)
  assert.ok(Date.now() - t0 < 15000, 'timeout phải diệt tiến trình, không chờ hết 30 giây')
})

test('shim trong node_modules/.bin chạy thật (Windows .cmd qua cmd.exe, POSIX script): lấy stdout/stderr/mã thoát, đúng cwd, đối số lạ bị từ chối', async () => {
  const win = IS_WIN
  const dir = project({
    'package.json': '{}',
    [`node_modules/.bin/shimtool${win ? '.cmd' : ''}`]: win
      ? '@echo off\r\necho shim-ok %1 %CD%\r\nif "%1"=="bad" (echo shim-loi 1>&2 & exit /b 3)\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho "shim-ok $1 $PWD"\n[ "$1" = bad ] && { echo shim-loi >&2; exit 3; }\nexit 0\n',
  })
  if (!win) fs.chmodSync(path.join(dir, 'node_modules', '.bin', 'shimtool'), 0o755)
  const c = (id, args) => ({ id, stack: 'web', title: id, cmd: 'shimtool', args, hint: 'Sửa đi.', required: true, install: 'npm i -D shimtool' })
  const rep = await runChecks({ dir, checkers: [{ ...c('okk', ['ok']), passOn: { exit: [0], match: 'shim-ok ok' } }, c('bad', ['bad']), c('unsafe', ['a&b'])] })
  const by = Object.fromEntries(rep.results.map((r) => [r.id, r]))
  assert.equal(by.okk.status, 'pass', JSON.stringify(by.okk))
  assert.equal(by.bad.status, 'fail')
  assert.match(by.bad.message, /mã thoát 3/)
  assert.ok(by.bad.detail.some((l) => l.includes('shim-loi')), 'chép cả stderr')
  if (win) {
    assert.equal(by.unsafe.status, 'fail', 'đối số có & không được chuyển cho cmd.exe')
    assert.match(by.unsafe.message, /không an toàn/)
    assert.match(by.unsafe.fix, /\.exe|dấu cách/)
  }
})

test('runChecks không đổi thư mục làm việc của tiến trình gọi', async () => {
  const before = process.cwd()
  await runChecks({ dir: project({ 'package.json': '{}' }), checkers: [mk()], which: whichAll, exec: async () => OK })
  const dir = project({ 'package.json': '{}' })
  await runChecks({ dir, checkers: [{ id: 'n', stack: 'web', title: 'N', cmd: 'node', args: ['-e', '0'], hint: 'h', required: true, install: 'x' }] })
  assert.equal(process.cwd(), before)
})

// --- checker nội bộ ----------------------------------------------------------------------------------------------------------------------

test('secret-scan-build: có khoá trong dist/ ⇒ fail, không in lại khoá; build sạch ⇒ pass; chưa có thư mục build ⇒ missing + dặn build', async () => {
  const c = [{ id: 'secret-build', stack: 'web', title: 'Quét bản build', internal: 'secret-scan-build', hint: 'Xoá khoá khỏi code client.', required: true }]
  const dirty = project({ 'package.json': '{}', 'dist/assets/app.js': `const k="${FAKE_SECRET}";`, 'src/main.ts': `const unused="${FAKE_SECRET}"` })
  const r1 = (await runChecks({ dir: dirty, checkers: c })).results[0]
  assert.equal(r1.status, 'fail')
  assert.ok(r1.detail.some((l) => l.includes('dist/assets/app.js')))
  assert.ok(!r1.detail.some((l) => l.includes('src/main.ts')), 'chỉ quét thư mục build, không quét src/')
  assert.ok(!JSON.stringify(r1).includes(FAKE_SECRET))
  const clean = project({ 'package.json': '{}', 'dist/assets/app.js': 'console.log(1)' })
  assert.equal((await runChecks({ dir: clean, checkers: c })).results[0].status, 'pass')
  const none = project({ 'package.json': '{}', 'src/a.ts': 'x' })
  const r3 = (await runChecks({ dir: none, checkers: c })).results[0]
  assert.equal(r3.status, 'missing', 'chưa build thì chưa kiểm được ⇒ không tính đạt')
  assert.match(r3.fix, /build/i)
  const nested = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'frontend/dist/a.js': `x="${FAKE_SECRET}"` })
  assert.equal((await runChecks({ dir: nested, checkers: c })).results[0].status, 'fail', 'Wails: frontend/dist cũng được quét')
})

test('mv3Problems: manifest_version != 3, quyền quá rộng/nhạy cảm, unsafe-eval, mã từ xa trong CSP', () => {
  const good = { manifest_version: 3, name: 'x', permissions: ['storage', 'activeTab'], host_permissions: ['https://api.example.com/*'], content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" } }
  assert.deepEqual(mv3Problems(good), [])
  const text = mv3Problems({
    manifest_version: 2,
    permissions: ['<all_urls>', 'debugger', 'storage'],
    host_permissions: ['*://*/*'],
    content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval' https://cdn.example.com; object-src 'self'" },
  }).join('\n')
  assert.match(text, /manifest_version/)
  assert.match(text, /<all_urls>/)
  assert.match(text, /\*:\/\/\*\/\*/)
  assert.match(text, /debugger/)
  assert.match(text, /unsafe-eval/)
  assert.match(text, /cdn\.example\.com|từ xa/)
  assert.match(mv3Problems({ manifest_version: 3, content_security_policy: "script-src 'self' 'unsafe-eval'" }).join('\n'), /unsafe-eval/, 'CSP dạng chuỗi (MV2) cũng bị xét')
})

test('mv3-manifest (chạy thật): manifest tốt + không có mã từ xa ⇒ pass; <script src=https> hoặc importScripts(https) ⇒ fail; không có manifest ⇒ missing', async () => {
  const c = [{ id: 'mv3-manifest', stack: 'extension', title: 'MV3', internal: 'mv3-manifest', hint: 'Sửa manifest.', required: true }]
  const manifest = { manifest_version: 3, name: 'x', version: '1', permissions: ['storage'] }
  const ok = project({ 'manifest.json': manifest, 'popup.html': '<script src="popup.js"></script>', 'popup.js': 'console.log(1)' })
  assert.equal((await runChecks({ dir: ok, checkers: c })).results[0].status, 'pass')
  const remoteHtml = project({ 'manifest.json': manifest, 'popup.html': '<script src="https://cdn.example.com/lib.js"></script>' })
  const r1 = (await runChecks({ dir: remoteHtml, checkers: c })).results[0]
  assert.equal(r1.status, 'fail')
  assert.ok(r1.detail.some((l) => l.includes('popup.html')))
  const remoteJs = project({ 'manifest.json': manifest, 'sw.js': "importScripts('https://evil.example.com/x.js')" })
  assert.equal((await runChecks({ dir: remoteJs, checkers: c })).results[0].status, 'fail')
  const nodeMods = project({ 'manifest.json': manifest, 'node_modules/lib/x.js': "importScripts('https://cdn.example.com/x.js')" })
  assert.equal((await runChecks({ dir: nodeMods, checkers: c })).results[0].status, 'pass', 'không quét node_modules')
  const noManifest = project({ 'package.json': '{"devDependencies":{"wxt":"1"}}' })
  assert.equal((await runChecks({ dir: noManifest, checkers: c })).results[0].status, 'missing')
})

test('shadcn-lint (nội bộ): gói @shadcn/lint có trong package.json nhưng cấu hình ESLint không nhắc tới ⇒ fail; có nhắc ⇒ pass', async () => {
  const c = [{ id: 'shadcn-lint', stack: 'web', title: 'shadcn', internal: 'shadcn-lint', hint: 'Bật plugin.', required: true, detect: { files: ['components.json'] }, requires: { pkgs: ['@shadcn/lint'], install: 'npm i -D @shadcn/lint' } }]
  const pkg = { devDependencies: { '@shadcn/lint': '0.2.1', eslint: '9' } }
  const off = project({ 'package.json': pkg, 'components.json': '{}', 'eslint.config.mjs': 'export default []' })
  assert.equal((await runChecks({ dir: off, checkers: c })).results[0].status, 'fail')
  const on = project({ 'package.json': pkg, 'components.json': '{}', 'eslint.config.mjs': 'import {plugin as shadcn} from "@shadcn/lint"\nexport default [{plugins:{shadcn}}]' })
  assert.equal((await runChecks({ dir: on, checkers: c })).results[0].status, 'pass')
  const notShadcn = project({ 'package.json': pkg })
  assert.equal((await runChecks({ dir: notShadcn, checkers: c })).results[0].status, 'skip', 'không có components.json ⇒ dự án không dùng shadcn')
  const noPkg = project({ 'package.json': '{}', 'components.json': '{}' })
  assert.equal((await runChecks({ dir: noPkg, checkers: c })).results[0].status, 'missing')
})

test('INTERNALS có đủ checker nội bộ mà checkers.json nhắc tới', () => {
  for (const n of ['secret-scan-build', 'mv3-manifest', 'shadcn-lint']) assert.equal(typeof INTERNALS[n], 'function', n)
})

// --- bảng chữ + CLI ------------------------------------------------------------------------------------------------------------------

test('formatReport: bảng tiếng Việt — nhãn, lời dặn, lệnh cài, dòng kết luận; không có mã màu', async () => {
  const dir = project({ 'package.json': '{}' })
  const checkers = [
    mk({ id: 'ok', title: 'Kiểm A' }),
    mk({ id: 'bad', title: 'Kiểm B', args: ['bad'], hint: 'Sửa lỗi B đi.' }),
    mk({ id: 'nocli', title: 'Kiểm C', cmd: 'ghost', install: 'npm i -D ghost' }),
    mk({ id: 'cond', title: 'Kiểm D', detect: { files: ['x.json'] }, skipWhy: 'không dùng X' }),
  ]
  const rep = await runChecks({ dir, checkers, which: (n) => (n === 'ghost' ? null : '/f'), exec: async (f, a) => ({ ...OK, code: a[0] === 'bad' ? 1 : 0, stdout: a[0] === 'bad' ? 'lỗi dòng 3' : '' }) })
  const txt = formatReport(rep)
  assert.match(txt, /ĐẠT\s+ok/)
  assert.match(txt, /KHÔNG\s+bad/)
  assert.match(txt, /THIẾU\s+nocli/)
  assert.match(txt, /BỎ QUA\s+cond/)
  assert.match(txt, /Sửa lỗi B đi/)
  assert.match(txt, /npm i -D ghost/)
  assert.match(txt, /lỗi dòng 3/)
  assert.match(txt, /KHÔNG ĐẠT/)
  assert.ok(!txt.includes('\u001b['))
})

test('main: --json in JSON đọc được; exit 0/1; dùng sai (thư mục không có, cờ lạ, checkers.json hỏng) ⇒ exit 2 và nói rõ', async () => {
  const dir = project({ 'package.json': '{}' })
  const okFile = path.join(project({ 'c.json': { checkers: [mk({ id: 'a' })] } }), 'c.json')
  const badFile = path.join(project({ 'c.json': { checkers: [mk({ id: 'a', hint: '' })] } }), 'c.json')
  const io = () => { const o = { out: '', err: '' }; return { o, deps: { stdout: { write: (s) => { o.out += s } }, stderr: { write: (s) => { o.err += s } }, which: whichAll, exec: async (f, a) => ({ ...OK, code: a[0] === 'bad' ? 1 : 0 }) } } }
  let { o, deps } = io()
  assert.equal(await main(['--dir', dir, '--json', '--checkers', okFile], deps), 0)
  const j = JSON.parse(o.out)
  assert.equal(j.ok, true)
  assert.equal(j.results[0].status, 'pass')
  assert.deepEqual(j.stacks, ['web'])
  ;({ o, deps } = io())
  const failFile = path.join(project({ 'c.json': { checkers: [mk({ id: 'a', args: ['bad'] })] } }), 'c.json')
  assert.equal(await main(['--dir', dir, '--checkers', failFile], deps), 1)
  assert.match(o.out, /KHÔNG ĐẠT/)
  ;({ o, deps } = io())
  assert.equal(await main(['--dir', path.join(dir, 'khong-co')], deps), 2)
  assert.match(o.err, /không|thư mục/i)
  ;({ o, deps } = io())
  assert.equal(await main(['--la'], deps), 2)
  ;({ o, deps } = io())
  assert.equal(await main(['--dir', dir, '--checkers', badFile], deps), 2)
  assert.match(o.err, /hint/)
})

test('CLI thật (spawn): thư mục có dấu cách, checker giả chạy `node` thật ⇒ JSON + exit đúng', () => {
  const dir = project({ 'package.json': '{}' })
  const mkFile = (args) => path.join(project({ 'c.json': { checkers: [{ id: 'n', stack: 'web', title: 'N', cmd: 'node', args, hint: 'Sửa đi.', required: true, install: 'cài node' }] } }), 'c.json')
  const run = (file) => spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--json', '--checkers', file], { encoding: 'utf8' })
  const pass = run(mkFile(['-e', 'process.exit(0)']))
  assert.equal(pass.status, 0, pass.stderr)
  assert.equal(JSON.parse(pass.stdout).results[0].status, 'pass')
  const fail = run(mkFile(['-e', 'console.error("hỏng rồi");process.exit(1)']))
  assert.equal(fail.status, 1, fail.stderr)
  const j = JSON.parse(fail.stdout)
  assert.equal(j.ok, false)
  assert.ok(j.results[0].detail.join('\n').includes('hỏng rồi'))
})

// --- tầng 2: kiểm đối chiếu trên kit/checkers.json THẬT ------------------------------------------------------------------------------------

const REAL = loadCheckers()
const byStack = (s) => REAL.checkers.filter((c) => c.stack === s)

// Bảng PLAN "Kiến trúc dòng flow-check" (AC-11/43). Thiếu một mục ⇒ đỏ.
const MANDATORY = {
  web: ['tsc', 'eslint', 'biome', 'shadcn-lint', 'knip', 'jscpd', 'size-limit', 'axe', 'osv-scanner', 'secret-build'],
  go: ['go-vet', 'golangci-lint', 'govulncheck'],
  wails: ['wails-doctor'],
  extension: ['web-ext-lint', 'mv3-manifest'],
  all: ['sast-ast-grep'],
}

test('checkers.json thật: hợp lệ theo validateCheckers, không lỗi', () => {
  assert.deepEqual(REAL.errors, [])
  assert.ok(REAL.checkers.length >= 17)
})

for (const [stack, ids] of Object.entries(MANDATORY)) {
  test(`checkers.json thật — stack ${stack} có đủ checker BẮT BUỘC: ${ids.join(', ')}`, () => {
    const have = new Map(byStack(stack).map((c) => [c.id, c]))
    for (const id of ids) {
      assert.ok(have.has(id), `stack ${stack} thiếu checker "${id}"`)
      assert.equal(have.get(id).required, true, `${id} phải required:true`)
    }
  })
}

test('checkers.json thật: lệnh đúng bảng PLAN (go vet, golangci-lint, govulncheck, wails doctor, web-ext lint, osv-scanner, ast-grep)', () => {
  const get = (id) => REAL.checkers.find((c) => c.id === id)
  assert.equal(get('go-vet').cmd, 'go')
  assert.deepEqual(get('go-vet').args.slice(0, 2), ['vet', './...'])
  assert.equal(get('golangci-lint').cmd, 'golangci-lint')
  assert.equal(get('govulncheck').cmd, 'govulncheck')
  assert.ok([].concat(get('wails-doctor').cmd).includes('wails'))
  assert.deepEqual(get('wails-doctor').args, ['doctor'])
  assert.match(get('wails-doctor').passOn.match, /ready/i, 'wails doctor: bắt chuỗi SUCCESS ngoài mã thoát (research §3)')
  assert.equal(get('web-ext-lint').cmd, 'web-ext')
  assert.equal(get('web-ext-lint').args[0], 'lint')
  assert.equal(get('osv-scanner').cmd, 'osv-scanner')
  assert.ok([].concat(get('sast-ast-grep').cmd).includes('ast-grep'))
  assert.equal(get('secret-build').internal, 'secret-scan-build')
  assert.equal(get('mv3-manifest').internal, 'mv3-manifest')
  assert.ok(get('tsc').args.includes('--noEmit'))
  assert.deepEqual(get('tsc-build').args, ['-b'], 'tsconfig kiểu solution (references, mẫu Vite): tsc --noEmit sẽ pass giả')
})

test('checkers.json thật: mọi checker chạy lệnh có lệnh cài chính thức + lời dặn tiếng Việt; checker nội bộ có hàm trong INTERNALS', () => {
  for (const c of REAL.checkers) {
    assert.match(c.hint, /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i, `${c.id}: lời dặn phải bằng tiếng Việt`)
    assert.ok(c.title && c.title.length <= 60, `${c.id}: title`)
    if (c.internal) assert.equal(typeof INTERNALS[c.internal], 'function', `${c.id}: internal ${c.internal} không có hàm`)
    else assert.ok(c.install, `${c.id}: thiếu lệnh cài`)
  }
})

test('checkers.json thật: tham chiếu {kit}/… trỏ tới file có thật; SAST dùng ast-grep scan với sgconfig của kit', () => {
  for (const c of REAL.checkers) {
    for (const a of c.args ?? []) {
      if (!a.includes('{kit}')) continue
      assert.ok(fs.existsSync(a.replace('{kit}', KIT_DIR)), `${c.id}: ${a} không tồn tại`)
    }
  }
  const sast = REAL.checkers.find((c) => c.id === 'sast-ast-grep')
  assert.equal(sast.args[0], 'scan')
  assert.ok(sast.args.some((a) => a.startsWith('{kit}/rules/sgconfig.yml')))
  assert.equal(sast.identify, 'ast-grep')
})

// Máy "đủ đồ": which trả đường dẫn, exec báo đạt (stdout đủ cho cả wails doctor + ast-grep --version).
const GOOD_OUT = 'SUCCESS Your system is ready for Wails development! ast-grep 0.40.0'
const execGood = async () => ({ ...OK, stdout: GOOD_OUT })

test('thật × web đủ đồ (Vite + shadcn + Playwright + axe): đúng bộ checker áp dụng, tất cả đạt, exit 0', async () => {
  const dir = project({
    'package.json': { devDependencies: { '@playwright/test': '1', '@axe-core/playwright': '4', '@shadcn/lint': '0.2.1', eslint: '9' } },
    'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    'components.json': '{}',
    'eslint.config.mjs': 'import {plugin as shadcn} from "@shadcn/lint"; export default [{plugins:{shadcn}}]',
    'dist/assets/index.js': 'console.log(1)',
  })
  const rep = await runChecks({ dir, checkers: REAL.checkers, which: whichAll, exec: execGood })
  const st = Object.fromEntries(rep.results.map((r) => [r.id, r.status]))
  for (const id of ['tsc-build', 'eslint', 'shadcn-lint', 'knip', 'jscpd', 'size-limit', 'axe', 'osv-scanner', 'secret-build', 'sast-ast-grep']) assert.equal(st[id], 'pass', `${id}: ${JSON.stringify(rep.results.find((r) => r.id === id))}`)
  assert.equal(st.tsc, 'skip', 'có references ⇒ dùng tsc -b, không dùng tsc --noEmit')
  assert.equal(st.biome, 'skip', 'không dùng Biome')
  assert.ok(!('go-vet' in st) && !('wails-doctor' in st) && !('mv3-manifest' in st))
  assert.equal(rep.ok, true)
  assert.equal(exitCode(rep), 0)
})

test('thật × web trống công cụ: mọi checker bắt buộc thành THIẾU kèm lệnh cài, exit 1 (không tính đạt, không cài ngầm)', async () => {
  const dir = project({
    'package.json': { devDependencies: { '@playwright/test': '1' } },
    'tsconfig.json': '{}',
    'dist/a.js': 'x',
  })
  let ran = 0
  const rep = await runChecks({ dir, checkers: REAL.checkers, which: whichNone, exec: async () => { ran++; return OK } })
  const st = Object.fromEntries(rep.results.map((r) => [r.id, r]))
  assert.equal(ran, 0, 'không có công cụ thì không gọi gì')
  for (const id of ['tsc', 'eslint', 'knip', 'jscpd', 'size-limit', 'axe', 'osv-scanner', 'sast-ast-grep']) {
    assert.equal(st[id].status, 'missing', id)
    assert.ok(st[id].fix && /\S/.test(st[id].fix), `${id}: thiếu lệnh cài`)
  }
  assert.equal(st.axe.status, 'missing')
  assert.equal(st['shadcn-lint'].status, 'skip')
  assert.equal(st['secret-build'].status, 'pass', 'secret-build là checker nội bộ, không cần công cụ ngoài')
  assert.equal(rep.summary.pass, 1)
  assert.equal(rep.ok, false)
  assert.equal(exitCode(rep), 1)
})

test('thật × Go: go-vet, golangci-lint, govulncheck + SAST; không có checker web/wails', async () => {
  const rep = await runChecks({ dir: project({ 'go.mod': 'module x\n' }), checkers: REAL.checkers, which: whichAll, exec: execGood })
  assert.deepEqual(rep.stacks, ['go'])
  assert.deepEqual(rep.results.map((r) => r.id).sort(), ['go-vet', 'golangci-lint', 'govulncheck', 'sast-ast-grep'])
  assert.equal(exitCode(rep), 0)
})

test('thật × Wails (frontend/): thêm wails doctor + toàn bộ checker web chạy ở frontend/', async () => {
  const dir = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'frontend/tsconfig.json': '{}', 'frontend/dist/a.js': 'x' })
  const cwds = new Set()
  const exec = async (file, args, o) => { cwds.add(`${path.basename(file)}@${path.relative(dir, o.cwd) || '.'}`); return { ...OK, stdout: GOOD_OUT } }
  const rep = await runChecks({ dir, checkers: REAL.checkers, which: (n) => `/f/${n}`, exec })
  const ids = rep.results.filter((r) => r.status !== 'skip').map((r) => r.id)
  for (const id of ['wails-doctor', 'go-vet', 'tsc', 'knip', 'sast-ast-grep']) assert.ok(ids.includes(id), id)
  assert.ok(cwds.has('tsc@frontend'), [...cwds].join(', '))
  assert.ok(cwds.has('go@.'), [...cwds].join(', '))
  assert.equal(exitCode(rep), 0, JSON.stringify(rep.results.filter((r) => r.status !== 'pass' && r.status !== 'skip')))
})

test('thật × extension (manifest MV3 ở gốc): web-ext-lint + mv3-manifest + SAST', async () => {
  const dir = project({ 'manifest.json': { manifest_version: 3, name: 'x', version: '1', permissions: ['storage'] } })
  const rep = await runChecks({ dir, checkers: REAL.checkers, which: whichAll, exec: execGood })
  assert.deepEqual(rep.stacks, ['extension'])
  assert.deepEqual(rep.results.map((r) => r.id).sort(), ['mv3-manifest', 'sast-ast-grep', 'web-ext-lint'])
  assert.equal(exitCode(rep), 0)
})

test('thật × thư mục chưa nhận ra loại dự án: vẫn chạy SAST chung và báo loại = chưa rõ', async () => {
  const rep = await runChecks({ dir: project({ 'readme.txt': 'x' }), checkers: REAL.checkers, which: whichAll, exec: execGood })
  assert.deepEqual(rep.stacks, [])
  assert.deepEqual(rep.results.map((r) => r.id), ['sast-ast-grep'])
  assert.match(formatReport(rep), /chưa nhận ra|chưa rõ/i)
})

// --- luật SAST (ast-grep) -------------------------------------------------------------------------------------------------------------------

const RULES_DIR = path.join(KIT_DIR, 'rules')
const SAST_DIR = path.join(RULES_DIR, 'sast')
const FIXTURES_DIR = path.join(RULES_DIR, 'fixtures')
// id luật → đuôi file fixture
const RULES = {
  'ai-secret-in-public-env': 'tsx',
  'ai-service-role-in-client': 'tsx',
  'ai-eval-dynamic-code': 'tsx',
  'ai-innerhtml-dynamic': 'tsx',
  'ai-dangerously-set-html': 'tsx',
  'ai-sql-string-concat': 'tsx',
  'ai-ssrf-fetch-user-url': 'tsx',
  'ai-catch-swallow-error': 'tsx',
  'ai-cors-wildcard-credentials': 'tsx',
  'ai-wails-binding-exec-write': 'go',
}

// Kiểm cú pháp YAML "lite" (không có thư viện YAML; ast-grep mới là bộ phân tích thật): không tab, thụt lề chẵn, nháy đơn cân, ngoặc [] {} cân trên một dòng.
function yamlLiteProblems(text) {
  const out = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1
    if (/^\s*#/.test(raw) || !raw.trim()) return
    if (/^ *\t/.test(raw)) out.push(`dòng ${n}: tab trong thụt lề`)
    const indent = raw.length - raw.trimStart().length
    if (indent % 2) out.push(`dòng ${n}: thụt lề lẻ`)
    const noEsc = raw.replace(/''/g, '')
    const dq = (noEsc.match(/'/g) ?? []).length
    if (dq % 2) out.push(`dòng ${n}: nháy đơn không cân`)
    if (!/^\s*(?:-\s+)?[\w$.-]+:/.test(raw) && !/^\s*-\s/.test(raw) && !/^\s+\S/.test(raw)) out.push(`dòng ${n}: không giống mapping/sequence/giá trị nối tiếp`)
    const flat = raw.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    for (const [o, c] of [['[', ']'], ['{', '}']]) {
      if (flat.split(o).length !== flat.split(c).length) out.push(`dòng ${n}: ngoặc ${o}${c} không cân`)
    }
  })
  return out
}

test('luật SAST: đủ 10 luật, mỗi luật một file .yml đúng khuôn (id = tên file, severity error, lời dặn tiếng Việt, bỏ node_modules/dist/fixtures)', () => {
  assert.deepEqual(fs.readdirSync(SAST_DIR).filter((f) => f.endsWith('.yml')).sort(), Object.keys(RULES).map((id) => `${id}.yml`).sort())
  for (const id of Object.keys(RULES)) {
    const text = fs.readFileSync(path.join(SAST_DIR, `${id}.yml`), 'utf8')
    assert.match(text, new RegExp(`^id: ${id}\\s*$`, 'm'), `${id}: id`)
    assert.match(text, /^language: (?:Tsx|Go)\s*$/m, `${id}: language`)
    assert.match(text, /^severity: error\s*$/m, `${id}: severity`)
    assert.match(text, /^message:/m, `${id}: message`)
    assert.match(text, /^note:/m, `${id}: note (lời dặn sửa)`)
    assert.match(text, /^rule:\s*$/m, `${id}: rule`)
    assert.match(text, /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i, `${id}: lời dặn tiếng Việt`)
    assert.match(text, /^ignores:/m, `${id}: ignores`)
    assert.match(text, /node_modules/, `${id}: ignores node_modules`)
    assert.match(text, /fixtures/, `${id}: ignores kit/rules/fixtures (không tự bắt fixture đỏ khi quét chính kit)`)
    assert.deepEqual(yamlLiteProblems(text), [], `${id}.yml`)
  }
})

test('luật SAST: sgconfig.yml trỏ tới thư mục luật; ánh xạ .ts/.js sang parser tsx', () => {
  const text = fs.readFileSync(path.join(RULES_DIR, 'sgconfig.yml'), 'utf8')
  assert.match(text, /^ruleDirs:\s*\n\s*- sast\s*$/m)
  assert.match(text, /languageGlobs:/)
  assert.match(text, /tsx:/)
  assert.deepEqual(yamlLiteProblems(text), [])
})

test('luật SAST: mỗi luật có đúng một fixture ĐỎ (bad) và một fixture XANH (good), khác nhau, không rỗng', () => {
  for (const [id, ext] of Object.entries(RULES)) {
    const bad = path.join(FIXTURES_DIR, id, `bad.${ext}`)
    const good = path.join(FIXTURES_DIR, id, `good.${ext}`)
    assert.ok(fs.existsSync(bad), `${id}: thiếu bad.${ext}`)
    assert.ok(fs.existsSync(good), `${id}: thiếu good.${ext}`)
    const b = fs.readFileSync(bad, 'utf8')
    const g = fs.readFileSync(good, 'utf8')
    assert.ok(b.trim().length > 20 && g.trim().length > 20, `${id}: fixture rỗng`)
    assert.notEqual(b, g)
    assert.deepEqual(fs.readdirSync(path.join(FIXTURES_DIR, id)).sort(), [`bad.${ext}`, `good.${ext}`])
    for (const t of [b, g]) assert.ok(!/(?:sk|rk)_live_|BEGIN [A-Z ]*PRIVATE KEY/.test(t), `${id}: fixture không được chứa khoá thật`)
  }
})

// Tìm ast-grep THẬT trên máy (bằng đúng findTool của flow-check); không có ⇒ bỏ qua phần chạy thật.
function findAstGrep() {
  for (const name of ['ast-grep', 'sg']) {
    const f = findTool(name, { cwd: HERE, env: process.env })
    if (!f) continue
    const v = spawnSync(f, ['--version'], { encoding: 'utf8', shell: IS_WIN && /\.(cmd|bat)$/i.test(f) })
    if (/ast-grep/i.test(`${v.stdout}${v.stderr}`)) return f
  }
  return null
}
const AST_GREP = findAstGrep()

test('luật SAST chạy THẬT bằng ast-grep: fixture bad bị luật bắt, fixture good không bị luật đó bắt', { skip: AST_GREP ? false : 'máy không có ast-grep/sg — chỉ kiểm cú pháp + fixture (test trên)' }, () => {
  const sgconfig = path.join(RULES_DIR, 'sgconfig.yml').replace(/\\/g, '/')
  for (const [id, ext] of Object.entries(RULES)) {
    // Chép fixture ra thư mục tạm: luật có `ignores` kit/rules/fixtures nên không thể quét tại chỗ.
    const work = project({}, 'sast ')
    fs.copyFileSync(path.join(FIXTURES_DIR, id, `bad.${ext}`), path.join(work, `bad.${ext}`))
    fs.copyFileSync(path.join(FIXTURES_DIR, id, `good.${ext}`), path.join(work, `good.${ext}`))
    const r = spawnSync(AST_GREP, ['scan', '--config', sgconfig, '--json', '.'], { cwd: work, encoding: 'utf8', shell: IS_WIN && /\.(cmd|bat)$/i.test(AST_GREP) })
    assert.ok(r.status === 0 || r.status === 1, `${id}: ast-grep lỗi (${r.status}): ${r.stderr}`)
    let hits
    try { hits = JSON.parse(r.stdout || '[]') } catch { hits = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }
    const mine = hits.filter((h) => h.ruleId === id)
    assert.ok(mine.some((h) => path.basename(h.file) === `bad.${ext}`), `${id}: fixture bad KHÔNG bị bắt`)
    assert.ok(!mine.some((h) => path.basename(h.file) === `good.${ext}`), `${id}: fixture good bị bắt nhầm`)
  }
})

// --- đợt 2 (làn B): máy kiểm kiến trúc / API / migration --------------------------------------------------------------------------------------

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (dir, rel, text) => {
  const f = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
const commit = (dir, msg = 'c') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD') }
function repo(files, branch = 'main') {
  const d = project(files)
  git(d, 'init', '-q', '-b', branch)
  commit(d, 'goc')
  return d
}
const only = (...ids) => REAL.checkers.filter((c) => ids.includes(c.id))
const check = (dir, ids, deps = {}) => runChecks({ dir, checkers: only(...ids), which: whichAll, exec: async () => OK, ...deps })
const first = async (dir, id, deps) => (await check(dir, [id], deps)).results[0]

const WEB_ARCH = {
  version: 1,
  parts: [{
    name: 'web', stack: 'web', root: 'src',
    modules: [{ name: 'features/a', path: 'src/features/a', desc: 'A', mayDependOn: ['shared'] }, { name: 'shared', path: 'src/shared', desc: 'chung', mayDependOn: [] }],
    shared: ['src/shared'], limits: { fileLines: 10 }, forbidden: [],
  }],
}
const CODEMAP = '# Kiến trúc\n\n## Codemap\n\n- `src/features/a` — a; KHÔNG làm gì\n- `src/shared` — chung\n'
const webProject = (extra = {}) => ({ 'package.json': '{}', 'docs/arch.json': WEB_ARCH, 'docs/ARCHITECTURE.md': CODEMAP, 'src/features/a/index.ts': 'export const a = 1\n', 'src/shared/util.ts': 'export const u = 1\n', ...extra })
const goArch = (...names) => ({
  version: 1,
  parts: names.map((n, i) => ({ name: n, stack: 'go', root: i ? n : 'internal', modules: [{ name: 'user', path: `${i ? n : 'internal'}/user`, desc: 'u', mayDependOn: [] }], shared: [], limits: {}, forbidden: [] })),
})
const BIG = `${Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n')}\n`
const BASELINE = (o = {}) => ({ base: 'abc1234', size: {}, depcruise: null, go: null, eslint: false, ...o })

test('validateCheckers: plan chỉ đi với cmd và phải là chuỗi; quietSkip phải là true/false', () => {
  const bad = (o, re) => assert.match(validateCheckers({ checkers: [mk(o)] }).join('\n'), re)
  assert.deepEqual(validateCheckers({ checkers: [mk({ plan: 'depcruise', quietSkip: true })] }), [])
  bad({ plan: 5 }, /plan/)
  bad({ plan: '' }, /plan/)
  bad({ cmd: undefined, install: undefined, internal: 'secret-scan-build', plan: 'depcruise' }, /plan/)
  bad({ quietSkip: 'yes' }, /quietSkip/)
})

test('checkers.json thật: có arch-sync, arch-size, depcruise, go-arch-lint, oasdiff, squawk — bắt buộc, chỉ hiện khi có dấu hiệu, lệnh cài chính thức; golangci-lint có plan baseline', () => {
  const get = (id) => REAL.checkers.find((c) => c.id === id)
  for (const id of ['arch-sync', 'arch-size', 'depcruise', 'go-arch-lint', 'oasdiff', 'squawk']) {
    const c = get(id)
    assert.ok(c, `thiếu checker ${id}`)
    assert.equal(c.required, true, `${id} required`)
    assert.equal(c.quietSkip, true, `${id}: không áp dụng thì không hiện dòng nào`)
  }
  assert.equal(get('arch-sync').internal, 'arch-sync')
  assert.equal(get('arch-size').internal, 'arch-size')
  assert.deepEqual(get('arch-sync').detect, { files: ['docs/arch.json'] })
  assert.equal(get('depcruise').cmd, 'depcruise')
  assert.equal(get('depcruise').install, 'npm i -D dependency-cruiser@^18 typescript@^6') // khớp DEPCRUISE_PKGS của lib/arch.mjs
  assert.equal(get('go-arch-lint').cmd, 'go-arch-lint')
  assert.equal(get('go-arch-lint').install, 'go install github.com/fe3dback/go-arch-lint@latest')
  assert.equal(get('oasdiff').cmd, 'oasdiff')
  assert.match(JSON.stringify(get('oasdiff').install), /oasdiff/)
  assert.deepEqual(get('oasdiff').detect.files, OPENAPI_FILES, 'detect của checker và danh sách file openapi trong code phải trùng nhau')
  assert.equal(get('squawk').cmd, 'squawk')
  assert.equal(get('squawk').install, 'npm i -g squawk-cli')
  for (const id of ['depcruise', 'go-arch-lint', 'oasdiff', 'squawk', 'golangci-lint']) assert.equal(typeof PLANNERS[get(id).plan], 'function', `${id}: plan ${get(id).plan} không có hàm`)
  for (const n of ['arch-sync', 'arch-size']) assert.equal(typeof INTERNALS[n], 'function', n)
  assert.deepEqual(get('golangci-lint').args, ['run', './...'], 'lệnh cũ giữ nguyên')
})

test('dự án không có docs/arch.json, openapi, migration: các checker mới không hiện dòng nào (bảng cũ không đổi)', async () => {
  const dir = project({ 'package.json': '{}', 'src/a.ts': 'x', 'go.mod': 'module x\n' })
  const rep = await runChecks({ dir, checkers: REAL.checkers, which: whichAll, exec: execGood })
  const ids = rep.results.map((r) => r.id)
  for (const id of ['arch-sync', 'arch-size', 'depcruise', 'go-arch-lint', 'oasdiff', 'squawk']) assert.ok(!ids.includes(id), id)
})

// --- base: nhánh chính + file đổi --------------------------------------------------------------------------------------------------------------

test('resolveBase: main rồi master; --base tự chọn; ref lạ / có dấu gạch đầu / không phải repo ⇒ null; fork = điểm tách khỏi nhánh chính', () => {
  const d = repo({ 'a.txt': '1' })
  const tip0 = git(d, 'rev-parse', 'HEAD')
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'b.txt', '2'); commit(d)
  git(d, 'checkout', '-q', 'main')
  put(d, 'c.txt', '3'); const tip1 = commit(d)
  git(d, 'checkout', '-q', 'feat')
  const b = resolveBase(d)
  assert.deepEqual({ ref: b.ref, sha: b.sha, fork: b.fork }, { ref: 'main', sha: tip1, fork: tip0 })
  assert.equal(resolveBase(d, { ref: 'feat' }).ref, 'feat')
  assert.equal(resolveBase(d, { ref: 'khong-co-nhanh-nay' }), null)
  assert.equal(resolveBase(d, { ref: '--upload-pack=x' }), null)
  assert.equal(resolveBase(project({ 'a.txt': '1' })), null, 'không phải repo git')
  const m = repo({ 'a.txt': '1' }, 'master')
  assert.equal(resolveBase(m).ref, 'master')
  const t = repo({ 'a.txt': '1' }, 'trunk')
  assert.equal(resolveBase(t), null, 'không có main/master')
  assert.equal(resolveBase(t, { ref: 'trunk' }).ref, 'trunk')
})

// Repo mà `main` KHÔNG chung lịch sử với nhánh làm việc (feat), còn `master` là cha của feat. → { dir, masterTip }
function repoMainUnrelated(files) {
  const d = repo(files, 'master')
  const masterTip = git(d, 'rev-parse', 'HEAD')
  git(d, 'checkout', '-q', '--orphan', 'main')
  git(d, 'rm', '-r', '-f', '-q', '.')
  put(d, 'khac-goc.txt', 'lịch sử riêng'); commit(d, 'main mồ côi')
  git(d, 'checkout', '-q', '-b', 'feat', 'master')
  return { dir: d, masterTip }
}

test('resolveBase: main KHÔNG chung lịch sử với HEAD còn master là cha ⇒ thử tiếp và chọn master (không dừng ở main rồi coi như không có nhánh chính); --base chỉ định mà không chung lịch sử ⇒ null', () => {
  const { dir, masterTip } = repoMainUnrelated({ 'a.txt': '1' })
  put(dir, 'b.txt', '2'); commit(dir)
  const b = resolveBase(dir)
  assert.deepEqual({ ref: b?.ref, fork: b?.fork }, { ref: 'master', fork: masterTip })
  assert.equal(resolveBase(dir, { ref: 'main' }), null, 'tự chỉ định nhánh mà không có điểm chung ⇒ không đoán sang nhánh khác')
})

test('resolveBase: main và master đều không chung lịch sử ⇒ thử tới origin/main, origin/master; không nhánh nào chung ⇒ null', () => {
  const sha = (c) => c.repeat(40)
  const fakeGit = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
    if (args[0] === 'rev-parse') { const name = args[3].replace('^{commit}', ''); return { code: 0, stdout: `${sha(name === 'origin/main' ? 'c' : name === 'main' ? 'a' : 'b')}\n`, stderr: '' } }
    if (args[0] === 'merge-base') return args[1] === sha('c') ? { code: 0, stdout: `${sha('d')}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  assert.deepEqual(resolveBase('.', { git: fakeGit }), { ref: 'origin/main', sha: sha('c'), fork: sha('d') })
  assert.equal(resolveBase('.', { git: (args) => (args[0] === 'merge-base' ? { code: 1, stdout: '', stderr: '' } : fakeGit(args)) }), null)
})

test('changedFiles: gồm đã commit, đã stage, sửa chưa stage, file mới chưa theo dõi; bỏ file đã xoá; dự án nằm trong thư mục con của repo ⇒ đường dẫn tính từ thư mục con', () => {
  const d = repo({ 'sub/keep.txt': '1', 'sub/edit.txt': '1', 'sub/gone.txt': '1', 'out.txt': '1' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'sub/committed.txt', 'x'); commit(d)
  put(d, 'sub/staged.txt', 'x'); git(d, 'add', 'sub/staged.txt')
  put(d, 'sub/edit.txt', '2')
  put(d, 'sub/untracked.txt', 'x')
  put(d, 'out.txt', '2')
  fs.unlinkSync(path.join(d, 'sub', 'gone.txt'))
  const sub = path.join(d, 'sub')
  const base = resolveBase(sub)
  assert.deepEqual(changedFiles(sub, base).sort(), ['committed.txt', 'edit.txt', 'staged.txt', 'untracked.txt'])
  assert.ok(changedFiles(d, resolveBase(d)).includes('out.txt'))
  assert.equal(changedFiles(project({ 'a.txt': '1' }), null), null)
})

// --- arch-sync / arch-size (internal) ----------------------------------------------------------------------------------------------------------

test('arch-sync: khớp ⇒ đạt; thư mục có code mà arch.json chưa biết ⇒ không đạt kèm lời dặn; arch.json hỏng ⇒ KHÔNG ĐẠT kèm lời dặn (không bỏ qua); chưa có arch.json ⇒ không hiện', async () => {
  const ok = await first(project(webProject()), 'arch-sync')
  assert.equal(ok.status, 'pass', JSON.stringify(ok))
  const drift = await first(project(webProject({ 'src/billing/pay.ts': 'export const p = 1\n' })), 'arch-sync')
  assert.equal(drift.status, 'fail')
  assert.ok(drift.detail.some((l) => l.includes('src/billing')), drift.detail.join('|'))
  assert.match(drift.fix, /modules/)
  assert.match(drift.fix, /Codemap/)
  for (const content of ['{ không phải json', { version: 1, parts: [{ name: 'web', stack: 'web', root: 'src', forbidden: [{ from: 'a', to: 'b' }] }] }]) {
    const broken = await first(project(webProject({ 'docs/arch.json': content })), 'arch-sync')
    assert.equal(broken.status, 'fail', 'arch.json hỏng không được lặng lẽ bỏ qua')
    assert.match(broken.message, /arch\.json/)
    assert.match(broken.fix, /docs\/arch\.json/)
    assert.ok(broken.detail.length > 0)
  }
  assert.deepEqual((await check(project({ 'package.json': '{}' }), ['arch-sync'])).results, [])
})

test('arch-size: file vượt trần ⇒ không đạt kèm "tách file, đừng nâng trần, hỏi người dùng"; baseline ghi file cũ ⇒ chỉ đỏ khi dài thêm; arch.json hỏng ⇒ không đạt', async () => {
  assert.equal((await first(project(webProject()), 'arch-size')).status, 'pass')
  const dir = project(webProject({ 'src/features/a/big.ts': BIG }))
  const bad = await first(dir, 'arch-size')
  assert.equal(bad.status, 'fail')
  assert.ok(bad.detail.some((l) => l.includes('src/features/a/big.ts')))
  assert.match(bad.fix, /tách/i)
  assert.match(bad.fix, /hỏi người dùng/)
  const old = project(webProject({ 'src/features/a/big.ts': BIG, 'docs/arch-baseline.json': BASELINE({ size: { 'src/features/a/big.ts': 30 } }) }))
  assert.equal((await first(old, 'arch-size')).status, 'pass', 'file dài từ lúc chốt mốc không bị tính')
  put(old, 'src/features/a/big.ts', `${BIG}export const more = 1\n`)
  assert.equal((await first(old, 'arch-size')).status, 'fail', 'dài thêm ⇒ đỏ')
  const broken = await first(project(webProject({ 'docs/arch.json': '{ hỏng' })), 'arch-size')
  assert.equal(broken.status, 'fail')
  assert.match(broken.fix, /docs\/arch\.json/)
})

test('arch-size có baseline + git: chỉ xét file đổi so với nhánh chính (chưa commit cũng tính); không baseline hoặc không có git ⇒ xét toàn bộ', async () => {
  const d = repo(webProject({ 'src/features/a/big.ts': BIG, 'docs/arch-baseline.json': BASELINE() }))
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'src/shared/util.ts', 'export const u = 2\n'); commit(d)
  const r1 = await first(d, 'arch-size')
  assert.equal(r1.status, 'pass', `file dài sẵn nhưng không đổi: ${JSON.stringify(r1)}`)
  put(d, 'src/features/a/big.ts', `${BIG}export const more = 1\n`)
  const r2 = await first(d, 'arch-size')
  assert.equal(r2.status, 'fail')
  assert.ok(r2.detail.some((l) => l.includes('big.ts')))

  const noBaseline = repo(webProject({ 'src/features/a/big.ts': BIG }))
  git(noBaseline, 'checkout', '-q', '-b', 'feat')
  put(noBaseline, 'src/shared/util.ts', 'export const u = 2\n'); commit(noBaseline)
  assert.equal((await first(noBaseline, 'arch-size')).status, 'fail', 'không baseline ⇒ xét cả file không đổi')

  const noGit = project(webProject({ 'src/features/a/big.ts': BIG, 'docs/arch-baseline.json': BASELINE() }))
  assert.equal((await first(noGit, 'arch-size')).status, 'fail', 'không xác định được file đổi ⇒ xét toàn bộ (không bỏ sót)')
})

// --- depcruise ---------------------------------------------------------------------------------------------------------------------------------

test('depcruise: chạy ở gốc dự án với đúng đối số của arch.mjs + err-long; có baseline ⇒ thêm --ignore-known; chưa gen cấu hình ⇒ không đạt kèm lệnh gen', async () => {
  const dir = project(webProject({ '.dependency-cruiser.cjs': 'module.exports = {}\n' }))
  const calls = []
  const exec = async (file, args, o) => { calls.push({ args, cwd: o.cwd }); return OK }
  const r = await first(dir, 'depcruise', { exec })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(calls[0].args, ['--config', '.dependency-cruiser.cjs', '--output-type', 'err-long', '--', 'src'], 'option trước, `--`, rồi mới tới thư mục quét')
  assert.equal(path.resolve(calls[0].cwd), path.resolve(dir))

  const withBase = project(webProject({ '.dependency-cruiser.cjs': 'x', '.dependency-cruiser-known-violations.json': '[]', 'docs/arch-baseline.json': BASELINE({ depcruise: '.dependency-cruiser-known-violations.json' }) }))
  calls.length = 0
  assert.equal((await first(withBase, 'depcruise', { exec })).status, 'pass')
  assert.match(calls[0].args.join(' '), /--ignore-known \.dependency-cruiser-known-violations\.json/)
  assert.equal(calls[0].args.filter((a) => a === '--output-type').length, 1)
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--')), ['--', 'src'], 'sau `--` chỉ còn thư mục quét')

  calls.length = 0
  const fail = await first(dir, 'depcruise', { exec: async () => ({ ...OK, code: 1, stdout: 'error arch-web-features-a: src/features/a/x.ts → src/features/b/y.ts\n' }) })
  assert.equal(fail.status, 'fail')
  assert.ok(fail.detail.some((l) => l.includes('src/features/b/y.ts')))
  assert.match(fail.fix, /hỏi người dùng/)

  const noCfg = project(webProject())
  const miss = await first(noCfg, 'depcruise', { exec })
  assert.equal(calls.length, 0, 'chưa có cấu hình thì không chạy')
  assert.equal(miss.status, 'fail')
  assert.match(miss.fix, /arch\.mjs gen/)

  const noTool = await first(dir, 'depcruise', { which: whichNone })
  assert.equal(noTool.status, 'missing')
  assert.match(noTool.fix, /npm i -D dependency-cruiser/)
  assert.equal(noTool.required, true)
})

test('depcruise: root trong arch.json là dữ liệu không tin cậy — giống option (--exclude, -x), thoát ra ngoài (../x), tuyệt đối (C:/x) ⇒ KHÔNG ĐẠT kèm lời dặn, công cụ KHÔNG được chạy', async () => {
  for (const root of ['--exclude', '-x', '../x', 'C:/x', '/etc']) {
    const dir = project(webProject({ 'docs/arch.json': { ...WEB_ARCH, parts: [{ ...WEB_ARCH.parts[0], root }] }, '.dependency-cruiser.cjs': 'x' }))
    const calls = []
    const r = await first(dir, 'depcruise', { exec: async (file, args) => { calls.push(args); return OK } })
    assert.equal(r.status, 'fail', `${root}: ${JSON.stringify(r)}`)
    assert.ok(r.detail.some((l) => l.includes('"root"')), `${root}: ${r.detail.join('|')}`)
    assert.match(r.fix, /docs\/arch\.json/)
    assert.equal(calls.length, 0, `${root}: công cụ không được chạy`)
  }
})

test('depcruise: arch.json hợp lệ nhưng root có dấu cách / tiếng Việt vẫn chạy bình thường (chỉ chặn dạng nguy hiểm, không chặn tên thư mục lạ)', async () => {
  const root = 'mã nguồn/giao diện'
  const arch = { ...WEB_ARCH, parts: [{ ...WEB_ARCH.parts[0], root, modules: [{ name: 'shared', path: `${root}/shared`, desc: 's', mayDependOn: [] }], shared: [`${root}/shared`] }] }
  const dir = project(webProject({ 'docs/arch.json': arch, '.dependency-cruiser.cjs': 'x' }))
  let seen
  const r = await first(dir, 'depcruise', { exec: async (file, args) => { seen = args; return OK } })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(seen.slice(seen.indexOf('--')), ['--', root])
})

test('depcruise: arch.json chỉ có phần Go ⇒ không hiện; arch.json hỏng ⇒ không đạt; Wails: công cụ cài ở frontend/node_modules vẫn tìm ra, lệnh vẫn chạy ở gốc dự án', async () => {
  assert.deepEqual((await check(project({ 'go.mod': 'module x\n', 'docs/arch.json': goArch('go') }), ['depcruise'])).results, [])
  assert.equal((await first(project(webProject({ 'docs/arch.json': '{ hỏng', '.dependency-cruiser.cjs': 'x' })), 'depcruise')).status, 'fail')
  const wailsArch = { version: 1, parts: [{ name: 'web', stack: 'web', root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', desc: 's', mayDependOn: [] }], shared: ['frontend/src/shared'], limits: {}, forbidden: [] }, ...goArch('go').parts] }
  const dir = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'docs/arch.json': wailsArch, '.dependency-cruiser.cjs': 'x' })
  const cwds = []
  const which = (n, o) => (path.basename(o.cwd) === 'frontend' ? '/f/depcruise' : null)
  const exec = async (file, args, o) => { cwds.push(path.resolve(o.cwd)); return OK }
  const r = await first(dir, 'depcruise', { which, exec })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(cwds, [path.resolve(dir)])
})

const wailsDc = () => {
  const arch = { version: 1, parts: [{ name: 'web', stack: 'web', root: 'frontend/src', modules: [{ name: 'shared', path: 'frontend/src/shared', desc: 's', mayDependOn: [] }], shared: ['frontend/src/shared'], limits: {}, forbidden: [] }, ...goArch('go').parts] }
  return project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'frontend/src/shared/u.ts': 'export const u = 1\n', 'docs/arch.json': arch, '.dependency-cruiser.cjs': 'x' })
}

test('depcruise: bản cài trong thư mục của phần web (frontend/node_modules/.bin) thắng bản global ở PATH — tìm theo thứ tự thư mục phần → gốc dự án → PATH', async () => {
  const dir = wailsDc()
  let used
  const which = (n, o) => (path.basename(o.cwd) === 'frontend' ? '/du-an/frontend/node_modules/.bin/depcruise' : '/global/bin/depcruise')
  const r = await first(dir, 'depcruise', { which, exec: async (file) => { used = file; return OK } })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.equal(used, '/du-an/frontend/node_modules/.bin/depcruise')
  const onlyGlobal = []
  await first(dir, 'depcruise', { which: () => '/global/bin/depcruise', exec: async (file) => { onlyGlobal.push(file); return OK } })
  assert.deepEqual(onlyGlobal, ['/global/bin/depcruise'], 'phần không cài riêng ⇒ vẫn dùng bản có sẵn')
})

test('depcruise: tìm công cụ THẬT trên đĩa — frontend/node_modules/.bin/depcruise thắng bản trong PATH, bản của gốc dự án thắng PATH', async () => {
  const ext = IS_WIN ? '.cmd' : ''
  const globalDir = project({ [`depcruise${ext}`]: 'x' }, 'flow check global ')
  const dir = wailsDc()
  put(dir, `frontend/node_modules/.bin/depcruise${ext}`, 'x')
  if (!IS_WIN) for (const f of [path.join(globalDir, 'depcruise'), path.join(dir, 'frontend', 'node_modules', '.bin', 'depcruise')]) fs.chmodSync(f, 0o755)
  const env = { PATH: globalDir, PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', NO_COLOR: '1' }
  const seen = []
  const exec = async (file) => { seen.push(path.resolve(file)); return OK }
  const r = (await runChecks({ dir, checkers: only('depcruise'), env, exec })).results[0]
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(seen, [path.join(dir, 'frontend', 'node_modules', '.bin', `depcruise${ext}`)])
  fs.unlinkSync(path.join(dir, 'frontend', 'node_modules', '.bin', `depcruise${ext}`))
  put(dir, `node_modules/.bin/depcruise${ext}`, 'x')
  if (!IS_WIN) fs.chmodSync(path.join(dir, 'node_modules', '.bin', 'depcruise'), 0o755)
  seen.length = 0
  await runChecks({ dir, checkers: only('depcruise'), env, exec })
  assert.deepEqual(seen, [path.join(dir, 'node_modules', '.bin', `depcruise${ext}`)], 'bản ở gốc dự án thắng PATH')
})

test('depcruise: chưa cài ở đâu cả ⇒ THIẾU, lệnh cài ghim typescript bản depcruise đọc được và nói cài ở thư mục có package.json của phần web', async () => {
  const r = await first(wailsDc(), 'depcruise', { which: whichNone })
  assert.equal(r.status, 'missing')
  assert.match(r.fix, /npm i -D dependency-cruiser@\^18 typescript@\^6/)
  assert.match(r.fix, /package\.json/)
})

const ENGINE_MSG ='ERROR: Your node version (25.2.1) is not supported. dependency-cruiser\n       follows the node.js release cycle and runs on these node versions:\n       ^22||^24||>=26\n       See https://nodejs.org/en/about/releases/ for details.\n'

test('depcruise: Node của máy ngoài "engines" của dependency-cruiser ⇒ THIẾU (không phải KHÔNG ĐẠT) kèm lời đời thường; lỗi khác vẫn KHÔNG ĐẠT', async () => {
  const dir = project(webProject({ '.dependency-cruiser.cjs': 'x' }))
  for (const where of ['stdout', 'stderr']) {
    const r = await first(dir, 'depcruise', { exec: async () => ({ ...OK, code: 1, [where]: ENGINE_MSG }) })
    assert.equal(r.status, 'missing', `${where}: ${JSON.stringify(r)}`)
    assert.equal(r.message, 'Máy kiểm kiến trúc web cần Node 22, Node 24 LTS hoặc Node 26 trở lên; máy đang dùng Node 25.2.1.')
    assert.match(r.fix, /Node 22/)
    assert.match(r.fix, /Node 24/)
    assert.equal(r.required, true, 'vẫn là THIẾU bắt buộc: chặn cho tới khi có Node phù hợp')
  }
  const other = await first(dir, 'depcruise', { exec: async () => ({ ...OK, code: 1, stderr: 'Error: Cannot find module "typescript"\n' }) })
  assert.equal(other.status, 'fail', 'lỗi khác không bị nhầm thành THIẾU')
  assert.equal((await first(dir, 'depcruise', { exec: async () => ({ ...OK, code: 0, stdout: 'ghi chú: Your node version (25.2.1) is not supported (chỉ là chữ)\n' }) })).status, 'pass', 'thoát 0 là đạt, không soi chữ')
})

const DC_NOTHING = '✔ no dependency violations found (0 modules, 0 dependencies cruised)\n'
const DC_NO_TS = '  ‼ missing-typescript-transpiler: TypeScript chưa cài\n'

test('depcruise: dự án có file .ts/.tsx mà depcruise cruise 0 module (hoặc báo thiếu typescript — depcruise cài global không thấy TypeScript của dự án) ⇒ THIẾU kèm lệnh cài trong dự án, KHÔNG tính ĐẠT', async () => {
  const dir = project(webProject({ '.dependency-cruiser.cjs': 'x' }))
  for (const stdout of [DC_NOTHING, `${DC_NO_TS}${DC_NOTHING}`, `✔ no dependency violations found (5 modules, 3 dependencies cruised)\n${DC_NO_TS}`]) {
    const r = await first(dir, 'depcruise', { exec: async () => ({ ...OK, stdout }) })
    assert.equal(r.status, 'missing', `${JSON.stringify(stdout)} → ${JSON.stringify(r)}`)
    assert.equal(r.required, true)
    assert.match(r.message, /TypeScript|typescript/)
    assert.match(r.fix, /pnpm add -D dependency-cruiser@\^18 typescript@\^6/, 'ghim typescript bản depcruise đọc được (typescript 7 trở lên thì depcruise không đọc được)')
    assert.match(r.fix, /npm i -D dependency-cruiser@\^18 typescript@\^6/)
    assert.match(r.fix, /package\.json/, 'cài ở thư mục của phần web (vd frontend/), không phải thư mục nào cũng được')
  }
  const ok = await first(dir, 'depcruise', { exec: async () => ({ ...OK, stdout: '✔ no dependency violations found (12 modules, 31 dependencies cruised)\n' }) })
  assert.equal(ok.status, 'pass', 'có module được cruise ⇒ đạt như thường')
  const jsOnly = project({ 'package.json': '{}', 'docs/arch.json': WEB_ARCH, 'docs/ARCHITECTURE.md': CODEMAP, 'src/features/a/index.js': 'export const a = 1\n', 'src/shared/util.js': 'export const u = 1\n', '.dependency-cruiser.cjs': 'x' })
  const js = await first(jsOnly, 'depcruise', { exec: async () => ({ ...OK, stdout: DC_NOTHING }) })
  assert.equal(js.status, 'pass', 'dự án thuần JS: 0 module không do thiếu TypeScript ⇒ không bắt')
})

test('arch.json hỏng ⇒ báo MỘT lần ở checker arch đầu tiên; arch-size, depcruise, go-arch-lint BỎ QUA kèm lý do (không lặp khối lỗi 4 lần); chỉ chạy một checker arch riêng lẻ thì nó vẫn tự báo', async () => {
  const dir = project(webProject({ 'docs/arch.json': { version: 1, parts: [{ name: 'web', stack: 'web', root: '--exclude' }] }, '.dependency-cruiser.cjs': 'x' }))
  const rep = await check(dir, ['arch-sync', 'arch-size', 'depcruise', 'go-arch-lint'])
  const by = Object.fromEntries(rep.results.map((r) => [r.id, r]))
  assert.equal(by['arch-sync'].status, 'fail')
  assert.ok(by['arch-sync'].detail.some((l) => l.includes('"root"')))
  for (const id of ['arch-size', 'depcruise', 'go-arch-lint']) {
    assert.equal(by[id].status, 'skip', `${id}: ${JSON.stringify(by[id])}`)
    assert.match(by[id].message, /docs\/arch\.json/)
    assert.match(by[id].message, /arch-sync/, 'nói rõ lỗi đã báo ở dòng nào')
    assert.deepEqual(by[id].detail, [])
  }
  assert.equal(rep.ok, false, 'vẫn KHÔNG ĐẠT tổng thể')
  assert.equal((await first(dir, 'depcruise')).status, 'fail')
  assert.equal((await first(dir, 'arch-size')).status, 'fail')
})

// Môi trường chạy depcruise THẬT: Node của máy đủ mới thì dùng luôn; không thì thử Node trong FLOW_DEPCRUISE_NODE_DIR hoặc bộ chạy sẵn có của Codex (đặt lên đầu PATH); không có ⇒ null.
const DC_ENV = (() => {
  if (!findTool('depcruise', { cwd: HERE, env: process.env })) return null
  const works = (env) => { const v = spawnSync('depcruise', ['--version'], { env, encoding: 'utf8', shell: IS_WIN, windowsHide: true }); return v.status === 0 && !/is not supported/i.test(`${v.stdout}${v.stderr}`) }
  if (works(process.env)) return process.env
  const exe = IS_WIN ? 'node.exe' : 'node'
  for (const d of [process.env.FLOW_DEPCRUISE_NODE_DIR, path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin')].filter(Boolean)) {
    if (!fs.existsSync(path.join(d, exe))) continue
    const env = { ...process.env }
    const k = Object.keys(env).find((x) => x.toLowerCase() === 'path') ?? 'PATH'
    env[k] = `${d}${path.delimiter}${env[k] ?? ''}`
    if (works(env)) return env
  }
  return null
})()

test('depcruise THẬT + TypeScript: dự án có .ts mà depcruise không thấy TypeScript của dự án (cài global) ⇒ THIẾU kèm lệnh cài trong dự án, KHÔNG ĐẠT giả "0 modules"; thấy TypeScript ⇒ đạt', { skip: DC_ENV ? false : 'không có depcruise chạy được (cần Node 22/24/26+; đặt FLOW_DEPCRUISE_NODE_DIR) — bỏ qua test thật' }, async () => {
  const dir = project({ 'package.json': '{}', 'docs/arch.json': WEB_ARCH, 'docs/ARCHITECTURE.md': CODEMAP, 'src/features/a/index.ts': 'export const a: number = 1\n', 'src/shared/util.ts': 'export const u: number = 1\n' })
  gen(dir)
  const r = (await runChecks({ dir, checkers: only('depcruise'), env: { ...DC_ENV, NO_COLOR: '1' } })).results[0]
  assert.ok(['missing', 'pass'].includes(r.status), JSON.stringify(r))
  if (r.status === 'missing') {
    assert.match(r.message, /TypeScript/)
    assert.match(r.fix, /pnpm add -D dependency-cruiser@\^18 typescript@\^6/)
    assert.equal(r.required, true)
  }
})

// Cần một thư mục node_modules CÓ SẴN trên máy chứa dependency-cruiser 18 và typescript dưới 7 (kit không cài gì): đặt FLOW_DEPCRUISE_LOCAL_MODULES=<đường dẫn node_modules>.
// Test nối nó thành frontend/node_modules (junction) của một dự án Wails — đúng tình huống "depcruise cài riêng trong frontend/" — trong khi bản global vẫn nằm trên PATH.
const LOCAL_MODULES = process.env.FLOW_DEPCRUISE_LOCAL_MODULES
const LOCAL_SKIP = DC_ENV && LOCAL_MODULES && fs.existsSync(path.join(LOCAL_MODULES, 'dependency-cruiser')) && fs.existsSync(path.join(LOCAL_MODULES, 'typescript'))
  ? false
  : 'cần FLOW_DEPCRUISE_LOCAL_MODULES=<node_modules có dependency-cruiser 18 + typescript dưới 7> và depcruise chạy được — bỏ qua test thật'

test('Wails THẬT: frontend/ có tsconfig.json và depcruise cài RIÊNG trong frontend/ (bản global vẫn trên PATH) ⇒ dùng bản của frontend, hết lỗi TS18003, sạch ⇒ đạt, feature b import a ⇒ bị bắt', { skip: LOCAL_SKIP }, async () => {
  const tsconfig = '{"compilerOptions":{"target":"es2022","module":"esnext","moduleResolution":"bundler","strict":true,"skipLibCheck":true,"noEmit":true},"include":["src"]}'
  const dir = project({
    'go.mod': 'module example.com/app\n\ngo 1.21\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'frontend/tsconfig.json': tsconfig,
    'frontend/src/features/a/index.ts': 'export const a: number = 1\n', 'frontend/src/features/b/index.ts': 'export const b: number = 2\n', 'frontend/src/shared/u.ts': 'export const s: number = 0\n',
    'internal/billing/domain/d.go': 'package domain\n',
  })
  const link = path.join(dir, 'frontend', 'node_modules')
  fs.symlinkSync(LOCAL_MODULES, link, 'junction')
  try {
    init(dir, { stack: 'wails' })
    gen(dir)
    const run = async () => (await runChecks({ dir, checkers: only('depcruise'), env: { ...DC_ENV, NO_COLOR: '1' } })).results[0]
    const ok = await run()
    assert.doesNotMatch(JSON.stringify(ok), /TS18003|No inputs were found/)
    assert.equal(ok.status, 'pass', JSON.stringify(ok))
    put(dir, 'frontend/src/features/b/index.ts', "import { a } from '../a'\nexport const b: number = a\n")
    const bad = await run()
    assert.equal(bad.status, 'fail', JSON.stringify(bad))
    assert.match(bad.detail.join('\n'), /arch-web-features-b/)
  } finally {
    fs.rmdirSync(link) // chỉ gỡ liên kết, không đụng thư mục đích
  }
})

test('depcruise THẬT trên máy này: chạy được ⇒ đạt; Node của máy không được hỗ trợ ⇒ THIẾU nêu đúng phiên bản Node, không bao giờ KHÔNG ĐẠT vì môi trường', { skip: findTool('depcruise') ? false : 'máy không có depcruise (npm i -D dependency-cruiser) — bỏ qua test thật' }, async () => {
  const dir = project({ 'package.json': '{}', 'docs/arch.json': WEB_ARCH, 'docs/ARCHITECTURE.md': CODEMAP, 'src/features/a/index.js': 'export const a = 1\n', 'src/shared/util.js': 'export const u = 1\n' })
  gen(dir)
  const r = (await runChecks({ dir, checkers: only('depcruise') })).results[0]
  assert.ok(['pass', 'missing'].includes(r.status), JSON.stringify(r))
  if (r.status === 'missing') assert.ok(r.message.includes(`Node ${process.versions.node}.`), r.message)
})

// --- go-arch-lint ------------------------------------------------------------------------------------------------------------------------------

const GAL =(...deps) => JSON.stringify({ Type: 'models.Check', Payload: { ArchHasWarnings: deps.length > 0, ArchWarningsDeps: deps.map(([c, f, i]) => ({ ComponentName: c, FileRelativePath: f, ResolvedImportName: i })), ArchWarningsNotMatched: [], ArchWarningsDeepScan: [] } })
const goLintProject = (extra = {}) => ({ 'go.mod': 'module x\n', 'docs/arch.json': goArch('go'), '.go-arch-lint.yml': 'version: 3\n', ...extra })

test('go-arch-lint: sạch ⇒ đạt; vi phạm mới ⇒ không đạt liệt kê; vi phạm đã chốt trong baseline ⇒ không tính; vi phạm mới lẫn cũ ⇒ chỉ báo cái mới', async () => {
  const oldV = GAL(['user', 'internal/user/a.go', 'x/internal/store'])
  const newV = GAL(['user', 'internal/user/a.go', 'x/internal/store'], ['user', 'internal/user/b.go', 'x/internal/transport'])
  const calls = []
  const run = (out, code) => async (file, args, o) => { calls.push({ args, cwd: o.cwd }); return { ...OK, code, stdout: out } }
  const d = project(goLintProject())
  assert.equal((await first(d, 'go-arch-lint', { exec: run(GAL(), 0) })).status, 'pass')
  assert.deepEqual(calls[0].args, ['check', '--json'])
  assert.equal(path.resolve(calls[0].cwd), path.resolve(d))
  const bad = await first(d, 'go-arch-lint', { exec: run(oldV, 1) })
  assert.equal(bad.status, 'fail')
  assert.ok(bad.detail.some((l) => l.includes('internal/user/a.go')), bad.detail.join('|'))
  assert.match(bad.fix, /hỏi người dùng/)

  const keys = newGoArchViolations(project(), oldV)
  assert.equal(keys.length, 1)
  const based = project(goLintProject({ 'docs/arch-baseline.json': BASELINE({ go: { newFromRev: null, archLint: keys } }) }))
  assert.equal((await first(based, 'go-arch-lint', { exec: run(oldV, 1) })).status, 'pass', 'vi phạm cũ đã chốt')
  const mixed = await first(based, 'go-arch-lint', { exec: run(newV, 1) })
  assert.equal(mixed.status, 'fail')
  assert.ok(mixed.detail.some((l) => l.includes('b.go')))
  assert.ok(!mixed.detail.some((l) => l.includes('a.go')), 'vi phạm cũ không được báo lại')
})

test('go-arch-lint: lỗi cấu hình (không ra kết quả đọc được) KHÔNG được coi là "toàn vi phạm cũ"; chưa gen .go-arch-lint.yml ⇒ không đạt kèm lệnh gen; thiếu công cụ ⇒ THIẾU + lệnh cài', async () => {
  const keys = newGoArchViolations(project(), GAL(['user', 'internal/user/a.go', 'x/internal/store']))
  const based = project(goLintProject({ 'docs/arch-baseline.json': BASELINE({ go: { newFromRev: null, archLint: keys } }) }))
  const crashed = await first(based, 'go-arch-lint', { exec: async () => ({ ...OK, code: 1, stderr: 'error: parse arch file: yaml: line 3' }) })
  assert.equal(crashed.status, 'fail')
  assert.ok(crashed.detail.some((l) => l.includes('yaml')))
  const refused = JSON.stringify({ Type: 'models.Check', Payload: { ExecutionWarnings: [{ Text: "($.deps) deps is required", File: '', Line: 0, Offset: 0 }], ArchHasWarnings: false, ArchWarningsDeps: [], ArchWarningsNotMatched: [], ArchWarningsDeepScan: [] } })
  const rejected = await first(based, 'go-arch-lint', { exec: async () => ({ ...OK, code: 1, stdout: refused }) })
  assert.equal(rejected.status, 'fail', 'công cụ từ chối cấu hình ⇒ không đạt')
  assert.ok(rejected.detail.some((l) => l.includes('deps is required')))
  assert.match(rejected.fix, /arch\.mjs gen/)
  const { '.go-arch-lint.yml': _gen, ...withoutCfg } = goLintProject()
  const noCfg = await first(project(withoutCfg), 'go-arch-lint')
  assert.equal(noCfg.status, 'fail')
  assert.match(noCfg.fix, /arch\.mjs gen/)
  const miss = await first(project(goLintProject()), 'go-arch-lint', { which: whichNone })
  assert.equal(miss.status, 'missing')
  assert.match(miss.fix, /go install github\.com\/fe3dback\/go-arch-lint@latest/)
  assert.deepEqual((await check(project(webProject()), ['go-arch-lint'])).results, [], 'arch.json không có phần Go ⇒ không hiện')
})

test('go-arch-lint: nhiều phần Go ⇒ mỗi phần một lệnh (phần sau dùng --arch-file), lỗi ghi rõ phần nào', async () => {
  const dir = project({ 'go.mod': 'module x\n', 'docs/arch.json': goArch('go', 'agent'), '.go-arch-lint.yml': 'v', '.go-arch-lint.agent.yml': 'v' })
  const calls = []
  const exec = async (file, args) => { calls.push(args); return calls.length === 2 ? { ...OK, code: 1, stdout: GAL(['user', 'agent/user/a.go', 'x/agent/store']) } : { ...OK, stdout: GAL() } }
  const r = await first(dir, 'go-arch-lint', { exec })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], ['check', '--json'])
  assert.deepEqual(calls[1], ['check', '--json', '--arch-file', '.go-arch-lint.agent.yml'])
  assert.equal(r.status, 'fail')
  assert.match(`${r.message} ${r.detail.join(' ')}`, /agent/)
})

// --- golangci-lint + baseline ------------------------------------------------------------------------------------------------------------------

test('golangci-lint: baseline có go.newFromRev ⇒ thêm --new-from-rev; không baseline / rev lạ ⇒ lệnh cũ nguyên vẹn', async () => {
  const seen = []
  const exec = async (file, args) => { seen.push(args); return OK }
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  await first(project({ 'go.mod': 'module x\n' }), 'golangci-lint', { exec })
  await first(project({ 'go.mod': 'module x\n', 'docs/arch-baseline.json': BASELINE({ go: { newFromRev: sha, archLint: [] } }) }), 'golangci-lint', { exec })
  await first(project({ 'go.mod': 'module x\n', 'docs/arch-baseline.json': BASELINE({ go: { newFromRev: '$(evil); x', archLint: [] } }) }), 'golangci-lint', { exec })
  await first(project({ 'go.mod': 'module x\n', 'docs/arch-baseline.json': BASELINE({ go: null }) }), 'golangci-lint', { exec })
  assert.deepEqual(seen[0], ['run', './...'])
  assert.deepEqual(seen[1], ['run', `--new-from-rev=${sha}`, '--', './...'], 'option trước, `--`, rồi mới tới đích quét')
  assert.deepEqual(seen[2], ['run', './...'], 'rev không phải mã commit ⇒ bỏ qua')
  assert.deepEqual(seen[3], ['run', './...'])
})

const REAL_GOLANGCI = findTool('golangci-lint', { cwd: HERE, env: process.env })
const REAL_GO = findTool('go', { cwd: HERE, env: process.env })

test('golangci-lint THẬT + baseline: lỗi cũ lúc chốt mốc không báo, lỗi mới cùng loại báo; không baseline thì báo cả hai', { skip: REAL_GOLANGCI && REAL_GO ? false : 'máy không có golangci-lint/go' }, async () => {
  const cacheDir = project({}, 'golangci cache ')
  const env = { ...process.env, NO_COLOR: '1', GOLANGCI_LINT_CACHE: cacheDir }
  const d = repo({ 'go.mod': 'module example.com/x\n\ngo 1.21\n', 'main.go': 'package main\n\nfunc main() {}\n\nfunc oldUnused() {}\n' })
  const rev = git(d, 'rev-parse', 'HEAD')
  put(d, 'docs/arch-baseline.json', `${JSON.stringify(BASELINE({ go: { newFromRev: rev, archLint: [] } }))}\n`)
  commit(d)
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'extra.go', 'package main\n\nfunc newUnused() {}\n')
  commit(d)
  const withBase = await runChecks({ dir: d, checkers: only('golangci-lint'), env })
  const r = withBase.results[0]
  assert.equal(r.status, 'fail', JSON.stringify(r))
  const text = r.detail.join('\n')
  assert.match(text, /newUnused/)
  assert.ok(!/oldUnused/.test(text), `lỗi cũ không được báo: ${text}`)
  fs.unlinkSync(path.join(d, 'docs', 'arch-baseline.json'))
  const noBase = (await runChecks({ dir: d, checkers: only('golangci-lint'), env })).results[0]
  assert.match(noBase.detail.join('\n'), /oldUnused/, 'không baseline ⇒ báo cả lỗi cũ')
})

// --- oasdiff -----------------------------------------------------------------------------------------------------------------------------------

const OAS_OLD = 'openapi: 3.0.0\ninfo: {title: t, version: "1"}\npaths:\n  /a:\n    get:\n      responses:\n        "200": {description: ok}\n'
const OAS_NEW = `${OAS_OLD}  /b:\n    get:\n      responses:\n        "200": {description: ok}\n`

test('oasdiff: lấy bản ở nhánh chính ra file tạm, chạy `oasdiff breaking --fail-on ERR <cũ> <mới>`, xong xoá file tạm', async () => {
  const d = repo({ 'openapi.yaml': OAS_OLD })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'openapi.yaml', OAS_NEW)
  let seen
  const exec = async (file, args, o) => { seen = { args, old: fs.readFileSync(args[4], 'utf8').replace(/\r\n/g, '\n'), cwd: o.cwd }; return OK }
  const r = await first(d, 'oasdiff', { exec })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(seen.args.slice(0, 4), ['breaking', '--fail-on', 'ERR', '--'], 'option trước, `--`, rồi mới tới hai file')
  assert.equal(seen.args[5], 'openapi.yaml')
  assert.equal(seen.args.length, 6)
  assert.equal(seen.old, OAS_OLD, 'bản cũ lấy từ nhánh chính')
  assert.ok(seen.args[4].endsWith('.yaml'))
  assert.equal(path.resolve(seen.cwd), path.resolve(d))
  assert.ok(!fs.existsSync(seen.args[4]), 'file tạm đã xoá')
  assert.equal(git(d, 'status', '--porcelain').split('\n').filter((l) => !l.includes('openapi.yaml')).join(''), '', 'không để rác trong dự án')
})

test('oasdiff: exit 1 ⇒ không đạt kèm lời dặn giữ tương thích; thiếu công cụ ⇒ THIẾU + lệnh cài; file api/openapi.json cũng được nhận', async () => {
  const d = repo({ 'api/openapi.json': '{"openapi":"3.0.0","paths":{}}' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'api/openapi.json', '{"openapi":"3.0.0","paths":{"/x":{}}}')
  let tmpOld
  const bad = await first(d, 'oasdiff', { exec: async (f, a) => { tmpOld = a[4]; return { ...OK, code: 1, stdout: `error\t[response-property-removed] at ${a[4]}\n` } } })
  assert.equal(bad.status, 'fail')
  assert.ok(bad.detail.some((l) => l.includes('response-property-removed')))
  assert.ok(bad.detail.some((l) => l.includes('main:api/openapi.json')), `đường dẫn file tạm phải đổi thành "main:<file>": ${bad.detail.join('|')}`)
  assert.ok(!bad.detail.join('').includes(tmpOld))
  assert.match(bad.fix, /tương thích/)
  const miss = await first(d, 'oasdiff', { which: whichNone })
  assert.equal(miss.status, 'missing')
  assert.match(miss.fix, /oasdiff/)
  assert.equal(miss.required, true)
})

test('oasdiff: chỉ chạy khi file có thay đổi — không đổi / file mới chưa có ở nhánh chính / không tìm được nhánh chính ⇒ BỎ QUA có lý do (không THIẾU dù máy chưa cài); không có openapi ⇒ không hiện', async () => {
  const ran = []
  const exec = async () => { ran.push(1); return OK }
  const same = repo({ 'openapi.yaml': OAS_OLD })
  git(same, 'checkout', '-q', '-b', 'feat')
  const r1 = await first(same, 'oasdiff', { exec, which: whichNone })
  assert.equal(r1.status, 'skip')
  assert.match(r1.message, /không đổi/)

  const fresh = repo({ 'a.txt': '1' })
  git(fresh, 'checkout', '-q', '-b', 'feat')
  put(fresh, 'openapi.yml', OAS_OLD)
  const r2 = await first(fresh, 'oasdiff', { exec, which: whichNone })
  assert.equal(r2.status, 'skip')
  assert.match(r2.message, /mới/)

  const noGit = project({ 'openapi.yaml': OAS_OLD })
  const r3 = await first(noGit, 'oasdiff', { exec, which: whichNone })
  assert.equal(r3.status, 'skip')
  assert.match(r3.message, /--base/)

  assert.deepEqual((await check(project({ 'package.json': '{}' }), ['oasdiff'])).results, [])
  assert.equal(ran.length, 0)
})

test('oasdiff: --base chọn nhánh chính tuỳ ý (repo không có main/master)', async () => {
  const d = repo({ 'openapi.yaml': OAS_OLD }, 'trunk')
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, 'openapi.yaml', OAS_NEW)
  assert.equal((await first(d, 'oasdiff')).status, 'skip', 'không có main/master và không truyền --base')
  const r = await first(d, 'oasdiff', { base: 'trunk' })
  assert.equal(r.status, 'pass', JSON.stringify(r))
})

// --- squawk ------------------------------------------------------------------------------------------------------------------------------------

const MIG = 'supabase/migrations'

test('squawk: chạy trên migration .sql đổi so với nhánh chính (đã commit lẫn chưa theo dõi), không đụng migration cũ và .sql khác', async () => {
  const d = repo({ [`${MIG}/001_init.sql`]: 'create table t (id int);\n', 'db/queries.sql': 'select 1;\n' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, `${MIG}/002_add.sql`, 'alter table t add column x int;\n'); commit(d)
  put(d, `${MIG}/003_more.sql`, 'alter table t add column y int;\n')
  put(d, 'db/queries.sql', 'select 2;\n')
  let args
  const r = await first(d, 'squawk', { exec: async (f, a) => { args = a; return OK } })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  const at = args.indexOf('--')
  assert.ok(at > 0, '`--` ngăn cách option với danh sách file')
  assert.ok(args.slice(0, at).every((a) => /^--exclude=[a-z-]+$/.test(a)), `trước -- chỉ có --exclude: ${args.slice(0, at)}`)
  assert.deepEqual(args.slice(at + 1).sort(), [`${MIG}/002_add.sql`, `${MIG}/003_more.sql`])
})

test('squawk: chỉ giữ luật về khoá bảng / mất dữ liệu — bỏ các luật kiểu hình thức (require-lock-timeout, require-statement-timeout, prefer-robust-stmts) vốn làm migration an toàn cũng đỏ; luật nguy hiểm (ban-drop-column…) không bị bỏ', async () => {
  const d = repo({ 'a.txt': '1' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, `${MIG}/001_x.sql`, 'alter table t add column x int;\n')
  let args
  await first(d, 'squawk', { exec: async (f, a) => { args = a; return OK } })
  const excluded = args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice('--exclude='.length)).sort()
  assert.deepEqual(excluded, ['prefer-robust-stmts', 'require-lock-timeout', 'require-statement-timeout'])
})

test('squawk: file migration nằm trong thư mục tên giống option (--evil/migrations/…) ⇒ vẫn là đối số vị trí sau `--`, không bị hiểu thành cờ', async () => {
  const d = repo({ 'a.txt': '1' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, '--evil/migrations/001_x.sql', 'select 1;\n')
  let args
  const r = await first(d, 'squawk', { exec: async (f, a) => { args = a; return OK } })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '--evil/migrations/001_x.sql'])
})

const REAL_SQUAWK = findTool('squawk', { cwd: HERE, env: process.env })

test('squawk THẬT: migration an toàn (thêm cột) ⇒ đạt; DROP COLUMN ⇒ không đạt (ban-drop-column); thư mục tên --evil không làm squawk hiểu nhầm là cờ', { skip: REAL_SQUAWK ? false : 'máy không có squawk (npm i -g squawk-cli) — bỏ qua test thật' }, async () => {
  const d = repo({ 'a.txt': '1' })
  git(d, 'checkout', '-q', '-b', 'feat')
  put(d, '--evil/migrations/001_add.sql', 'alter table t add column x text;\n')
  const ok = (await runChecks({ dir: d, checkers: only('squawk') })).results[0]
  assert.equal(ok.status, 'pass', JSON.stringify(ok))
  put(d, '--evil/migrations/002_drop.sql', 'alter table t drop column x;\n')
  const bad = (await runChecks({ dir: d, checkers: only('squawk') })).results[0]
  assert.equal(bad.status, 'fail', JSON.stringify(bad))
  assert.match(bad.detail.join('\n'), /ban-drop-column/)
})

test('main không chung lịch sử với nhánh làm việc còn master là cha ⇒ oasdiff và squawk VẪN chạy so với master (không BỎ QUA im lặng rồi exit 0)', async () => {
  const { dir } = repoMainUnrelated({ 'openapi.yaml': OAS_OLD, [`${MIG}/001_init.sql`]: 'create table t (id int);\n' })
  put(dir, 'openapi.yaml', OAS_NEW)
  put(dir, `${MIG}/002_add.sql`, 'alter table t add column x int;\n')
  const calls = []
  const exec = async (file, args) => { calls.push(args); return OK }
  const oas = await first(dir, 'oasdiff', { exec })
  const sql = await first(dir, 'squawk', { exec })
  assert.equal(oas.status, 'pass', JSON.stringify(oas))
  assert.equal(sql.status, 'pass', JSON.stringify(sql))
  assert.equal(calls.length, 2, 'cả hai công cụ đều được chạy')
  assert.ok(calls[1].includes(`${MIG}/002_add.sql`))
})

test('squawk: exit 1 ⇒ không đạt kèm lời dặn; chưa cài mà có migration đổi ⇒ THIẾU + lệnh cài; không có migration đổi ⇒ BỎ QUA (không THIẾU); không có migration nào ⇒ không hiện', async () => {
  const d = repo({ [`${MIG}/001_init.sql`]: 'create table t (id int);\n' })
  git(d, 'checkout', '-q', '-b', 'feat')
  const calm = await first(d, 'squawk', { which: whichNone })
  assert.equal(calm.status, 'skip')
  assert.match(calm.message, /migration/)
  put(d, `${MIG}/002_drop.sql`, 'alter table t drop column x;\n')
  const bad = await first(d, 'squawk', { exec: async () => ({ ...OK, code: 1, stdout: 'supabase/migrations/002_drop.sql:1:1: warning: ban-drop-column\n' }) })
  assert.equal(bad.status, 'fail')
  assert.ok(bad.detail.some((l) => l.includes('ban-drop-column')))
  assert.match(bad.fix, /migration|CONCURRENTLY|DEFAULT/i)
  const miss = await first(d, 'squawk', { which: whichNone })
  assert.equal(miss.status, 'missing')
  assert.match(miss.fix, /npm i -g squawk-cli/)
  assert.deepEqual((await check(repo({ 'a.txt': '1' }), ['squawk'])).results, [])
  const noGit = await first(project({ [`${MIG}/001_init.sql`]: 'x' }), 'squawk')
  assert.equal(noGit.status, 'skip')
  assert.match(noGit.message, /--base/)
})

// --- CLI --base --------------------------------------------------------------------------------------------------------------------------------

test('main --base: nhánh không có ⇒ exit 2 nói rõ; thiếu giá trị ⇒ exit 2; nhánh có ⇒ chạy bình thường; --help nhắc --base', async () => {
  const d = repo({ 'package.json': '{}' }, 'trunk')
  const file = path.join(project({ 'c.json': { checkers: [mk({ id: 'a' })] } }), 'c.json')
  const io = () => { const o = { out: '', err: '' }; return { o, deps: { stdout: { write: (s) => { o.out += s } }, stderr: { write: (s) => { o.err += s } }, which: whichAll, exec: async () => OK } } }
  let { o, deps } = io()
  assert.equal(await main(['--dir', d, '--checkers', file, '--base', 'khong-co'], deps), 2)
  assert.match(o.err, /khong-co/)
  ;({ o, deps } = io())
  assert.equal(await main(['--dir', d, '--checkers', file, '--base'], deps), 2)
  ;({ o, deps } = io())
  assert.equal(await main(['--dir', d, '--checkers', file, '--base', '--upload-pack=x'], deps), 2)
  ;({ o, deps } = io())
  assert.equal(await main(['--dir', d, '--checkers', file, '--base', 'trunk'], deps), 0)
  ;({ o, deps } = io())
  assert.equal(await main(['--help'], deps), 0)
  assert.match(o.out, /--base/)
})

// --- đợt 3 (làn E): spec-codes, web-headers, ui-rules, mv3-manifest mở rộng ---------------------------------------------------------------------

const NEW_IDS = ['spec-codes', 'web-headers', 'ui-rules']

test('checkers.json thật (đợt 3): spec-codes, web-headers, ui-rules bắt buộc + chỉ hiện khi áp dụng; ui-rules chạy ui-check.mjs có thật, timeout ≥ 300 giây, exit 3 xử lý bằng plan', () => {
  const get = (id) => REAL.checkers.find((c) => c.id === id)
  for (const id of NEW_IDS) {
    assert.equal(get(id).required, true, id)
    assert.equal(get(id).quietSkip, true, `${id}: không áp dụng thì không hiện dòng nào (bảng của dự án thường giữ nguyên)`)
  }
  assert.deepEqual([get('spec-codes').stack, get('spec-codes').internal], ['all', 'spec-codes'])
  assert.deepEqual([get('web-headers').stack, get('web-headers').internal], ['web', 'web-headers'])
  const ui = get('ui-rules')
  assert.equal(ui.cmd, 'node')
  assert.equal(ui.plan, 'ui-check')
  assert.deepEqual(ui.detect, { files: ['.claude/ui.json'] })
  assert.ok(ui.timeoutMs >= 300000, `ui-rules timeoutMs ${ui.timeoutMs}`)
  assert.ok(ui.args[0].startsWith('{hooks}/'))
  assert.ok(fs.existsSync(ui.args[0].replace('{hooks}', HERE)), 'ui-check.mjs phải có thật ở thư mục hooks/')
  assert.equal(typeof PLANNERS[ui.plan], 'function')
  for (const n of ['spec-codes', 'web-headers']) assert.equal(typeof INTERNALS[n], 'function', n)
})

test('đợt 3: dự án thường (không SPEC mở, không ui.json, không index.html) ⇒ ba checker mới không hiện dòng nào', async () => {
  const rep = await check(project({ 'package.json': '{}', 'docs/specs/a/SPEC.md': '# SPEC\n', 'docs/specs/a/progress.md': 'Trạng thái: xong\n' }), NEW_IDS)
  assert.deepEqual(rep.results, [])
  assert.equal(rep.ok, true)
})

// SPEC kiểu "Bạn duyệt": một màn bốn trạng thái S-01..S-04 + hai quyền P-01, P-02.
const TABLE_HEAD = '| mã | khi | thấy gì | làm được gì |\n|---|---|---|---|\n'
const SCREEN = `#### Danh sách đơn\n\n${TABLE_HEAD}| S-01 | Có dữ liệu | a | b |\n| S-02 | Trống | a | b |\n| S-03 | Đang tải | a | b |\n| S-04 | Lỗi | a | b |\n`
function specText(over = {}) {
  const s = {
    'Ai dùng': 'Chủ cửa hàng.',
    'Các màn hình': SCREEN,
    'Làm được gì': '- Xem đơn.',
    'Để sau': 'Không có.',
    'Phí phát sinh': 'Không.',
    'Ai thấy/sửa được dữ liệu gì': '- P-01: Chủ đơn thấy đơn của mình\n- P-02: Nhân viên sửa đơn được giao',
    ...over,
  }
  return `# SPEC\n\n## Bạn duyệt\n\n${Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => `### ${k}\n\n${v}\n`).join('\n')}\n## Kỹ thuật\n\nGhi chú.\n`
}
const APP_ALL = '<div data-s="S-01"/><div data-s="S-02"/><div data-s="S-03"/><div data-s="S-04"/>'
const TEST_ALL = "test('S-01 S-02 S-03 S-04 P-01 P-02', () => {})"
const withSpec = (spec, extra = {}) => project({ 'package.json': '{}', 'docs/specs/don-hang/SPEC.md': spec, 'docs/specs/don-hang/progress.md': '# Tiến độ\nTrạng thái: đang làm\n', ...extra })

test('spec-codes: SPEC đang làm, mọi mã S-nn có trong app + test, P-nn có trong test ⇒ đạt', async () => {
  const d = withSpec(specText(), { 'src/App.tsx': APP_ALL, 'tests/app.spec.ts': TEST_ALL })
  const rep = await check(d, ['spec-codes'])
  assert.equal(rep.results.length, 1)
  assert.equal(rep.results[0].status, 'pass', JSON.stringify(rep.results[0]))
  assert.equal(exitCode(rep), 0)
})

test('spec-codes: thiếu S-02 trong app và P-02 trong test ⇒ KHÔNG ĐẠT nêu đúng mã + chỗ gắn data-s; SPEC xong (progress "Trạng thái: xong") thì không xét', async () => {
  const d = withSpec(specText(), { 'src/App.tsx': APP_ALL.replace('<div data-s="S-02"/>', ''), 'tests/app.spec.ts': TEST_ALL.replace(' P-02', '') })
  const rep = await check(d, ['spec-codes'])
  const r = rep.results[0]
  assert.equal(r.status, 'fail')
  assert.equal(exitCode(rep), 1)
  const text = r.detail.join('\n')
  assert.match(text, /S-02[^\n]*app/)
  assert.match(text, /P-02[^\n]*test/)
  assert.ok(!/S-01|S-03|P-01/.test(text), `chỉ nêu mã thiếu: ${text}`)
  assert.match(r.fix, /data-s="S-02"/)
  fs.writeFileSync(path.join(d, 'docs', 'specs', 'don-hang', 'progress.md'), '# Tiến độ\nTrạng thái: xong\n')
  assert.deepEqual((await check(d, ['spec-codes'])).results, [])
})

test('spec-codes: SPEC thiếu mục "Để sau" và màn thiếu trạng thái "lỗi" ⇒ KHÔNG ĐẠT nêu tên mục / màn (specProblems)', async () => {
  const noError = SCREEN.replace('| S-04 | Lỗi | a | b |\n', '')
  const d = withSpec(specText({ 'Để sau': null, 'Các màn hình': noError }), { 'src/App.tsx': APP_ALL, 'tests/app.spec.ts': TEST_ALL })
  const r = (await check(d, ['spec-codes'])).results[0]
  assert.equal(r.status, 'fail')
  const text = r.detail.join('\n')
  assert.match(text, /Để sau/)
  assert.match(text, /Danh sách đơn[^\n]*lỗi/)
  assert.match(text, /docs\/specs\/don-hang\/SPEC\.md/, 'nêu SPEC nào')
})

test('spec-codes: SPEC kiểu cũ (chưa có "Bạn duyệt") chỉ được nhắc, KHÔNG chặn; lẫn SPEC mới đạt ⇒ ĐẠT kèm ghi chú hiện trong bảng', async () => {
  const old = withSpec('# SPEC\n\n## Mục tiêu\nLàm gì đó.\n')
  const rep = await check(old, ['spec-codes'])
  assert.equal(rep.results[0].status, 'skip')
  assert.match(rep.results[0].message, /kiểu cũ/)
  assert.match(rep.results[0].message, /không chặn/)
  assert.equal(rep.ok, true)
  assert.equal(exitCode(rep), 0)
  const mixed = withSpec(specText(), { 'src/App.tsx': APP_ALL, 'tests/app.spec.ts': TEST_ALL, 'docs/specs/cu/SPEC.md': '# SPEC cũ\n## Mục tiêu\nx\n' })
  const r2 = await check(mixed, ['spec-codes'])
  assert.equal(r2.results[0].status, 'pass')
  assert.ok(r2.results[0].detail.some((l) => l.includes('docs/specs/cu/SPEC.md') && /kiểu cũ/.test(l)))
  assert.match(formatReport(r2), /ĐẠT\s+spec-codes[^\n]*\n\s+\| docs\/specs\/cu\/SPEC\.md[^\n]*kiểu cũ/)
  assert.equal(exitCode(r2), 0)
})

test('spec-codes: SPEC đang làm đánh lại mã đã dùng ở SPEC cũ (đã xong) ⇒ KHÔNG ĐẠT dù app + test cũ có đủ mã, nêu SPEC cũ + mã kế tiếp; đổi sang mã chưa dùng ⇒ ĐẠT', async () => {
  const d = withSpec(specText(), { 'src/App.tsx': APP_ALL, 'tests/app.spec.ts': TEST_ALL, 'docs/specs/cu/SPEC.md': specText(), 'docs/specs/cu/progress.md': 'Trạng thái: xong\n' })
  const r = (await check(d, ['spec-codes'])).results[0]
  assert.equal(r.status, 'fail')
  const text = r.detail.join('\n')
  assert.match(text, /S-01 \(docs\/specs\/don-hang\/SPEC\.md:\d+\) đã dùng ở docs\/specs\/cu\/SPEC\.md/)
  assert.match(text, /P-02 .*đã dùng ở docs\/specs\/cu\/SPEC\.md/)
  assert.match(r.fix, /Đổi sang mã chưa dùng, vd S-05/)
  const renum = (s) => s.replace(/S-0(\d)/g, 'S-1$1').replace(/P-0(\d)/g, 'P-1$1')
  const fixed = withSpec(renum(specText()), { 'src/App.tsx': renum(APP_ALL), 'tests/app.spec.ts': renum(TEST_ALL), 'docs/specs/cu/SPEC.md': specText(), 'docs/specs/cu/progress.md': 'Trạng thái: xong\n' })
  assert.equal((await check(fixed, ['spec-codes'])).results[0].status, 'pass')
})

test('web-headers: web có index.html mà chưa có file header ⇒ KHÔNG ĐẠT; thêm đủ 4 header ⇒ ĐẠT; thiếu nosniff ⇒ nêu đúng header đó', async () => {
  const d = project({ 'package.json': '{}', 'index.html': '<div id="root"></div>' })
  const r = (await check(d, ['web-headers'])).results[0]
  assert.equal(r.status, 'fail')
  assert.match(r.detail.join('\n'), /public\/_headers/)
  assert.ok(r.fix)
  const FULL = "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
  put(d, 'public/_headers', FULL)
  assert.equal((await check(d, ['web-headers'])).results[0].status, 'pass')
  put(d, 'public/_headers', FULL.replace('  X-Content-Type-Options: nosniff\n', ''))
  const lack = (await check(d, ['web-headers'])).results[0]
  assert.equal(lack.status, 'fail')
  assert.equal(lack.detail.length, 1)
  assert.match(lack.detail[0], /nosniff/)
})

test('web-headers: dự án không phải web kiểu Vite (không index.html, không vite) và app Wails / extension ⇒ không hiện dòng nào (không đòi file header)', async () => {
  assert.deepEqual((await check(project({ 'package.json': '{"name":"thu-vien"}' }), ['web-headers'])).results, [])
  const wails = project({ 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}', 'frontend/index.html': '<div/>' })
  assert.deepEqual((await check(wails, ['web-headers'])).results, [])
  const ext = project({ 'package.json': '{}', 'index.html': '<div/>', 'public/manifest.json': { manifest_version: 3, name: 'x' } })
  assert.deepEqual((await check(ext, ['web-headers'])).results, [])
  const vite = project({ 'package.json': '{"devDependencies":{"vite":"7"}}' })
  assert.equal((await check(vite, ['web-headers'])).results[0].status, 'fail', 'có vite mà chưa có header ⇒ vẫn đòi')
})

const UI_CFG = { '.claude/ui.json': { start: 'npm run dev', url: 'http://localhost:5173', routes: ['/'] }, 'package.json': '{}' }
const uiExec = (res, seen = []) => async (file, args, o) => { seen.push({ file, args, cwd: o.cwd, timeoutMs: o.timeoutMs }); return { ...OK, ...res } }

test('ui-rules: không có .claude/ui.json ⇒ không hiện; có ⇒ chạy `node <hooks>/ui-check.mjs --dir .` ở gốc dự án với timeout ≥ 300 giây, exit 0 ⇒ ĐẠT', async () => {
  assert.deepEqual((await check(project({ 'package.json': '{}' }), ['ui-rules'])).results, [])
  const d = project(UI_CFG)
  const seen = []
  const r = (await check(d, ['ui-rules'], { exec: uiExec({ stdout: 'ĐẠT  Giao diện: đã kiểm 1 màn ở 2 khổ (1280, 390), không có lỗi chặn.' }, seen) })).results[0]
  assert.equal(r.status, 'pass')
  assert.equal(seen.length, 1)
  assert.equal(path.basename(seen[0].args[0]), 'ui-check.mjs')
  assert.ok(fs.existsSync(seen[0].args[0]), `đường dẫn ui-check phải có thật: ${seen[0].args[0]}`)
  assert.deepEqual(seen[0].args.slice(1), ['--dir', '.'])
  assert.equal(seen[0].cwd, d)
  assert.ok(seen[0].timeoutMs >= 300000)
})

test('ui-rules: exit 1 ⇒ KHÔNG ĐẠT kèm các lỗi + lời dặn; exit 2 ⇒ KHÔNG ĐẠT "chưa chạy được"; exit 3 ⇒ THIẾU kèm lệnh cài ui-check in ra, chặn (bắt buộc)', async () => {
  const d = project(UI_CFG)
  const one = (res) => check(d, ['ui-rules'], { exec: uiExec(res) })
  const bad = await one({ code: 1, stdout: 'KHÔNG  Giao diện còn 2 lỗi chặn (đã kiểm 1 màn ở 2 khổ (1280, 390)):\n  1. Màn /, khổ rộng 1280: 2 nút chính\n     Sửa: chỉ để một nút chính mỗi màn' })
  assert.equal(bad.results[0].status, 'fail')
  assert.match(bad.results[0].message, /^2 lỗi giao diện/)
  assert.match(bad.results[0].detail.join('\n'), /2 nút chính/)
  assert.match(bad.results[0].fix, /ui-baseline\.json/)
  assert.equal(exitCode(bad), 1)
  const cfg = await one({ code: 2, stderr: 'ui-check: Chưa có .claude/ui.json. Tạo file này' })
  assert.equal(cfg.results[0].status, 'fail')
  assert.match(cfg.results[0].message, /chưa chạy được/)
  assert.match(cfg.results[0].detail.join('\n'), /Chưa có \.claude\/ui\.json/)
  const noPw = await one({ code: 3, stderr: 'ui-check: Thiếu Playwright (công cụ mở app thử như người dùng) trong dự án này. Cài bằng:\n  pnpm add -D playwright\n  pnpm exec playwright install chromium' })
  assert.equal(noPw.results[0].status, 'missing')
  assert.equal(noPw.results[0].required, true)
  assert.match(noPw.results[0].fix, /pnpm add -D playwright && pnpm exec playwright install chromium/)
  assert.equal(exitCode(noPw), 1, 'thiếu công cụ bắt buộc ⇒ chặn, không tính đạt')
  const bare = await one({ code: 3, stderr: 'ui-check: lạ' })
  assert.match(bare.results[0].fix, /npx playwright install chromium/)
  const odd = await one({ code: 9, stdout: 'x' })
  assert.equal(odd.results[0].status, 'fail')
})

test('ui-rules × Wails: ui.json ở frontend/ (roots.web) ⇒ ui-check chạy `--dir .` NGAY TRONG frontend/ (Playwright của frontend); ui.json chỉ nằm ở gốc Wails ⇒ không hiện; web thường vẫn ở gốc', async () => {
  const wails = { 'go.mod': 'module x\n', 'wails.json': '{}', 'frontend/package.json': '{}' }
  const d = project({ ...wails, 'frontend/.claude/ui.json': UI_CFG['.claude/ui.json'] })
  const seen = []
  const rep = await check(d, ['ui-rules'], { exec: uiExec({ stdout: 'ĐẠT  Giao diện: đã kiểm 1 màn ở 2 khổ (1280, 390), không có lỗi chặn.' }, seen) })
  assert.equal(rep.results.length, 1)
  assert.equal(rep.results[0].status, 'pass')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cwd, path.join(d, 'frontend'), 'chạy trong frontend/, không phải gốc dự án Go')
  assert.deepEqual(seen[0].args.slice(1), ['--dir', '.'])
  const real = (await runChecks({ dir: d, checkers: only('ui-rules') })).results[0]
  assert.equal(real.status, 'missing', 'frontend/ chưa cài Playwright ⇒ THIẾU (ui-check đọc đúng frontend/.claude/ui.json)')
  const rootOnly = project({ ...wails, '.claude/ui.json': UI_CFG['.claude/ui.json'] })
  assert.deepEqual((await check(rootOnly, ['ui-rules'], { exec: uiExec({}) })).results, [])
  const web = project(UI_CFG)
  const seenWeb = []
  await check(web, ['ui-rules'], { exec: uiExec({}, seenWeb) })
  assert.equal(seenWeb[0].cwd, web)
})

test('ui-rules THẬT: chạy ui-check.mjs thật trên dự án có ui.json mà chưa cài Playwright ⇒ THIẾU kèm lệnh cài (không đạt giả)', async () => {
  const d = project(UI_CFG)
  const r = (await runChecks({ dir: d, checkers: only('ui-rules') })).results[0]
  assert.equal(r.status, 'missing', JSON.stringify(r))
  assert.match(r.fix, /playwright/)
})

const MV3 = (over = {}) => ({ manifest_version: 3, name: 'x', version: '1', permissions: ['storage'], ...over })
const mv3Run = (files) => first(project(files), 'mv3-manifest')

test('mv3-manifest + extensionPermProblems: host_permissions phủ mọi trang ⇒ KHÔNG ĐẠT; mẫu mv3Problems đã báo (<all_urls>, *://*/*) chỉ hiện MỘT lần; optional_host_permissions thì được', async () => {
  const dup = await mv3Run({ 'manifest.json': MV3({ host_permissions: ['<all_urls>', '*://*/*'] }) })
  assert.equal(dup.status, 'fail')
  for (const pattern of ['<all_urls>', '*://*/*']) assert.equal(dup.detail.filter((l) => l.includes(pattern)).length, 1, `${pattern} báo trùng: ${dup.detail.join(' | ')}`)
  const wide = await mv3Run({ 'manifest.json': MV3({ host_permissions: ['*://*.com/*', 'https://api.example.com/*'] }) })
  assert.equal(wide.status, 'fail')
  assert.equal(wide.detail.length, 1)
  assert.match(wide.detail[0], /manifest\.json: host_permissions.*\*:\/\/\*\.com\/\*/)
  assert.match(wide.fix, /optional_host_permissions/)
  const optional = await mv3Run({ 'manifest.json': MV3({ optional_host_permissions: ['<all_urls>'], host_permissions: ['https://api.example.com/*'] }) })
  assert.equal(optional.status, 'pass')
})

test('mv3-manifest: WXT chưa build mà wxt.config khai host_permissions rộng ⇒ KHÔNG ĐẠT (không chờ build); không khai rộng ⇒ vẫn THIẾU như cũ', async () => {
  const wxt = { 'package.json': '{"devDependencies":{"wxt":"1"}}' }
  const wide = await mv3Run({ ...wxt, 'wxt.config.ts': "export default { manifest: { host_permissions: ['<all_urls>'] } }" })
  assert.equal(wide.status, 'fail')
  assert.match(wide.detail.join('\n'), /wxt\.config\.ts: host_permissions/)
  const fine = await mv3Run({ ...wxt, 'wxt.config.ts': "export default { manifest: { host_permissions: ['https://api.example.com/*'] } }" })
  assert.equal(fine.status, 'missing')
})

test('mv3-manifest: manifest build cũ / public/ SẠCH không che wxt.config khai host_permissions rộng mới ⇒ KHÔNG ĐẠT nêu wxt.config.ts; wxt.config hẹp ⇒ ĐẠT', async () => {
  const wxt = { 'package.json': '{"devDependencies":{"wxt":"1"}}' }
  const WIDE = "export default { manifest: { host_permissions: ['https://*/*'] } }"
  const NARROW = "export default { manifest: { host_permissions: ['https://api.example.com/*'] } }"
  for (const where of ['.output/chrome-mv3/manifest.json', 'public/manifest.json', 'manifest.json']) {
    const old = { ...wxt, [where]: MV3({ host_permissions: ['https://api.example.com/*'] }) }
    const wide = await mv3Run({ ...old, 'wxt.config.ts': WIDE })
    assert.equal(wide.status, 'fail', `${where}: ${JSON.stringify(wide)}`)
    assert.match(wide.detail.join('\n'), /wxt\.config\.ts: host_permissions[^\n]*https:\/\/\*\/\*/, where)
    assert.equal((await mv3Run({ ...old, 'wxt.config.ts': NARROW })).status, 'pass', where)
  }
  // manifest đã build cũng rộng + cấu hình rộng ⇒ cả hai nơi đều được nêu
  const both = await mv3Run({ ...wxt, '.output/chrome-mv3/manifest.json': MV3({ host_permissions: ['https://*/*'] }), 'wxt.config.ts': WIDE })
  assert.equal(both.status, 'fail')
  assert.match(both.detail.join('\n'), /wxt\.config\.ts: host_permissions/)
})

// --- đợt 3 lượt 2 (QA lượt 1): checker bật app chạy nối tiếp · jscpd 5.x · web-ext với WXT ------------------------------------------------------

test('validateCheckers: exclusive phải là true hoặc false', () => {
  assert.deepEqual(validateCheckers({ checkers: [mk({ id: 'a', exclusive: true }), mk({ id: 'b', exclusive: false })] }), [])
  assert.match(validateCheckers({ checkers: [mk({ id: 'a', exclusive: 'có' })] }).join('\n'), /a: exclusive phải là true hoặc false/)
})

test('exclusive: checker bật app (tranh cùng cổng) chạy NỐI TIẾP từng cái SAU nhóm song song; nhóm còn lại vẫn song song; thứ tự bảng giữ nguyên', async () => {
  const events = []
  let active = 0
  let activeEx = 0
  let peak = 0
  let peakEx = 0
  const exec = async (file, args) => {
    const ex = args[0].startsWith('ex')
    active++; peak = Math.max(peak, active)
    if (ex) { activeEx++; peakEx = Math.max(peakEx, activeEx) }
    events.push(`start ${args[0]}`)
    await new Promise((r) => setTimeout(r, 30))
    events.push(`end ${args[0]}`)
    active--
    if (ex) activeEx--
    return OK
  }
  const checkers = [
    mk({ id: 'ex1', args: ['ex1'], exclusive: true }), mk({ id: 'p1', args: ['p1'] }), mk({ id: 'ex2', args: ['ex2'], exclusive: true }),
    mk({ id: 'p2', args: ['p2'] }), mk({ id: 'p3', args: ['p3'] }),
  ]
  const rep = await runChecks({ dir: project({ 'package.json': '{}' }), checkers, which: whichAll, exec, concurrency: 4 })
  assert.deepEqual(rep.results.map((r) => r.id), ['ex1', 'p1', 'ex2', 'p2', 'p3'])
  assert.deepEqual(rep.results.map((r) => r.status), ['pass', 'pass', 'pass', 'pass', 'pass'])
  assert.equal(peakEx, 1, 'hai checker exclusive không được chạy cùng lúc')
  assert.ok(peak >= 3, `nhóm không exclusive vẫn song song (đỉnh ${peak})`)
  const lastPlainEnd = events.findLastIndex((e) => /^end p\d$/.test(e))
  const firstExStart = events.findIndex((e) => e.startsWith('start ex'))
  assert.ok(lastPlainEnd < firstExStart, `exclusive chỉ bắt đầu khi nhóm song song xong: ${events.join(', ')}`)
  assert.ok(events.indexOf('end ex1') < events.indexOf('start ex2'), events.join(', '))
})

test('checkers.json thật: axe (playwright test tự bật webServer) và ui-rules (ui-check bật dev server) đều exclusive; chạy thật không bao giờ chồng nhau', async () => {
  const get = (id) => REAL.checkers.find((c) => c.id === id)
  assert.equal(get('axe').exclusive, true)
  assert.equal(get('ui-rules').exclusive, true)
  assert.deepEqual(REAL.checkers.filter((c) => c.exclusive).map((c) => c.id), ['axe', 'ui-rules'])
  const dir = project({ 'package.json': { devDependencies: { '@playwright/test': '1', '@axe-core/playwright': '4', typescript: '5' } }, 'tsconfig.json': '{}', '.claude/ui.json': '{}' })
  let appUp = 0
  let overlap = 0
  const seen = []
  const exec = async (file, args) => {
    const app = args[0] === 'test' || /ui-check\.mjs$/.test(args[0])
    if (app) { seen.push(args[0] === 'test' ? 'axe' : 'ui-rules'); appUp++; overlap = Math.max(overlap, appUp) }
    await new Promise((r) => setTimeout(r, 30))
    if (app) appUp--
    return OK
  }
  const rep = await check(dir, ['tsc', 'knip', 'axe', 'ui-rules'], { exec })
  assert.deepEqual(rep.results.map((r) => [r.id, r.status]), [['tsc', 'pass'], ['knip', 'pass'], ['axe', 'pass'], ['ui-rules', 'pass']])
  assert.deepEqual(seen, ['axe', 'ui-rules'])
  assert.equal(overlap, 1)
})

test('jscpd (CLI 5.x): không còn cờ --gitignore (bản 5.x báo "unexpected argument" exit 2); bỏ node_modules/dist qua file cấu hình tạm rồi xoá file', async () => {
  const jc = REAL.checkers.find((c) => c.id === 'jscpd')
  assert.ok(!jc.args.includes('--gitignore'), `args: ${jc.args.join(' ')}`)
  assert.deepEqual(jc.args.slice(0, 2), ['--threshold', '5'])
  assert.equal(jc.plan, 'jscpd')
  const seen = []
  const exec = async (file, args, o) => {
    const at = args.indexOf('--config')
    const cfgPath = args[at + 1]
    seen.push({ args, cwd: o.cwd, cfgPath, cfg: at < 0 ? null : JSON.parse(fs.readFileSync(cfgPath, 'utf8')) })
    return OK
  }
  const dir = project({ 'package.json': '{}' })
  const r = await first(dir, 'jscpd', { exec })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.equal(seen.length, 1)
  const { args, cfg, cfgPath } = seen[0]
  assert.ok(!args.includes('--gitignore'))
  assert.ok(args.includes('--threshold') && args.includes('.'), args.join(' '))
  assert.ok(cfg.ignore.includes('**/node_modules/**') && cfg.ignore.includes('**/dist/**'), JSON.stringify(cfg))
  assert.ok(!cfgPath.includes('\\'), 'đường dẫn file cấu hình dùng dấu / (qua được bộ lọc .cmd của Windows)')
  assert.equal(fs.existsSync(cfgPath), false, 'file cấu hình tạm phải được xoá sau khi chạy')
})

test('jscpd: dự án có .jscpd.json riêng ⇒ cấu hình tạm GỘP (giữ ignore và khoá khác của dự án + thêm node_modules/dist); .jscpd.json hỏng ⇒ chỉ dùng danh sách của kit', async () => {
  const cfgOf = async (files) => {
    let cfg = null
    const exec = async (file, args) => { cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8')); return OK }
    const r = await first(project({ 'package.json': '{}', ...files }), 'jscpd', { exec })
    assert.equal(r.status, 'pass')
    return cfg
  }
  const merged = await cfgOf({ '.jscpd.json': JSON.stringify({ ignore: ['**/gen/**', '**/dist/**'], minLines: 12 }) })
  assert.deepEqual(merged.ignore, ['**/gen/**', '**/dist/**', '**/node_modules/**'])
  assert.equal(merged.minLines, 12)
  assert.deepEqual((await cfgOf({ '.jscpd.json': '{ hỏng' })).ignore, ['**/node_modules/**', '**/dist/**'])
})

test('checkers.json thật: đối số TĨNH của mọi checker chỉ gồm ký tự qua được bộ lọc .cmd của Windows (chữ, số, . : = / -) — glob * hoặc dấu phẩy sẽ bị từ chối ở máy Windows', () => {
  for (const c of REAL.checkers) {
    for (const a of c.args ?? []) assert.match(a.replaceAll('{kit}', '').replaceAll('{hooks}', ''), /^[\w.:=/-]*$/, `${c.id}: đối số ${a}`)
  }
})

const WEBEXT_JSON = ['lint', '--output', 'json']
const webExtOut = (errors = [], warnings = []) => JSON.stringify({ count: errors.length + warnings.length, summary: { errors: errors.length, notices: 0, warnings: warnings.length }, errors, notices: [], warnings })
const wxErr = (code, message = `lỗi ${code}`) => ({ _type: 'error', code, message, file: 'manifest.json' })
const FIREFOX_ONLY = [wxErr('BACKGROUND_SERVICE_WORKER_NOFALLBACK'), wxErr('ADDON_ID_REQUIRED')]
const webExtExec = (stdout, code = 0, seen = []) => async (file, args, o) => { seen.push({ args, cwd: o.cwd }); return { ...OK, code, stdout } }

test('web-ext-lint × WXT: có wxt.config.* và bản build .output/chrome-mv3 ⇒ lint thư mục đó (--source-dir) chạy từ gốc dự án; chưa build ⇒ THIẾU kèm dặn build, không chạy web-ext', async () => {
  const wxt = { 'package.json': '{"devDependencies":{"wxt":"1"}}', 'wxt.config.ts': 'export default {}' }
  const seen = []
  const exec = webExtExec(webExtOut(), 0, seen)
  const built = project({ ...wxt, '.output/chrome-mv3/manifest.json': MV3() })
  const ok = await first(built, 'web-ext-lint', { exec })
  assert.equal(ok.status, 'pass', JSON.stringify(ok))
  assert.deepEqual(seen[0].args, [...WEBEXT_JSON, '--source-dir', '.output/chrome-mv3'])
  assert.equal(fs.realpathSync(seen[0].cwd), fs.realpathSync(built), 'chạy từ gốc dự án, không phải từ trong thư mục build')
  seen.length = 0
  const unbuilt = await first(project(wxt), 'web-ext-lint', { exec })
  assert.equal(unbuilt.status, 'missing')
  assert.match(unbuilt.message, /build/i)
  assert.match(unbuilt.fix, /build/i)
  assert.equal(seen.length, 0, 'chưa có bản build thì không chạy web-ext')
})

test('web-ext-lint × WXT với outDir "dist" (mẫu extension của kit): manifest ở dist/ ⇒ lint thẳng trong dist/, không cần --source-dir; dist/ thắng .output/ cũ còn sót', async () => {
  const wxt = { 'package.json': '{"devDependencies":{"wxt":"1"}}', 'wxt.config.ts': "export default { outDir: 'dist' }", 'dist/manifest.json': MV3() }
  const seen = []
  const dir = project(wxt)
  const r = await first(dir, 'web-ext-lint', { exec: webExtExec(webExtOut(), 0, seen) })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.deepEqual(seen[0].args, WEBEXT_JSON)
  assert.equal(fs.realpathSync(seen[0].cwd), fs.realpathSync(path.join(dir, 'dist')))
  seen.length = 0
  const both = project({ ...wxt, '.output/chrome-mv3/manifest.json': MV3() })
  await first(both, 'web-ext-lint', { exec: webExtExec(webExtOut(), 0, seen) })
  assert.deepEqual(seen[0].args, WEBEXT_JSON)
})

test('web-ext-lint: extension thường (manifest.json ở gốc, không wxt.config) ⇒ `web-ext lint --output json` chạy trong thư mục chứa manifest', async () => {
  const seen = []
  const dir = project({ 'manifest.json': MV3() })
  const r = await first(dir, 'web-ext-lint', { exec: webExtExec(webExtOut(), 0, seen) })
  assert.equal(r.status, 'pass')
  assert.deepEqual(seen[0].args, WEBEXT_JSON)
  assert.equal(fs.realpathSync(seen[0].cwd), fs.realpathSync(dir))
})

test('web-ext-lint: bản Chrome-only (manifest không có browser_specific_settings.gecko) ⇒ bỏ 2 lỗi CHỈ của Firefox (BACKGROUND_SERVICE_WORKER_NOFALLBACK, ADDON_ID_REQUIRED), vẫn ĐẠT và nói rõ đã bỏ', async () => {
  const dir = project({ 'manifest.json': MV3({ background: { service_worker: 'bg.js' } }) })
  const r = await first(dir, 'web-ext-lint', { exec: webExtExec(webExtOut(FIREFOX_ONLY), 1) })
  assert.equal(r.status, 'pass', JSON.stringify(r))
  assert.match(r.detail.join('\n'), /bỏ 2 lỗi chỉ của Firefox/)
})

test('web-ext-lint: lỗi khác vẫn KHÔNG ĐẠT và chỉ liệt kê lỗi thật (không kể 2 mã Firefox-only); manifest khai gecko ⇒ không lọc gì', async () => {
  const chrome = project({ 'manifest.json': MV3() })
  const real = wxErr('MANIFEST_FIELD_REQUIRED', 'Thiếu trường name')
  const bad = await first(chrome, 'web-ext-lint', { exec: webExtExec(webExtOut([...FIREFOX_ONLY, real]), 1) })
  assert.equal(bad.status, 'fail')
  assert.match(bad.message, /1 lỗi/)
  const text = bad.detail.join('\n')
  assert.match(text, /MANIFEST_FIELD_REQUIRED/)
  assert.doesNotMatch(text, /ADDON_ID_REQUIRED|BACKGROUND_SERVICE_WORKER_NOFALLBACK/)
  assert.ok(bad.fix)
  const gecko = project({ 'manifest.json': MV3({ browser_specific_settings: { gecko: { id: 'x@y.z' } } }) })
  const ff = await first(gecko, 'web-ext-lint', { exec: webExtExec(webExtOut(FIREFOX_ONLY), 1) })
  assert.equal(ff.status, 'fail')
  assert.match(ff.detail.join('\n'), /ADDON_ID_REQUIRED/)
})

test('web-ext-lint: output không phải JSON đọc được ⇒ theo mã thoát như cũ (0 đạt, khác 0 KHÔNG ĐẠT kèm output), không đạt giả', async () => {
  const dir = project({ 'manifest.json': MV3() })
  const bad = await first(dir, 'web-ext-lint', { exec: async () => ({ ...OK, code: 1, stdout: 'Error: không đọc được manifest' }) })
  assert.equal(bad.status, 'fail')
  assert.match(bad.detail.join('\n'), /không đọc được manifest/)
  assert.equal((await first(dir, 'web-ext-lint', { exec: async () => ({ ...OK, code: 0, stdout: 'ok' }) })).status, 'pass')
})

test('size-limit: lệnh cài gợi ý @size-limit/file (preset-app kéo puppeteer có lỗ hổng chưa vá)', () => {
  const sl = REAL.checkers.find((c) => c.id === 'size-limit')
  assert.match(sl.install, /size-limit @size-limit\/file$/)
  assert.doesNotMatch(sl.install, /preset-app/)
})

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
import { INTERNALS, KIT_DIR, exitCode, findTool, formatReport, loadCheckers, main, mv3Problems, runChecks, validateCheckers } from './flow-check.mjs'
import { STACKS, detect, matches, roots } from './lib/stack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'flow-check.mjs')
const IS_WIN = process.platform === 'win32'

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
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

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

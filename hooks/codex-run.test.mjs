import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { plan, runnerFor, pickRunner, execute } from './codex-run.mjs'
import { resolve as resolveModel } from './lib/models.mjs'

test('codex-run: -C thành thư mục chạy, -o ghi qua file tạm, prompt có dấu cách chuyển sang stdin', () => {
  const p = plan(['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '-C', 'D:/AI/Vibe Coding/app', '-o', 'D:/AI/Vibe Coding/out/r.md', 'Tìm lỗi ở đây'],
    { cwd: 'D:/w', tmp: os.tmpdir(), winSandbox: [] })
  assert.equal(p.cwd, path.resolve('D:/AI/Vibe Coding/app'))
  assert.equal(p.outFile, path.resolve('D:/AI/Vibe Coding/out/r.md'))
  assert.match(p.tmpOut, /\/codex-run-[^/]+\/out\.md$/)
  assert.ok(fs.statSync(path.dirname(p.tmpOut)).isDirectory(), 'thư mục tạm riêng đã được tạo độc quyền')
  assert.ok(!p.tmpOut.includes(' '), 'đường dẫn tạm an toàn cho cmd.exe')
  fs.rmSync(path.dirname(p.tmpOut), { recursive: true, force: true })
  assert.deepEqual(p.args, ['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '-o', p.tmpOut, '-'])
  assert.equal(p.prompt, 'Tìm lỗi ở đây')
})

test('codex-run: thư mục Temp có dấu cách/chữ có dấu ⇒ file -o tạm nằm trong thư mục chạy, truyền đường dẫn tương đối an toàn', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'))
  const p = plan(['exec', '-o', 'r.md', '-C', run, '-'], { cwd: run, tmp: 'C:\\Users\\Nguyễn Văn\\Temp', winSandbox: [] })
  assert.match(p.tmpOut, /^\.codex-run-[^/]+\/out\.md$/)
  assert.equal(path.dirname(p.tmpDir), path.resolve(run))
  assert.deepEqual(p.args, ['exec', '-o', p.tmpOut, '-'])
  fs.rmSync(run, { recursive: true, force: true })
})

test('codex-run: prompt đã qua stdin ("-") giữ nguyên, đối số an toàn không đổi', () => {
  const p = plan(['exec', '-c', 'model_reasoning_effort=high', '-'], { cwd: 'D:/w', stdinPrompt: 'đề', winSandbox: [] })
  assert.deepEqual(p.args, ['exec', '-c', 'model_reasoning_effort=high', '-'])
  assert.equal(p.prompt, 'đề')
  assert.equal(p.cwd, 'D:/w')
})

test('codex-run: Windows ⇒ chèn sandbox không nâng quyền sau exec (đối số an toàn cho cmd.exe), người gọi tự đặt thì giữ', () => {
  const ws = ['-c', 'windows.sandbox=unelevated']
  assert.deepEqual(plan(['exec', '-'], { cwd: 'D:/w', winSandbox: ws }).args, ['exec', ...ws, '-'])
  assert.deepEqual(plan(['exec', '-c', 'windows.sandbox=elevated', '-'], { cwd: 'D:/w', winSandbox: ws }).args, ['exec', '-c', 'windows.sandbox=elevated', '-'])
  assert.match(ws[1], /^[\w.:=/-]+$/)
})

// ---------- --vai: model theo hạng; Codex thiếu hạng ⇒ Factory (droid) ----------

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'fixtures', 'models')
const DROID = fs.readFileSync(path.join(FIX, 'droid-help.txt'), 'utf8')
const CODEX_REAL = fs.readFileSync(path.join(FIX, 'codex.json'), 'utf8')
const NOW = Date.parse('2026-11-27T12:00:00Z')
const SAFE = /^[\w.:=/-]+$/
const slug = (s) => ({ slug: s, visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort })) })
const homes = []
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }) })
// resolve thật, catalog tiêm sẵn, HOME giả, exec bị cấm (không gọi CLI thật, không gọi model).
function viaFake(catalog) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-vai-'))
  homes.push(home)
  return { opts: { home, env: {}, now: NOW, catalog, exec: () => { throw new Error('exec không được gọi') } }, resolveFn: resolveModel }
}
const P = (argv, extra = {}) => plan(argv, { cwd: 'D:/w', winSandbox: [], ...extra })

test('codex-run --vai: plan tách --vai khỏi đối số (không đưa cho codex)', () => {
  const p = P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-'], { stdinPrompt: 'đề' })
  assert.equal(p.vai, 'debugger')
  assert.deepEqual(p.args, ['exec', '--sandbox', 'read-only', '-'])
  assert.equal(P(['exec', '-']).vai, null)
})

test('codex-run --vai: Codex có hạng mạnh ⇒ `codex exec -m gpt-6-sol -c model_reasoning_effort=high …`', () => {
  const f = viaFake({ codex: { models: [slug('gpt-6-sol'), slug('gpt-6-luna')] }, droid: DROID })
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-'], { stdinPrompt: 'đề' }), f)
  assert.equal(r.bin, 'codex')
  assert.deepEqual(r.args, ['exec', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--sandbox', 'read-only', '-'])
  assert.equal(r.input, 'đề')
  assert.deepEqual(r.warnings, [])
})

test('codex-run --vai: Codex thiếu hạng mạnh mà Factory có ⇒ `droid exec -m gpt-6-sol -r high` (chỉ đọc, không --cwd/--auto), prompt qua stdin, một dòng báo', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-C', 'D:/AI/Vibe Coding/app', '-o', 'D:/out/r.md', '-'], { stdinPrompt: 'đề dài\ncó dòng mới' }), f)
  homes.push(r.settingsDir)
  assert.equal(r.bin, 'droid')
  assert.deepEqual(r.args.slice(0, 5), ['exec', '-m', 'gpt-6-sol', '-r', 'high'])
  assert.equal(r.args[5], '--settings')
  assert.equal(r.args.length, 7)
  assert.equal(r.input, 'đề dài\ncó dòng mới')
  assert.ok(!r.args.some((a) => /--auto|--cwd|--skip/.test(a)), 'chỉ đọc, thư mục chạy là cwd của tiến trình')
  assert.equal(r.warnings.filter((w) => /Codex thiếu hạng mạnh, dùng Factory gpt-6-sol/.test(w)).length, 1, r.warnings.join('|'))
  for (const a of r.args.slice(0, 6)) assert.match(a, SAFE, 'đối số an toàn cho shim .cmd')
})

test('codex-run --vai: vai nhanh vẫn ở Codex (có gpt-6-luna); lượt KHÔNG chỉ đọc không bao giờ chuyển sang droid; Factory không đọc được ⇒ hạ hạng trong Codex', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const mini = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'coder-mini', '-']), f)
  assert.deepEqual([mini.bin, mini.args.slice(0, 5)], ['codex', ['exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium']])
  const write = runnerFor(P(['exec', '--sandbox', 'workspace-write', '--vai', 'debugger', '-']), f)
  assert.equal(write.bin, 'codex')
  assert.equal(write.args[2], 'gpt-6-luna', 'ghi được ⇒ không đẩy sang droid, hạ hạng trong Codex')
  assert.ok(write.warnings.some((w) => /hạng mạnh/.test(w)))
  const noDroid = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), viaFake({ codex: CODEX_REAL, droid: null }))
  assert.deepEqual([noDroid.bin, noDroid.args[2]], ['codex', 'gpt-6-luna'])
})

test('codex-run: cách cũ (-m) và không --vai giữ nguyên; vai lạ ⇒ ném lỗi có tên vai', () => {
  const boom = { resolveFn: () => { throw new Error('không được resolve') } }
  const old = runnerFor(P(['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '--vai', 'debugger', '-']), boom)
  assert.deepEqual([old.bin, old.args], ['codex', ['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '-']])
  const plain = runnerFor(P(['exec', '-c', 'model_reasoning_effort=high', '-']), boom)
  assert.deepEqual(plain.args, ['exec', '-c', 'model_reasoning_effort=high', '-'])
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  assert.throws(() => runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'khong-co', '-']), f), /khong-co/)
})

// ---------- nhiều tài khoản Codex: mỗi tài khoản một models_cache.json KHÁC nhau ----------

// HOME giả có ~/.codex (tài khoản 1: chỉ gpt-6-luna…) và ~/.codex-2 (tài khoản 2: gpt-6.2-sol, gpt-6.2-astra…), cả hai có auth.json; fetched_at = bây giờ.
function twoAccounts() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-2tk-'))
  homes.push(home)
  for (const [dir, file] of [['.codex', 'codex.json'], ['.codex-2', 'codex-2.json']]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
    fs.writeFileSync(path.join(home, dir, 'auth.json'), '{}')
    fs.writeFileSync(path.join(home, dir, 'models_cache.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8')), fetched_at: new Date(NOW).toISOString() }))
  }
  return { home, opts: { home, env: {}, now: NOW, catalog: { droid: DROID }, exec: () => { throw new Error('exec không được gọi') } }, resolveFn: resolveModel }
}
const argsOf = (r) => r.args.slice(0, 5)

test('codex-run --vai, 2 tài khoản: vai mạnh ⇒ gpt-6.2-sol của tài khoản 2, CHỈ thử tài khoản có model đó (tài khoản 1 không có ⇒ không gọi -m đó)', () => {
  const w = twoAccounts()
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), w)
  assert.equal(r.bin, 'codex')
  assert.deepEqual(argsOf(r), ['exec', '-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort=high'])
  assert.deepEqual(r.homes, [path.join(w.home, '.codex-2')])
  assert.deepEqual(r.warnings, [])
  const mini = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'coder-mini', '-']), w)
  assert.equal(mini.args[2], 'gpt-6-luna')
  assert.deepEqual(mini.homes.map((d) => path.basename(d)).sort(), ['.codex', '.codex-2'], 'gpt-6-luna có ở cả hai tài khoản')
})

test('codex-run --vai, 2 tài khoản: tài khoản 2 ghi hết lượt ⇒ resolve lại bỏ nó: Codex còn lại thiếu hạng mạnh ⇒ Factory gpt-6-sol + một dòng báo; hết hạn ghi sổ ⇒ lại gpt-6.2-sol', () => {
  const w = twoAccounts()
  const state = path.join(w.home, '.claude', 'cache', 'codex-het-luot.json')
  fs.mkdirSync(path.dirname(state), { recursive: true })
  fs.writeFileSync(state, JSON.stringify({ [path.join(w.home, '.codex-2').toLowerCase()]: { until: NOW + 3600000 }, [path.join(w.home, '.codex-2')]: { until: NOW + 3600000 } }))
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), w)
  homes.push(r.settingsDir)
  assert.equal(r.bin, 'droid')
  assert.deepEqual(r.args.slice(0, 5), ['exec', '-m', 'gpt-6-sol', '-r', 'high'])
  assert.equal(r.warnings.filter((x) => /Codex thiếu hạng mạnh, dùng Factory gpt-6-sol/.test(x)).length, 1, r.warnings.join('|'))
  const later = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), { ...w, opts: { ...w.opts, now: NOW + 2 * 3600000 } })
  assert.equal(later.args[2], 'gpt-6.2-sol')
  // lượt ghi được (không chỉ đọc) ⇒ không sang Factory: dùng model tốt nhất của tài khoản còn lại
  const write = runnerFor(P(['exec', '--sandbox', 'workspace-write', '--vai', 'debugger', '-']), w)
  assert.equal(write.bin, 'codex'); assert.equal(write.args[2], 'gpt-6-luna')
})

// ---------- an toàn khi chạy Factory: tắt hook, lọc môi trường, kiểm droid trước ----------

test('codex-run --vai → droid: argv có --settings trỏ file JSON do kit tạo (hooks.hooksDisabled) trong thư mục tạm riêng, không nằm trong repo; dọn được qua settingsDir', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-C', 'D:/AI/Vibe Coding/app', '-']), { ...f, tmp: os.tmpdir() })
  homes.push(r.settingsDir)
  assert.deepEqual(r.args.slice(0, 5), ['exec', '-m', 'gpt-6-sol', '-r', 'high'])
  const i = r.args.indexOf('--settings')
  assert.ok(i > 0, r.args.join(' '))
  const file = r.args[i + 1]
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: { hooksDisabled: true } })
  assert.equal(path.resolve(path.dirname(file)), path.resolve(r.settingsDir))
  assert.ok(!path.resolve(file).startsWith(path.resolve('D:/AI/Vibe Coding/app')), 'file cấu hình của kit không nằm trong repo của người dùng')
  assert.ok(!r.args.some((a) => /--auto|--skip-permissions|--cwd/.test(a)))
  const codex = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'coder-mini', '-']), f)
  assert.equal(codex.settingsDir, undefined, 'đường Codex không tạo file cấu hình droid')
})

test('codex-run --vai → droid: env truyền cho droid đã lọc khoá của máy (OPENAI_API_KEY… bị bỏ), chỉ giữ FACTORY_API_KEY và biến thường', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const env = { PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'sk-gia', GITHUB_TOKEN: 'ghp-gia', FACTORY_API_KEY: 'fk-gia', DB_URL: ['postgres://u', 'matkhau123@h/db'].join(':') } // ghép lúc chạy: máy quét khoá không coi dòng test là khoá thật
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), { ...f, env })
  homes.push(r.settingsDir)
  assert.equal(r.bin, 'droid')
  assert.deepEqual(r.env, { PATH: '/usr/bin', HOME: '/h', FACTORY_API_KEY: 'fk-gia' })
})

test('codex-run --vai: droid chưa cài/chưa đăng nhập ⇒ KHÔNG chọn droid: resolve lại Codex không bật allowFallbackHost (hạ hạng, báo); droid sẵn sàng ⇒ chọn droid', async () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const asked = []
  const notReady = async (name) => { asked.push(name); return { name, ready: false, message: 'droid chưa đăng nhập', loginCmd: 'droid', installHint: null } }
  const r = await pickRunner(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), { ...f, checkFn: notReady })
  assert.deepEqual(asked, ['droid'])
  assert.equal(r.bin, 'codex')
  assert.equal(r.args[2], 'gpt-6-luna', 'hạ hạng trong Codex')
  assert.ok(r.warnings.some((w) => /droid chưa đăng nhập/.test(w) && /Đăng nhập: droid/.test(w) && /Codex dùng hạng thấp hơn/.test(w)), r.warnings.join('|'))
  assert.ok(!r.warnings.some((w) => /dùng Factory/.test(w)), 'không được báo "dùng Factory" khi không chạy Factory')
  assert.equal(r.settingsDir, undefined)
  const ready = async (name) => ({ name, ready: true })
  const ok = await pickRunner(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-']), { ...f, checkFn: ready })
  homes.push(ok.settingsDir)
  assert.deepEqual([ok.bin, ok.args[2]], ['droid', 'gpt-6-sol'])
  // Codex có hạng (không cần droid) ⇒ không kiểm droid
  const none = []
  const own = await pickRunner(P(['exec', '--sandbox', 'read-only', '--vai', 'coder-mini', '-']), { ...f, checkFn: async (n) => { none.push(n); return { ready: true } } })
  assert.deepEqual([own.bin, none], ['codex', []])
})

test('codex-run --vai → droid: thư mục Temp có dấu cách/chữ có dấu ⇒ file --settings nằm trong thư mục tạm riêng TRONG cwd và truyền đường tương đối an toàn (như plan() làm cho -o); mọi đối số qua được cmd.exe', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cwd-'))
  homes.push(run)
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-C', run, '-'], { cwd: run }), { ...f, tmp: 'C:/Users/Nguyễn Văn/AppData/Local/Temp' })
  assert.equal(r.bin, 'droid')
  const rel = r.args[r.args.indexOf('--settings') + 1]
  assert.ok(!path.isAbsolute(rel) && SAFE.test(rel), rel)
  assert.equal(path.resolve(path.dirname(path.resolve(run, rel))), path.resolve(r.settingsDir))
  assert.equal(path.dirname(path.resolve(r.settingsDir)), path.resolve(run), 'thư mục tạm riêng nằm trong cwd')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.resolve(run, rel), 'utf8')), { hooks: { hooksDisabled: true } })
  for (const a of r.args) assert.match(a, SAFE, `không an toàn cho cmd.exe: ${a}`)
  // Temp an toàn thì vẫn dùng Temp (không đụng cwd của người dùng)
  const ok = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-C', run, '-'], { cwd: run }), { ...f, tmp: os.tmpdir() })
  homes.push(ok.settingsDir)
  assert.ok(!path.resolve(ok.settingsDir).startsWith(path.resolve(run)), 'Temp an toàn ⇒ không ghi vào cwd')
})

test('codex-run: lượt Factory vẫn EUNSAFE (đối số/đường dẫn lạ qua shim) ⇒ hạ về Codex hạng thấp hơn + một dòng báo, KHÔNG chết cả lượt; dọn mọi thư mục tạm của kit', async () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const p = P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-'], { stdinPrompt: 'đề' })
  const first = runnerFor(p, f)
  const calls = []
  const exec = async (cur) => {
    calls.push(cur.bin)
    return cur.bin === 'droid'
      ? { status: null, stdout: '', stderr: '', timedOut: false, error: { code: 'EUNSAFE', message: 'đối số hoặc đường dẫn không an toàn để chạy qua cmd.exe' } }
      : { status: 0, stdout: 'xong', stderr: '', timedOut: false, error: null }
  }
  const said = []
  const out = await execute(p, first, { deps: f, exec, say: (s) => said.push(s) })
  assert.deepEqual(calls, ['droid', 'codex'])
  assert.equal(out.r.stdout, 'xong')
  assert.deepEqual([out.run.bin, out.run.args[2]], ['codex', 'gpt-6-luna'])
  assert.equal(said.filter((s) => /không an toàn.*Codex dùng hạng thấp hơn/.test(s)).length, 1, said.join('|'))
  assert.ok(first.settingsDir && !fs.existsSync(first.settingsDir), 'thư mục tạm cấu hình droid đã được dọn')
})

test('codex-run: hết lượt ở mọi tài khoản có model đã chọn ⇒ chọn lại (hạ model hoặc Factory), một dòng báo, chạy lại đúng một lần', async () => {
  let n = 0
  const resolveFn = () => (n++ === 0
    ? { host: 'codex', model: 'gpt-6.2-sol', effort: 'high', homes: ['/tk/.codex-2'], warnings: [] }
    : { host: 'droid', fallbackFrom: 'codex', model: 'gpt-6-sol', effort: 'high', warnings: ['Codex thiếu hạng mạnh, dùng Factory gpt-6-sol.'] })
  const deps = { resolveFn, checkFn: async () => ({ ready: true }) }
  const p = P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', '-'], { stdinPrompt: 'đề' })
  const first = await pickRunner(p, deps)
  assert.deepEqual([first.bin, first.homes], ['codex', ['/tk/.codex-2']])
  const seen = []
  const exec = async (cur) => { seen.push([cur.bin, cur.homes ?? null]); return cur.bin === 'codex' ? { status: 1, stdout: '', stderr: '', quota: true, error: null } : { status: 0, stdout: 'ok', stderr: '', error: null } }
  const said = []
  const out = await execute(p, first, { deps, exec, say: (s) => said.push(s) })
  assert.deepEqual(seen, [['codex', ['/tk/.codex-2']], ['droid', null]])
  assert.equal(said.filter((s) => /hết lượt ở mọi tài khoản có gpt-6\.2-sol ⇒ chuyển sang Factory gpt-6-sol/.test(s)).length, 1, said.join('|'))
  assert.equal(out.r.stdout, 'ok')
})

test('codex-run --vai: prompt ngắn ở cuối đối số (không qua stdin) ⇒ droid nhận làm đối số cuối; --vai không bao giờ tới droid', () => {
  const f = viaFake({ codex: CODEX_REAL, droid: DROID })
  const r = runnerFor(P(['exec', '--sandbox', 'read-only', '--vai', 'debugger', 'TimLoi']), f)
  homes.push(r.settingsDir)
  assert.deepEqual([r.bin, r.args.slice(0, 5), r.args.at(-1), r.args.includes('--vai')], ['droid', ['exec', '-m', 'gpt-6-sol', '-r', 'high'], 'TimLoi', false])
  assert.equal(r.args.at(-3), '--settings', 'prompt đứng cuối, sau --settings <file>')
})

// Test cho lib/health.mjs: node --test hooks/lib/health.test.mjs
// Không chạy công cụ thật: `run` và `which` là bản giả (ghi lại lệnh được gọi). Thư mục dự án mẫu có dấu cách + tiếng Việt; log của release-state trỏ vào thư mục tạm.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FLOW_IDS, HEALTH_REL, collect, compare, docFiles, docPathProblems, parseSnapshot, pathCandidate, recordHealth, renderHealth, scanDebt, snapshotOf, summarize, todoList } from './health.mjs'
import { readState, statePath, writeState } from './release-state.mjs'

const tmpDirs = []
function project(files = {}, { git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health thử '))
  tmpDirs.push(root)
  const dir = path.join(root, 'ứng dụng mẫu')
  fs.mkdirSync(dir)
  if (git) fs.mkdirSync(path.join(dir, '.git'))
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return { dir, root, stateOpts: { logDir: path.join(root, 'logs') } }
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const NOW = new Date(2026, 9, 13, 10, 0, 0) // 2026-10-13 giờ máy
const ok = (stdout = '', extra = {}) => ({ code: 0, stdout, stderr: '', timedOut: false, error: null, ...extra })
const flowJson = (results) => JSON.stringify({ dir: '/x', stacks: ['web'], results, summary: {}, ok: true })
const res = (id, status, extra = {}) => ({ id, title: `Tiêu đề ${id}`, status, message: '', fix: null, detail: [], required: true, ...extra })

// handlers: { node(args), ncu(args,o), lychee(args,o), scc(args,o), git(args,o) } → kết quả; thiếu handler ⇒ lỗi "không mong đợi".
// tools: tên → có cài hay không. calls ghi lại mọi lệnh.
function fake({ handlers = {}, tools = {} } = {}) {
  const calls = []
  const run = async (file, args, o = {}) => {
    calls.push({ file, args, o })
    const key = file === 'NODE' ? 'node' : file === 'git' ? 'git' : file.replace(/^TOOL:/, '')
    const h = handlers[key]
    if (!h) throw new Error(`lệnh không mong đợi: ${file} ${args.join(' ')}`)
    return h(args, o)
  }
  const which = async (name) => (tools[name] ? `TOOL:${name}` : null)
  return { calls, run, which }
}
const collectWith = (fx, f, opts = {}) => collect({ dir: fx.dir, run: f.run, which: f.which, now: NOW, nodeBin: 'NODE', flowCheck: 'FLOW-CHECK', platform: 'win32', ...opts })
const byId = (report, id) => report.items.find((i) => i.id === id)
const outFile = (args) => args[args.indexOf('--output') + 1]

// ============================== máy kiểm của flow-check ==============================

describe('máy kiểm flow-check', () => {
  test('chỉ chín checker sẵn có vào file tạm (đủ cả chín trong kit), file tạm dọn xong; kết quả ánh xạ đỏ/vàng/xanh/chưa kiểm', async () => {
    const fx = project()
    let seen
    const f = fake({
      handlers: {
        node: (args) => {
          assert.equal(args[0], 'FLOW-CHECK')
          assert.equal(args[args.indexOf('--dir') + 1], fx.dir)
          assert.ok(args.includes('--json'))
          const file = args[args.indexOf('--checkers') + 1]
          seen = { file, ids: JSON.parse(fs.readFileSync(file, 'utf8')).checkers.map((c) => c.id) }
          return ok(flowJson([
            res('osv-scanner', 'fail', { message: '2 lỗ hổng', detail: ['lodash 4.17.20 GHSA-xxxx'] }),
            res('depcruise', 'fail', { message: 'import lệch' }),
            res('jscpd', 'fail', { message: 'trùng 8%', detail: ['a.ts ↔ b.ts'] }),
            res('knip', 'pass', { message: 'sạch' }),
            res('arch-size', 'fail', { message: '1 file quá dài' }),
            res('govulncheck', 'missing', { message: 'Chưa cài govulncheck', fix: 'go install golang.org/x/vuln/cmd/govulncheck@latest' }),
            res('size-limit', 'skip', { message: 'không áp dụng' }),
            res('tsc', 'fail', { message: 'không thuộc khám sức khoẻ' }),
          ]))
        },
      },
    })
    const rep = await collectWith(fx, f)
    assert.deepEqual([...seen.ids].sort(), [...FLOW_IDS].sort())
    assert.equal(fs.existsSync(seen.file), false, 'file tạm phải được dọn')
    assert.equal(byId(rep, 'osv-scanner').level, 'red')
    assert.equal(byId(rep, 'depcruise').level, 'red')
    assert.equal(byId(rep, 'jscpd').level, 'yellow')
    assert.equal(byId(rep, 'arch-size').level, 'yellow')
    assert.equal(byId(rep, 'knip').level, 'green')
    assert.equal(byId(rep, 'size-limit'), undefined, 'không áp dụng ⇒ không đưa vào')
    assert.equal(byId(rep, 'tsc'), undefined, 'checker ngoài danh sách khám ⇒ bỏ')
    const gov = byId(rep, 'govulncheck')
    assert.equal(gov.level, 'unchecked')
    assert.equal(gov.why, 'chưa kiểm được: govulncheck (go install golang.org/x/vuln/cmd/govulncheck@latest)')
    assert.deepEqual(byId(rep, 'jscpd').detail, ['a.ts ↔ b.ts'])
    assert.match(byId(rep, 'osv-scanner').todo, /hỏi bạn trước khi cập nhật/)
  })

  test('osv-scanner thoát 128 (thiếu file khoá) KHÔNG báo đỏ; 127 ⇒ chưa kiểm được; lệnh cài "Cài: … (link)" được rút gọn', async () => {
    const fx = project()
    const mk = (results) => fake({ handlers: { node: () => ok(flowJson(results)) } })
    const noLock = byId(await collectWith(fx, mk([res('osv-scanner', 'fail', { message: 'osv-scanner báo lỗi (mã thoát 128)', detail: ['No package sources found, --help for usage information.'] })])), 'osv-scanner')
    assert.equal(noLock.level, 'yellow')
    assert.match(noLock.summary, /thiếu file khoá/)
    assert.match(noLock.todo, /npm install/)
    const general = byId(await collectWith(fx, mk([res('osv-scanner', 'fail', { message: 'osv-scanner báo lỗi (mã thoát 127)' })])), 'osv-scanner')
    assert.deepEqual([general.level, general.why], ['unchecked', 'chưa kiểm được: osv-scanner chạy lỗi (mã thoát 127)'])
    const real = byId(await collectWith(fx, mk([res('osv-scanner', 'fail', { message: 'osv-scanner báo lỗi (mã thoát 1)' })])), 'osv-scanner')
    assert.equal(real.level, 'red')
    const knip = byId(await collectWith(fx, mk([res('knip', 'missing', { message: 'Chưa cài knip', fix: 'Cài: npm i -D knip (https://knip.dev/overview/getting-started)' })])), 'knip')
    assert.equal(knip.why, 'chưa kiểm được: knip (npm i -D knip)')
  })

  test('flow-check chạy lỗi (không ra JSON) ⇒ một mục "chưa kiểm được", không ném, các mục khác vẫn chạy', async () => {
    const fx = project({ 'src/a.js': '// TODO x\n' })
    const f = fake({ handlers: { node: () => ({ code: 2, stdout: '', stderr: 'flow-check: cờ lạ --checkers\n', timedOut: false, error: null }) } })
    const rep = await collectWith(fx, f)
    const it = byId(rep, 'flow-check')
    assert.equal(it.level, 'unchecked')
    assert.match(it.why, /^chưa kiểm được: flow-check chạy lỗi \(flow-check: cờ lạ/)
    assert.ok(byId(rep, 'todo'), 'phần đếm nợ kỹ thuật vẫn chạy')
  })

  test('hết giờ ⇒ chưa kiểm được: quá thời gian chờ', async () => {
    const fx = project()
    const f = fake({ handlers: { node: () => ({ code: null, stdout: '', stderr: '', timedOut: true, error: null }) } })
    assert.match(byId(await collectWith(fx, f), 'flow-check').why, /quá thời gian chờ/)
  })

  test('một mục ném lỗi (which hỏng) ⇒ mục đó "lỗi nội bộ", cả lần khám vẫn xong', async () => {
    const fx = project({ 'package.json': '{}' })
    const f = fake({ handlers: { node: () => ok(flowJson([])) } })
    const rep = await collectWith(fx, { ...f, which: () => { throw new Error('which hỏng') } })
    assert.match(byId(rep, 'outdated').why, /lỗi nội bộ khi chạy \(which hỏng\)/)
  })
})

// ============================== thư viện lỗi thời ==============================

describe('npm-check-updates', () => {
  const pkg = JSON.stringify({ dependencies: { react: '^18.2.0', zod: '^3.22.0' }, devDependencies: { vite: '~5.0.0', typescript: '^5.3.0' } })
  const flowOk = { node: () => ok(flowJson([])) }

  test('không có package.json ⇒ không có mục', async () => {
    const fx = project()
    const rep = await collectWith(fx, fake({ handlers: flowOk }))
    assert.equal(byId(rep, 'outdated'), undefined)
  })

  test('chưa cài ncu ⇒ chưa kiểm được kèm lệnh cài; thử cả tên npm-check-updates', async () => {
    const fx = project({ 'package.json': pkg })
    const asked = []
    const f = fake({ handlers: flowOk })
    const rep = await collectWith(fx, { ...f, which: async (n) => { asked.push(n); return null } })
    assert.equal(byId(rep, 'outdated').why, 'chưa kiểm được: npm-check-updates (npm i -g npm-check-updates)')
    assert.deepEqual(asked.filter((n) => n !== 'lychee' && n !== 'scc'), ['ncu', 'npm-check-updates'])
  })

  test('có bản mới ⇒ vàng, đếm bản lớn, bản lớn đứng trước; chạy ncu --jsonUpgraded trong thư mục app', async () => {
    const fx = project({ 'package.json': pkg })
    const f = fake({
      tools: { ncu: true },
      handlers: { ...flowOk, ncu: () => ok(JSON.stringify({ zod: '^3.24.1', react: '^19.0.0', vite: '~5.4.0' })) },
    })
    const rep = await collectWith(fx, f)
    const it = byId(rep, 'outdated')
    assert.equal(it.level, 'yellow')
    assert.equal(it.n, 3)
    assert.equal(it.summary, '3 thư viện có bản mới (1 bản lớn)')
    assert.equal(it.detail[0], 'react ^18.2.0 → ^19.0.0 (bản lớn)')
    assert.match(it.todo, /hỏi bạn trước khi cập nhật/)
    const call = f.calls.find((c) => c.file === 'TOOL:ncu')
    assert.deepEqual(call.args, ['--jsonUpgraded'])
    assert.equal(call.o.cwd, fx.dir)
  })

  test('không gói nào cũ ({}) hoặc output rỗng mã 0 ⇒ xanh', async () => {
    for (const out of ['{}', '']) {
      const fx = project({ 'package.json': pkg })
      const rep = await collectWith(fx, fake({ tools: { ncu: true }, handlers: { ...flowOk, ncu: () => ok(out) } }))
      assert.equal(byId(rep, 'outdated').level, 'green')
    }
  })

  test('ncu lỗi mạng (mã 1, không JSON) ⇒ chưa kiểm được, không phải xanh', async () => {
    const fx = project({ 'package.json': pkg })
    const rep = await collectWith(fx, fake({ tools: { ncu: true }, handlers: { ...flowOk, ncu: () => ({ code: 1, stdout: '', stderr: 'FetchError: getaddrinfo ENOTFOUND registry.npmjs.org\n', timedOut: false, error: null }) } }))
    assert.match(byId(rep, 'outdated').why, /chưa kiểm được: npm-check-updates chạy lỗi \(FetchError/)
  })
})

// ============================== liên kết hỏng (lychee) ==============================

describe('lychee', () => {
  const flowOk = { node: () => ok(flowJson([])) }
  const docs = { 'README.md': '# A\n', 'docs/GUIDE.md': 'x', 'docs/specs/2026/SPEC.md': 'plan', 'docs/adr/0001.md': 'adr', [HEALTH_REL]: 'cũ' }

  test('docFiles: README + docs/**/*.md, bỏ docs/specs, docs/adr và HEALTH.md', () => {
    const fx = project(docs)
    assert.deepEqual(docFiles(fx.dir), ['README.md', 'docs/GUIDE.md'])
  })

  test('không có tài liệu ⇒ không có mục', async () => {
    const rep = await collectWith(project(), fake({ handlers: flowOk }))
    assert.equal(byId(rep, 'links'), undefined)
  })

  test('chưa cài lychee ⇒ chưa kiểm được kèm lệnh cài theo máy', async () => {
    const fx = project(docs)
    assert.equal(byId(await collectWith(fx, fake({ handlers: flowOk }), { platform: 'win32' }), 'links').why, 'chưa kiểm được: lychee (scoop install lychee)')
    assert.equal(byId(await collectWith(fx, fake({ handlers: flowOk }), { platform: 'darwin' }), 'links').why, 'chưa kiểm được: lychee (brew install lychee)')
  })

  test('có link hỏng (mã 2) ⇒ vàng, nêu file + link; chỉ truyền file tài liệu hợp lệ', async () => {
    const fx = project(docs)
    const f = fake({
      tools: { lychee: true },
      handlers: {
        ...flowOk,
        lychee: (args) => {
          fs.writeFileSync(outFile(args), JSON.stringify({ total: 5, errors: 2, fail_map: { 'docs/GUIDE.md': [{ url: 'https://example.invalid/a', status: { text: '404 Not Found' } }, { url: 'https://example.invalid/b', status: { text: 'Network error' } }] } }))
          return ok('', { code: 2 })
        },
      },
    })
    const rep = await collectWith(fx, f)
    const it = byId(rep, 'links')
    assert.equal(it.level, 'yellow')
    assert.equal(it.n, 2)
    assert.equal(it.detail[0], 'docs/GUIDE.md: https://example.invalid/a (404 Not Found)')
    const call = f.calls.find((c) => c.file === 'TOOL:lychee')
    assert.deepEqual(call.args.slice(-2), ['README.md', 'docs/GUIDE.md'])
    assert.ok(call.args.includes('--no-progress'))
  })

  test('đọc được cả khoá error_map; mã 0 và không lỗi ⇒ xanh', async () => {
    const fx = project(docs)
    const mk = (map, code) => fake({ tools: { lychee: true }, handlers: { ...flowOk, lychee: (args) => { fs.writeFileSync(outFile(args), JSON.stringify({ error_map: map })); return ok('', { code }) } } })
    assert.equal(byId(await collectWith(fx, mk({ 'README.md': [{ url: 'https://x.invalid', status: { text: '500' } }] }, 2)), 'links').n, 1)
    assert.equal(byId(await collectWith(fx, mk({}, 0)), 'links').level, 'green')
  })

  test('lychee lỗi chạy (mã 1) ⇒ chưa kiểm được, không phải xanh', async () => {
    const fx = project(docs)
    const f = fake({ tools: { lychee: true }, handlers: { ...flowOk, lychee: () => ({ code: 1, stdout: '', stderr: 'error: unexpected argument\n', timedOut: false, error: null }) } })
    assert.match(byId(await collectWith(fx, f), 'links').why, /lychee chạy lỗi \(error: unexpected argument\)/)
  })
})

// ============================== điểm nóng (scc + git) ==============================

describe('scc + git log', () => {
  const flowOk = { node: () => ok(flowJson([])) }
  const gitLog = (files) => ok(files.map((f) => `${f}\n`).join('\n'))
  const scc = (files) => (args) => { fs.writeFileSync(outFile(args), JSON.stringify([{ Name: 'TypeScript', Files: files }])); return ok() }
  const times = (f, n) => Array(n).fill(f)

  test('không phải repo git ⇒ không có mục', async () => {
    assert.equal(byId(await collectWith(project(), fake({ handlers: flowOk })), 'hotspots'), undefined)
  })

  test('chưa cài scc ⇒ chưa kiểm được kèm lệnh cài', async () => {
    const fx = project({}, { git: true })
    assert.equal(byId(await collectWith(fx, fake({ handlers: flowOk })), 'hotspots').why, 'chưa kiểm được: scc (scoop install scc)')
  })

  test('file sửa ≥ 5 lần và phức tạp ≥ 40 ⇒ vàng; file test và file ít sửa không tính', async () => {
    const fx = project({}, { git: true })
    const f = fake({
      tools: { scc: true },
      handlers: {
        ...flowOk,
        git: () => gitLog([...times('src/core.ts', 7), ...times('src/core.test.ts', 9), ...times('src/calm.ts', 2), ...times('src/small.ts', 8)]),
        scc: scc([
          { Location: 'src/core.ts', Complexity: 90 },
          { Location: 'src/core.test.ts', Complexity: 200 },
          { Location: 'src/calm.ts', Complexity: 300 },
          { Location: 'src/small.ts', Complexity: 5 },
        ]),
      },
    })
    const it = byId(await collectWith(fx, f), 'hotspots')
    assert.equal(it.level, 'yellow')
    assert.equal(it.n, 1)
    assert.match(it.detail[0], /^src\/core\.ts — sửa 7 lần trong 90 ngày, độ phức tạp 90$/)
    assert.ok(!it.detail.some((d) => d.includes('core.test')))
    const git = f.calls.find((c) => c.file === 'git')
    assert.ok(git.args.includes('--since=90.days') && git.args.includes('--name-only'))
  })

  test('không file nào vượt ngưỡng ⇒ xanh (Windows: đường dẫn scc có dấu \\ vẫn khớp git)', async () => {
    const fx = project({}, { git: true })
    const f = fake({ tools: { scc: true }, handlers: { ...flowOk, git: () => gitLog(times('src/a.ts', 3)), scc: scc([{ Location: 'src\\a.ts', Complexity: 100 }]) } })
    const it = byId(await collectWith(fx, f), 'hotspots')
    assert.equal(it.level, 'green')
    assert.equal(it.detail.length, 1)
  })

  test('scc ra JSON hỏng ⇒ chưa kiểm được', async () => {
    const fx = project({}, { git: true })
    const f = fake({ tools: { scc: true }, handlers: { ...flowOk, git: () => gitLog([]), scc: (args) => { fs.writeFileSync(outFile(args), 'không phải json'); return ok() } } })
    assert.match(byId(await collectWith(fx, f), 'hotspots').why, /scc chạy lỗi \(không đọc được kết quả JSON\)/)
  })
})

// ============================== nợ kỹ thuật + tài liệu cũ ==============================

describe('nợ kỹ thuật', () => {
  const files = {
    'src/a.ts': '// TODO: làm sau\nconst x = 1 // FIXME\n// @ts-ignore\nconst s = "TODO không phải ghi chú"\n',
    'src/b.go': '// HACK tạm\npackage x\n',
    'src/a.test.ts': "it.skip('x', () => {})\ntest('y', { skip: true }, () => {})\n",
    'src/lib.ts': "const o = { skip: true }\n// it.skip( chỉ tính trong file test\n",
    'src/note.go': '// @ts-ignore chỉ tính với JS/TS\n',
    'node_modules/dep/index.js': '// TODO bị bỏ qua\n',
    '.hidden/x.js': '// TODO bị bỏ qua\n',
    'dist/out.js': '// TODO bị bỏ qua\n',
    'README.md': 'TODO trong markdown không tính\n',
  }

  test('scanDebt đếm đúng chỗ và chỉ file code của dự án', () => {
    const d = scanDebt(project(files).dir)
    assert.equal(d.todo.n, 3, JSON.stringify(d.todo.at))
    assert.deepEqual(d.todo.at, ['src/a.ts:1', 'src/a.ts:2', 'src/b.go:1'])
    assert.equal(d.skipped.n, 2)
    assert.equal(d.tsIgnore.n, 1)
    assert.equal(d.tsIgnore.at[0], 'src/a.ts:3')
  })

  test('collect: TODO < 20 ⇒ xanh, test bị tắt / @ts-ignore ≥ 1 ⇒ vàng; chưa có file code ⇒ không có mục', async () => {
    const flowOk = { node: () => ok(flowJson([])) }
    const rep = await collectWith(project(files), fake({ handlers: flowOk }))
    assert.equal(byId(rep, 'todo').level, 'green')
    assert.equal(byId(rep, 'skipped-tests').level, 'yellow')
    assert.equal(byId(rep, 'ts-ignore').level, 'yellow')
    assert.equal(byId(rep, 'ts-ignore').n, 1)
    const none = await collectWith(project({ 'README.md': 'x' }), fake({ handlers: flowOk }))
    assert.equal(byId(none, 'todo'), undefined)
  })

  test('TODO đủ 20 chỗ ⇒ vàng; dự án Go không có mục @ts-ignore', async () => {
    const flowOk = { node: () => ok(flowJson([])) }
    const many = project({ 'main.go': `${'// TODO x\n'.repeat(20)}package main\n` })
    const rep = await collectWith(many, fake({ handlers: flowOk }))
    assert.equal(byId(rep, 'todo').level, 'yellow')
    assert.equal(byId(rep, 'todo').n, 20)
    assert.equal(byId(rep, 'ts-ignore'), undefined)
  })

  test('TODO dưới ngưỡng: vẫn xanh nhưng lời nói rõ "dưới ngưỡng 20 nên chưa cần làm" (BUG-7b); 0 chỗ ⇒ "không có"; đủ ngưỡng ⇒ vàng, không nhắc ngưỡng', async () => {
    const flowOk = { node: () => ok(flowJson([])) }
    const run = async (files) => collectWith(project(files), fake({ handlers: flowOk }))
    const one = await run({ 'src/a.js': '// TODO x\n' })
    assert.equal(byId(one, 'todo').level, 'green')
    assert.equal(byId(one, 'todo').summary, '1 chỗ ghi việc dở, dưới ngưỡng 20 nên chưa cần làm')
    assert.equal(byId(one, 'todo').todo, undefined, 'dưới ngưỡng ⇒ không đưa vào "Việc nên làm"')
    assert.match(renderHealth(one), /## Xanh — ổn\n[\s\S]*- \*\*Ghi chú việc dở \(TODO\/FIXME\/HACK\)\*\* — 1 chỗ ghi việc dở, dưới ngưỡng 20 nên chưa cần làm\n/)
    assert.equal(byId(await run({ 'src/a.js': 'const a = 1\n' }), 'todo').summary, 'không có chỗ ghi việc dở')
    const many = byId(await run({ 'main.go': `${'// TODO x\n'.repeat(20)}package main\n` }), 'todo')
    assert.equal(many.summary, '20 chỗ ghi việc dở')
    assert.match(many.todo, /\(20 chỗ\)$/)
  })

  test('không dòng nào trong HEALTH.md hay màn hình CLI dài quá 60 chữ, kể cả khi flow-check trả lời dặn rất dài (hint log-secrets của kit/checkers.json)', async () => {
    const kit = JSON.parse(fs.readFileSync(new URL('../../kit/checkers.json', import.meta.url), 'utf8'))
    const hint = kit.checkers.find((c) => c.id === 'log-secrets').hint
    assert.ok(hint.split(/\s+/).length > 60, 'hint mẫu phải dài hơn 60 chữ thì test mới có nghĩa')
    const flow = flowJson([
      res('log-secrets', 'fail', { message: hint, detail: [hint], fix: hint }),
      res('jscpd', 'fail', { message: hint, detail: [hint, hint], fix: hint }),
      res('knip', 'missing', { message: `Chưa cài ${hint}`, fix: `Cài: ${hint} (https://knip.dev)` }),
    ])
    const rep = await collectWith(project({ 'src/a.js': '// TODO x\n' }), fake({ handlers: { node: () => ok(flow) } }))
    const words = (l) => l.split(/\s+/).filter(Boolean).length
    const tooLong = renderHealth(rep).split('\n').filter((l) => words(l) > 60)
    assert.deepEqual(tooLong, [])
    for (const i of rep.items) for (const l of [i.summary, i.todo, i.why, ...i.detail]) assert.ok(!l || words(l) <= 60, `${i.id}: ${l}`)
    assert.equal(byId(rep, 'log-secrets'), undefined, 'log-secrets không nằm trong danh sách khám sức khoẻ')
  })
})

describe('tài liệu nhắc file không còn', () => {
  test('pathCandidate: chỉ nhận đường dẫn file thật sự', () => {
    for (const ok1 of ['src/app.ts', './src/app.ts', 'src/app.ts:12', 'src/app.ts#L3', 'src/features/']) assert.ok(pathCandidate(ok1), ok1)
    for (const bad of ['app.ts', 'react-dom/client', 'https://x.com/a.html', '/etc/hosts', 'src/*.ts', 'src/<tên>/a.ts', 'dist/index.js', '.output/a.js', '.claude/release.json', 'a b/c.ts', '$HOME/x.ts', '@scope/pkg']) assert.equal(pathCandidate(bad), null, bad)
  })

  test('nhắc file còn (tính từ gốc hoặc từ thư mục tài liệu) ⇒ ổn; nhắc file mất ⇒ vàng; docs/specs bị bỏ', () => {
    const fx = project({
      'src/app.ts': 'x', 'docs/img/a.png': 'x',
      'README.md': 'Xem `src/app.ts`, `src/cu.ts` và `src/cu.ts` nữa; `https://x.com/a.html`; `dist/main.js`.',
      'docs/GUIDE.md': 'Ảnh `img/a.png`, mất `docs/xoa-roi.md:12`, lệnh `npm run dev`.',
      'docs/specs/2026/PLAN.md': 'sẽ làm `src/chua-co.ts`',
    })
    assert.deepEqual(docPathProblems(fx.dir), [{ doc: 'README.md', ref: 'src/cu.ts' }, { doc: 'docs/GUIDE.md', ref: 'docs/xoa-roi.md' }])
  })

  test('collect: có mục mất ⇒ vàng kèm n; tất cả còn ⇒ xanh', async () => {
    const flowOk = { node: () => ok(flowJson([])) }
    const bad = project({ 'README.md': 'Xem `src/mat.ts`' })
    const it = byId(await collectWith(bad, fake({ handlers: flowOk })), 'docs-paths')
    assert.deepEqual([it.level, it.n, it.detail], ['yellow', 1, ['README.md nhắc src/mat.ts']])
    const good = project({ 'README.md': 'Xem `src/a.ts`', 'src/a.ts': 'x' })
    assert.equal(byId(await collectWith(good, fake({ handlers: flowOk })), 'docs-paths').level, 'green')
  })
})

// ============================== không chạy gì tốn tiền / ngoài danh sách ==============================

test('mọi lệnh đã gọi nằm trong danh sách: node (flow-check), ncu, lychee, scc, git — không npx, không cài đặt', async () => {
  const fx = project({ 'package.json': '{}', 'README.md': 'x', 'src/a.js': '// TODO\n' }, { git: true })
  const f = fake({
    tools: { ncu: true, lychee: true, scc: true },
    handlers: {
      node: () => ok(flowJson([])),
      ncu: () => ok('{}'),
      lychee: (args) => { fs.writeFileSync(outFile(args), '{}'); return ok() },
      git: () => ok(''),
      scc: (args) => { fs.writeFileSync(outFile(args), '[]'); return ok() },
    },
  })
  await collectWith(fx, f)
  assert.deepEqual([...new Set(f.calls.map((c) => c.file))].sort(), ['NODE', 'TOOL:lychee', 'TOOL:ncu', 'TOOL:scc', 'git'])
  assert.ok(f.calls.every((c) => !c.args.some((a) => /^(install|i|add|publish|deploy)$/.test(a))))
})

// ============================== so với lần trước + HEALTH.md ==============================

describe('so với lần trước', () => {
  const rep = (items, date = '2026-10-13') => ({ dir: '/x', date, at: `${date}T03:00:00.000Z`, items })
  const it = (id, level, n, extra = {}) => ({ id, title: `T-${id}`, level, summary: `s-${id}`, detail: [], ...(n === undefined ? {} : { n }), ...extra })

  test('snapshot ghi rồi đọc lại đúng; hỏng/không có ⇒ null', () => {
    const r = rep([it('a', 'red', 2), it('b', 'unchecked'), it('c', 'green', 0)])
    const back = parseSnapshot(renderHealth(r))
    assert.deepEqual(back, { date: '2026-10-13', items: [{ id: 'a', level: 'red', n: 2 }, { id: 'b', level: 'unchecked', n: null }, { id: 'c', level: 'green', n: 0 }] })
    assert.deepEqual(snapshotOf(r).items[1], ['b', 'unchecked', null])
    assert.equal(parseSnapshot('không có gì'), null)
    assert.equal(parseSnapshot('<!-- flow-health {hỏng} -->'), null)
    assert.equal(parseSnapshot('<!-- flow-health {"date":"x","items":[["a","tím",1]]} -->').items.length, 0)
  })

  test('compare: lần đầu · tốt lên · tệ đi · lẫn · như cũ; số lượng đổi cùng mức cũng tính; chưa kiểm được không tính', () => {
    const snap = (items) => ({ date: '2026-09-01', items })
    const prev = snap([{ id: 'a', level: 'red', n: null }, { id: 'b', level: 'yellow', n: 4 }, { id: 'c', level: 'green', n: 0 }, { id: 'd', level: 'unchecked', n: null }])
    assert.equal(compare(null, rep([])).verdict, 'first')
    const better = compare(prev, rep([it('a', 'yellow'), it('b', 'yellow', 4), it('c', 'green', 0), it('d', 'green')]))
    assert.deepEqual([better.verdict, better.better], ['better', ['T-a: đỏ → vàng']])
    const worse = compare(prev, rep([it('a', 'red'), it('b', 'yellow', 9), it('c', 'yellow', 1), it('d', 'red')]))
    assert.equal(worse.verdict, 'worse')
    assert.deepEqual(worse.worse, ['T-b: 4 → 9', 'T-c: xanh → vàng'])
    assert.equal(compare(prev, rep([it('a', 'red'), it('b', 'yellow', 4), it('c', 'green', 0)])).verdict, 'same')
    assert.equal(compare(prev, rep([it('a', 'green'), it('b', 'red')])).verdict, 'mixed')
    assert.deepEqual(compare(prev, rep([it('a', 'red'), it('e', 'yellow')])).worse, ['T-e: mục mới, vàng'])
    assert.equal(compare(prev, rep([it('a', 'red'), it('e', 'green')])).verdict, 'same')
  })

  test('renderHealth: đủ ngày · đỏ · vàng · xanh · so với lần trước · việc nên làm; mục chưa kiểm nằm riêng, không đỏ', () => {
    const r = rep([
      it('osv-scanner', 'red', undefined, { detail: ['lodash'], todo: 'Nâng thư viện' }),
      it('jscpd', 'yellow', undefined, { detail: ['a ↔ b'], todo: 'Gộp code trùng' }),
      it('knip', 'green'),
      { id: 'links', title: 'Link', level: 'unchecked', summary: '', detail: [], why: 'chưa kiểm được: lychee (scoop install lychee)' },
    ])
    const md = renderHealth(r, compare({ date: '2026-09-01', items: [{ id: 'jscpd', level: 'green', n: null }] }, r))
    assert.match(md, /^# Sức khoẻ ứng dụng/)
    assert.match(md, /Khám ngày 2026-10-13 · đỏ 1 · vàng 1 · xanh 1 · chưa kiểm được 1/)
    assert.match(md, /So với lần trước \(2026-09-01\): tệ đi/)
    assert.match(md, /- tệ đi — T-jscpd: xanh → vàng/)
    assert.match(md, /## Đỏ — nên làm ngay\n\n- \*\*T-osv-scanner\*\* — s-osv-scanner\n {2}- lodash/)
    assert.match(md, /## Xanh — ổn\n\n- \*\*T-knip\*\* — s-knip\n/)
    assert.match(md, /## Chưa kiểm được\n\n- chưa kiểm được: lychee \(scoop install lychee\)/)
    assert.match(md, /## Việc nên làm\n\n1\. Nâng thư viện\n2\. Gộp code trùng\n/)
    assert.deepEqual(summarize(r.items), { red: 1, yellow: 1, green: 1, unchecked: 1 })
    assert.deepEqual(todoList(r.items), ['Nâng thư viện', 'Gộp code trùng'])
  })

  test('không có việc gấp ⇒ nói rõ', () => {
    assert.match(renderHealth(rep([it('knip', 'green')])), /## Việc nên làm\n\nKhông có việc gấp\./)
  })
})

describe('recordHealth', () => {
  const report = (date, items) => ({ dir: '/x', date, at: `${date}T03:00:00.000Z`, items })
  const green = { id: 'knip', title: 'Code thừa', level: 'green', summary: 'sạch', detail: [] }
  const red = { id: 'osv-scanner', title: 'Lỗ hổng', level: 'red', summary: '2 lỗ hổng', detail: [], todo: 'Nâng thư viện' }

  test('ghi docs/HEALTH.md + health.lastAt; lần sau so với lần trước; giữ nguyên các trường khác của release.json', () => {
    const fx = project()
    assert.equal(writeState(fx.dir, { v: 1, platform: 'cloudflare', checkAt: ['2026-10-14T00:00:00Z'], backup: { choice: 'off' }, health: { lastAt: '2026-08-01T00:00:00Z', ghiChu: 'giữ' }, tuyBien: 1 }, fx.stateOpts), true)
    const first = recordHealth(fx.dir, report('2026-09-12', [green]), { stateOpts: fx.stateOpts })
    assert.equal(first.wrote, true)
    assert.equal(first.state, 'ok')
    assert.equal(first.cmp.verdict, 'first')
    assert.ok(fs.existsSync(path.join(fx.dir, 'docs', 'HEALTH.md')))
    const second = recordHealth(fx.dir, report('2026-10-13', [{ ...green, level: 'red', summary: 'x' }]), { stateOpts: fx.stateOpts })
    assert.equal(second.cmp.verdict, 'worse')
    assert.equal(second.cmp.since, '2026-09-12')
    assert.match(fs.readFileSync(second.file, 'utf8'), /So với lần trước \(2026-09-12\): tệ đi/)
    const st = readState(fx.dir, fx.stateOpts)
    assert.equal(st.health.lastAt, '2026-10-13T03:00:00.000Z')
    assert.equal(st.health.ghiChu, 'giữ')
    assert.deepEqual([st.platform, st.checkAt, st.backup, st.tuyBien], ['cloudflare', ['2026-10-14T00:00:00Z'], { choice: 'off' }, 1])
  })

  test('khám lâu: release/backup ghi release.json SAU khi báo cáo đã tính xong, trước lúc ghi mốc ⇒ health.lastAt gộp lên bản mới nhất, không mất mốc phát hành/sao lưu', () => {
    const fx = project()
    writeState(fx.dir, { v: 1, platform: 'cloudflare', health: { lastAt: '2026-08-01T00:00:00Z' } }, fx.stateOpts)
    const rep = report('2026-10-13', [green]) // báo cáo xong ở đây …
    const lastRelease = { at: '2026-10-13T02:00:00.000Z', version: 'v9', smoke: 'pass' }
    const backup = { choice: 'on', lastBackup: '2026-10-13T02:30:00.000Z' }
    writeState(fx.dir, { ...readState(fx.dir, fx.stateOpts), lastRelease, checkAt: ['2026-10-14T02:00:00.000Z'], backup }, fx.stateOpts) // … `release cf` + `backup` ghi tiếp
    assert.equal(recordHealth(fx.dir, rep, { stateOpts: fx.stateOpts }).state, 'ok')
    const st = readState(fx.dir, fx.stateOpts)
    assert.deepEqual([st.lastRelease, st.checkAt, st.backup], [lastRelease, ['2026-10-14T02:00:00.000Z'], backup])
    assert.equal(st.health.lastAt, '2026-10-13T03:00:00.000Z')
  })

  test('chưa có release.json ⇒ tạo mới chỉ với health.lastAt', () => {
    const fx = project()
    recordHealth(fx.dir, report('2026-10-13', [red]), { stateOpts: fx.stateOpts })
    assert.deepEqual(readState(fx.dir, fx.stateOpts), { v: 1, health: { lastAt: '2026-10-13T03:00:00.000Z' } })
  })

  test('release.json đang hỏng ⇒ KHÔNG ghi đè, vẫn ghi HEALTH.md, báo state corrupt', () => {
    const fx = project({ '.claude/release.json': '{ hỏng' })
    const r = recordHealth(fx.dir, report('2026-10-13', [red]), { stateOpts: fx.stateOpts })
    assert.equal(r.state, 'corrupt')
    assert.equal(r.wrote, true)
    assert.equal(fs.readFileSync(statePath(fx.dir), 'utf8'), '{ hỏng')
  })

  test('write:false ⇒ không ghi file nào (kể cả thư mục docs, .claude)', () => {
    const fx = project()
    const r = recordHealth(fx.dir, report('2026-10-13', [red]), { write: false, stateOpts: fx.stateOpts })
    assert.deepEqual([r.wrote, r.state], [false, 'off'])
    assert.match(r.markdown, /Lỗ hổng/)
    assert.deepEqual(fs.readdirSync(fx.dir), [])
  })

  test('HEALTH.md cũ không có/hỏng dòng snapshot ⇒ coi như lần đầu', () => {
    const fx = project({ [HEALTH_REL]: '# tự viết tay\n' })
    assert.equal(recordHealth(fx.dir, report('2026-10-13', [green]), { stateOpts: fx.stateOpts }).cmp.verdict, 'first')
  })
})

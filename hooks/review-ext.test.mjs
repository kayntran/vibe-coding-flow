// Test cho review-ext.mjs: node --test hooks/review-ext.test.mjs
// Không gọi model thật. Phần thuần (extractReview, buildPrompt, sanitizeDiff, tarEntries) test thẳng; phần chạy (run) dùng repo git tạm,
// kiểm CLI giả + model giả + bộ chạy giả (tiêm qua deps) để soi đúng cái được gửi đi (stdin/đối số/workspace tạm); runReviewer thử với tiến
// trình Node thật; hai ca đầu-cuối chạy cả `node review-ext.mjs` với CLI `codex` giả trên PATH và HOME giả (clis.check + models.resolve thật).
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReview, buildPrompt, parseArgs, GROK_ENV, sanitizeDiff, parseNameStatusZ, buildWorkspace, runReviewer, run, reviewerEnv } from './review-ext.mjs'
import { scanText } from './lib/secrets.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'review-ext.mjs')
const IS_WIN = process.platform === 'win32'
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
// withOddNames nối thêm chỉ số 2, không ghi đè hai khoá này.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })
const R = { findings: [{ severity: 'MAJOR', summary: 's', path: 'a.js', line: 1, failure_scenario: 'f', fix: 'x' }], areas_checked: 'a' }
// Ghép lúc chạy để file test không chứa nguyên chuỗi giống khoá thật (cổng commit quét chính file này).
const AWS_KEY = 'AKIA' + 'QWERTYUIOPASDFGH'

const tmpDirs = []
function tmp(prefix = 'rx-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }) })
const real = (p) => fs.realpathSync(p)

describe('extractReview', () => {
  test('lấy JSON nằm giữa chữ dẫn', () => {
    assert.deepEqual(extractReview(`Tôi sẽ đọc diff.\n${JSON.stringify(R)}\nXong.`), R)
  })
  test('JSON in hai lần liền nhau ⇒ lấy cái đầu', () => {
    assert.deepEqual(extractReview(JSON.stringify(R) + '\n' + JSON.stringify({ ...R, areas_checked: 'b' })), R)
  })
  test('bỏ qua object không có findings và ngoặc trong chuỗi', () => {
    const r2 = { findings: [], areas_checked: 'có } và { trong chuỗi "x"' }
    assert.deepEqual(extractReview(`{"a":1} rồi ${JSON.stringify(r2)}`), r2)
  })
  test('không có JSON ⇒ null', () => {
    assert.equal(extractReview('Tôi sẽ chỉ đọc luật dự án.'), null)
    assert.equal(extractReview('{"findings": [ hỏng'), null)
  })
})

describe('buildPrompt', () => {
  const p = { brief: 'BRIEF', schema: '{"s":1}', base: 'main', note: 'thêm X', diff: '+dòng mới' }
  test('diff nhỏ ⇒ dán thẳng, brief đứng đầu (cache được)', () => {
    const s = buildPrompt(p)
    assert.ok(s.startsWith('BRIEF'))
    assert.ok(s.includes('git diff main...HEAD') && s.includes('thêm X') && s.includes('{"s":1}') && s.endsWith('+dòng mới'))
  })
  test('có diffFile ⇒ trỏ file, không dán diff', () => {
    const s = buildPrompt({ ...p, diffFile: 'C:/x/r.diff' })
    assert.ok(s.includes('C:/x/r.diff') && !s.includes('+dòng mới'))
  })
})

test('GROK_ENV tắt đủ 5 nguồn của Claude và Cursor', () => {
  assert.equal(Object.keys(GROK_ENV).filter((k) => k.endsWith('_ENABLED')).length, 10)
  assert.equal(GROK_ENV.GIT_PAGER, 'cat')
  assert.equal(GROK_ENV.GROK_CLAUDE_MCPS_ENABLED, '0')
  assert.equal(GROK_ENV.GROK_CURSOR_HOOKS_ENABLED, '0')
})

test('parseArgs: mặc định + ghi đè', () => {
  const o = parseArgs(['--model', 'grok', '--wt', '.', '--out', 'o.json', '--timeout', '600'])
  assert.equal(o.brief, 'review-brief.md')
  assert.equal(o.base, 'main')
  assert.equal(o.timeout, 600)
})

test('parseArgs: --role', () => {
  assert.equal(parseArgs(['--model', 'codex', '--role', 'plan-reviewer']).role, 'plan-reviewer')
  assert.equal(parseArgs(['--model', 'codex']).role, undefined)
})

test('CLI thiếu tham số ⇒ exit 1, không gọi model', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--model', 'gpt'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--model grok\|flash/)
})

test('CLI nhận cả codex và opus (thiếu --wt/--out vẫn exit 1 nhưng không báo sai --model)', () => {
  for (const m of ['codex', 'opus']) {
    const r = spawnSync(process.execPath, [SCRIPT, '--model', m], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--wt/)
  }
})

test('brief + schema thật của kit không dính mẫu secret (để quét prompt không tự chặn)', () => {
  for (const f of ['review-brief.md', 'review-brief-security.md', 'review-schema.json']) {
    assert.deepEqual(scanText(fs.readFileSync(path.join(HERE, '..', 'workers', f), 'utf8')), [], f)
  }
})

// ---------- tầng 1: diff ----------

const section = (file, plus, minus = '') =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n${minus ? `-${minus}\n` : ''}+${plus}\n`

describe('sanitizeDiff (tầng 1)', () => {
  test('bỏ hunk của file nhạy cảm, dữ liệu riêng, glob private của dự án, .mcp.json, Note/; giữ file thường', () => {
    const diff = [
      section('src/a.js', 'const a = 1'),
      section('.env', 'DB_HOST=prod'),
      section('data/customers.csv', 'alice,alice@example.com'),
      section('reports/export.sqlite', 'x'),
      section('secrets/notes.txt', 'riêng'),
      section('.mcp.json', '{}'),
      section('Note/y-tuong.md', 'riêng'),
      section('src/b.js', 'const b = 2'),
    ].join('')
    const r = sanitizeDiff(diff, { private: ['secrets/**'] })
    assert.deepEqual(r.findings, [])
    assert.deepEqual([...r.dropped].sort(), ['.env', '.mcp.json', 'Note/y-tuong.md', 'data/customers.csv', 'reports/export.sqlite', 'secrets/notes.txt'])
    assert.equal(r.diff, section('src/a.js', 'const a = 1') + section('src/b.js', 'const b = 2'))
  })

  test('secret chỉ nằm ở dòng bị XOÁ vẫn bị bắt (removed:true), không in giá trị đầy đủ', () => {
    const r = sanitizeDiff(section('src/cfg.js', 'const k = process.env.K', `const k = "${AWS_KEY}"`), {})
    assert.equal(r.findings.length, 1)
    assert.equal(r.findings[0].file, 'src/cfg.js')
    assert.equal(r.findings[0].name, 'aws')
    assert.equal(r.findings[0].removed, true)
    assert.ok(!JSON.stringify(r.findings).includes(AWS_KEY))
  })

  test('secret nằm trong hunk của file bị bỏ ⇒ không tính (hunk đó không bao giờ được gửi)', () => {
    const r = sanitizeDiff(section('.env', `KEY=${AWS_KEY}`) + section('src/a.js', 'ok'), {})
    assert.deepEqual(r.findings, [])
    assert.deepEqual(r.dropped, ['.env'])
    assert.ok(!r.diff.includes(AWS_KEY))
  })

  test('đổi tên từ file dữ liệu riêng sang tên thường vẫn bị bỏ', () => {
    const rename = 'diff --git a/data/a.csv b/docs/a.txt\nsimilarity index 80%\nrename from data/a.csv\nrename to docs/a.txt\nindex 1..2 100644\n--- a/data/a.csv\n+++ b/docs/a.txt\n@@ -1 +1 @@\n-x,y\n+x,z\n'
    const r = sanitizeDiff(rename + section('src/a.js', 'ok'), {})
    assert.ok(r.dropped.includes('data/a.csv') || r.dropped.includes('docs/a.txt'))
    assert.equal(r.diff, section('src/a.js', 'ok'))
  })

  test('đổi tên / sao chép TỪ file nhạy cảm hoặc dữ liệu riêng sang đường dẫn khác ⇒ đường dẫn MỚI cũng nằm trong dropped (cho workspace loại theo)', () => {
    const move = (kind, from, to) => `diff --git a/${from} b/${to}\nsimilarity index 100%\n${kind} from ${from}\n${kind} to ${to}\n`
    for (const kind of ['rename', 'copy']) {
      const r = sanitizeDiff(move(kind, '.env', 'config/app.settings') + move(kind, 'data/a.csv', 'docs/a.txt') + move(kind, 'secrets/k.txt', 'notes/k.txt') + section('src/a.js', 'ok'), { private: ['secrets/**'] })
      assert.deepEqual([...r.dropped].sort(), ['.env', 'config/app.settings', 'data/a.csv', 'docs/a.txt', 'notes/k.txt', 'secrets/k.txt'], kind)
      assert.equal(r.diff, section('src/a.js', 'ok'), kind)
    }
  })

  test('đổi tên TỪ file thường SANG file nhạy cảm: chỉ đường dẫn nhạy cảm bị bỏ, đường dẫn cũ (không còn ở HEAD) không bị kéo theo', () => {
    const r = sanitizeDiff('diff --git a/src/old.js b/.env\nsimilarity index 100%\nrename from src/old.js\nrename to .env\n', {})
    assert.deepEqual(r.dropped, ['.env'])
  })

  test('diff sạch đi qua nguyên vẹn', () => {
    const d = section('src/a.js', 'const a = 1') + section('README.md', 'x')
    assert.deepEqual(sanitizeDiff(d, {}), { diff: d, dropped: [], findings: [] })
  })

  // Review lượt 2: git bọc nháy C-quote khi tên có ", \, tab… (kể cả core.quotepath=off) — đích phải được giải ra đúng tên thật mới khớp với tên trong git archive.
  test('đích đổi tên / sao chép từ file riêng bọc nháy C-quote (", \\, tab, \\ooo) ⇒ dropped có tên THẬT đã giải nháy', () => {
    const move = (kind, from, toQuoted) => `diff --git a/${from} b/x\nsimilarity index 100%\n${kind} from ${from}\n${kind} to ${toQuoted}\n`
    for (const kind of ['rename', 'copy']) {
      const d = move(kind, 'data/a.csv', '"reports/q1\\"notes.txt"') + move(kind, '.env', '"cfg/back\\\\slash.txt"') + move(kind, 'secrets/k.txt', '"notes/tab\\tname.txt"') +
        move(kind, 'data/b.csv', '"docs/caf\\303\\251.txt"') + section('src/a.js', 'ok')
      const r = sanitizeDiff(d, { private: ['secrets/**'] })
      assert.deepEqual([...r.dropped].sort(), ['.env', 'cfg/back\\slash.txt', 'data/a.csv', 'data/b.csv', 'docs/café.txt', 'notes/tab\tname.txt', 'reports/q1"notes.txt', 'secrets/k.txt'], kind)
      assert.equal(r.diff, section('src/a.js', 'ok'), kind)
    }
  })

  test('tiêu đề "from" bọc nháy (nguồn có ký tự lạ) cũng được nhận ra là file riêng', () => {
    const d = 'diff --git "a/data/q\\"1.csv" b/docs/x.txt\nsimilarity index 100%\nrename from "data/q\\"1.csv"\nrename to docs/x.txt\n'
    const r = sanitizeDiff(d + section('src/a.js', 'ok'), {})
    assert.deepEqual([...r.dropped].sort(), ['data/q"1.csv', 'docs/x.txt'])
    assert.equal(r.diff, section('src/a.js', 'ok'))
  })

  test('moves (git diff -z --name-status -M -C, tên thô): đích đổi tên từ file riêng bị bỏ dù diff hiện nó như file mới (không có dòng rename); mục diff mang đích đó bị loại', () => {
    const asNew = 'diff --git a/x "b/reports/q1\\"notes.txt"\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ "b/reports/q1\\"notes.txt"\n@@ -0,0 +1 @@\n+ALICE-ROW\n'
    const plain = section('docs/q1 notes.txt', 'ALICE-ROW')
    const moves = [
      { status: 'R', from: 'data/customers.csv', to: 'reports/q1"notes.txt' }, { status: 'C', from: '.env', to: 'docs/q1 notes.txt' },
      { status: 'R', from: 'src/x.js', to: 'src/y.js' },
    ]
    const r = sanitizeDiff(asNew + plain + section('src/a.js', 'ok'), {}, { moves })
    assert.deepEqual([...r.dropped].sort(), ['docs/q1 notes.txt', 'reports/q1"notes.txt'])
    assert.equal(r.diff, section('src/a.js', 'ok'))
    assert.ok(!r.diff.includes('ALICE-ROW'))
  })

  test('moves rỗng / đổi tên từ file thường ⇒ không đổi hành vi', () => {
    const d = section('src/a.js', 'ok')
    assert.deepEqual(sanitizeDiff(d, {}, { moves: [{ status: 'R', from: 'src/o.js', to: 'src/a.js' }] }), { diff: d, dropped: [], findings: [] })
  })
})

describe('parseNameStatusZ', () => {
  test('R/C có hai đường dẫn, loại khác một; tên có ", tab, xuống dòng giữ nguyên (không nháy); lệch khuôn ⇒ ném', () => {
    const z = ['M', 'src/a.js', 'R087', 'data/old.csv', 'reports/q1"notes.txt', 'C100', 'a\tb', 'c\nd', 'A', 'new.js', 'D', 'gone.js'].join('\0') + '\0'
    assert.deepEqual(parseNameStatusZ(z), [{ status: 'R', from: 'data/old.csv', to: 'reports/q1"notes.txt' }, { status: 'C', from: 'a\tb', to: 'c\nd' }])
    assert.deepEqual(parseNameStatusZ(''), [])
    assert.throws(() => parseNameStatusZ('R100\0chi-mot-duong-dan\0'))
    assert.throws(() => parseNameStatusZ('?? lạ\0x\0'))
  })
})

// ---------- repo git tạm ----------

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// Đưa một file vào index mà không tạo trong cây làm việc (liên kết tượng trưng, đường dẫn dài hơn MAX_PATH của Windows).
function indexOnly(cwd, mode, file, content) {
  const h = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: content, encoding: 'utf8' })
  assert.equal(h.status, 0, h.stderr)
  git(cwd, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `${mode},${h.stdout.trim()},${file}`) // protectNTFS=false: Windows từ chối " và tab trong tên
}

// Windows: git từ chối " / tab trong tên cả khi git archive (core.protectNTFS) ⇒ tắt qua env cho các git con, chỉ trong test cần tên lạ.
async function withOddNames(fn) {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2']
  const keep = keys.map((k) => [k, process.env[k]])
  Object.assign(process.env, { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.protectNTFS', GIT_CONFIG_VALUE_2: 'false' })
  try { return await fn() } finally { for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

function writeFiles(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, ...f.split('/'))
    if (c === null) { fs.rmSync(p, { force: true }); continue }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, c)
  }
}

const PREFIX_PATH = `src/${'thu-muc-long-gom-nhieu-tang/'.repeat(5)}tep.js` // > 100 ký tự: tar dùng trường prefix
const PAX_PATH = `src/${'abcdefghij/'.repeat(25)}tep-rat-sau.js` // > 255 ký tự: tar dùng pax header
const BASE = {
  'src/app.js': 'export const a = 1\n',
  'README.md': '# demo\n',
  'package-lock.json': '{"lock":1}\n',
  'data/customers.csv': 'name,email\nbob,bob@example.com\n',
  '.env': 'DB_HOST=localhost\n',
  '.mcp.json': '{"mcpServers":{}}\n',
  'Note/ideas.md': 'ý tưởng riêng\n',
  'secrets/notes.txt': 'riêng theo glob của dự án\n',
  '.claude/flow.json': '{"private":["secrets/**"]}\n',
}
const FEAT = {
  'src/app.js': 'export const a = 1\nexport const b = 2\n',
  'data/customers.csv': 'name,email\nbob,bob@example.com\nALICE-PRIVATE-ROW,alice@example.com\n',
  '.env': 'DB_HOST=localhost\nENV-MARKER-VALUE=1\n',
  'secrets/notes.txt': 'riêng theo glob của dự án\nGLOB-PRIVATE-MARKER\n',
  'src/new.js': 'export const n = 3\n',
  'package-lock.json': '{"lock":2}\n',
}

// repo có nhánh main (BASE + base) và nhánh feat (FEAT + feat) đang đứng ở feat. extra: file chỉ vào index (không có trong cây làm việc).
function makeRepo({ base = {}, feat = {}, indexFiles = true } = {}) {
  const dir = tmp('rx-repo-')
  git(dir, 'init', '-q')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFiles(dir, { ...BASE, ...base })
  git(dir, 'add', '-A')
  if (indexFiles) {
    indexOnly(dir, '120000', 'link-to-app', 'src/app.js')
    indexOnly(dir, '100644', PREFIX_PATH, 'export const prefix = 1\n')
    indexOnly(dir, '100644', PAX_PATH, 'export const pax = 1\n')
  }
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'feat')
  const changed = { ...FEAT, ...feat }
  writeFiles(dir, changed)
  for (const f of Object.keys(changed)) git(dir, 'add', '-A', '--', f)
  git(dir, 'commit', '-q', '-m', 'feat')
  return dir
}

function snapshot(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out[r] = fs.statSync(path.join(d, e.name)).size < 2 << 20 ? fs.readFileSync(path.join(d, e.name), 'utf8') : '<lớn>'
    }
  }
  walk(dir, '')
  return out
}

// ---------- tầng 3: workspace ----------

describe('buildWorkspace (tầng 3)', () => {
  test('dựng từ git archive HEAD: bỏ nhạy cảm/dữ liệu riêng/liên kết, giữ file thường kể cả đường dẫn dài', () => {
    const repo = makeRepo()
    const ws = tmp('rx-ws-')
    const info = buildWorkspace(repo, ws, { private: ['secrets/**'] })
    const files = Object.keys(snapshot(ws)).sort()
    assert.deepEqual(files.filter((f) => /customers|\.env|Note\/|\.mcp|secrets\/|link-to-app/.test(f)), [])
    for (const f of ['src/app.js', 'src/new.js', 'README.md', 'package-lock.json', '.claude/flow.json', PREFIX_PATH, PAX_PATH]) assert.ok(files.includes(f), `thiếu ${f}`)
    assert.equal(fs.readFileSync(path.join(ws, 'src', 'app.js'), 'utf8'), FEAT['src/app.js'], 'lấy từ HEAD (feat), không phải main')
    assert.equal(fs.readFileSync(path.join(ws, ...PAX_PATH.split('/')), 'utf8'), 'export const pax = 1\n')
    assert.equal(info.omitted.private, 5) // customers.csv, .env, .mcp.json, Note/ideas.md, secrets/notes.txt
    assert.equal(info.omitted.links, 1)
    assert.ok(!fs.existsSync(path.join(ws, '.git')))
  })

  test('exclude: đường dẫn được liệt kê (đích đổi tên từ file nhạy cảm) không vào workspace, tính vào omitted.private', () => {
    const repo = makeRepo({ feat: { 'config/app.settings': 'RENAMED-ENV-MARKER=1\n' } })
    const ws = tmp('rx-ws-')
    const info = buildWorkspace(repo, ws, { private: ['secrets/**'] }, { exclude: ['config/app.settings', 'khong/co/file.txt'] })
    assert.ok(!fs.existsSync(path.join(ws, 'config', 'app.settings')))
    assert.ok(fs.existsSync(path.join(ws, 'src', 'app.js')))
    assert.equal(info.omitted.private, 6)
  })

  test('exclude khớp tên THẬT trong git archive kể cả có " hoặc tab (Windows không tạo được file tên này nên chỉ đếm omitted.private)', () => withOddNames(() => {
    const repo = makeRepo()
    indexOnly(repo, '100644', 'reports/q1"notes.txt', 'x\n')
    indexOnly(repo, '100644', 'tab\tdir/x.txt', 'x\n')
    git(repo, 'commit', '-q', '-m', 'tên lạ')
    const before = buildWorkspace(repo, tmp('rx-ws-'), { private: ['secrets/**'] })
    const after = buildWorkspace(repo, tmp('rx-ws-'), { private: ['secrets/**'] }, { exclude: ['reports/q1"notes.txt', 'tab\tdir/x.txt'] })
    assert.equal(after.omitted.private, before.omitted.private + 2)
    assert.equal(after.files, before.files - (IS_WIN ? 0 : 2), 'Windows không ghi được hai file này nên before.files không đếm chúng')
  }))

  test('file lớn hơn mức quét được bị bỏ (không quét được ⇒ không gửi)', () => {
    const repo = makeRepo({ feat: { 'src/huge.js': 'x'.repeat(5000) } })
    const ws = tmp('rx-ws-')
    const info = buildWorkspace(repo, ws, {}, { maxFileBytes: 1000 })
    assert.ok(!fs.existsSync(path.join(ws, 'src', 'huge.js')))
    assert.ok(info.omitted.large >= 1)
  })
})

// ---------- run (CLI giả, trong tiến trình) ----------

function harness({ reply, check, resolve } = {}) {
  const tmpRoot = tmp('rx-tmproot-')
  const outDir = tmp('rx-out-')
  const logs = { out: [], err: [] }
  const calls = []
  const checks = []
  const resolves = []
  const deps = {
    tmpRoot,
    io: { out: (s) => logs.out.push(String(s)), err: (s) => logs.err.push(String(s)) },
    exec: async (file, args, opts) => {
      const call = { file, args, ...opts, realCwd: real(opts.cwd), snap: snapshot(opts.cwd) }
      calls.push(call)
      const r = typeof reply === 'function' ? reply(call) : reply
      return { status: 0, stdout: JSON.stringify(R), stderr: '', timedOut: false, error: null, ...r }
    },
    check: async (name) => {
      checks.push(name)
      if (check) return check(name)
      return { name, ready: true, message: 'sẵn sàng', loginCmd: null, installHint: null }
    },
  }
  if (resolve !== null) {
    deps.resolve = resolve ?? ((host, role) => {
      resolves.push([host, role])
      return { host, role, model: `m-${host}-${role}`, effort: 'high', source: 'catalog', warnings: [] }
    })
  }
  const out = path.join(outDir, 'review.json')
  return { deps, calls, logs, checks, resolves, tmpRoot, out, args: (repo, model, extra = []) => ['--model', model, '--wt', repo, '--out', out, '--base', 'main', ...extra] }
}
const errText = (h) => h.logs.err.join('\n')

describe('run: chặn trước khi gọi', () => {
  test('CLI chưa sẵn sàng ⇒ exit 1 kèm message của clis, không gọi model, không tạo workspace', async () => {
    const h = harness({ check: (name) => ({ name, ready: false, message: `${name} chưa đăng nhập`, loginCmd: `${name} login`, installHint: null }) })
    const code = await run(h.args(makeRepo(), 'codex'), h.deps)
    assert.equal(code, 1)
    assert.deepEqual(h.checks, ['codex'])
    assert.match(errText(h), /codex chưa đăng nhập/)
    assert.match(errText(h), /codex login/)
    assert.equal(h.calls.length, 0)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('chưa cài ⇒ in lệnh cài', async () => {
    const h = harness({ check: (name) => ({ name, ready: false, message: `${name} chưa cài`, loginCmd: null, installHint: 'npm i -g x' }) })
    assert.equal(await run(h.args(makeRepo(), 'opus'), h.deps), 1)
    assert.match(errText(h), /npm i -g x/)
  })

  test('secret chỉ nằm ở dòng bị xoá ⇒ exit 3, không gọi model, không in khoá, không tạo gì', async () => {
    const repo = makeRepo({ base: { 'src/cfg.js': `const k = "${AWS_KEY}"\n` }, feat: { 'src/cfg.js': 'const k = process.env.K\n' } })
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 3)
    assert.equal(h.calls.length, 0)
    assert.match(errText(h), /src\/cfg\.js/)
    assert.match(errText(h), /aws/)
    assert.ok(!errText(h).includes(AWS_KEY))
    assert.equal(fs.existsSync(h.out), false)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('secret chỉ có trong file bị bỏ (.env) ⇒ không chặn, không lọt vào prompt', async () => {
    const repo = makeRepo({ feat: { '.env': `DB_HOST=x\nKEY=${AWS_KEY}\n` } })
    const h = harness()
    assert.equal(await run(h.args(repo, 'codex'), h.deps), 0)
    assert.ok(!h.calls[0].input.includes(AWS_KEY))
    assert.ok(!Object.values(h.calls[0].snap).some((c) => c.includes(AWS_KEY)))
  })

  test('tầng 2: secret trong --note ⇒ exit 3 trước khi ghi/gửi', async () => {
    const h = harness()
    const code = await run(h.args(makeRepo(), 'codex', ['--note', `khoá cũ ${AWS_KEY}`]), h.deps)
    assert.equal(code, 3)
    assert.equal(h.calls.length, 0)
    assert.ok(!errText(h).includes(AWS_KEY))
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
    assert.deepEqual(fs.readdirSync(path.dirname(h.out)), [], 'không ghi prompt ra đĩa khi chưa sạch')
  })

  test('tầng 3: khoá nằm trong file UTF-16 của HEAD (có byte NUL) ⇒ giải mã rồi bắt được, exit 3, không in khoá', async () => {
    const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`export const old = "${AWS_KEY}"\n`, 'utf16le')])
    const repo = makeRepo({ base: { 'src/legacy16.js': u16 } })
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 3, errText(h))
    assert.equal(h.calls.length, 0)
    assert.match(errText(h), /src\/legacy16\.js:1/)
    assert.ok(!errText(h).includes(AWS_KEY))
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('tầng 3: file nhị phân (có NUL, không phải UTF-16, kể cả đuôi .png) ⇒ bị LOẠI khỏi workspace, không chặn cả lượt review và không coi là sạch', async () => {
    const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), Buffer.from('nội dung không quét được')])
    const repo = makeRepo({ base: { 'assets/logo.png': bin, 'assets/blob.dat': bin } })
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 0, errText(h))
    const c = h.calls[0]
    assert.ok(!('assets/logo.png' in c.snap) && !('assets/blob.dat' in c.snap), 'nhị phân lọt vào workspace')
    assert.ok('src/app.js' in c.snap)
    assert.match(errText(h), /2 nhị phân/)
  })

  test('tầng 3: secret nằm sẵn trong HEAD (không có trong diff) ⇒ quét workspace bắt được, exit 3', async () => {
    const repo = makeRepo({ base: { 'src/legacy.js': `export const old = "${AWS_KEY}"\n` } })
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 3)
    assert.equal(h.calls.length, 0)
    assert.match(errText(h), /src\/legacy\.js/)
    assert.ok(!errText(h).includes(AWS_KEY))
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [], 'workspace tạm đã xoá')
  })

  test('đổi tên .env sang tên thường (nội dung giống hệt): bản đổi tên không có trong diff gửi đi lẫn workspace tạm', async () => {
    const envBody = 'RENAMED-ENV-MARKER=1\nDB_HOST=localhost\nDB_PORT=5432\nAPP_NAME=demo\n'
    const repo = makeRepo({ base: { '.env': envBody }, feat: { '.env': null, 'config/app.settings': envBody } })
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 0, errText(h))
    const c = h.calls[0]
    assert.ok(!('config/app.settings' in c.snap), 'bản đổi tên của .env lọt vào workspace')
    assert.ok(!c.input.includes('RENAMED-ENV-MARKER') && !c.input.includes('app.settings'), 'bản đổi tên lọt vào prompt')
    for (const content of Object.values(c.snap)) assert.ok(!content.includes('RENAMED-ENV-MARKER'))
    assert.match(errText(h), /config\/app\.settings/)
  })

  // Review lượt 2 (BLOCKER): đích đổi tên/sao chép có " hoặc tab ⇒ git bọc nháy C-quote; trước đây tên đích không khớp tên trong git archive
  // (hoặc mục diff của đích không bị nhận ra là file riêng) nên bản sao dữ liệu khách lọt vào prompt/workspace. Tên thật lấy từ `git diff -z --name-status -M -C`.
  for (const kind of ['rename', 'copy']) {
    for (const dest of ['reports/q1"notes.txt', 'tab\tdir/x.txt']) {
      test(`${kind} data/customers.csv sang ${JSON.stringify(dest)} ⇒ đích không có trong diff gửi đi lẫn workspace tạm`, () => withOddNames(async () => {
        const csv = (extra = '') => Array.from({ length: 30 }, (_, i) => `user${i},user${i}@example.com`).join('\n') + '\n' + extra
        const repo = makeRepo({ base: { 'data/customers.csv': csv() }, feat: { 'data/customers.csv': csv('ALICE-PRIVATE-ROW,alice@example.com\n') } })
        indexOnly(repo, '100644', dest, csv('ALICE-PRIVATE-ROW,alice@example.com\n'))
        if (kind === 'rename') git(repo, 'rm', '-q', '--cached', '--', 'data/customers.csv')
        git(repo, 'commit', '-q', '-m', kind)
        const h = harness()
        assert.equal(await run(h.args(repo, 'codex'), h.deps), 0, errText(h))
        const c = h.calls[0]
        assert.ok(!c.input.includes('ALICE-PRIVATE-ROW'), 'bản sao dữ liệu khách lọt vào prompt')
        assert.ok(!/notes\.txt|dir\/x\.txt/.test(c.input), 'đích lọt vào prompt')
        for (const content of Object.values(c.snap)) assert.ok(!content.includes('ALICE-PRIVATE-ROW'), 'bản sao dữ liệu khách lọt vào workspace')
        assert.ok(errText(h).includes(dest), `danh sách bỏ phải có tên thật đã giải nháy: ${errText(h)}`)
        assert.match(errText(h), new RegExp(`bỏ ${kind === 'rename' ? 5 : 6} nhạy cảm`), 'đích phải được tính vào file bị loại khỏi workspace')
        assert.doesNotMatch(errText(h), /không ghi được/)
      }))
    }
  }

  test('.claude/flow.json hỏng ⇒ không biết glob private ⇒ exit 3 (đóng cửa), không gọi model', async () => {
    const h = harness()
    const code = await run(h.args(makeRepo({ base: { '.claude/flow.json': '{ hỏng' }, feat: { '.claude/flow.json': '{ hỏng' } }), 'codex'), h.deps)
    assert.equal(code, 3)
    assert.equal(h.calls.length, 0)
    assert.match(errText(h), /flow\.json/)
  })

  test('diff chỉ gồm file nhạy cảm/dữ liệu riêng ⇒ exit 1 (không có gì để gửi), nói rõ vì sao', async () => {
    // repo mà nhánh feat chỉ sửa đúng một file dữ liệu riêng
    const only = tmp('rx-only-')
    git(only, 'init', '-q'); git(only, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    writeFiles(only, { 'data/c.csv': 'a\n', 'src/x.js': '1\n' })
    git(only, 'add', '-A'); git(only, 'commit', '-q', '-m', 'b'); git(only, 'checkout', '-q', '-b', 'feat')
    writeFiles(only, { 'data/c.csv': 'a\nb\n' }); git(only, 'add', '-A'); git(only, 'commit', '-q', '-m', 'f')
    const h = harness()
    assert.equal(await run(h.args(only, 'codex'), h.deps), 1)
    assert.match(errText(h), /nhạy cảm|dữ liệu riêng/)
    assert.equal(h.calls.length, 0)
  })

  test('diff rỗng ⇒ exit 1', async () => {
    const repo = makeRepo()
    const h = harness()
    assert.equal(await run(['--model', 'codex', '--wt', repo, '--out', h.out, '--base', 'feat'], h.deps), 1)
    assert.match(errText(h), /Diff rỗng/)
  })
})

describe('run: cái được gửi đi', () => {
  test('codex: workspace tạm đã lọc ≠ worktree thật, prompt qua stdin đã bỏ hunk riêng + lockfile, xoá workspace sau khi xong', async () => {
    const repo = makeRepo()
    const h = harness()
    const code = await run(h.args(repo, 'codex'), h.deps)
    assert.equal(code, 0, errText(h))
    assert.deepEqual(h.checks, ['codex'])
    assert.deepEqual(h.resolves, [['codex', 'code-reviewer']])
    const c = h.calls[0]
    // workspace
    assert.notEqual(c.realCwd, real(repo))
    assert.ok(!c.realCwd.startsWith(real(repo)) && !real(repo).startsWith(c.realCwd))
    assert.equal(path.dirname(c.realCwd), real(h.tmpRoot), 'workspace nằm trong thư mục tạm')
    const files = Object.keys(c.snap)
    assert.deepEqual(files.filter((f) => /customers|\.env|Note\/|\.mcp|secrets\/|link-to-app/.test(f)), [])
    assert.ok(files.includes('src/app.js') && files.includes(PAX_PATH))
    // prompt
    assert.ok(c.input.includes('+export const b = 2') && c.input.includes('+export const n = 3'))
    for (const marker of ['ALICE-PRIVATE-ROW', 'ENV-MARKER-VALUE', 'GLOB-PRIVATE-MARKER', 'package-lock']) assert.ok(!c.input.includes(marker), marker)
    for (const content of Object.values(c.snap)) for (const marker of ['ALICE-PRIVATE-ROW', 'ENV-MARKER-VALUE', 'GLOB-PRIVATE-MARKER']) assert.ok(!content.includes(marker), marker)
    // lệnh
    assert.deepEqual(c.args.slice(0, 3), ['exec', '--sandbox', 'read-only'])
    assert.ok(c.args.includes('--output-schema') && c.args.includes('--skip-git-repo-check') && c.args.includes('--ephemeral'))
    assert.equal(c.args[c.args.indexOf('-m') + 1], 'm-codex-code-reviewer')
    assert.ok(c.args.includes('model_reasoning_effort=high'))
    assert.equal(c.args.at(-1), '-')
    assert.equal(c.snap[c.args[c.args.indexOf('--output-schema') + 1]], fs.readFileSync(path.join(HERE, '..', 'workers', 'review-schema.json'), 'utf8'))
    // sau khi xong
    assert.equal(fs.existsSync(c.cwd), false, 'workspace phải bị xoá')
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
    const rev = JSON.parse(fs.readFileSync(h.out, 'utf8'))
    assert.deepEqual(rev.findings, R.findings)
    assert.match(rev.reviewer, /m-codex-code-reviewer/)
    assert.ok(fs.existsSync(h.out.replace(/\.json$/, '.raw.txt')))
    assert.match(h.logs.out.join('\n'), /1 finding/)
  })

  test('codex + brief bảo mật ⇒ vai security-reviewer; --role ghi đè', async () => {
    let h = harness()
    assert.equal(await run(h.args(makeRepo(), 'codex', ['--brief', 'review-brief-security.md']), h.deps), 0)
    assert.deepEqual(h.resolves, [['codex', 'security-reviewer']])
    h = harness()
    assert.equal(await run(h.args(makeRepo(), 'codex', ['--role', 'plan-reviewer']), h.deps), 0)
    assert.deepEqual(h.resolves, [['codex', 'plan-reviewer']])
  })

  test('opus ⇒ agy -p, model của vai plan-reviewer trên agy, cwd = workspace tạm, không --add-dir', async () => {
    const repo = makeRepo()
    const h = harness()
    assert.equal(await run(h.args(repo, 'opus'), h.deps), 0, errText(h))
    assert.deepEqual(h.checks, ['agy'])
    assert.deepEqual(h.resolves, [['agy', 'plan-reviewer']])
    const c = h.calls[0]
    assert.equal(c.args[0], '-p')
    assert.ok(c.args[1].includes('+export const b = 2'))
    assert.equal(c.args[c.args.indexOf('--model') + 1], 'm-agy-plan-reviewer')
    assert.equal(c.args[c.args.indexOf('--mode') + 1], 'plan')
    assert.match(c.args[c.args.indexOf('--print-timeout') + 1], /^\d+m$/)
    assert.ok(!c.args.includes('--add-dir'))
    assert.equal(c.input, undefined)
    assert.ok(!c.realCwd.startsWith(real(repo)))
    assert.match(JSON.parse(fs.readFileSync(h.out, 'utf8')).reviewer, /m-agy-plan-reviewer/)
  })

  test('flash ⇒ agy, vai sensitive-reviewer', async () => {
    const h = harness()
    assert.equal(await run(h.args(makeRepo(), 'flash'), h.deps), 0)
    assert.deepEqual(h.checks, ['agy'])
    assert.deepEqual(h.resolves, [['agy', 'sensitive-reviewer']])
    assert.equal(h.calls[0].args[h.calls[0].args.indexOf('--model') + 1], 'm-agy-sensitive-reviewer')
  })

  test('model lấy được là null (không đọc được danh sách) ⇒ không đoán id, bỏ -m/--model', async () => {
    const nul = (host, role) => ({ host, role, model: null, effort: 'high', source: 'fallback', warnings: ['Không chọn được model'] })
    let h = harness({ resolve: nul })
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 0)
    assert.ok(!h.calls[0].args.includes('-m'))
    assert.match(errText(h), /Không chọn được model/)
    h = harness({ resolve: nul })
    assert.equal(await run(h.args(makeRepo(), 'flash'), h.deps), 0)
    assert.ok(!h.calls[0].args.includes('--model'))
  })

  test('vai không chạy trên app đó (opus + code-reviewer) ⇒ exit 1 kèm lời của models (resolve thật)', async () => {
    const h = harness({ resolve: null })
    assert.equal(await run(h.args(makeRepo(), 'opus', ['--role', 'code-reviewer']), h.deps), 1)
    assert.match(errText(h), /code-reviewer.*không chạy trên agy/)
    assert.equal(h.calls.length, 0)
  })

  test('grok ⇒ cursor-agent, giữ model/đối số cũ, --workspace = workspace tạm, prompt nằm trong workspace', async () => {
    const repo = makeRepo()
    const h = harness()
    assert.equal(await run(h.args(repo, 'grok'), h.deps), 0, errText(h))
    assert.deepEqual(h.checks, ['cursor-agent'])
    assert.deepEqual(h.resolves, [], 'grok không qua models.resolve (cursor không có trong roles.json)')
    const c = h.calls[0]
    if (IS_WIN) { assert.match(c.file, /powershell/i); assert.ok(c.args.includes('-File')) }
    const ws = c.args[c.args.indexOf('--workspace') + 1]
    assert.equal(ws, c.cwd)
    assert.ok(!c.realCwd.startsWith(real(repo)))
    assert.ok(!c.args.includes('--add-dir'))
    assert.equal(c.args[c.args.indexOf('--model') + 1], 'grok-4.7[context=256k,reasoning_effort=high,fast=false]')
    assert.ok(c.args.includes('--mode') && c.args.includes('plan') && c.args.includes('--trust'))
    const rel = /(\S*prompt\.txt)/.exec(c.args.at(-1))[1]
    assert.ok(c.snap[rel].includes('+export const b = 2'), 'prompt đầy đủ nằm trong workspace')
    assert.match(JSON.parse(fs.readFileSync(h.out, 'utf8')).reviewer, /grok-4\.7 high 256k \(Cursor\)/)
  })

  test('diff lớn ⇒ diff ra file trong workspace (đã lọc), prompt chỉ trỏ tới file', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    const h = harness()
    assert.equal(await run(h.args(makeRepo({ feat: { 'src/big.js': big } }), 'codex'), h.deps), 0)
    const c = h.calls[0]
    const rel = /(\S*diff\.patch)/.exec(c.input)[1]
    assert.ok(c.snap[rel].includes('+export const v2999 = 2999') && !c.snap[rel].includes('ALICE-PRIVATE-ROW'))
    assert.ok(!c.input.includes('v2999'))
  })

  test('model in thêm chữ quanh JSON vẫn lấy được; có cảnh báo của models thì in ra stderr', async () => {
    const h = harness({
      reply: { stdout: `Đang đọc...\n${JSON.stringify(R)}\nXong` },
      resolve: (host, role) => ({ host, role, model: 'm', effort: 'high', source: 'fallback', warnings: ['máy không có dòng sol'] }),
    })
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 0)
    assert.match(errText(h), /! máy không có dòng sol/)
  })
})

describe('run: reviewer hỏng', () => {
  test('hết lượt ⇒ exit 1, thông báo HẾT LƯỢT, vẫn xoá workspace và ghi raw', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: 'Error: usage limit reached' } })
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.match(errText(h), /HẾT LƯỢT/)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
    assert.equal(fs.existsSync(h.out), false)
    assert.match(fs.readFileSync(h.out.replace(/\.json$/, '.raw.txt'), 'utf8'), /usage limit/)
  })

  test('chưa đăng nhập giữa chừng ⇒ nói lệnh đăng nhập', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: 'Not logged in' } })
    assert.equal(await run(h.args(makeRepo(), 'opus'), h.deps), 1)
    assert.match(errText(h), /chưa đăng nhập/)
  })

  test('không ra JSON ⇒ exit 1, chỉ chỗ xem raw', async () => {
    const h = harness({ reply: { stdout: 'Tôi chỉ đọc luật dự án.' } })
    assert.equal(await run(h.args(makeRepo(), 'flash'), h.deps), 1)
    assert.match(errText(h), /không ra JSON review/)
    assert.match(errText(h), /raw\.txt/)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('quá giờ ⇒ exit 1', async () => {
    const h = harness({ reply: { status: null, stdout: '', timedOut: true } })
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.match(errText(h), /ETIMEDOUT/)
  })

  test('bộ chạy ném lỗi bất ngờ ⇒ exit 1 và workspace vẫn bị xoá', async () => {
    const h = harness()
    h.deps.exec = async () => { throw new Error('boom') }
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.match(errText(h), /boom/)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })
})

describe('run: CLI ngoài báo lỗi kiểu bản cũ ⇒ thêm một dòng gợi ý cập nhật (zzma CN-05)', () => {
  const REQ = "The 'gpt-6.1-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
  const HINT = 'Codex đang ở bản 0.153.0, bản mới nhất là 0.162.1: lỗi này là do bản cũ. Nói "cập nhật Codex" để AI cập nhật.'
  // Gắn staleHint giả vào deps; trả về danh sách lần gọi.
  const stub = (h, impl) => {
    const calls = []
    h.deps.staleHint = async (tool, text) => { calls.push({ tool, text }); return impl ? impl(tool, text) : HINT }
    return calls
  }

  test('codex "requires a newer version" ⇒ exit 1, giữ lời báo lỗi cũ, thêm đúng dòng gợi ý; staleHint nhận tên CLI + chữ lỗi', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: REQ } })
    const calls = stub(h)
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tool, 'codex')
    assert.ok(calls[0].text.includes('requires a newer version of Codex'))
    assert.match(errText(h), /không ra JSON review/)
    assert.ok(h.logs.err.includes(HINT), errText(h))
    assert.equal(h.logs.err.filter((l) => l === HINT).length, 1)
    assert.equal(fs.existsSync(h.out), false)
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('mỗi model gọi staleHint với đúng tên CLI: grok → cursor-agent, flash/opus → agy, codex → codex', async () => {
    for (const [model, cli] of [['grok', 'cursor-agent'], ['flash', 'agy'], ['opus', 'agy'], ['codex', 'codex']]) {
      const h = harness({ reply: { status: 1, stdout: '', stderr: REQ } })
      const calls = stub(h)
      assert.equal(await run(h.args(makeRepo(), model), h.deps), 1, model)
      assert.deepEqual(calls.map((c) => c.tool), [cli], model)
    }
  })

  test('cũng hỏi khi lỗi là hết lượt / chưa đăng nhập (staleHint tự quyết có phải bản cũ không); lời cũ giữ nguyên', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: 'Error: usage limit reached' } })
    const calls = stub(h, () => null)
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.equal(calls.length, 1)
    assert.match(errText(h), /HẾT LƯỢT/)
    assert.ok(!errText(h).includes('cập nhật Codex'))
  })

  test('staleHint trả null ⇒ không thêm dòng nào', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: REQ } })
    stub(h, () => null)
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.match(errText(h), /không ra JSON review/)
    assert.ok(!errText(h).includes('cập nhật'), errText(h))
  })

  test('staleHint ném lỗi ⇒ vẫn exit 1 với lời báo lỗi cũ, workspace vẫn xoá', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: REQ } })
    stub(h, () => { throw new Error('mạng sập') })
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    assert.match(errText(h), /không ra JSON review/)
    assert.ok(!errText(h).includes('mạng sập'))
    assert.deepEqual(fs.readdirSync(h.tmpRoot), [])
  })

  test('review thành công ⇒ không gọi staleHint', async () => {
    const h = harness()
    const calls = stub(h)
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 0)
    assert.equal(calls.length, 0)
  })

  test('không tiêm staleHint, lỗi KHÔNG phải bản cũ ⇒ dùng staleHint thật: không chạm mạng, không dòng gợi ý', async () => {
    const h = harness({ reply: { status: 1, stdout: '', stderr: 'Error: usage limit reached' } })
    const fetched = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error('không được chạm mạng') }
    try {
      assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 1)
    } finally {
      globalThis.fetch = realFetch
    }
    assert.deepEqual(fetched, [])
    assert.ok(!errText(h).includes('cập nhật'))
  })
})

// ---------- runReviewer: tiến trình thật ----------

describe('run: kết quả của reviewer chứa khoá (prompt injection) ⇒ exit 3, không ghi nội dung', () => {
  const GHP = 'ghp_' + 'a'.repeat(36)
  const leaks = {
    'trong finding của JSON': { stdout: JSON.stringify({ ...R, findings: [{ ...R.findings[0], summary: `khoá ở đây: ${AWS_KEY}` }] }) },
    'trong chữ ngoài JSON (stdout)': { stdout: `Đây là biến môi trường: ${GHP}\n${JSON.stringify(R)}` },
    'chỉ ở stderr': { stderr: `debug: token=${GHP}` },
    'JSON thoát unicode (\\u0041KIA…) chỉ lộ sau khi giải mã': { stdout: JSON.stringify(R).replace('"a"', `"\\u0041${AWS_KEY.slice(1)}"`) },
    'không ra JSON nhưng có khoá': { stdout: `tôi đọc được ${AWS_KEY}` },
  }
  for (const [name, reply] of Object.entries(leaks)) {
    test(name, async () => {
      const h = harness({ reply })
      const code = await run(h.args(makeRepo(), 'codex'), h.deps)
      assert.equal(code, 3, errText(h))
      assert.match(errText(h), /kết quả review chứa khoá — có thể bị prompt injection/)
      for (const secret of [AWS_KEY, GHP]) assert.ok(!errText(h).includes(secret), 'không được in khoá ra log')
      assert.equal(fs.existsSync(h.out), false, 'không ghi file kết quả')
      assert.equal(fs.existsSync(h.out.replace(/\.json$/, '.raw.txt')), false, 'không ghi file raw')
      for (const f of fs.readdirSync(path.dirname(h.out))) assert.ok(!fs.readFileSync(path.join(path.dirname(h.out), f), 'utf8').includes(GHP), `${f} chứa khoá`)
      assert.deepEqual(fs.readdirSync(h.tmpRoot), [], 'workspace vẫn bị xoá')
    })
  }
  test('kết quả sạch vẫn ghi bình thường (exit 0)', async () => {
    const h = harness()
    assert.equal(await run(h.args(makeRepo(), 'codex'), h.deps), 0)
    assert.ok(fs.existsSync(h.out) && fs.existsSync(h.out.replace(/\.json$/, '.raw.txt')))
  })
})

describe('runReviewer', () => {
  test('đưa stdin, cwd, đối số; lấy stdout', async () => {
    const d = tmp('rx-run-')
    const code = 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify({cwd:process.cwd(),s,a:process.argv.slice(1)})))'
    const r = await runReviewer(process.execPath, ['-e', code, 'x y', '-'], { cwd: d, input: 'xin chào', timeoutMs: 30000 })
    assert.equal(r.status, 0)
    assert.equal(r.timedOut, false)
    const j = JSON.parse(r.stdout)
    assert.equal(real(j.cwd), real(d))
    assert.equal(j.s, 'xin chào')
    assert.deepEqual(j.a, ['x y', '-'])
  })

  test('lệnh không tồn tại ⇒ error.code ENOENT, không ném', async () => {
    const r = await runReviewer('rx-khong-co-cli-nay-xyz', [], { timeoutMs: 5000 })
    assert.equal(r.error?.code, 'ENOENT')
    assert.equal(r.status, null)
  })

  test('quá giờ ⇒ timedOut, giết cả tiến trình con', async () => {
    const d = tmp('rx-run-')
    const pidFile = path.join(d, 'pid')
    const child = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const parent = `const {spawn}=require("child_process");spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"});setInterval(()=>{},1000)`
    const t0 = Date.now()
    const r = await runReviewer(process.execPath, ['-e', parent], { cwd: d, timeoutMs: 3000 })
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - t0 < 20000)
    assert.ok(fs.existsSync(pidFile), 'tiến trình con đã chạy')
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((ok) => setTimeout(ok, 100)) } catch { alive = false }
    }
    assert.equal(alive, false, 'tiến trình con còn sống sau khi quá giờ')
  })

  test('Windows: shim .cmd chạy được (đường dẫn có dấu cách), từ chối đối số lạ', { skip: !IS_WIN }, async () => {
    const d = tmp('rx shim ')
    fs.writeFileSync(path.join(d, 'echo.cjs'), 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify({a:process.argv.slice(2),s})))')
    fs.writeFileSync(path.join(d, 'tool.cmd'), '@echo off\r\nnode "%~dp0echo.cjs" %*\r\n')
    const r = await runReviewer(path.join(d, 'tool.cmd'), ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-'], { cwd: d, input: 'abc', timeoutMs: 30000 })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { a: ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-'], s: 'abc' })
    const bad = await runReviewer(path.join(d, 'tool.cmd'), ['a b & calc'], { cwd: d, timeoutMs: 5000 })
    assert.equal(bad.error?.code, 'EUNSAFE')
  })
})

// ---------- đầu-cuối: node review-ext.mjs với codex giả trên PATH, HOME giả ----------

const FAKE_CLI = `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
if (a[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0) }
if (a[0] === 'login') {
  if (process.env.FAKE_AUTH === 'none') { console.error('Not logged in'); process.exit(1) }
  console.log('Logged in using ChatGPT'); process.exit(0)
}
if (a[0] === 'exec') {
  let stdin = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (stdin += d))
  process.stdin.on('end', () => {
    const files = []
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r) } }
    walk(process.cwd(), '')
    fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, cwd: process.cwd(), stdin, files }))
    console.log('Reading the diff...')
    console.log(JSON.stringify({ findings: [], areas_checked: 'fake' }))
  })
} else process.exit(2)
`

function e2e({ auth = 'ok' } = {}) {
  const bin = tmp('rx-bin-')
  fs.writeFileSync(path.join(bin, 'fake-cli.cjs'), FAKE_CLI)
  if (IS_WIN) fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0fake-cli.cjs" %*\r\n')
  else {
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-cli.cjs" "$@"\n')
    fs.chmodSync(path.join(bin, 'codex'), 0o755)
  }
  const home = tmp('rx-home-')
  fs.mkdirSync(path.join(home, '.codex'))
  const lv = (e) => ({ effort: e })
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: [
      { slug: 'gpt-6-sol', visibility: 'list', priority: 2, supported_reasoning_levels: [lv('low'), lv('high')] },
      { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1, supported_reasoning_levels: [lv('low'), lv('medium'), lv('high')] },
      { slug: 'gpt-6-luna', visibility: 'list', priority: 3, supported_reasoning_levels: [lv('low')] },
    ],
  }))
  const log = path.join(tmp('rx-log-'), 'fake.json')
  const env = { ...process.env, HOME: home, USERPROFILE: home, FAKE_LOG: log, FAKE_AUTH: auth }
  const pk = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  env[pk] = bin + path.delimiter + (env[pk] ?? '')
  delete env.CODEX_HOME
  const out = path.join(tmp('rx-out-'), 'review.json')
  const go = (repo, extra = []) => spawnSync(process.execPath, [SCRIPT, '--model', 'codex', '--wt', repo, '--out', out, '--base', 'main', '--timeout', '120', ...extra], { env, encoding: 'utf8', timeout: 120000 })
  return { go, log, out }
}

describe('đầu-cuối với codex giả', () => {
  test('exit 0: model thật từ models_cache, prompt qua stdin, workspace tạm đã lọc và xoá', () => {
    const repo = makeRepo()
    const e = e2e()
    const r = e.go(repo)
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /gpt-6\.1-sol/)
    const seen = JSON.parse(fs.readFileSync(e.log, 'utf8'))
    assert.deepEqual(seen.args.slice(0, 3), ['exec', '--sandbox', 'read-only'])
    assert.equal(seen.args[seen.args.indexOf('-m') + 1], 'gpt-6.1-sol')
    assert.ok(seen.args.includes('model_reasoning_effort=high'))
    assert.equal(fs.existsSync(seen.cwd), false, 'workspace tạm đã xoá')
    assert.ok(!seen.cwd.startsWith(repo))
    assert.deepEqual(seen.files.filter((f) => /customers|\.env|Note\/|\.mcp|secrets\/|link-to-app/.test(f)), [])
    assert.ok(seen.files.includes('src/app.js'))
    assert.ok(seen.stdin.includes('+export const b = 2'))
    for (const marker of ['ALICE-PRIVATE-ROW', 'ENV-MARKER-VALUE', 'GLOB-PRIVATE-MARKER']) assert.ok(!seen.stdin.includes(marker), marker)
    const rev = JSON.parse(fs.readFileSync(e.out, 'utf8'))
    assert.deepEqual(rev.findings, [])
    assert.match(rev.reviewer, /gpt-6\.1-sol/)
  })

  test('exit 3 khi secret chỉ ở dòng xoá: CLI giả không bao giờ được gọi exec', () => {
    const repo = makeRepo({ base: { 'src/cfg.js': `const k = "${AWS_KEY}"\n` }, feat: { 'src/cfg.js': 'const k = 1\n' } })
    const e = e2e()
    const r = e.go(repo)
    assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`)
    assert.equal(fs.existsSync(e.log), false)
    assert.ok(!r.stdout.includes(AWS_KEY) && !r.stderr.includes(AWS_KEY))
  })

  test('chưa đăng nhập ⇒ exit 1 kèm message của clis và lệnh đăng nhập', () => {
    const e = e2e({ auth: 'none' })
    const r = e.go(makeRepo())
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /codex chưa đăng nhập/)
    assert.match(r.stderr, /codex login/)
    assert.equal(fs.existsSync(e.log), false)
  })
})

test('reviewerEnv: bỏ biến dạng khoá/mật khẩu của máy, chỉ giữ biến đăng nhập của đúng CLI đang gọi', () => {
  const parent = { PATH: '/bin', HOME: '/h', SUPABASE_TOKEN_CLAWX_SEO: 'x', GITHUB_PERSONAL_ACCESS_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x',
    DB_PASSWORD: 'x', OPENAI_API_KEY: 'o', CURSOR_API_KEY: 'c', GEMINI_API_KEY: 'g', LOCALAPPDATA: 'L' }
  assert.deepEqual(Object.keys(reviewerEnv(parent, 'codex')).sort(), ['HOME', 'LOCALAPPDATA', 'OPENAI_API_KEY', 'PATH'])
  assert.deepEqual(Object.keys(reviewerEnv(parent, 'grok')).sort(), ['CURSOR_API_KEY', 'HOME', 'LOCALAPPDATA', 'PATH'])
  assert.deepEqual(Object.keys(reviewerEnv(parent, 'flash')).sort(), ['GEMINI_API_KEY', 'HOME', 'LOCALAPPDATA', 'PATH'])
})

test('reviewerEnv: lọc cả theo GIÁ TRỊ — tên vô hại nhưng giá trị là khoá / URL có mật khẩu ⇒ bỏ; biến đăng nhập của đúng CLI vẫn giữ', () => {
  const parent = {
    PATH: '/bin', HOME: '/h', BUILD_REF: AWS_KEY, MY_VAR: 'ghp_' + 'a'.repeat(36),
    // URL có mật khẩu ghép lúc chạy: viết liền thì chính bộ lọc gửi sạch chặn diff của file test này khi review.
    DATABASE_URL: 'postgres://app' + ':' + 'Sup3rS3cretPw@db.internal:5432/app', REDIS_URL: 'redis://u' + ':' + 'p@h', HTTP_PROXY: 'http://user' + ':' + 'pw@proxy.corp:8080',
    LOG_LEVEL: 'debug', REPO_URL: 'https://github.com/o/r.git', EMAIL: 'a@b.c', OPENAI_API_KEY: 'sk-' + 'a'.repeat(40),
  }
  assert.deepEqual(Object.keys(reviewerEnv(parent, 'codex')).sort(), ['EMAIL', 'HOME', 'LOG_LEVEL', 'OPENAI_API_KEY', 'PATH', 'REPO_URL'])
  assert.deepEqual(Object.keys(reviewerEnv(parent, 'grok')).sort(), ['EMAIL', 'HOME', 'LOG_LEVEL', 'PATH', 'REPO_URL'])
})

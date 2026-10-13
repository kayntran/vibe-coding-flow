// Test cho lib/secrets.mjs + secret-scan.mjs: node --test hooks/lib/secrets.test.mjs
// Mọi secret giả ghép lúc chạy (nối chuỗi) để chính file này không chứa token nguyên văn — tránh tự bị cổng quét secret chặn khi commit.
// Ký tự ẩn viết bằng \u escape, không dán ký tự thật.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECRET_PATTERNS, KNOWN_FALSE_POSITIVES, ALLOW_MARK,
  BUILD_DIRS, isSensitiveFile, isPrivateData, scanLine, scanText, scanPatch, scanDiff, scanDir, scanFiles, extensionBuilds, scanHidden, scanHiddenPaths, unquoteGitPath,
} from './secrets.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'secret-scan.mjs')

// ---------- fixture giả ----------
const GHP = 'ghp_' + 'a'.repeat(36)
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => [b64u({ alg: 'HS256', typ: 'JWT' }), b64u(payload), 'x'.repeat(43)].join('.')
const JWT_ANON = jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'anon', iat: 1, exp: 2 })
const JWT_SERVICE = jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role', iat: 1, exp: 2 })
const JWT_USER = jwt({ iss: 'supabase', role: 'authenticated', sub: 'u1' })
const STRIPE_LIVE = 'sk_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'
const STRIPE_RK = 'rk_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'
const SB_SECRET = 'sb_' + 'secret_' + 'AbCdEfGhIjKlMnOpQrStUv_1a2b3c4d'
const SENDGRID = 'SG' + '.' + 'a1B2c3D4e5F6g7H8i9J0kL' + '.' + 'z'.repeat(43)
const TWILIO_SK = 'S' + 'K' + 'a1'.repeat(16)
const CF_TOKEN = 'cf' + 'ut_' + 'Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5Nm7'

// Nguyên bộ mẫu của flow-gate.test.mjs (hành vi cũ phải giữ nguyên)
const SAMPLES = [
  ['private-key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
  ['aws', 'AKIA' + 'Q3EGRDLMZ7XK2PWN'],
  ['github', GHP],
  ['github', 'github_pat_' + 'b'.repeat(60)],
  ['anthropic', 'sk-ant-' + 'c'.repeat(24)],
  ['openai', 'sk-proj-' + 'd'.repeat(40)],
  ['xai', 'xai-' + 'e'.repeat(40)],
  ['google', 'AIza' + 'f'.repeat(35)],
  ['slack', 'xoxb-' + '1234567890-abcdef'],
  ['jwt', 'eyJ' + 'hbGciOiJIUzI1' + '.eyJ' + 'zdWIiOiIxMjM0' + '.' + 'SflKxwRJSMeKKF2QT4'],
  ['url-credential', 'postgres://' + 'admin:hunter22pass@db.example.com/app'],
]

const names = (hits) => hits.map((h) => h.name)
const tmp = (p = 'secrets-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const put = (root, rel, content) => {
  const f = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return f
}
const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input })

describe('scanLine: giữ nguyên hành vi của flow-gate', () => {
  test('mọi mẫu cũ được nhận đúng tên; value che còn 4 ký tự đầu', () => {
    for (const [name, s] of SAMPLES) {
      const hits = scanLine(`x = ${s}`)
      assert.deepEqual(names(hits), [name], `${name}: ${JSON.stringify(hits)}`)
      assert.equal(hits[0].value, `${s.slice(0, 4)}…`)
      assert.equal(hits[0].index, 4)
      // url-credential chỉ khớp tới dấu "@" (phần host sau đó không thuộc mẫu); các mẫu khác khớp trọn token
      if (name === 'url-credential') assert.ok(hits[0].end > hits[0].index + 10)
      else assert.equal(hits[0].end, 4 + s.length)
      assert.ok(!JSON.stringify(hits).includes(s.slice(0, 8)), 'lộ quá 4 ký tự đầu')
    }
  })

  test('sk-ant chỉ báo anthropic, không báo trùng openai', () => {
    assert.deepEqual(names(scanLine('k = ' + 'sk-ant-' + 'c'.repeat(40))), ['anthropic'])
  })

  test('khoá ví dụ công khai của AWS và URL mẫu :password@ không bị báo', () => {
    assert.deepEqual(scanLine('k = AKIA' + 'IOSFODNN7EXAMPLE'), [])
    assert.deepEqual(scanLine('proxy = http://user:' + 'password@proxy.local:8080'), [])
  })

  test('khớp ví dụ đứng trước KHÔNG che khớp thật đứng sau trên cùng dòng', () => {
    const line = 'a = AKIA' + 'IOSFODNN7EXAMPLE ; b = AKIA' + 'Q3EGRDLMZ7XK2PWN'
    assert.deepEqual(names(scanLine(line)), ['aws'])
  })

  test('11 mẫu đầu y hệt bản còn nằm trong flow-gate.mjs (hết hiệu lực khi làn D chuyển flow-gate sang import)', (t) => {
    const src = fs.readFileSync(path.join(HERE, '..', 'flow-gate.mjs'), 'utf8')
    const body = /const SECRET_PATTERNS = \[([\s\S]*?)\n\]/.exec(src)?.[1]
    if (!body) return t.skip('flow-gate.mjs không còn bản sao SECRET_PATTERNS')
    const orig = new Function(`return [${body}]`)()
    assert.equal(orig.length, 11)
    orig.forEach(([n, re], i) => assert.deepEqual([SECRET_PATTERNS[i][0], SECRET_PATTERNS[i][1].source, SECRET_PATTERNS[i][1].flags], [n, re.source, re.flags], `mẫu #${i}`))
  })

  test('cấu trúc xuất: SECRET_PATTERNS là [tên, RegExp], KNOWN_FALSE_POSITIVES là [tên, hàm], ALLOW_MARK', () => {
    assert.ok(SECRET_PATTERNS.length >= 11)
    for (const [n, re] of SECRET_PATTERNS) assert.ok(typeof n === 'string' && re instanceof RegExp)
    for (const [n, fn] of KNOWN_FALSE_POSITIVES) assert.ok(typeof n === 'string' && typeof fn === 'function')
    assert.equal(ALLOW_MARK, 'flow-gate: allow-secret')
  })
})

describe('mẫu mới (AC-11)', () => {
  test('Stripe sk_live_ / rk_live_ bị báo; pk_live_ (công khai) và chữ x giữ chỗ thì không', () => {
    assert.deepEqual(names(scanLine(`STRIPE=${STRIPE_LIVE}`)), ['stripe'])
    assert.deepEqual(names(scanLine(`STRIPE=${STRIPE_RK}`)), ['stripe'])
    assert.deepEqual(scanLine('pk_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'), [])
    assert.deepEqual(scanLine('sk_' + 'live_' + 'x'.repeat(24)), [])
    assert.deepEqual(scanLine('sk_' + 'test_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'), []) // khoá test không phải live
    assert.deepEqual(scanLine('task_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'), []) // "sk_live_" nằm giữa một từ
  })

  test('Supabase sb_secret_ bị báo; sb_publishable_ thì không', () => {
    assert.deepEqual(names(scanLine(`key: "${SB_SECRET}"`)), ['supabase'])
    assert.deepEqual(scanLine('sb_' + 'publishable_' + 'AbCdEfGhIjKlMnOpQrStUv_1a2b3c4d'), [])
  })

  test('SendGrid SG.xxx.yyy bị báo; chuỗi SG. ngắn thì không', () => {
    assert.deepEqual(names(scanLine(`MAIL=${SENDGRID}`)), ['sendgrid'])
    assert.deepEqual(scanLine('SG' + '.' + 'abc.def'), [])
  })

  test('Twilio: SK + 32 hex, và auth token đứng sau tên biến twilio', () => {
    assert.deepEqual(names(scanLine(`sid = "${TWILIO_SK}"`)), ['twilio'])
    assert.deepEqual(names(scanLine('TWILIO_AUTH_' + 'TOKEN=' + 'a1b2c3d4'.repeat(4))), ['twilio'])
    assert.deepEqual(scanLine('TWILIO_AUTH_' + 'TOKEN=${TWILIO_AUTH_TOKEN}'), [])
    assert.deepEqual(scanLine('checksum = ' + 'a1b2c3d4'.repeat(4)), []) // 32 hex trần không đủ để kết luận
  })

  test('Cloudflare: token cfut_ và giá trị dài đứng sau CLOUDFLARE_API_TOKEN / CF_API_TOKEN', () => {
    assert.deepEqual(names(scanLine(`t = ${CF_TOKEN}`)), ['cloudflare'])
    const tok = 'Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5Nm7Qq'
    assert.deepEqual(names(scanLine('CLOUDFLARE_API_' + 'TOKEN=' + tok)), ['cloudflare'])
    assert.deepEqual(names(scanLine('CF_API_' + 'TOKEN: "' + tok + '"')), ['cloudflare'])
    assert.deepEqual(scanLine('CLOUDFLARE_API_' + 'TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'), [])
    assert.deepEqual(scanLine('CLOUDFLARE_API_' + 'TOKEN=your-token-goes-here-' + 'x'.repeat(20)), [])
    assert.deepEqual(scanLine('CF_ZONE_ID=' + 'a1b2c3d4'.repeat(4)), [])
  })

  test('dòng dài hàng MB (bundle minify) quét nhanh, không treo regex', () => {
    const blob = ('cf' + 'Ab12_-').repeat(400000) // ~3 MB một dòng, nhiều "cf"
    const t0 = Date.now()
    scanLine(blob)
    scanLine(`x="${JWT_SERVICE}";` + blob)
    assert.ok(Date.now() - t0 < 5000, `quét chậm: ${Date.now() - t0} ms`)
  })
})

describe('JWT: giải mã vai trò', () => {
  test('role=anon (khoá công khai) bỏ qua', () => {
    assert.deepEqual(scanLine(`anon: "${JWT_ANON}"`), [])
  })
  test('role=service_role ⇒ lỗi, tên riêng, value che', () => {
    const hits = scanLine(`k = "${JWT_SERVICE}"`)
    assert.deepEqual(names(hits), ['jwt-service-role'])
    assert.equal(hits[0].value, 'eyJh…')
  })
  test('role khác hoặc không giải mã được ⇒ vẫn báo là jwt (như cũ)', () => {
    assert.deepEqual(names(scanLine(JWT_USER)), ['jwt'])
    assert.deepEqual(names(scanLine(SAMPLES[9][1])), ['jwt'])
  })
  test('anon đứng trước service_role trên cùng một dòng không che được khoá quản trị', () => {
    assert.deepEqual(names(scanLine(`{a:"${JWT_ANON}",b:"${JWT_SERVICE}"}`)), ['jwt-service-role'])
  })
})

describe('scanText', () => {
  test('đánh số dòng từ 1, hỗ trợ CRLF, mỗi dòng nhiều mẫu', () => {
    const text = `ok\r\nx=${GHP}\r\n\r\ny=${STRIPE_LIVE} ${SENDGRID}\n`
    const hits = scanText(text)
    assert.deepEqual(hits.map((h) => [h.line, h.name]), [[2, 'github'], [4, 'stripe'], [4, 'sendgrid']])
    assert.ok(!JSON.stringify(hits).includes(GHP.slice(0, 8)))
  })
  test('dòng allow-secret: mặc định VẪN báo (gửi ra ngoài phải chặt), allow:true thì bỏ dòng đó', () => {
    const text = `a="${GHP}" // ${ALLOW_MARK}\nb="${GHP}"\n`
    assert.deepEqual(scanText(text).map((h) => h.line), [1, 2])
    assert.deepEqual(scanText(text, { allow: true }).map((h) => h.line), [2])
  })
  test('văn bản sạch/rỗng ⇒ []', () => {
    assert.deepEqual(scanText(''), [])
    assert.deepEqual(scanText('const a = process.env.API_KEY\n'), [])
  })
})

describe('isSensitiveFile (giữ nguyên)', () => {
  test('bị báo', () => {
    for (const f of ['.env', 'app/.env.production', 'keys/id_rsa', 'keys/id_ed25519', 'tls/server.pem', '.dev.vars', 'credentials.json', 'a/b/.ENV', 'C:\\x\\.env']) {
      assert.equal(isSensitiveFile(f), true, f)
    }
  })
  test('cho qua', () => {
    for (const f of ['.env.example', '.env.sample', '.env.template', 'keys/id_rsa.pub', 'README.md', 'src/env.ts', 'envelope.pem.txt']) {
      assert.equal(isSensitiveFile(f), false, f)
    }
  })
})

describe('isPrivateData', () => {
  test('đuôi csv/sqlite/db/dump và thư mục data/', () => {
    for (const f of ['users.csv', 'a/b/Export.CSV', 'app.sqlite', 'a.sqlite3', 'db/dev.db', 'backup.dump', 'data/customers.json', 'data/x/y.txt', 'apps/api/data/users.json']) {
      assert.equal(isPrivateData(f), true, f)
    }
  })
  test('mã nguồn nằm trong thư mục data lồng nhau, và tên na ná thì không', () => {
    for (const f of ['src/data/constants.ts', 'src/data/index.js', 'lib/data/model.go', 'README.md', 'metadata/x.json', 'src/dataset.ts', 'db.ts', 'docs/csv.md', 'a.csv.ts']) {
      assert.equal(isPrivateData(f), false, f)
    }
    assert.equal(isPrivateData('data/seed.ts'), true) // data/ ở gốc luôn là dữ liệu
  })
  test('glob "private" trong .claude/flow.json (mảng hoặc chuỗi)', () => {
    const cfg = { private: ['secrets/**', '*.xlsx', 'exports/', 'config/prod.yml', 'logs/**/*.log'] }
    for (const f of ['secrets/a/b.txt', 'secrets/x', 'report.xlsx', 'a/b/report.XLSX', 'exports/a.json', 'x/exports/a.json', 'config/prod.yml', 'logs/2026/10/a.log', 'logs/a.log']) {
      assert.equal(isPrivateData(f, cfg), true, f)
    }
    for (const f of ['config/dev.yml', 'x/config/prod.yml', 'src/secretsmith.ts', 'logs/a.txt', 'export/a.json']) {
      assert.equal(isPrivateData(f, cfg), false, f)
    }
    assert.equal(isPrivateData('notes/me.txt', { private: 'notes/**' }), true)
    assert.equal(isPrivateData('x.txt', { private: 5 }), false)
    assert.equal(isPrivateData('x.txt', null), false)
    assert.equal(isPrivateData('x.txt', {}), false)
  })
  test('dấu \\ của Windows được chuẩn hoá', () => {
    assert.equal(isPrivateData('data\\users.json'), true)
    assert.equal(isPrivateData('a\\b.csv'), true)
  })
})

describe('scanPatch (chép từ flow-gate, giữ nguyên)', () => {
  const patch = [
    'diff --git cfg.js cfg.js',
    '--- cfg.js',
    '+++ cfg.js',
    '@@ -3,0 +4,2 @@',
    `+const t = "${GHP}"`,
    '+const ok = 1',
    '@@ -9 +11 @@',
    `-old = "${GHP}"`,
    `+new = "${STRIPE_LIVE}" // ${ALLOW_MARK}`,
    'diff --git b.js b.js',
    '--- b.js',
    '+++ b.js',
    '@@ -0,0 +1 @@',
    `+k = "${SENDGRID}"`,
    'diff --git gone.js gone.js',
    'deleted file mode 100644',
    '--- gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-x = "${GHP}"`,
  ].join('\n')

  test('chỉ quét dòng THÊM, số dòng theo file mới, file có dòng allow vào allowed', () => {
    const { findings, allowed } = scanPatch(patch)
    assert.deepEqual(findings.map((f) => [f.file, f.line, f.name]), [['cfg.js', 4, 'github'], ['b.js', 1, 'sendgrid']])
    assert.deepEqual([...allowed], ['cfg.js'])
    assert.ok(!JSON.stringify(findings).includes(GHP.slice(0, 8)))
  })
  test('diff xuống dòng kiểu Windows (CRLF): tên file không dính \\r — dòng allow vẫn miễn đúng file, số dòng vẫn đúng', () => {
    const { findings, allowed } = scanPatch(patch.replace(/\n/g, '\r\n'))
    assert.deepEqual(findings.map((f) => [f.file, f.line, f.name]), [['cfg.js', 4, 'github'], ['b.js', 1, 'sendgrid']])
    assert.deepEqual([...allowed], ['cfg.js'])
  })
  test('dòng nội dung bắt đầu bằng "++ " trong hunk không bị nhầm là header', () => {
    const p = ['diff --git a.txt a.txt', '--- a.txt', '+++ a.txt', '@@ -0,0 +1,2 @@', '+++ tiêu đề', `+x = ${GHP}`].join('\n')
    assert.deepEqual(scanPatch(p).findings.map((f) => [f.file, f.line]), [['a.txt', 2]])
  })
})

describe('scanDiff: quét CẢ dòng xoá (AC-28)', () => {
  const diff = [
    'diff --git a/cfg.js b/cfg.js',
    'index 111..222 100644',
    '--- a/cfg.js',
    '+++ b/cfg.js',
    '@@ -10,3 +10,3 @@ function f() {',
    ' ctx',
    `-old = "${GHP}"`,
    '+new = 1',
    ' ctx2',
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a = 1',
    `-b = "${STRIPE_LIVE}"`,
  ].join('\n')

  test('secret chỉ nằm ở dòng bị xoá vẫn bị thấy; line = số dòng của file CŨ; removed=true', () => {
    const f = scanDiff(diff)
    assert.deepEqual(f.map((x) => [x.file, x.line, x.name, x.removed]), [['cfg.js', 11, 'github', true], ['gone.js', 2, 'stripe', true]])
    assert.ok(!JSON.stringify(f).includes(GHP.slice(0, 8)))
  })
  test('dòng thêm: removed=false, line theo file mới (có dòng ngữ cảnh -U3)', () => {
    const d = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -4,2 +4,3 @@', ' a', '+k = "' + SB_SECRET + '"', ' b'].join('\n')
    assert.deepEqual(scanDiff(d).map((x) => [x.file, x.line, x.name, x.removed]), [['x.js', 5, 'supabase', false]])
  })
  test('diff xuống dòng kiểu Windows (CRLF): file nhạy cảm / dữ liệu riêng / đổi tên vẫn bị thấy, tên không dính \\r', () => {
    const d = [
      'diff --git a/.env b/.env', 'index 1..2 100644', '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-A=1', '+A=2',
      'diff --git a/old.pem b/new.pem', 'similarity index 100%', 'rename from old.pem', 'rename to new.pem',
      'diff --git a/data/a.csv b/data/a.csv', 'index 1..2 100644', '--- a/data/a.csv', '+++ b/data/a.csv', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/src/ok.js b/src/ok.js', 'index 1..2 100644', '--- a/src/ok.js', '+++ b/src/ok.js', '@@ -1 +1 @@', '-a', `+b = "${GHP}"`,
    ].join('\r\n') + '\r\n'
    const f = scanDiff(d, {})
    assert.deepEqual(f.filter((x) => x.line === null).map((x) => `${x.file}:${x.name}`).sort(), ['.env:file nhạy cảm', 'data/a.csv:dữ liệu riêng', 'new.pem:file nhạy cảm', 'old.pem:file nhạy cảm'])
    assert.deepEqual(f.filter((x) => x.line !== null).map((x) => [x.file, x.line, x.name]), [['src/ok.js', 1, 'github']])
  })
  test('diff không tiền tố a/ b/ (--no-prefix) cũng đúng tên file', () => {
    const d = ['diff --git src/a.js src/a.js', '--- src/a.js', '+++ src/a.js', '@@ -1 +1 @@', `-t = ${GHP}`, '+t = 2'].join('\n')
    assert.deepEqual(scanDiff(d).map((x) => [x.file, x.line, x.removed]), [['src/a.js', 1, true]])
  })
  test('file nhạy cảm / dữ liệu riêng có mặt trong diff (kể cả chỉ đổi tên, nhị phân) ⇒ finding line=null', () => {
    const d = [
      'diff --git a/.env b/.env', 'index 1..2 100644', '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-A=1', '+A=2',
      'diff --git a/data/customers.csv b/data/customers.csv', 'Binary files a/data/customers.csv and b/data/customers.csv differ',
      'diff --git a/old.pem b/new.pem', 'similarity index 100%', 'rename from old.pem', 'rename to new.pem',
      'diff --git a/src/ok.js b/src/ok.js', '--- a/src/ok.js', '+++ b/src/ok.js', '@@ -1 +1 @@', '-a', '+b',
    ].join('\n')
    const f = scanDiff(d)
    assert.deepEqual(f.filter((x) => x.line === null).map((x) => [x.file, x.name]).sort(), [
      ['.env', 'file nhạy cảm'], ['data/customers.csv', 'dữ liệu riêng'], ['new.pem', 'file nhạy cảm'], ['old.pem', 'file nhạy cảm'],
    ])
    assert.equal(f.filter((x) => x.file === 'src/ok.js').length, 0)
  })
  test('projectCfg.private mở rộng phần dữ liệu riêng', () => {
    const d = ['diff --git a/exports/a.json b/exports/a.json', '--- a/exports/a.json', '+++ b/exports/a.json', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    assert.deepEqual(scanDiff(d), [])
    assert.deepEqual(scanDiff(d, { projectCfg: { private: ['exports/'] } }).map((x) => x.name), ['dữ liệu riêng'])
  })
  test('allow:true — dòng allow-secret bỏ dòng đó và cho file nhạy cảm có dòng allow qua; mặc định thì không', () => {
    const d = ['diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -0,0 +1,2 @@', `+# ${ALLOW_MARK}`, `+K=${GHP}`].join('\n')
    assert.ok(scanDiff(d).length >= 2)
    assert.deepEqual(scanDiff(d, { allow: true }).map((x) => x.line), [2])
  })
  test('diff rỗng/sạch ⇒ []', () => {
    assert.deepEqual(scanDiff(''), [])
    assert.deepEqual(scanDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n'), [])
  })
  test('đường dẫn git C-quote (\\", \\\\, \\t, \\ooo bát phân UTF-8) được giải đúng trước khi so với glob private', () => {
    const cfg = { private: ['exports/a"b/**', 'tab\tdir/**', 'bí-mật/**', 'kín/**'] }
    const d = [
      'diff --git "a/exports/a\\"b/x.txt" "b/exports/a\\"b/x.txt"', '--- "a/exports/a\\"b/x.txt"', '+++ "b/exports/a\\"b/x.txt"', '@@ -1 +1 @@', '-a', '+b',
      'diff --git "a/tab\\tdir/y.txt" "b/tab\\tdir/y.txt"', '--- "a/tab\\tdir/y.txt"', '+++ "b/tab\\tdir/y.txt"', '@@ -1 +1 @@', '-a', '+b',
      'diff --git "a/b\\303\\255-m\\341\\272\\255t/z.txt" "b/b\\303\\255-m\\341\\272\\255t/z.txt"', 'similarity index 100%',
      'rename from "b\\303\\255-m\\341\\272\\255t/z.txt"', 'rename to "docs/q1\\"\\tnotes.txt"',
    ].join('\n')
    const f = scanDiff(d, { projectCfg: cfg }).filter((x) => x.line === null)
    assert.deepEqual(f.map((x) => [x.file, x.name]).sort(), [['bí-mật/z.txt', 'dữ liệu riêng'], ['exports/a"b/x.txt', 'dữ liệu riêng'], ['tab\tdir/y.txt', 'dữ liệu riêng']])
  })
  test('dòng "diff --git" có nháy C-quote (chỉ nhị phân / đổi chế độ, không có dòng ---/+++): tên vẫn được giải và so đúng, mỗi vế nháy độc lập', () => {
    const d = [
      'diff --git "a/k\\303\\255n\\"/b.bin" "b/k\\303\\255n\\"/b.bin"', 'index 1..2 100644', 'Binary files "a/k\\303\\255n\\"/b.bin" and "b/k\\303\\255n\\"/b.bin" differ',
      'diff --git a/docs/plain.txt "b/b\\303\\255-m\\341\\272\\255t/moved.txt"', 'similarity index 100%',
    ].join('\n')
    const f = scanDiff(d, { projectCfg: { private: ['kín"/**', 'bí-mật/**'] } }).filter((x) => x.line === null)
    assert.deepEqual(f.map((x) => x.file).sort(), ['bí-mật/moved.txt', 'kín"/b.bin'])
  })
})

describe('unquoteGitPath (đường dẫn C-quote của git)', () => {
  test('giải \\" \\\\ \\t \\n \\r và \\ooo bát phân thành byte UTF-8; không có nháy thì giữ nguyên', () => {
    assert.equal(unquoteGitPath('"a\\"b"'), 'a"b')
    assert.equal(unquoteGitPath('"a\\\\b"'), 'a\\b')
    assert.equal(unquoteGitPath('"a\\tb\\nc\\rd"'), 'a\tb\nc\rd')
    assert.equal(unquoteGitPath('"caf\\303\\251/\\341\\272\\255"'), 'café/ậ')
    assert.equal(unquoteGitPath('"\\001x\\177"'), '\x01x\x7f')
    assert.equal(unquoteGitPath('src/a.js'), 'src/a.js')
    assert.equal(unquoteGitPath('"'), '"')
    assert.equal(unquoteGitPath('"đã bỏ nháy ngoài"'), 'đã bỏ nháy ngoài')
  })
  test('thoát lạ / thiếu giữ nguyên chữ (không ném, không nuốt)', () => {
    assert.equal(unquoteGitPath('"a\\qb"'), 'a\\qb')
    assert.equal(unquoteGitPath('"a\\"'), 'a\\')
    assert.equal(unquoteGitPath('"a\\9b"'), 'a\\9b')
  })
})

describe('scanDir (bản build)', () => {
  test('build:true chỉ quét dist/ build/ .next/ out/; mã nguồn không bị quét; node_modules, .git, .next/cache bỏ qua', () => {
    const r = tmp()
    put(r, 'dist/assets/app.js', `var s="${JWT_SERVICE}";\nvar a="${JWT_ANON}"\n`)
    put(r, 'build/static/main.js', `x="${STRIPE_LIVE}"`)
    put(r, '.next/static/chunks/p.js', `x="${SB_SECRET}"`)
    put(r, 'out/index.html', `<script>k="${SENDGRID}"</script>`)
    put(r, 'apps/web/dist/a.js', `k="${GHP}"`)
    put(r, 'src/server.js', `k="${GHP}"`)
    put(r, 'node_modules/pkg/dist/i.js', `k="${GHP}"`)
    put(r, '.next/cache/webpack/x.js', `k="${GHP}"`)
    put(r, '.git/dist/y.js', `k="${GHP}"`)
    const f = scanDir(r, { build: true })
    assert.deepEqual(f.map((x) => `${x.file}:${x.line}:${x.name}`).sort(), [
      '.next/static/chunks/p.js:1:supabase',
      'apps/web/dist/a.js:1:github',
      'build/static/main.js:1:stripe',
      'dist/assets/app.js:1:jwt-service-role',
      'out/index.html:1:sendgrid',
    ])
    assert.ok(!JSON.stringify(f).includes(GHP.slice(0, 8)))
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('.output (WXT, Nuxt) là thư mục build: khoá trong .output/chrome-mv3 bị thấy, .output/.. không quét mã nguồn', () => {
    assert.ok(BUILD_DIRS.includes('.output'))
    const r = tmp()
    put(r, '.output/chrome-mv3/background.js', `var k="${GHP}"`)
    put(r, 'src/a.js', `var k="${GHP}"`)
    assert.deepEqual(scanDir(r, { build: true }).map((x) => `${x.file}:${x.line}:${x.name}`), ['.output/chrome-mv3/background.js:1:github'])
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('quét thẳng vào thư mục build (dist) cũng được tính là bản build', () => {
    const r = tmp()
    put(r, 'dist/a.js', `k="${JWT_SERVICE}"`)
    assert.deepEqual(scanDir(path.join(r, 'dist'), { build: true }).map((x) => [x.file, x.name]), [['a.js', 'jwt-service-role']])
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('bản build sạch (chỉ khoá anon) ⇒ []', () => {
    const r = tmp()
    put(r, 'dist/a.js', `var a="${JWT_ANON}"`)
    put(r, 'dist/a.js.map', '{"sources":["a.ts"],"sourcesContent":["const a = 1"]}')
    assert.deepEqual(scanDir(r, { build: true }), [])
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('source map chứa secret trong sourcesContent bị thấy; file nhị phân / ảnh bỏ qua; .env trong build bị báo', () => {
    const r = tmp()
    put(r, 'dist/a.js.map', JSON.stringify({ sourcesContent: [`const k = "${GHP}"`] }))
    put(r, 'dist/logo.png', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(GHP)]))
    put(r, 'dist/blob.dat', Buffer.concat([Buffer.from(GHP), Buffer.from([0, 0, 0])]))
    put(r, 'dist/.env', 'A=1\n')
    const f = scanDir(r, { build: true })
    assert.deepEqual(f.map((x) => [x.file, x.line, x.name]).sort(), [['dist/.env', null, 'file nhạy cảm'], ['dist/a.js.map', 1, 'github']])
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('file quá lớn không bị coi là sạch: báo "chưa quét"', () => {
    const r = tmp()
    put(r, 'dist/big.js', 'a'.repeat(5000))
    const f = scanDir(r, { build: true, maxFileBytes: 1000 })
    assert.deepEqual(f.map((x) => [x.file, x.line]), [['dist/big.js', null]])
    assert.match(f[0].name, /quá lớn/)
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('build:false quét cả cây (trừ node_modules/.git); outbound:true còn báo dữ liệu riêng + liên kết tượng trưng', (t) => {
    const r = tmp()
    put(r, 'src/a.js', `k="${GHP}"`)
    put(r, 'dist/b.js', `k="${STRIPE_LIVE}"`)
    put(r, 'node_modules/x/i.js', `k="${GHP}"`)
    put(r, 'data/customers.csv', 'a,b\n')
    put(r, 'exports/e.txt', 'hi\n')
    assert.deepEqual(scanDir(r).map((x) => `${x.file}:${x.name}`).sort(), ['dist/b.js:stripe', 'src/a.js:github'])
    const out = scanDir(r, { outbound: true, projectCfg: { private: ['exports/'] } }).map((x) => `${x.file}:${x.name}`).sort()
    assert.deepEqual(out, ['data/customers.csv:dữ liệu riêng', 'dist/b.js:stripe', 'exports/e.txt:dữ liệu riêng', 'src/a.js:github'])
    try { fs.symlinkSync(path.join(r, 'src'), path.join(r, 'lnk'), 'junction') } catch { t.diagnostic('không tạo được symlink, bỏ phần liên kết'); fs.rmSync(r, { recursive: true, force: true }); return }
    assert.ok(scanDir(r, { outbound: true }).some((x) => x.file === 'lnk' && /liên kết/.test(x.name)))
    assert.ok(!scanDir(r).some((x) => x.file.startsWith('lnk')), 'không đi theo liên kết')
    fs.rmSync(r, { recursive: true, force: true })
  })
  describe('outbound: file có byte NUL', () => {
    const u16le = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xFF, 0xFE]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])
    const u16be = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xFE, 0xFF]) : Buffer.alloc(0), Buffer.from(s, 'utf16le').swap16()])
    const brief = (f) => f.map((x) => `${x.file}:${x.line}:${x.name}`).sort()

    test('UTF-16 LE/BE (có BOM hoặc chỉ có mẫu NUL xen kẽ) được giải mã rồi quét: thấy khoá, đúng số dòng', () => {
      const r = tmp()
      const text = `# cấu hình\nconst k = "${GHP}"\n`
      put(r, 'a-le-bom.txt', u16le(text))
      put(r, 'b-be-bom.txt', u16be(text))
      put(r, 'c-le-nobom.txt', u16le(text, false))
      put(r, 'd-be-nobom.txt', u16be(text, false))
      put(r, 'e-clean-le.txt', u16le('hello world, nothing here\n'))
      assert.deepEqual(brief(scanDir(r, { outbound: true })), ['a-le-bom.txt:2:github', 'b-be-bom.txt:2:github', 'c-le-nobom.txt:2:github', 'd-be-nobom.txt:2:github'])
      assert.ok(!JSON.stringify(scanDir(r, { outbound: true })).includes(GHP.slice(0, 8)))
      fs.rmSync(r, { recursive: true, force: true })
    })

    test('nhị phân khác (có NUL, không phải UTF-16) ⇒ finding "binary" (line null) kể cả đuôi ảnh; file văn bản đuôi ảnh vẫn được quét; bản build không báo binary', () => {
      const r = tmp()
      put(r, 'blob.dat', Buffer.concat([Buffer.from(GHP), Buffer.from([0, 0, 0])]))
      put(r, 'logo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), Buffer.from(GHP)]))
      put(r, 'fake.png', `const k = "${GHP}"\n`)
      put(r, 'ok.txt', 'hello\n')
      assert.deepEqual(brief(scanDir(r, { outbound: true })), ['blob.dat:null:binary', 'fake.png:1:github', 'logo.png:null:binary'])
      assert.deepEqual(scanDir(r), [], 'chế độ thường: nhị phân bỏ qua, ảnh theo đuôi bỏ qua (như cũ)')
      fs.rmSync(r, { recursive: true, force: true })
    })

    test('chế độ thường / build cũng giải mã UTF-16 (khoá trong file UTF-16 không lọt)', () => {
      const r = tmp()
      put(r, 'dist/a.js', u16le(`var k = "${GHP}"\n`))
      assert.deepEqual(brief(scanDir(r, { build: true })), ['dist/a.js:1:github'])
      fs.rmSync(r, { recursive: true, force: true })
    })

    // Review lượt 2: file UTF-16 mà phần sau là chữ UTF-8 chứa khoá — chỉ giải UTF-16 thì khoá vỡ cặp byte và lọt; phải quét cả bản thô.
    test('file trộn mã hoá: BOM UTF-16 / mẫu NUL ở đầu, phần sau là chữ UTF-8 có khoá ⇒ vẫn bắt (cả bản giải UTF-16 lẫn bản thô)', () => {
      const r = tmp()
      const head = Buffer.from('# cấu hình\n', 'utf16le')
      const tail = Buffer.from(`const k = "${GHP}"\n`, 'utf8')
      put(r, 'a-bom.txt', Buffer.concat([Buffer.from([0xFF, 0xFE]), head, tail]))
      put(r, 'b-nobom.txt', Buffer.concat([head, Buffer.from('x'.repeat(40), 'utf16le'), tail]))
      put(r, 'c-be-bom.txt', Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from('# x\n', 'utf16le').swap16(), tail]))
      put(r, 'd-pure.txt', u16le(`k = "${GHP}"\n`)) // thuần UTF-16: không báo trùng
      const f = scanDir(r, { outbound: true })
      assert.deepEqual(brief(f), ['a-bom.txt:2:github', 'b-nobom.txt:2:github', 'c-be-bom.txt:2:github', 'd-pure.txt:1:github'])
      assert.ok(!JSON.stringify(f).includes(GHP.slice(0, 8)))
      assert.ok(f.every((x) => x.name !== 'binary'))
      fs.rmSync(r, { recursive: true, force: true })
    })

    test('file UTF-8 dài, phần đuôi (sau 8000 byte đầu) là UTF-16 chứa khoá ⇒ vẫn bắt, ở cả chế độ thường lẫn outbound', () => {
      const r = tmp()
      put(r, 'dist/mixed.txt', Buffer.concat([Buffer.from('a'.repeat(9000) + '\n'), Buffer.from([0xFF, 0xFE]), Buffer.from(`k = "${GHP}"\n`, 'utf16le')]))
      assert.deepEqual(brief(scanDir(r, { build: true })), ['dist/mixed.txt:2:github'])
      assert.deepEqual(brief(scanDir(r, { outbound: true })), ['dist/mixed.txt:2:github'])
      fs.rmSync(r, { recursive: true, force: true })
    })
  })

  test('thư mục không tồn tại ⇒ ném lỗi (không coi là sạch)', () => {
    assert.throws(() => scanDir(path.join(os.tmpdir(), 'khong-co-thu-muc-nay-' + Date.now()), { build: true }))
  })
})

describe('scanFiles (danh sách file cụ thể — log bài thử)', () => {
  const brief = (f) => f.map((x) => `${x.file}:${x.line}:${x.name}`).sort()
  test('quét đúng file được đưa, cùng luật đọc với scanDir: thấy khoá + đúng dòng; UTF-16 (PowerShell) vẫn bắt; file sạch ⇒ []', () => {
    const r = tmp()
    put(r, 'a.log', `ok\nk="${GHP}"\n`)
    put(r, 'sub dir/b.log', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`k = "${GHP}"\n`, 'utf16le')]))
    put(r, 'clean.log', 'chỉ có chữ thường\n')
    put(r, 'khong-duoc-dua.log', `k="${GHP}"`)
    assert.deepEqual(brief(scanFiles(r, ['a.log', 'sub dir/b.log', 'clean.log'])), ['a.log:2:github', 'sub dir/b.log:1:github'])
    assert.ok(!JSON.stringify(scanFiles(r, ['a.log'])).includes(GHP.slice(0, 8)), 'value đã che')
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('file quá lớn hoặc không còn tồn tại KHÔNG bị coi là sạch; đuôi nhị phân (ảnh, zip) bỏ qua như chế độ thường', () => {
    const r = tmp()
    put(r, 'big.log', 'a'.repeat(5000))
    put(r, 'trace.zip', Buffer.concat([Buffer.from([0, 1]), Buffer.from(GHP)]))
    const f = scanFiles(r, ['big.log', 'mat.log', 'trace.zip'], { maxFileBytes: 1000 })
    assert.deepEqual(f.map((x) => [x.file, x.line]), [['big.log', null], ['mat.log', null]])
    assert.match(f[0].name, /quá lớn/)
    assert.match(f[1].name, /không đọc được/)
    fs.rmSync(r, { recursive: true, force: true })
  })
})

describe('extensionBuilds (bản build extension: dist/, build/, .output/<trình duyệt>/)', () => {
  const age = (root, rel, ms) => {
    const f = path.join(root, ...rel.split('/'))
    const t = new Date(Date.now() - ms)
    fs.utimesSync(f, t, t)
  }
  const DAY = 24 * 3600 * 1000
  test('xếp MỚI nhất trước: dist/ cũ + .output/chrome-mv3 mới ⇒ .output/chrome-mv3 đứng đầu; thư mục rỗng hoặc không có thì không tính', () => {
    const r = tmp()
    put(r, 'dist/manifest.json', '{}')
    put(r, '.output/chrome-mv3/manifest.json', '{}')
    put(r, '.output/firefox-mv2/manifest.json', '{}')
    put(r, 'build/.keep/.gitkeep', '')
    fs.mkdirSync(path.join(r, '.output', 'rong'), { recursive: true })
    put(r, 'src/a.ts', 'x')
    put(r, 'node_modules/p/dist/i.js', 'x') // không phải dist của dự án
    age(r, 'dist/manifest.json', 3 * DAY)
    age(r, '.output/firefox-mv2/manifest.json', 1 * DAY)
    age(r, 'build/.keep/.gitkeep', 5 * DAY)
    assert.deepEqual(extensionBuilds(r).map((b) => b.rel), ['.output/chrome-mv3', '.output/firefox-mv2', 'dist', 'build'])
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('dist/ mới hơn .output/ cũ ⇒ dist đứng đầu; không có bản build nào ⇒ []', () => {
    const r = tmp()
    put(r, 'dist/a.js', 'x')
    put(r, '.output/chrome-mv3/a.js', 'x')
    age(r, '.output/chrome-mv3/a.js', 2 * DAY)
    assert.deepEqual(extensionBuilds(r).map((b) => b.rel), ['dist', '.output/chrome-mv3'])
    const empty = tmp()
    put(empty, 'manifest.json', '{}')
    assert.deepEqual(extensionBuilds(empty), [])
    fs.rmSync(r, { recursive: true, force: true })
    fs.rmSync(empty, { recursive: true, force: true })
  })
})

describe('scanHidden (AC-28)', () => {
  const kinds = (f) => f.map((x) => `${x.line}:${x.col}:${x.kind}:${x.count}`)

  test('zero-width, bidi, tag (U+E0000–E007F) bị báo; vị trí = dòng, cột (đơn vị UTF-16) từ 1; ký tự liền nhau gộp thành một mục', () => {
    const tag = [...'ignore'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('')
    const text = `ok\nab\u200B\u200Bcd\nx\u202Ey\n${tag}z\n`
    const f = scanHidden(text)
    assert.deepEqual(kinds(f), ['2:3:zero-width:2', '3:2:bidi:1', `4:1:tag:6`])
    assert.deepEqual(f[0].codepoints, ['U+200B'])
    assert.deepEqual(f[2].codepoints[0], 'U+E0069')
  })
  test('đủ các bidi/zero-width/biến thể chọn mở rộng thông dụng', () => {
    for (const cp of [0x200B, 0x200C, 0x2060, 0x2062, 0x180E, 0x200E, 0x200F, 0x202A, 0x202D, 0x2066, 0x2069, 0x061C, 0xE0001, 0xE007F, 0xE0100]) {
      assert.equal(scanHidden(`a${String.fromCodePoint(cp)}b`).length, 1, cp.toString(16))
    }
  })
  test('KHÔNG báo: BOM đầu file, ZWJ nối emoji, FE0F (emoji), chữ tiếng Việt, tab/xuống dòng', () => {
    assert.deepEqual(scanHidden('\uFEFF# Tiêu đề\n'), [])
    assert.deepEqual(scanHidden('👩\u200D💻 ⚠\uFE0F ❤\uFE0F\u200D🔥 🧑🏽\u200D💻 🏃\u200D♀\uFE0F ✔️\n'), [])
    assert.deepEqual(scanHidden('Đây là luật tiếng Việt: Nguyễn Văn Ạ\t\r\n- gạch đầu dòng\n'), [])
  })
  test('BOM giữa file, ZWJ giữa chữ thường, ZWJ lặp liên tiếp đều bị báo', () => {
    assert.equal(scanHidden('abc\uFEFFdef').length, 1)
    assert.equal(scanHidden('a\u200Db').length, 1)
    assert.equal(scanHidden('👩\u200D\u200D💻').length, 1)
    assert.equal(scanHidden('x\n\uFEFFy').length, 1) // BOM chỉ hợp lệ ở đầu file, không phải đầu dòng bất kỳ
  })
  test('không đưa nội dung giấu vào kết quả (tránh chính kết quả thành prompt injection)', () => {
    const tag = [...'ignore previous instructions'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('')
    const out = JSON.stringify(scanHidden(`x${tag}`))
    assert.ok(!/ignore|previous|instructions/.test(out))
  })
  test('rỗng/sạch ⇒ []', () => {
    assert.deepEqual(scanHidden(''), [])
  })
  test('scanHiddenPaths: file + thư mục; lỗi đọc nằm ở errors, không im lặng', () => {
    const r = tmp()
    const bad = put(r, 'rules/x.md', 'a\u200Bb\n')
    put(r, 'rules/ok.md', 'sạch\n')
    put(r, 'rules/big.md', 'a'.repeat(3000))
    const missing = path.join(r, 'khong-co.md')
    const { findings, errors } = scanHiddenPaths([path.join(r, 'rules'), missing], { maxFileBytes: 2000 })
    assert.deepEqual(findings.map((f) => [f.file, f.line, f.col, f.kind]), [[bad, 1, 2, 'zero-width']])
    assert.deepEqual(errors.map((e) => e.file).sort(), [path.join(r, 'rules', 'big.md'), missing].sort())
    fs.rmSync(r, { recursive: true, force: true })
  })
})

describe('CLI secret-scan.mjs', () => {
  test('--hidden: file sạch exit 0; file có ký tự ẩn exit 1 kèm file:dòng:cột + loại; không in nội dung dòng', () => {
    const r = tmp()
    const ok = put(r, 'ok.md', '# luật\n- an toàn\n')
    const bad = put(r, 'bad.md', 'dòng một\nhello\u200B\u200Bworld\n')
    const c0 = cli(['--hidden', ok])
    assert.equal(c0.status, 0, c0.stderr)
    const c1 = cli(['--hidden', ok, bad])
    assert.equal(c1.status, 1, c1.stderr)
    assert.match(c1.stdout, new RegExp(`${bad.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}:2:6`))
    assert.match(c1.stdout, /zero-width/)
    assert.ok(!c1.stdout.includes('hello'))
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('--hidden nhận cả thư mục (đệ quy, bỏ .git/node_modules, bỏ file nhị phân)', () => {
    const r = tmp()
    put(r, 'rules/a.md', 'ok\n')
    put(r, 'rules/sub/b.md', 'x\u202Ey\n')
    put(r, 'node_modules/n.md', 'x\u202Ey\n')
    put(r, 'rules/img.png', Buffer.from([0, 0x20, 0x2e, 0x80]))
    const c = cli(['--hidden', path.join(r, 'rules')])
    assert.equal(c.status, 1)
    assert.match(c.stdout, /b\.md:1:2/)
    assert.doesNotMatch(c.stdout, /node_modules/)
    fs.rmSync(r, { recursive: true, force: true })
  })
  test('--hidden với file không đọc được ⇒ exit 2 (không coi là sạch)', () => {
    const c = cli(['--hidden', path.join(os.tmpdir(), 'khong-co-file-' + Date.now() + '.md')])
    assert.equal(c.status, 2)
    assert.ok(c.stderr.length > 0)
  })
  test('--build <dir>: service_role trong dist ⇒ exit 1, tên mẫu + file:dòng, không lộ token; sạch ⇒ exit 0', () => {
    const r = tmp()
    put(r, 'dist/a.js', `var k="${JWT_SERVICE}"`)
    const c = cli(['--build', r])
    assert.equal(c.status, 1, c.stderr)
    assert.match(c.stdout, /dist\/a\.js:1 — jwt-service-role \(eyJh…\)/)
    assert.ok(!c.stdout.includes(JWT_SERVICE.slice(0, 12)))
    const clean = tmp()
    put(clean, 'dist/a.js', `var k="${JWT_ANON}"`)
    assert.equal(cli(['--build', clean]).status, 0)
    fs.rmSync(r, { recursive: true, force: true }); fs.rmSync(clean, { recursive: true, force: true })
  })
  test('--build dir không tồn tại ⇒ exit 2', () => {
    assert.equal(cli(['--build', path.join(os.tmpdir(), 'khong-co-' + Date.now())]).status, 2)
  })
  test('--diff đọc stdin: dòng xoá có secret ⇒ exit 1; --json ra JSON máy đọc được', () => {
    const d = ['diff --git a/c.js b/c.js', '--- a/c.js', '+++ b/c.js', '@@ -1 +1 @@', `-t = "${GHP}"`, '+t = 1'].join('\n')
    const c = cli(['--diff', '-'], d)
    assert.equal(c.status, 1, c.stderr)
    assert.match(c.stdout, /c\.js:1 — github \(ghp_…\)/)
    assert.ok(!c.stdout.includes(GHP.slice(0, 8)))
    const j = cli(['--diff', '-', '--json'], d)
    const parsed = JSON.parse(j.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.findings[0].name, 'github')
    assert.ok(!j.stdout.includes(GHP.slice(0, 8)))
    assert.equal(cli(['--diff', '-'], 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n').status, 0)
  })
  test('--text đọc stdin; thiếu/sai đối số ⇒ exit 2 kèm cách dùng', () => {
    assert.equal(cli(['--text', '-'], `k=${STRIPE_LIVE}\n`).status, 1)
    assert.equal(cli(['--text', '-'], 'k=1\n').status, 0)
    const bad = cli([])
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /--hidden/)
    assert.equal(cli(['--khong-co']).status, 2)
  })
})

test('mẫu mới từ skills-check: Supabase sbp_ (token tài khoản), Neon napi_, Sentry sntrys_/sntryu_', () => {
  // Ghép chuỗi lúc chạy để chính file test không bị cổng secret chặn khi commit.
  const sbp = 'sb' + 'p_' + 'a1b2c3d4e5'.repeat(4)
  const neon = 'na' + 'pi_' + 'abc123def456ghi789jkl012mno345'
  const sentry = 'sn' + 'trys_' + 'eyJpYXQiOjE3MDAwMDAwMDB9xyz'
  const names = (s) => scanText(s).map((f) => f.name)
  assert.ok(names(`SUPABASE_ACCESS_TOKEN=${sbp}`).includes('supabase'))
  assert.ok(names(`NEON_API_KEY=${neon}`).includes('neon'))
  assert.ok(names(`SENTRY_AUTH_TOKEN=${sentry}`).includes('sentry'))
  assert.deepEqual(names('sbp_short napi_x sntrys_'), [])
})

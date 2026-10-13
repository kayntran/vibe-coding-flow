// Test cho lib/app-safety.mjs: node --test ~/.claude/hooks/lib/app-safety.test.mjs
// Mọi thứ chạy trong thư mục tạm (fs.mkdtempSync); không lệnh ngoài.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as S from './app-safety.mjs'

const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'safety-test-'))); roots.push(d); return d }
const put = (dir, rel, text = '') => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }

// Mẫu đủ 4 thứ; mỗi test bỏ đúng một thứ.
const CSP_OK = "default-src 'self'; script-src 'self'; frame-ancestors 'none'"
const H = {
  csp: `Content-Security-Policy: ${CSP_OK}`,
  nosniff: 'X-Content-Type-Options: nosniff',
  referrer: 'Referrer-Policy: strict-origin-when-cross-origin',
  xfo: 'X-Frame-Options: DENY',
}
const headersFile = (...lines) => `/*\n${lines.map((l) => `  ${l}`).join('\n')}\n`
const FULL = [H.csp, H.nosniff, H.referrer, H.xfo]
const names = (problems) => problems.map((p) => p.msg)
const shape = (problems) => { for (const p of problems) { assert.equal(typeof p.file, 'string'); assert.ok(p.msg.length > 20); assert.ok(p.fix.length > 10) } }

describe('headerProblems: _headers (Cloudflare/Netlify)', () => {
  test('đủ 4 thứ ⇒ không lỗi', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(...FULL))
    assert.deepEqual(S.headerProblems(d), [])
  })

  test('chống nhúng bằng frame-ancestors trong CSP (không có X-Frame-Options) vẫn đạt', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(H.csp, H.nosniff, H.referrer))
    assert.deepEqual(S.headerProblems(d), [])
  })

  test('chống nhúng bằng X-Frame-Options (CSP không có frame-ancestors) vẫn đạt', () => {
    const d = tmp(); put(d, '_headers', headersFile("Content-Security-Policy: default-src 'self'", H.nosniff, H.referrer, H.xfo))
    assert.deepEqual(S.headerProblems(d), [])
  })

  test('không có file cấu hình nào ⇒ một lỗi, chỉ chỗ tạo; meta CSP trong index.html không thay được', () => {
    const d = tmp(); put(d, 'index.html', `<meta http-equiv="Content-Security-Policy" content="${CSP_OK}">`)
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.equal(p[0].file, 'public/_headers')
    assert.match(p[0].msg, /Chưa có file cấu hình header/)
    assert.match(p[0].fix, /public\/_headers/)
    shape(p)
  })

  test('thiếu Content-Security-Policy ⇒ báo đúng header đó, và chỉ nó (còn X-Frame-Options lo chống nhúng)', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(H.nosniff, H.referrer, H.xfo))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /Content-Security-Policy/)
    assert.equal(p[0].file, 'public/_headers')
    shape(p)
  })

  test('thiếu X-Content-Type-Options ⇒ báo đúng header đó', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(H.csp, H.referrer, H.xfo))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /X-Content-Type-Options: nosniff/)
    shape(p)
  })

  test('X-Content-Type-Options có nhưng giá trị khác nosniff ⇒ vẫn báo', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(H.csp, 'X-Content-Type-Options: sniff', H.referrer))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /X-Content-Type-Options/)
  })

  test('thiếu Referrer-Policy ⇒ báo đúng header đó', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(H.csp, H.nosniff, H.xfo))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /Referrer-Policy/)
    shape(p)
  })

  test('thiếu chống nhúng (CSP không frame-ancestors, không X-Frame-Options) ⇒ báo đúng chỗ đó', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile("Content-Security-Policy: default-src 'self'", H.nosniff, H.referrer))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /chống nhúng/)
    assert.match(p[0].msg, /frame-ancestors/)
    shape(p)
  })

  test('file rỗng/chỉ có chú thích ⇒ báo thiếu cả 4', () => {
    const d = tmp(); put(d, 'public/_headers', '# chưa có gì\n')
    const m = names(S.headerProblems(d)).join('\n')
    for (const w of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'chống nhúng']) assert.match(m, new RegExp(w))
  })

  test('header chỉ áp cho /api/* (không phải cả site) không được tính', () => {
    const d = tmp(); put(d, 'public/_headers', `/api/*\n  ${H.csp}\n  ${H.nosniff}\n  ${H.referrer}\n`)
    assert.equal(S.headerProblems(d).length, 4)
  })

  test("CSP có 'unsafe-eval' ⇒ báo, nêu 'unsafe-eval'", () => {
    const d = tmp(); put(d, 'public/_headers', headersFile("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; frame-ancestors 'none'", H.nosniff, H.referrer))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /unsafe-eval/)
    assert.match(p[0].fix, /unsafe-eval/)
  })

  test('CSP script-src * ⇒ báo; script-src https: cũng báo; script-src có tên miền cụ thể thì đạt', () => {
    const wide = (v) => { const d = tmp(); put(d, 'public/_headers', headersFile(`Content-Security-Policy: script-src ${v}; frame-ancestors 'none'`, H.nosniff, H.referrer)); return S.headerProblems(d) }
    const star = wide('*')
    assert.equal(star.length, 1)
    assert.match(star[0].msg, /script-src \*/)
    assert.equal(wide("'self' https:").length, 1)
    assert.deepEqual(wide("'self' https://cdn.example.com"), [])
  })

  test('không có script-src mà default-src * ⇒ báo', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile("Content-Security-Policy: default-src *; frame-ancestors 'none'", H.nosniff, H.referrer))
    assert.equal(S.headerProblems(d).length, 1)
  })

  test('chỉ có Content-Security-Policy-Report-Only ⇒ vẫn tính là thiếu CSP', () => {
    const d = tmp(); put(d, 'public/_headers', headersFile(`Content-Security-Policy-Report-Only: ${CSP_OK}`, H.nosniff, H.referrer, H.xfo))
    const p = S.headerProblems(d)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /Content-Security-Policy/)
  })
})

describe('headerProblems: vercel.json / netlify.toml / nginx / Caddy', () => {
  test('vercel.json: đủ ⇒ không lỗi; thiếu Referrer-Policy ⇒ báo đúng nó', () => {
    const mk = (keys) => JSON.stringify({ headers: [{ source: '/(.*)', headers: keys.map((l) => { const i = l.indexOf(': '); return { key: l.slice(0, i), value: l.slice(i + 2) } }) }] })
    const ok = tmp(); put(ok, 'vercel.json', mk(FULL))
    assert.deepEqual(S.headerProblems(ok), [])
    const bad = tmp(); put(bad, 'vercel.json', mk([H.csp, H.nosniff, H.xfo]))
    const p = S.headerProblems(bad)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /Referrer-Policy/)
    assert.equal(p[0].file, 'vercel.json')
  })

  test('vercel.json hỏng JSON ⇒ coi như chưa có header (báo thiếu), không văng lỗi', () => {
    const d = tmp(); put(d, 'vercel.json', '{ not json')
    assert.equal(S.headerProblems(d).length, 4)
  })

  test('netlify.toml: đủ ⇒ không lỗi; thiếu nosniff ⇒ báo đúng nó', () => {
    const toml = (lines) => `[build]\n  publish = "dist"\n\n[[headers]]\n  for = "/*"\n  [headers.values]\n${lines.map((l) => { const i = l.indexOf(': '); return `    ${l.slice(0, i)} = "${l.slice(i + 2)}"` }).join('\n')}\n`
    const ok = tmp(); put(ok, 'netlify.toml', toml(FULL))
    assert.deepEqual(S.headerProblems(ok), [])
    const bad = tmp(); put(bad, 'netlify.toml', toml([H.csp, H.referrer, H.xfo]))
    const p = S.headerProblems(bad)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /X-Content-Type-Options/)
  })

  test('nginx.conf: add_header đủ ⇒ không lỗi; thiếu CSP ⇒ báo đúng nó', () => {
    const conf = (lines) => `server {\n  listen 80;\n${lines.map((l) => { const i = l.indexOf(': '); return `  add_header ${l.slice(0, i)} "${l.slice(i + 2)}" always;` }).join('\n')}\n}\n`
    const ok = tmp(); put(ok, 'nginx.conf', conf(FULL))
    assert.deepEqual(S.headerProblems(ok), [])
    const bad = tmp(); put(bad, 'nginx/site.conf', conf([H.nosniff, H.referrer, H.xfo]))
    const p = S.headerProblems(bad)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /Content-Security-Policy/)
    assert.equal(p[0].file, 'nginx/site.conf')
  })

  test('Caddyfile: khối header đủ ⇒ không lỗi; thiếu chống nhúng ⇒ báo đúng nó', () => {
    const caddy = (lines) => `example.com {\n  header {\n${lines.map((l) => { const i = l.indexOf(': '); return `    ${l.slice(0, i)} "${l.slice(i + 2)}"` }).join('\n')}\n  }\n}\n`
    const ok = tmp(); put(ok, 'Caddyfile', caddy(FULL))
    assert.deepEqual(S.headerProblems(ok), [])
    const bad = tmp(); put(bad, 'Caddyfile', caddy(["Content-Security-Policy: default-src 'self'", H.nosniff, H.referrer]))
    const p = S.headerProblems(bad)
    assert.equal(p.length, 1)
    assert.match(p[0].msg, /chống nhúng/)
  })

  test('nhiều nền: MỖI file cấu hình header phải tự đủ 4 thứ, không gộp giữa public/_headers và vercel.json; báo theo từng file', () => {
    const d = tmp()
    put(d, 'public/_headers', headersFile(H.csp, H.nosniff))
    put(d, 'vercel.json', JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }] }))
    const p = S.headerProblems(d)
    const of = (f) => p.filter((x) => x.file === f)
    assert.equal(p.length, 4, names(p).join('\n'))
    assert.equal(of('public/_headers').length, 1)
    assert.match(of('public/_headers')[0].msg, /Referrer-Policy/)
    assert.equal(of('vercel.json').length, 3)
    const m = names(of('vercel.json')).join('\n')
    for (const w of ['Content-Security-Policy', 'X-Content-Type-Options', 'chống nhúng']) assert.match(m, new RegExp(w))
    assert.ok(of('vercel.json').every((x) => x.fix.includes('vercel.json')), 'lời sửa nêu đúng file')
    shape(p)
    // cả hai nền đều đủ ⇒ đạt
    put(d, 'public/_headers', headersFile(...FULL))
    put(d, 'vercel.json', JSON.stringify({ headers: [{ source: '/(.*)', headers: FULL.map((l) => { const i = l.indexOf(': '); return { key: l.slice(0, i), value: l.slice(i + 2) } }) }] }))
    assert.deepEqual(S.headerProblems(d), [])
  })

  test('file cấu hình không khai header nào (netlify.toml chỉ có [build], *.conf không liên quan) không bị tính là một nền thiếu header khi file khác đã đủ', () => {
    const d = tmp()
    put(d, 'public/_headers', headersFile(...FULL))
    put(d, 'netlify.toml', '[build]\n  publish = "dist"\n')
    put(d, 'redis.conf', 'port 6379\n')
    assert.deepEqual(S.headerProblems(d), [])
  })

  test('chỉ có file cấu hình không khai header nào (netlify.toml chỉ [build]) ⇒ vẫn báo thiếu đủ 4, một lần, ở file đầu', () => {
    const d = tmp(); put(d, 'netlify.toml', '[build]\n  publish = "dist"\n')
    const p = S.headerProblems(d)
    assert.equal(p.length, 4)
    assert.ok(p.every((x) => x.file === 'netlify.toml'))
  })
})

describe('headerProblems: chống nhúng và CSP phải thật sự chặn', () => {
  const embed = (...lines) => { const d = tmp(); put(d, 'public/_headers', headersFile("Content-Security-Policy: default-src 'self'; script-src 'self'", H.nosniff, H.referrer, ...lines)); return S.headerProblems(d) }
  const csp = (value) => { const d = tmp(); put(d, 'public/_headers', headersFile(`Content-Security-Policy: ${value}; frame-ancestors 'none'`, H.nosniff, H.referrer)); return S.headerProblems(d) }

  test('frame-ancestors cho mọi nơi (*, http:, https:, rỗng) hoặc X-Frame-Options lạ (ALLOWALL, ALLOW-FROM) ⇒ vẫn báo thiếu chống nhúng', () => {
    for (const v of ['*', 'http:', 'https:', "'self' *", 'HTTPS:', '']) {
      const p = embed(`Content-Security-Policy: frame-ancestors ${v}`.trimEnd())
      assert.ok(names(p).some((m) => /chống nhúng/.test(m)), `frame-ancestors "${v}" phải bị báo: ${names(p).join(' | ')}`)
    }
    for (const v of ['ALLOWALL', 'ALLOW-FROM https://a.example.com', 'allow', '']) {
      const p = embed(`X-Frame-Options: ${v}`.trimEnd())
      assert.ok(names(p).some((m) => /chống nhúng/.test(m)), `X-Frame-Options "${v}" phải bị báo: ${names(p).join(' | ')}`)
    }
  })

  test("frame-ancestors 'none' / 'self' / tên miền cụ thể (kể cả *.tên-miền) và X-Frame-Options DENY / SAMEORIGIN (không phân biệt hoa thường) ⇒ đạt", () => {
    for (const v of ["'none'", "'self'", "'self' https://app.example.com", 'https://*.example.com']) assert.deepEqual(embed(`Content-Security-Policy: frame-ancestors ${v}`), [], v)
    for (const v of ['DENY', 'SAMEORIGIN', 'deny', 'sameorigin']) assert.deepEqual(embed(`X-Frame-Options: ${v}`), [], v)
  })

  test('CSP có frame-ancestors * thì X-Frame-Options DENY không cứu (trình duyệt theo CSP)', () => {
    const p = embed('Content-Security-Policy: frame-ancestors *', 'X-Frame-Options: DENY')
    assert.ok(names(p).some((m) => /chống nhúng/.test(m)), names(p).join(' | '))
  })

  test('script-src-elem * hoặc script-src-attr * ⇒ báo, nêu đúng tên chỉ thị; script-src-elem chặt thì đạt', () => {
    const a = csp("default-src 'self'; script-src 'self'; script-src-elem *")
    assert.equal(a.length, 1)
    assert.match(a[0].msg, /script-src-elem \*/)
    const b = csp("default-src 'self'; script-src 'self'; script-src-attr https:")
    assert.equal(b.length, 1)
    assert.match(b[0].msg, /script-src-attr https:/)
    assert.deepEqual(csp("default-src 'self'; script-src 'self'; script-src-elem 'self' https://cdn.example.com"), [])
  })

  test('script-src https://* · http://* · *://* tính là mọi nguồn như * (cả ở script-src-elem, default-src)', () => {
    for (const v of ['https://*', 'http://*', '*://*', 'https://*:*', "'self' *://*/"]) {
      const p = csp(`script-src ${v}`)
      assert.equal(p.length, 1, `script-src ${v}: ${names(p).join(' | ')}`)
      assert.match(p[0].msg, /script-src /)
    }
    assert.equal(csp("script-src 'self'; script-src-elem https://*").length, 1)
    assert.equal(csp('default-src *://*').length, 1)
    assert.deepEqual(csp("script-src 'self' https://*.example.com"), [], 'wildcard theo tên miền cụ thể vẫn được')
  })
})

describe('extensionPermProblems', () => {
  const manifest = (o = {}) => JSON.stringify({ manifest_version: 3, name: 'x', version: '1', ...o })

  test('quyền tối thiểu (activeTab + scripting, host cụ thể) ⇒ không lỗi', () => {
    const d = tmp(); put(d, 'manifest.json', manifest({ permissions: ['activeTab', 'scripting'], host_permissions: ['https://api.example.com/*'] }))
    assert.deepEqual(S.extensionPermProblems(d), [])
  })

  test('không có manifest ⇒ không lỗi (việc báo thiếu manifest là của mv3-manifest)', () => {
    assert.deepEqual(S.extensionPermProblems(tmp()), [])
  })

  test('host_permissions rộng ngoài optional_host_permissions: mỗi mẫu rộng một lỗi, nêu mẫu đó và chỉ sang optional_host_permissions', () => {
    const d = tmp()
    put(d, 'public/manifest.json', manifest({ host_permissions: ['<all_urls>', '*://*/*', 'https://*.com/*', 'https://api.example.com/*'] }))
    const p = S.extensionPermProblems(d)
    assert.equal(p.length, 3)
    assert.match(p[0].msg, /<all_urls>/)
    assert.match(p[1].msg, /\*:\/\/\*\/\*/)
    assert.match(p[2].msg, /\*\.com/)
    assert.ok(p.every((x) => x.file === 'public/manifest.json' && /optional_host_permissions/.test(x.fix)))
    shape(p)
  })

  test('rộng nhưng nằm trong optional_host_permissions (xin lúc chạy) ⇒ không lỗi', () => {
    const d = tmp(); put(d, 'manifest.json', manifest({ host_permissions: ['https://api.example.com/*'], optional_host_permissions: ['<all_urls>'] }))
    assert.deepEqual(S.extensionPermProblems(d), [])
  })

  test('manifest đã build (.output/chrome-mv3) được đọc', () => {
    const d = tmp(); put(d, '.output/chrome-mv3/manifest.json', manifest({ host_permissions: ['http://*/*'] }))
    const p = S.extensionPermProblems(d)
    assert.equal(p.length, 1)
    assert.equal(p[0].file, '.output/chrome-mv3/manifest.json')
  })

  test('chưa build: host_permissions trong wxt.config.ts được đọc', () => {
    const d = tmp(); put(d, 'wxt.config.ts', "export default defineConfig({ manifest: { host_permissions: ['<all_urls>', 'https://a.example.com/*'] } })\n")
    const p = S.extensionPermProblems(d)
    assert.equal(p.length, 1)
    assert.equal(p[0].file, 'wxt.config.ts')
  })

  test('luôn đọc cả wxt.config.* ở gốc: manifest (build cũ) sạch không che host_permissions rộng mới khai trong wxt.config chưa build; hai nơi cùng rộng ⇒ báo cả hai', () => {
    const d = tmp()
    put(d, '.output/chrome-mv3/manifest.json', manifest({ host_permissions: ['https://a.example.com/*'] }))
    put(d, 'wxt.config.ts', "export default defineConfig({ manifest: { host_permissions: ['https://*/*'] } })\n")
    const p = S.extensionPermProblems(d)
    assert.equal(p.length, 1)
    assert.equal(p[0].file, 'wxt.config.ts')
    assert.match(p[0].msg, /https:\/\/\*\/\*/)
    put(d, 'manifest.json', manifest({ host_permissions: ['<all_urls>'] }))
    assert.deepEqual(S.extensionPermProblems(d).map((x) => x.file).sort(), ['manifest.json', 'wxt.config.ts'])
    put(d, 'wxt.config.ts', "export default defineConfig({ manifest: { host_permissions: ['https://a.example.com/*'] } })\n")
    put(d, 'manifest.json', manifest({ host_permissions: ['https://a.example.com/*'] }))
    assert.deepEqual(S.extensionPermProblems(d), [], 'cả hai hẹp ⇒ đạt')
  })

  test('JSON hỏng / không phải manifest ⇒ bỏ qua, không văng lỗi', () => {
    const d = tmp(); put(d, 'manifest.json', '{ hỏng'); put(d, 'public/manifest.json', '{"name":"pwa"}')
    assert.deepEqual(S.extensionPermProblems(d), [])
  })

  test('isBroadHost: mẫu rộng và hẹp', () => {
    for (const p of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/*', 'https://*.com/*']) assert.equal(S.isBroadHost(p), true, p)
    for (const p of ['https://api.example.com/*', 'https://*.example.com/*', '*://*.google.com/*', 'activeTab']) assert.equal(S.isBroadHost(p), false, p)
  })
})

describe('luật ast-grep Wails (kit/rules)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const RULES = path.resolve(HERE, '..', '..', 'kit', 'rules')
  const FIX = path.join(RULES, 'fixtures', 'ai-wails-binding-exec-write')
  const ruleText = fs.readFileSync(path.join(RULES, 'sast', 'ai-wails-binding-exec-write.yml'), 'utf8')

  test('luật phủ v3 service và các lời gọi ghi file / chạy lệnh ngoài exec.Command', () => {
    assert.match(ruleText, /Service/)
    assert.match(ruleText, /NewService/)
    for (const call of ['exec\\.Command', 'Rename', 'RemoveAll', 'MkdirAll', 'Chmod', 'StartProcess', 'syscall\\.', 'Exec']) assert.ok(ruleText.includes(call), call)
  })

  test('fixture bad có ca v3 service (Rename/RemoveAll/StartProcess…), fixture good có service mỏng + hàm viết thường', () => {
    const bad = fs.readFileSync(path.join(FIX, 'bad.go'), 'utf8')
    const good = fs.readFileSync(path.join(FIX, 'good.go'), 'utf8')
    assert.match(bad, /func \(s \*FileService\) [A-Z]\w*\(/)
    for (const call of ['os.Rename', 'os.RemoveAll', 'os.MkdirAll', 'os.Chmod', 'os.StartProcess', 'syscall.Exec']) assert.ok(bad.includes(call), call)
    assert.match(good, /func \(s \*NoteService\) Save\(/)
    assert.match(good, /func \(s \*NoteService\) moveInternal\(/)
  })

  // Chạy ast-grep thật nếu máy có: bad bị bắt đủ 8 hàm, good không bị bắt.
  const sg = (() => {
    for (const bin of ['ast-grep', 'sg']) {
      try { if (/ast-grep/i.test(execFileSync(bin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }))) return bin } catch { /* thử tên khác */ }
    }
    return null
  })()
  test('ast-grep thật: bad.go bị bắt 8 hàm, good.go 0', { skip: sg ? false : 'máy không có ast-grep' }, () => {
    const work = tmp()
    fs.copyFileSync(path.join(FIX, 'bad.go'), path.join(work, 'bad.go'))
    fs.copyFileSync(path.join(FIX, 'good.go'), path.join(work, 'good.go'))
    let out
    try { out = execFileSync(sg, ['scan', '--config', path.join(RULES, 'sgconfig.yml'), '--json', '.'], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }) } catch (e) { out = e.stdout }
    const hits = JSON.parse(out || '[]').filter((h) => h.ruleId === 'ai-wails-binding-exec-write')
    assert.equal(hits.filter((h) => path.basename(h.file) === 'bad.go').length, 8)
    assert.equal(hits.filter((h) => path.basename(h.file) === 'good.go').length, 0)
  })
})

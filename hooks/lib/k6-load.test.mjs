// Test cho kit/k6/load.js (chốt "chỉ đo bản thử", AC-51): node --test hooks/lib/k6-load.test.mjs
// load.js là script k6 (không phải module node, không có require) ⇒ test đọc khối giữa hai dấu `// >>> host-guard` và `// <<< host-guard`
// rồi chạy bằng new Function; phần nối setup() được kiểm bằng cách bỏ dòng import/export và đưa bản giả của k6 vào.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../../kit/k6/load.js', import.meta.url), 'utf8')

function guardBlock() {
  const m = /\/\/ >>> host-guard[^\n]*\n([\s\S]*?)\/\/ <<< host-guard/.exec(SRC)
  assert.ok(m, 'load.js thiếu khối // >>> host-guard … // <<< host-guard')
  return m[1]
}
const guard = () => new Function(`${guardBlock()}\nreturn { hostLooksSafe, hostOf, pathProblem, hostDrift }`)()
const hostLooksSafe = (url) => guard().hostLooksSafe(url)

// load.js thật với k6 giả (bỏ dòng import/export); env = các -e của k6.
function loadScript(env, { http = {}, check = () => {}, console: con = { warn() {} } } = {}) {
  const body = SRC.replace(/^import .*$/gm, '').replace(/^export default function/m, 'function defaultFn').replace(/^export (const|function)/gm, '$1')
  const k6 = new Function('__ENV', 'http', 'check', 'sleep', 'Counter', 'console', `${body}\nreturn { setup, defaultFn, options }`)
  return k6(env, http, check, () => {}, class { add() {} }, con)
}
// setup() thật của load.js
const runSetup = (env) => loadScript(env).setup()
// Chạy một vòng default() của một người dùng ảo; respond(url) trả phản hồi giả của http.get.
function runDefault(env, respond) {
  const calls = []
  const checks = []
  const warns = []
  const http = { get: (url, params) => { calls.push({ url, params }); return respond(url) } }
  const check = (res, spec) => { checks.push(Object.fromEntries(Object.entries(spec).map(([k, fn]) => [k, !!fn(res)]))); return true }
  const s = loadScript(env, { http, check, console: { warn: (m) => warns.push(String(m)) } })
  s.defaultFn()
  return { calls, checks, warns, options: s.options }
}

test('chốt host: localhost / 127.0.0.1 / [::1] luôn được (kể cả cổng, http/https)', () => {
  for (const u of ['http://localhost:3000', 'localhost', 'https://LOCALHOST/app', 'http://127.0.0.1:8787/x', 'http://[::1]:3000', 'http://[::1]']) {
    assert.equal(hostLooksSafe(u), true, u)
  }
})

test('chốt host: bản THẬT trên đuôi .dev / workers.dev / pages.dev / tên miền thường bị từ chối', () => {
  for (const u of [
    'https://shop.workers.dev', 'https://abc.pages.dev', 'https://myshop.dev', 'https://shop.com', 'https://www.shop.com/',
    'https://shop.com.vn', 'https://test.co.uk', 'https://staging.workers.dev', 'https://shop-staging.pages.dev',
    'https://a1b2c3d4.shop.pages.dev', 'https://shop.stg-acct.workers.dev', 'https://shop.dev.com', 'https://dev.dev', 'https://192.168.1.5:8080', '',
  ]) {
    assert.equal(hostLooksSafe(u), false, u)
  }
})

test('chốt host: nhãn staging|stg|test|dev|preview ở phần tên phụ ⇒ được', () => {
  for (const u of [
    'https://staging.shop.com', 'https://app-staging.shop.workers.dev', 'https://preview.x.pages.dev', 'https://STG.shop.com:8443/path?x=1',
    'https://dev.shop.com.vn', 'https://api.test.shop.co.uk', 'https://shop-dev.myacct.workers.dev', 'https://staging.shop.pages.dev',
  ]) {
    assert.equal(hostLooksSafe(u), true, u)
  }
})

test('chốt host: không bị lừa bằng user@, localhost giả, hay chữ staging nằm ở đường dẫn/query', () => {
  for (const u of [
    'https://localhost.evil.com', 'https://localhost@shop.com', 'https://staging.shop.com@real.com', 'https://staging:pw@shop.com',
    'https://shop.com/staging.dev', 'https://shop.com?h=staging.x.com', 'https://shop.com#staging.x.com', 'https://shop.com\\@staging.x.com',
    'https://127.0.0.1.shop.com', 'https://[fe80::1]:3000',
  ]) {
    assert.equal(hostLooksSafe(u), false, u)
  }
  assert.equal(hostLooksSafe('https://user:pw@staging.shop.com/x'), true) // thông tin đăng nhập đứng trước thì host thật vẫn là staging
})

test('khối host-guard tự đủ để chạy trong k6: không import/require/__ENV', () => {
  const block = guardBlock()
  assert.doesNotMatch(block, /\b(?:import|require|__ENV)\b/)
})

const STG = 'https://app-staging.acct.workers.dev'

test('k6 KHÔNG đi theo chuyển hướng: options.maxRedirects = 0 và mỗi yêu cầu mang redirects: 0 (cờ --max-redirects / K6_MAX_REDIRECTS không ghi đè được tham số từng yêu cầu)', () => {
  const r = runDefault({ BASE_URL: STG, PATHS: '/,/a' }, () => ({ status: 200, body: 'ok', headers: {} }))
  assert.equal(r.options.maxRedirects, 0)
  assert.equal(r.calls.length, 2)
  for (const c of r.calls) assert.equal(c.params?.redirects, 0, c.url)
  assert.deepEqual(r.calls.map((c) => c.url), [`${STG}/`, `${STG}/a`])
})

test('bản thử trả 3xx sang bản thật ⇒ không đạt (check riêng nêu rõ "chuyển hướng") và in cảnh báo MỘT lần kèm nơi chuyển tới; 200 thì đạt hết', () => {
  const redirect = runDefault({ BASE_URL: STG, PATHS: '/,/a' }, () => ({ status: 302, body: '', headers: { Location: 'https://shop.workers.dev/' } }))
  assert.equal(redirect.checks.length, 2)
  for (const c of redirect.checks) {
    assert.equal(c['trả 200'], false)
    assert.equal(c['không bị chuyển hướng (3xx)'], false)
  }
  assert.equal(redirect.warns.length, 1, 'cảnh báo một lần mỗi người dùng ảo, không tràn log')
  assert.match(redirect.warns[0], /302/)
  assert.match(redirect.warns[0], /shop\.workers\.dev/)
  const ok = runDefault({ BASE_URL: STG }, () => ({ status: 200, body: 'ok', headers: {} }))
  assert.deepEqual(ok.checks, [{ 'trả 200': true, 'có nội dung đúng': true, 'không bị chuyển hướng (3xx)': true }])
  assert.deepEqual(ok.warns, [])
  const notFound = runDefault({ BASE_URL: STG }, () => ({ status: 404, body: '', headers: {} }))
  assert.equal(notFound.checks[0]['không bị chuyển hướng (3xx)'], true, '404 không phải chuyển hướng')
  assert.equal(notFound.checks[0]['trả 200'], false)
})

test('PATHS: chỉ nhận đường dẫn bắt đầu bằng "/" — không "@", "\\", "//" đầu, khoảng trắng/ký tự điều khiển', () => {
  const { pathProblem } = guard()
  for (const p of ['/', '/a/b', '/api/v1/items?id=1&x=%40y', '/a#frag', '/ứng-dụng', '/a.b/c_d-e', '/a//b']) assert.equal(pathProblem(p), null, p)
  for (const p of ['', 'shop', 'a/b', '@shop.workers.dev/', '/@shop', '/a@b.com', '//evil.com', '//', '/a\\b', '\\evil', 'https://evil.com/', '/a b', '/a\tb', '/a\nb', '/a\u0000b']) {
    assert.equal(typeof pathProblem(p), 'string', JSON.stringify(p))
  }
})

test('PATHS=@shop.workers.dev/ ghép vào BASE_URL sẽ đổi host thật ⇒ hostDrift bắt được; đường dẫn hợp lệ thì host giữ nguyên', () => {
  const { hostDrift, hostOf } = guard()
  assert.equal(hostOf(`${STG}@shop.workers.dev/`), 'shop.workers.dev', 'đây chính là cách lách')
  assert.equal(hostDrift(STG, '@shop.workers.dev/'), true)
  assert.equal(hostDrift('http://localhost:8787', '@evil.com/'), true)
  for (const p of ['/', '/a/b?x=1', '/a#f']) assert.equal(hostDrift(STG, p), false, p)
  assert.equal(hostDrift('http://localhost:8787', '/x'), false)
})

test('setup(): PATHS lách host hoặc sai dạng ⇒ dừng như host-guard (kể cả đã ALLOW_HOST=1); PATHS hợp lệ / mặc định qua', () => {
  for (const PATHS of ['@shop.workers.dev/', '/ok,@shop.workers.dev/', 'shop', '//shop.workers.dev/', '/a\\b', '/,', '/@x']) {
    assert.throws(() => runSetup({ BASE_URL: STG, PATHS }), /PATHS .*bị từ chối/, PATHS)
    assert.throws(() => runSetup({ BASE_URL: 'https://shop.workers.dev', ALLOW_HOST: '1', PATHS }), /PATHS .*bị từ chối/, `ALLOW_HOST ${PATHS}`)
  }
  assert.doesNotThrow(() => runSetup({ BASE_URL: STG, PATHS: '/,/api/items?page=1, /about ' }))
  assert.doesNotThrow(() => runSetup({ BASE_URL: STG }))
  assert.doesNotThrow(() => runSetup({ BASE_URL: 'http://localhost:8787/', PATHS: '/a' }))
  // BASE_URL vẫn bị chốt trước khi xét PATHS
  assert.throws(() => runSetup({ BASE_URL: 'https://shop.workers.dev', PATHS: '/a' }), /không giống bản thử/)
})

test('setup(): bản thật bị chặn, ALLOW_HOST=1 thì cho, bản thử/localhost qua, thiếu BASE_URL báo rõ', () => {
  assert.throws(() => runSetup({ BASE_URL: 'https://shop.workers.dev' }), /"shop\.workers\.dev" không giống bản thử.*ALLOW_HOST=1/)
  assert.throws(() => runSetup({ BASE_URL: 'https://myshop.dev/' }), /không giống bản thử/)
  assert.throws(() => runSetup({ BASE_URL: 'https://shop.workers.dev', ALLOW_HOST: '0' }), /không giống bản thử/)
  assert.doesNotThrow(() => runSetup({ BASE_URL: 'https://shop.workers.dev', ALLOW_HOST: '1' }))
  assert.doesNotThrow(() => runSetup({ BASE_URL: 'https://app-staging.shop.workers.dev' }))
  assert.doesNotThrow(() => runSetup({ BASE_URL: 'http://localhost:8787/' }))
  assert.throws(() => runSetup({}), /Thiếu BASE_URL/)
})

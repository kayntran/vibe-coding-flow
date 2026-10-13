// Test cho ui-check.mjs: node --test hooks/ui-check.test.mjs
// Kit không cài Playwright ⇒ Playwright giả (tiêm qua io.loadPlaywright) trả snapshot dựng sẵn; phần bật/tắt app dùng tiến trình node thật.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectScript } from './lib/ui-rules.mjs'
import { DEFAULT_PORT, loadConfig, loadPlaywright, run } from './ui-check.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-check.mjs')
const roots = []
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

// ---------- dựng dự án + Playwright giả ----------
function put(dir, rel, content) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

function project(cfg, files = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-')))
  roots.push(dir)
  if (cfg !== null) put(dir, '.claude/ui.json', cfg)
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content)
  return dir
}

const CFG = { url: 'http://localhost:5173', routes: ['/', '/orders'] }
const btn = (o = {}) => ({ text: '', name: '', iconOnly: false, primary: false, inDialog: false, dialogButtons: 0, inToolbar: false, title: '', ...o })
const icon = (name) => btn({ name, iconOnly: true })
const lab = (text, o = {}) => btn({ text, name: text, ...o })
const pathOf = (url) => new URL(url).pathname + new URL(url).search

// snap(url, width) → mảng nút của trang đó. Ghi lại mọi lần mở trang để test kiểm "mở đủ route × khổ".
// present(url, s) → trang có phần tử data-s="s" không (mặc định có).
function fakePw({ snap = () => [], status = 200, gotoError = null, launchError = null, onGoto = null, readError = null, present = () => true } = {}) {
  const log = { launches: 0, contexts: [], visits: [], browserClosed: 0 }
  const makePage = (width) => ({
    async goto(url) {
      log.visits.push({ url, width })
      if (onGoto) await onGoto(url)
      if (gotoError) throw new Error(gotoError)
      return { status: () => (typeof status === 'function' ? status(url) : status) }
    },
    async waitForLoadState() {},
    async evaluate(script, arg) {
      if (typeof script === 'function') return present(log.visits.at(-1).url, arg) // kiểm có data-s không
      if (script !== collectScript) return undefined // đoạn chờ khung hình
      if (readError) throw new Error(readError)
      const url = log.visits.at(-1).url
      return { route: pathOf(url), viewport: width, dialogsOnLoad: 0, buttons: snap(url, width) }
    },
    async close() {},
  })
  const browser = {
    async newContext({ viewport }) {
      log.contexts.push(viewport)
      return { newPage: async () => makePage(viewport.width), close: async () => {} }
    },
    async close() { log.browserClosed++ },
  }
  const chromium = { async launch() { if (launchError) throw new Error(launchError); log.launches++; return browser } }
  return { loadPlaywright: () => ({ chromium }), log }
}
const answering = (pw) => ({ loadPlaywright: pw.loadPlaywright, probe: async () => true })
const out = (r) => [...r.lines, ...r.errLines].join('\n')
const readBaseline = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'ui-baseline.json'), 'utf8'))
const isRoot = (url) => new URL(url).pathname === '/' && !new URL(url).search

describe('cấu hình .claude/ui.json (exit 2)', () => {
  test('chưa có ui.json ⇒ exit 2, nói thiếu file và đưa ví dụ', async () => {
    const r = await run(['--dir', project(null)])
    assert.equal(r.code, 2)
    assert.match(out(r), /Chưa có \.claude\/ui\.json/)
    assert.match(out(r), /"routes"/)
  })

  test('JSON hỏng ⇒ exit 2 (không coi như chưa có file)', async () => {
    const r = await run(['--dir', project('{ "url": "http://localhost:1", ')])
    assert.equal(r.code, 2)
    assert.match(out(r), /sai cú pháp JSON/)
  })

  test('sai dạng ⇒ exit 2 và nêu từng chỗ sai', async () => {
    for (const [cfg, re] of [
      [{ routes: ['/'] }, /thiếu "url"/],
      [{ url: 'http://example.com', routes: ['/'] }, /chỉ được là app chạy trên máy này/],
      [{ url: 'ftp://localhost', routes: ['/'] }, /http:\/\//],
      [{ url: 'localhost:5173', routes: ['/'] }, /không phải địa chỉ|http/],
      [{ url: 'http://localhost:1', routes: [] }, /ít nhất một đường dẫn/],
      [{ url: 'http://localhost:1', routes: ['orders'] }, /"routes" phải/],
      [{ url: 'http://localhost:1', routes: ['/'], start: 5 }, /"start"/],
      [{ url: 'http://localhost:1', routes: ['/'], states: [{ route: '/', s: 'S-01', setup: 'x=1' }] }, /"states"/],
      [{ url: 'http://localhost:1', routes: ['/'], states: [{ route: '/' }] }, /"states"/],
      [{ url: 'http://localhost:1', routes: ['/'], whitelistIcons: [1] }, /"whitelistIcons"/],
      [[], /đối tượng JSON/],
    ]) {
      const r = await run(['--dir', project(cfg)])
      assert.equal(r.code, 2, JSON.stringify(cfg))
      assert.match(out(r), re, JSON.stringify(cfg))
    }
  })

  test('--url cũng phải là localhost', async () => {
    const r = await run(['--dir', project(CFG), '--url', 'https://example.com'])
    assert.equal(r.code, 2)
    assert.match(out(r), /--url/)
  })

  test('chỉ có states (không routes) vẫn hợp lệ; BOM đầu file được bỏ qua', async () => {
    const pw = fakePw()
    const dir = project(String.fromCharCode(0xfeff) + JSON.stringify({ url: 'http://localhost:1', states: [{ route: '/', s: 'S-01' }] }))
    assert.equal((await run(['--dir', dir], answering(pw))).code, 0)
    assert.equal(pw.log.visits.length, 2)
  })

  test('đối số sai ⇒ exit 2; --help ⇒ exit 0', async () => {
    assert.equal((await run(['--bậy'])).code, 2)
    assert.equal((await run(['--dir'])).code, 2)
    const h = await run(['--help'])
    assert.equal(h.code, 0)
    assert.match(out(h), /exit: 0 đạt/)
  })
})

describe('{PORT} trong "url" và "start" (nhiều bản sao app chạy song song không đụng cổng)', () => {
  const cfg = (extra = {}) => ({ url: 'http://localhost:{PORT}', routes: ['/'], start: 'pnpm dev --port {PORT} --strictPort', ...extra })

  test('điền từ biến môi trường PORT; không đặt (hoặc rỗng) thì 5173', () => {
    const dir = project(cfg())
    const c = loadConfig(dir, undefined, { PORT: '4321' })
    assert.equal(c.url, 'http://localhost:4321')
    assert.equal(c.start, 'pnpm dev --port 4321 --strictPort')
    for (const env of [{}, { PORT: '' }, { PORT: '  ' }]) {
      const d = loadConfig(dir, undefined, env)
      assert.equal(d.url, `http://localhost:${DEFAULT_PORT}`)
      assert.equal(d.start, `pnpm dev --port ${DEFAULT_PORT} --strictPort`)
    }
    assert.equal(DEFAULT_PORT, '5173')
  })

  test('ui.json không có {PORT} thì giữ nguyên (cổng viết cứng vẫn chạy); --url cũng điền được {PORT}', () => {
    const dir = project({ url: 'http://localhost:3000', routes: ['/'], start: 'npm run dev' })
    const c = loadConfig(dir, undefined, { PORT: '4321' })
    assert.deepEqual([c.url, c.start], ['http://localhost:3000', 'npm run dev'])
    assert.equal(loadConfig(dir, 'http://localhost:{PORT}/x', { PORT: '4321' }).url, 'http://localhost:4321/x')
  })

  test('chạy thật: mở đúng cổng PORT của môi trường', async () => {
    const pw = fakePw()
    const r = await run(['--dir', project(cfg())], { ...answering(pw), env: { PORT: '4321' } })
    assert.equal(r.code, 0, out(r))
    assert.equal(pw.log.visits[0].url, 'http://localhost:4321/')
    const d = fakePw()
    await run(['--dir', project(cfg())], { ...answering(d), env: {} })
    assert.equal(d.log.visits[0].url, 'http://localhost:5173/')
  })

  test('PORT không phải số (có thể chèn lệnh vào "start") ⇒ exit 2, không chạy gì', async () => {
    for (const bad of ['abc', '4321; calc', '99999999', '-1']) {
      const r = await run(['--dir', project(cfg())], { ...answering(fakePw()), env: { PORT: bad } })
      assert.equal(r.code, 2, bad)
      assert.match(out(r), /PORT/)
    }
    // Không dùng {PORT} thì PORT lạ không liên quan.
    const fixed = await run(['--dir', project({ url: 'http://localhost:5173', routes: ['/'] })], { ...answering(fakePw()), env: { PORT: 'abc' } })
    assert.equal(fixed.code, 0)
  })
})

describe('thiếu Playwright (exit 3)', () => {
  test('dự án không có Playwright ⇒ exit 3 + lệnh cài (npm mặc định)', async () => {
    const r = await run(['--dir', project(CFG)], { probe: async () => true })
    assert.equal(r.code, 3, out(r))
    assert.match(out(r), /Thiếu Playwright/)
    assert.match(out(r), /npm i -D playwright/)
    assert.match(out(r), /npx playwright install chromium/)
  })

  test('lệnh cài theo trình quản lý của dự án (pnpm / yarn)', async () => {
    const pnpm = await run(['--dir', project(CFG, { 'pnpm-lock.yaml': '' })], { probe: async () => true })
    assert.equal(pnpm.code, 3)
    assert.match(out(pnpm), /pnpm add -D playwright/)
    assert.match(out(pnpm), /pnpm exec playwright install chromium/)
    const yarn = await run(['--dir', project(CFG, { 'yarn.lock': '' })], { probe: async () => true })
    assert.match(out(yarn), /yarn add -D playwright/)
  })

  test('có Playwright nhưng chưa tải trình duyệt ⇒ exit 3, chỉ lệnh cài trình duyệt, không bật app', async () => {
    let probed = 0
    const pw = fakePw({ launchError: "browserType.launch: Executable doesn't exist at C:\\x\\chrome.exe\n  npx playwright install" })
    const r = await run(['--dir', project(CFG)], { loadPlaywright: pw.loadPlaywright, probe: async () => { probed++; return true } })
    assert.equal(r.code, 3)
    assert.match(out(r), /không mở được trình duyệt/)
    assert.match(out(r), /npx playwright install chromium/)
    assert.doesNotMatch(out(r), /npm i -D playwright/)
    assert.equal(probed, 0, 'thiếu trình duyệt thì chưa đụng tới app')
  })

  test('--json: lỗi cũng ra JSON có code', async () => {
    const r = await run(['--dir', project(CFG), '--json'], { probe: async () => true })
    assert.equal(r.code, 3)
    assert.deepEqual([JSON.parse(r.lines[0]).ok, JSON.parse(r.lines[0]).code], [false, 3])
  })

  describe('loadPlaywright (nạp từ node_modules của dự án)', () => {
    const pkg = (dir, name, body) => {
      put(dir, `node_modules/${name}/package.json`, { name, version: '0.0.0', main: 'index.js' })
      put(dir, `node_modules/${name}/index.js`, body)
    }
    test('không có gói ⇒ null', () => {
      assert.equal(loadPlaywright(project(CFG)), null)
    })
    test('lấy chromium từ gói playwright của dự án', () => {
      const dir = project(CFG)
      pkg(dir, 'playwright', "exports.chromium = { who: 'playwright' }")
      assert.equal(loadPlaywright(dir).chromium.who, 'playwright')
    })
    test('playwright thắng playwright-core; chỉ có playwright-core / @playwright/test (pnpm) vẫn nạp được', () => {
      const both = project(CFG)
      pkg(both, 'playwright-core', "exports.chromium = { who: 'core' }")
      pkg(both, 'playwright', "exports.chromium = { who: 'playwright' }")
      assert.equal(loadPlaywright(both).chromium.who, 'playwright')
      const core = project(CFG)
      pkg(core, 'playwright-core', "exports.chromium = { who: 'core' }")
      assert.equal(loadPlaywright(core).chromium.who, 'core')
      const scoped = project(CFG)
      pkg(scoped, '@playwright/test', "exports.chromium = { who: 'test' }")
      assert.equal(loadPlaywright(scoped).chromium.who, 'test')
    })
    test('gói cài dở (ném lỗi khi nạp) hoặc không có chromium ⇒ thử tên khác rồi null, không ném', () => {
      const dir = project(CFG)
      pkg(dir, 'playwright', "throw new Error('cai do')")
      pkg(dir, 'playwright-core', 'exports.other = 1')
      assert.equal(loadPlaywright(dir), null)
      pkg(dir, '@playwright/test', "exports.chromium = { who: 'test' }")
      assert.equal(loadPlaywright(dir).chromium.who, 'test')
    })
    test('chạy qua run(): dùng gói trong dự án (đường nạp thật), chromium giả của gói được gọi', async () => {
      const dir = project(CFG)
      put(dir, 'node_modules/playwright/package.json', { name: 'playwright', version: '0.0.0', main: 'index.js' })
      put(dir, 'node_modules/playwright/index.js', "exports.chromium = { launch: async () => { throw new Error('goi that duoc nap') } }")
      const r = await run(['--dir', dir], { probe: async () => true })
      assert.equal(r.code, 3)
      assert.match(out(r), /goi that duoc nap/)
    })
  })
})

describe('duyệt và kiểm', () => {
  test('trang sạch ⇒ exit 0; mở MỖI route ở CẢ HAI khổ 1280 và 390', async () => {
    const pw = fakePw({ snap: () => [lab('Lưu', { primary: true }), lab('Huỷ đơn')] })
    const r = await run(['--dir', project(CFG)], answering(pw))
    assert.equal(r.code, 0, out(r))
    assert.match(out(r), /ĐẠT/)
    assert.match(out(r), /2 màn ở 2 khổ \(1280, 390\)/)
    assert.deepEqual(pw.log.contexts.map((v) => v.width), [1280, 390])
    assert.deepEqual(pw.log.visits.map((v) => `${v.width} ${v.url}`), [
      '1280 http://localhost:5173/', '1280 http://localhost:5173/orders', '390 http://localhost:5173/', '390 http://localhost:5173/orders',
    ])
    assert.equal(pw.log.browserClosed, 1, 'đóng trình duyệt')
  })

  test('có lỗi chặn ⇒ exit 1; nói màn nào, khổ nào, lỗi gì, sửa gì', async () => {
    const pw = fakePw({ snap: (url, w) => (pathOf(url) === '/orders' && w === 390 ? [icon('Xoá'), lab('OK')] : []) })
    const r = await run(['--dir', project(CFG)], answering(pw))
    assert.equal(r.code, 1, out(r))
    assert.match(out(r), /KHÔNG +Giao diện còn 2 lỗi chặn/)
    assert.match(out(r), /Màn \/orders, khổ hẹp 390: Nút "Xoá" chỉ có hình/)
    assert.match(out(r), /Màn \/orders, khổ hẹp 390: Nút "OK" không nói rõ/)
    assert.doesNotMatch(out(r), /khổ rộng/)
    assert.match(out(r), /Sửa: /)
  })

  test('chỉ có cảnh báo (nhãn dài) ⇒ exit 0 và vẫn nhắc; cùng cảnh báo ở hai khổ gộp một dòng', async () => {
    const pw = fakePw({ snap: () => [lab('Thêm một đơn hàng mới')] })
    const r = await run(['--dir', project({ ...CFG, routes: ['/'] })], answering(pw))
    assert.equal(r.code, 0)
    assert.match(out(r), /Cảnh báo \(không chặn\): 1/)
    assert.match(out(r), /- Màn \/, khổ rộng và hẹp \(1280, 390\): Nút "Thêm một đơn hàng mới" dài 5 chữ/)
  })

  test('cùng một lỗi ở cả hai khổ ⇒ MỘT dòng "khổ rộng và hẹp"; số lỗi đếm theo dòng đã gộp; lỗi chỉ ở một khổ giữ nguyên', async () => {
    const pw = fakePw({ snap: (url, w) => (isRoot(url) ? [icon('Xoá'), lab('OK'), ...(w === 390 ? [icon('Sửa')] : [])] : []) })
    const r = await run(['--dir', project(CFG)], answering(pw))
    assert.equal(r.code, 1, out(r))
    assert.match(out(r), /KHÔNG +Giao diện còn 3 lỗi chặn/)
    assert.match(out(r), /Màn \/, khổ rộng và hẹp \(1280, 390\): Nút "Xoá" chỉ có hình/)
    assert.match(out(r), /Màn \/, khổ rộng và hẹp \(1280, 390\): Nút "OK" không nói rõ/)
    assert.match(out(r), /Màn \/, khổ hẹp 390: Nút "Sửa" chỉ có hình/)
    assert.equal(out(r).split('\n').filter((l) => /Nút "Xoá"/.test(l)).length, 1)
    const j = JSON.parse((await run(['--dir', project(CFG), '--json'], answering(pw))).lines[0])
    assert.equal(j.blocking.length, 5, 'JSON vẫn từng khổ riêng cho máy đọc')
  })

  test('nút không tên: lời báo nêu nút nào (hint) và gộp hai khổ khi giống nhau', async () => {
    const pw = fakePw({ snap: (url, w) => [btn({ iconOnly: true, hint: `<button.size-9> có icon lucide-plus${w === 390 ? ' (khổ hẹp)' : ''}` }), btn({ iconOnly: true, hint: '<a href="/x">' })] })
    const r = await run(['--dir', project({ ...CFG, routes: ['/'] })], answering(pw))
    assert.equal(r.code, 1, out(r))
    assert.match(out(r), /Có một nút không có tên/)
    assert.match(out(r), /Nút nào: <button\.size-9> có icon lucide-plus; <a href="\/x">/)
    assert.match(out(r), /khổ rộng 1280:[^\n]*lucide-plus;/)
    assert.match(out(r), /khổ hẹp 390:[^\n]*lucide-plus \(khổ hẹp\)/)
  })

  test('whitelistIcons trong ui.json được áp dụng', async () => {
    const snap = () => [icon('Đóng')]
    assert.equal((await run(['--dir', project({ ...CFG, routes: ['/'] })], answering(fakePw({ snap })))).code, 1)
    assert.equal((await run(['--dir', project({ ...CFG, routes: ['/'], whitelistIcons: ['Đóng'] })], answering(fakePw({ snap })))).code, 0)
  })

  test('states: mở route + setup, gắn mã S vào lời báo; trùng route thì chỉ mở một lần', async () => {
    const cfg = { url: 'http://localhost:5173', routes: ['/'], states: [{ route: '/', setup: '?empty=1', s: 'S-02' }, { route: '/', s: 'S-01' }] }
    const pw = fakePw({ snap: (url) => (url.includes('empty=1') ? [icon('Xoá')] : []) })
    const r = await run(['--dir', project(cfg)], answering(pw))
    assert.deepEqual(pw.log.visits.filter((v) => v.width === 1280).map((v) => v.url), ['http://localhost:5173/', 'http://localhost:5173/?empty=1'])
    assert.equal(r.code, 1)
    assert.match(out(r), /Màn \/\?empty=1 \(S-02\), khổ rộng và hẹp \(1280, 390\)/)
    const clean = await run(['--dir', project(cfg)], answering(fakePw({ snap: () => [icon('Xoá')] })))
    assert.match(out(clean), /Màn \/ \(S-01\), khổ rộng và hẹp \(1280, 390\)/, 'state trùng route đã có ⇒ gắn mã S vào route đó')
  })

  test('states: trang không có data-s của mã ⇒ lỗi state-missing nêu mã, có mã ⇒ đạt', async () => {
    const cfg = { url: 'http://localhost:5173', routes: [], states: [{ route: '/', setup: '?empty=1', s: 'S-02' }] }
    const miss = await run(['--dir', project(cfg)], answering(fakePw({ present: () => false })))
    assert.equal(miss.code, 1)
    assert.match(out(miss), /Không thấy trạng thái S-02/)
    assert.match(out(miss), /data-s="S-02"/)
    assert.equal((await run(['--dir', project(cfg)], answering(fakePw({ present: (url, s) => s === 'S-02' })))).code, 0)
  })

  test('states: hai mã S cùng route + setup ⇒ giữ CẢ HAI mã, kiểm data-s của từng mã (mã sau không bị bỏ)', async () => {
    const cfg = { url: 'http://localhost:5173', routes: [], states: [{ route: '/', s: 'S-01' }, { route: '/', s: 'S-02' }] }
    const onlyFirst = fakePw({ present: (url, s) => s === 'S-01' })
    const miss = await run(['--dir', project(cfg)], answering(onlyFirst))
    assert.equal(miss.code, 1, out(miss))
    assert.match(out(miss), /Không thấy trạng thái S-02/)
    assert.doesNotMatch(out(miss), /Không thấy trạng thái S-01/)
    assert.equal(onlyFirst.log.visits.filter((v) => v.width === 1280).length, 1, 'cùng đích chỉ mở một lần')
    const both = await run(['--dir', project(cfg)], answering(fakePw({ present: () => true })))
    assert.equal(both.code, 0, out(both))
    const none = await run(['--dir', project(cfg)], answering(fakePw({ present: () => false })))
    assert.match(out(none), /Không thấy trạng thái S-01/)
    assert.match(out(none), /Không thấy trạng thái S-02/)
  })

  test('HTTP lỗi: route ⇒ exit 2 (sai cấu hình); state ⇒ chấp nhận (màn "không tìm thấy" là trạng thái hợp lệ)', async () => {
    const status = (url) => (pathOf(url) === '/orders' ? 404 : 200)
    const bad = await run(['--dir', project(CFG)], answering(fakePw({ status })))
    assert.equal(bad.code, 2)
    assert.match(out(bad), /trả lỗi 404/)
    const okState = await run(['--dir', project({ url: CFG.url, routes: ['/'], states: [{ route: '/orders', s: 'S-09' }] })], answering(fakePw({ status })))
    assert.equal(okState.code, 0, out(okState))
  })

  test('không mở được trang ⇒ exit 2 nêu địa chỉ, vẫn đóng trình duyệt', async () => {
    const pw = fakePw({ gotoError: 'net::ERR_CONNECTION_REFUSED at http://localhost:5173/\n  extra' })
    const r = await run(['--dir', project(CFG)], answering(pw))
    assert.equal(r.code, 2)
    assert.match(out(r), /Không mở được http:\/\/localhost:5173\/: net::ERR_CONNECTION_REFUSED/)
    assert.equal(pw.log.browserClosed, 1)
  })

  test('trang tự chuyển hướng giữa lúc đọc ⇒ exit 2 với lời báo rõ, không phải "lỗi bất ngờ"', async () => {
    const r = await run(['--dir', project(CFG)], answering(fakePw({ readError: 'Execution context was destroyed, most likely because of a navigation' })))
    assert.equal(r.code, 2)
    assert.match(out(r), /Không đọc được nội dung màn http:\/\/localhost:5173\/: Execution context was destroyed/)
  })

  test('--url thay url trong ui.json', async () => {
    const pw = fakePw()
    const r = await run(['--dir', project(CFG), '--url', 'http://127.0.0.1:4010/'], answering(pw))
    assert.equal(r.code, 0)
    assert.equal(pw.log.visits[0].url, 'http://127.0.0.1:4010/')
  })

  test('--json: cấu trúc ổn định (ok, code, blocking[], warnings[], viewports)', async () => {
    const pw = fakePw({ snap: (url) => (isRoot(url) ? [icon('Xoá'), lab('Thêm một đơn hàng mới')] : []) })
    const r = await run(['--dir', project(CFG), '--json'], answering(pw))
    assert.equal(r.code, 1)
    assert.equal(r.lines.length, 1)
    const j = JSON.parse(r.lines[0])
    assert.equal(j.ok, false)
    assert.equal(j.code, 1)
    assert.deepEqual(j.checked.viewports, [1280, 390])
    assert.deepEqual(j.checked.screens, ['/', '/orders'])
    assert.equal(j.baseline, false)
    assert.deepEqual(j.blocking.map((b) => [b.rule, b.route, b.viewport, b.count]), [['icon-only', '/', 1280, 1], ['icon-only', '/', 390, 1]])
    assert.equal(j.warnings.length, 2)
    assert.ok(j.blocking[0].msg && j.blocking[0].fix && j.blocking[0].key)
  })

  test('app đang chạy sẵn ⇒ nói rõ là dùng app có sẵn', async () => {
    const r = await run(['--dir', project(CFG)], answering(fakePw()))
    assert.match(out(r), /Dùng app đang chạy sẵn ở http:\/\/localhost:5173/)
  })
})

describe('mốc docs/ui-baseline.json (app cũ: chỉ lỗi mới/vượt mốc mới chặn)', () => {
  const xoa = (n) => (url) => (isRoot(url) ? Array.from({ length: n }, () => icon('Xoá')) : [])

  test('không có mốc ⇒ mọi lỗi chặn', async () => {
    assert.equal((await run(['--dir', project(CFG)], answering(fakePw({ snap: xoa(1) })))).code, 1)
  })

  test('--baseline ghi mốc {base, counts} theo khoá route|khổ|luật|nhãn, exit 0 dù có lỗi', async () => {
    const dir = project(CFG)
    const r = await run(['--dir', dir, '--baseline'], answering(fakePw({ snap: xoa(1) })))
    assert.equal(r.code, 0, out(r))
    assert.match(out(r), /Đã chốt mốc giao diện: 2 lỗi cũ/)
    const b = readBaseline(dir)
    assert.ok('base' in b)
    assert.deepEqual(b.counts, { '/|1280|icon-only|xoá': 1, '/|390|icon-only|xoá': 1 })
  })

  test('cùng lỗi như lúc chốt ⇒ exit 0 (báo là lỗi cũ); ít hơn ⇒ exit 0', async () => {
    const dir = project(CFG, { 'docs/ui-baseline.json': { base: null, counts: { '/|1280|icon-only|xoá': 1, '/|390|icon-only|xoá': 1 } } })
    const same = await run(['--dir', dir], answering(fakePw({ snap: xoa(1) })))
    assert.equal(same.code, 0, out(same))
    assert.match(out(same), /ĐẠT/)
    assert.match(out(same), /Còn 2 lỗi cũ đã chốt/)
    assert.equal((await run(['--dir', dir], answering(fakePw({ snap: xoa(0) })))).code, 0)
  })

  test('THÊM một nút lỗi cùng route/khổ/luật/nhãn ⇒ vượt mốc ⇒ exit 1, nói "thêm 1 so với mốc"', async () => {
    const dir = project(CFG, { 'docs/ui-baseline.json': { base: null, counts: { '/|1280|icon-only|xoá': 1, '/|390|icon-only|xoá': 1 } } })
    const r = await run(['--dir', dir], answering(fakePw({ snap: xoa(2) })))
    assert.equal(r.code, 1, out(r))
    assert.match(out(r), /Giao diện còn 1 lỗi chặn/, 'cùng lỗi ở hai khổ gộp một dòng')
    assert.match(out(r), /khổ rộng và hẹp \(1280, 390\)[^\n]*\(thêm 1 so với mốc\)/)
  })

  test('lỗi mới khác nhãn / khác luật ⇒ exit 1', async () => {
    const dir = project(CFG, { 'docs/ui-baseline.json': { base: null, counts: { '/|1280|icon-only|xoá': 1, '/|390|icon-only|xoá': 1 } } })
    const r = await run(['--dir', dir], answering(fakePw({ snap: (url) => (isRoot(url) ? [icon('Xoá'), icon('Sửa'), lab('OK')] : []) })))
    assert.equal(r.code, 1)
    assert.match(out(r), /Nút "Sửa"/)
    assert.match(out(r), /Nút "OK"/)
    assert.doesNotMatch(out(r), /Nút "Xoá"/)
  })

  test('mốc hỏng JSON hoặc sai dạng ⇒ exit 2 (không nới luật, không tính như "chưa có mốc")', async () => {
    for (const bad of ['{ "counts": ', JSON.stringify({ base: null }), JSON.stringify({ counts: { a: -1 } }), JSON.stringify({ counts: { a: 'x' } }), JSON.stringify({ counts: [] })]) {
      const r = await run(['--dir', project(CFG, { 'docs/ui-baseline.json': bad })], answering(fakePw()))
      assert.equal(r.code, 2, bad)
      assert.match(out(r), /ui-baseline\.json/)
    }
  })

  test('--baseline ghi đè cả mốc hỏng', async () => {
    const dir = project(CFG, { 'docs/ui-baseline.json': '{ hỏng' })
    assert.equal((await run(['--dir', dir, '--baseline'], answering(fakePw()))).code, 0)
    assert.deepEqual(readBaseline(dir).counts, {})
  })

  test('cảnh báo không vào mốc', async () => {
    const dir = project({ ...CFG, routes: ['/'] })
    await run(['--dir', dir, '--baseline'], answering(fakePw({ snap: () => [lab('Thêm một đơn hàng mới')] })))
    assert.deepEqual(readBaseline(dir).counts, {})
  })
})

describe('bật và tắt app', () => {
  const freePort = () => new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const readPid = (dir, f) => Number(fs.readFileSync(path.join(dir, f), 'utf8'))
  async function dead(pid, ms = 10_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await sleep(100) }
    return false
  }
  const SERVER = "import http from 'node:http'\nimport fs from 'node:fs'\nconst [port, pidFile] = process.argv.slice(2)\nfs.writeFileSync(pidFile, String(process.pid))\nhttp.createServer((q, r) => r.end('ok')).listen(Number(port), '127.0.0.1')\n"
  const PARENT = "import { spawn } from 'node:child_process'\nimport fs from 'node:fs'\nconst [port, serverPid, parentPid] = process.argv.slice(2)\nfs.writeFileSync(parentPid, String(process.pid))\nspawn(process.execPath, ['server.mjs', port, serverPid], { stdio: 'ignore' })\nsetInterval(() => {}, 1000)\n"
  const IDLE = "import fs from 'node:fs'\nfs.writeFileSync('idle.pid', String(process.pid))\nsetInterval(() => {}, 1000)\n"
  const proj = async (start, files) => {
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    return { port, url, dir: project({ url, routes: ['/'], start: start(port) }, files) }
  }

  test('app đang trả lời ⇒ KHÔNG chạy start', async () => {
    const dir = project({ ...CFG, start: 'node marker.mjs' }, { 'marker.mjs': "import fs from 'node:fs'\nfs.writeFileSync('ran.txt', 'x')\n" })
    const r = await run(['--dir', dir], answering(fakePw()))
    assert.equal(r.code, 0)
    assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false)
  })

  test('app chưa chạy và không có "start" ⇒ exit 2 nói cách xử lý', async () => {
    const r = await run(['--dir', project(CFG)], { loadPlaywright: fakePw().loadPlaywright, probe: async () => false })
    assert.equal(r.code, 2)
    assert.match(out(r), /chưa có "start"/)
  })

  test('bật app bằng start, đợi nó lên rồi mới duyệt, xong thì app bị tắt', async () => {
    const { dir, url } = await proj((p) => `node server.mjs ${p} server.pid`, { 'server.mjs': SERVER })
    const seen = []
    const pw = fakePw({ onGoto: async (u) => { seen.push((await fetch(u)).status) } })
    const r = await run(['--dir', dir], { loadPlaywright: pw.loadPlaywright })
    assert.equal(r.code, 0, out(r))
    assert.ok(seen.length >= 2 && seen.every((s) => s === 200), `app phải đang chạy lúc duyệt: ${seen}`)
    assert.doesNotMatch(out(r), /đang chạy sẵn/)
    assert.equal(await dead(readPid(dir, 'server.pid')), true, 'tiến trình app phải chết')
    await assert.rejects(fetch(url), 'cổng đã đóng')
  })

  test('"start" và "url" dùng {PORT}: bật app đúng cổng PORT của môi trường rồi tắt', async () => {
    const port = await freePort()
    const dir = project({ url: 'http://127.0.0.1:{PORT}', routes: ['/'], start: 'node server.mjs {PORT} server.pid' }, { 'server.mjs': SERVER })
    const seen = []
    const pw = fakePw({ onGoto: async (u) => { seen.push(u); assert.equal((await fetch(u)).status, 200) } })
    const r = await run(['--dir', dir], { loadPlaywright: pw.loadPlaywright, env: { PORT: String(port) } })
    assert.equal(r.code, 0, out(r))
    assert.ok(seen.length >= 2 && seen.every((u) => u.startsWith(`http://127.0.0.1:${port}/`)), String(seen))
    assert.equal(await dead(readPid(dir, 'server.pid')), true)
  })

  test('diệt CẢ CÂY tiến trình: lệnh start sinh ra tiến trình con giữ cổng ⇒ cả cha lẫn con đều chết', async () => {
    const { dir } = await proj((p) => `node parent.mjs ${p} server.pid parent.pid`, { 'server.mjs': SERVER, 'parent.mjs': PARENT })
    const r = await run(['--dir', dir], { loadPlaywright: fakePw().loadPlaywright })
    assert.equal(r.code, 0, out(r))
    assert.equal(await dead(readPid(dir, 'parent.pid')), true, 'tiến trình cha chết')
    assert.equal(await dead(readPid(dir, 'server.pid')), true, 'tiến trình con (giữ cổng) chết')
  })

  test('lỗi giữa chừng (không mở được trang) vẫn tắt app', async () => {
    const { dir } = await proj((p) => `node server.mjs ${p} server.pid`, { 'server.mjs': SERVER })
    const r = await run(['--dir', dir], { loadPlaywright: fakePw({ gotoError: 'boom' }).loadPlaywright })
    assert.equal(r.code, 2)
    assert.equal(await dead(readPid(dir, 'server.pid')), true)
  })

  test('lệnh start chết ngay ⇒ exit 2 nhanh, kèm dòng cuối app in ra', async () => {
    const t0 = Date.now()
    const { dir } = await proj(() => 'node boom.mjs', { 'boom.mjs': "console.error('cong 5173 dang bi chiem')\nprocess.exit(3)\n" })
    const r = await run(['--dir', dir], { loadPlaywright: fakePw().loadPlaywright, startTimeoutMs: 30_000 })
    assert.equal(r.code, 2)
    assert.match(out(r), /đã dừng \(mã 3\)/)
    assert.match(out(r), /cong 5173 dang bi chiem/)
    assert.ok(Date.now() - t0 < 15_000, 'không đợi hết giờ')
  })

  test('app không lên trong giờ chờ ⇒ exit 2 nêu cổng, và tiến trình đã bật bị diệt', async () => {
    const { dir } = await proj(() => 'node idle.mjs', { 'idle.mjs': IDLE })
    const r = await run(['--dir', dir], { loadPlaywright: fakePw().loadPlaywright, startTimeoutMs: 3000 })
    assert.equal(r.code, 2)
    assert.match(out(r), /Đợi 3 giây mà app chưa trả lời/)
    assert.equal(await dead(readPid(dir, 'idle.pid')), true)
  })
})

describe('chạy như lệnh (exit code thật)', () => {
  const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })

  test('--help ⇒ 0; đối số lạ ⇒ 2; thiếu ui.json ⇒ 2 (lời báo ở stderr)', () => {
    assert.equal(cli(['--help']).status, 0)
    assert.match(cli(['--help']).stdout, /ui-check/)
    const bad = cli(['--khong-co'])
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /đối số không hợp lệ/)
    const none = cli(['--dir', project(null)])
    assert.equal(none.status, 2)
    assert.match(none.stderr, /Chưa có \.claude\/ui\.json/)
  })

  test('dự án không có Playwright ⇒ exit 3 + lệnh cài ở stderr', () => {
    const r = cli(['--dir', project(CFG)])
    assert.equal(r.status, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /Thiếu Playwright/)
    assert.match(r.stderr, /npm i -D playwright/)
  })
})

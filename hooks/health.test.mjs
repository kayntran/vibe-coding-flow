// Test cho health.mjs (lệnh "khám sức khoẻ"): node --test hooks/health.test.mjs
// Phần lớn dùng run/which giả. Hai ca chạy tiến trình thật chỉ để kiểm đường chạy thật (flow-check con + findTool + runCommand) trên dự án mẫu
// không có package.json/.git/docs ⇒ không cần công cụ nào cài sẵn, không cần mạng.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, USAGE } from './health.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'health.mjs')
const tmpDirs = []
function app(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-cli '))
  tmpDirs.push(root)
  const dir = path.join(root, 'ứng dụng mẫu')
  fs.mkdirSync(dir)
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return { dir, root, stateOpts: { logDir: path.join(root, 'logs') } }
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const sink = () => { const s = { text: '', write(x) { s.text += x } }; return s }
const NOW = new Date(2026, 9, 13, 10, 0, 0)
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, error: null })
const flowJson = (results) => JSON.stringify({ results })
const res = (id, status, extra = {}) => ({ id, title: `Tiêu đề ${id}`, status, message: '', fix: null, detail: [], ...extra })

// Chạy main với flow-check giả (kết quả tuỳ ý) và không công cụ nào khác cài.
function go(fx, argv, flow = []) {
  const out = sink()
  const err = sink()
  const run = async () => ok(flowJson(flow))
  const p = main([fx.dir, ...argv], { stdout: out, stderr: err, run, which: async () => null, now: NOW, stateOpts: fx.stateOpts })
  return p.then((code) => ({ code, out: out.text, err: err.text }))
}

describe('dùng sai', () => {
  test('--help ⇒ 0 và in cách dùng', async () => {
    const out = sink()
    assert.equal(await main(['--help'], { stdout: out, stderr: sink() }), 0)
    assert.equal(out.text, `${USAGE}\n`)
  })

  test('cờ lạ, hai thư mục, thư mục không có ⇒ exit 3, không khám', async () => {
    const fx = app()
    for (const argv of [['--lạ'], [fx.dir, fx.dir], [path.join(fx.root, 'khong-co')]]) {
      const err = sink()
      let ran = false
      const code = await main(argv, { stdout: sink(), stderr: err, run: async () => { ran = true; return ok() }, which: async () => null })
      assert.equal(code, 3, argv.join(' '))
      assert.equal(ran, false)
      assert.match(err.text, /health/)
    }
  })
})

describe('khám', () => {
  test('có mục đỏ ⇒ exit 1, in đỏ/vàng/việc nên làm, ghi HEALTH.md và mốc khám', async () => {
    const fx = app({ 'src/a.js': '// TODO\n' })
    const r = await go(fx, [], [
      res('osv-scanner', 'fail', { title: 'Lỗ hổng thư viện', message: '2 lỗ hổng' }),
      res('jscpd', 'fail', { title: 'Code trùng lặp', message: 'trùng 9%' }),
      res('knip', 'pass', { message: 'sạch' }),
      res('depcruise', 'missing', { message: 'Chưa cài depcruise', fix: 'npm i -D dependency-cruiser' }),
    ])
    assert.equal(r.code, 1)
    assert.match(r.out, /^Khám xong: đỏ 1 · vàng 1 · xanh 4 · chưa kiểm được 1\./)
    assert.match(r.out, /So với lần trước: lần khám đầu tiên\./)
    assert.match(r.out, /\nĐỎ — Lỗ hổng thư viện: 2 lỗ hổng\n/)
    assert.match(r.out, /\nVÀNG — Code trùng lặp: trùng 9%\n/)
    assert.match(r.out, /\nChưa kiểm được: depcruise \(npm i -D dependency-cruiser\)\n/)
    assert.match(r.out, /Việc nên làm:\n {2}1\. Nâng thư viện có lỗ hổng/)
    assert.match(r.out, /Đã ghi docs\/HEALTH\.md\./)
    assert.match(r.err, /Đang khám/)
    assert.match(fs.readFileSync(path.join(fx.dir, 'docs', 'HEALTH.md'), 'utf8'), /Khám ngày 2026-10-13 · đỏ 1 · vàng 1/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.dir, '.claude', 'release.json'), 'utf8')).health.lastAt, NOW.toISOString())
  })

  test('chỉ có vàng và chưa kiểm được ⇒ exit 0 (thiếu công cụ không làm đỏ)', async () => {
    const fx = app({ 'package.json': '{}' })
    const r = await go(fx, [], [res('jscpd', 'fail', { message: 'trùng' })])
    assert.equal(r.code, 0)
    assert.match(r.out, /chưa kiểm được: npm-check-updates \(npm i -g npm-check-updates\)/i)
  })

  test('khám lần hai ⇒ nói tốt lên so với lần một', async () => {
    const fx = app({ 'src/a.js': 'x\n' })
    await go(fx, [], [res('jscpd', 'fail', { message: 'trùng' })])
    const r = await go(fx, [], [res('jscpd', 'pass')])
    assert.match(r.out, /So với lần trước \(2026-10-13\): tốt lên\./)
  })

  test('--no-write ⇒ chỉ in, không tạo docs/ hay .claude/', async () => {
    const fx = app({ 'src/a.js': 'x\n' })
    const r = await go(fx, ['--no-write'], [res('jscpd', 'pass')])
    assert.equal(r.code, 0)
    assert.match(r.out, /\(--no-write: chưa ghi file nào\)/)
    assert.deepEqual(fs.readdirSync(fx.dir).sort(), ['src'])
  })

  test('release.json đang hỏng ⇒ nói rõ không ghi đè mốc khám, HEALTH.md vẫn có', async () => {
    const fx = app({ 'src/a.js': 'x\n', '.claude/release.json': '{ hỏng' })
    const r = await go(fx, [], [])
    assert.match(r.out, /Chưa ghi được mốc khám: \.claude\/release\.json đang hỏng/)
    assert.ok(fs.existsSync(path.join(fx.dir, 'docs', 'HEALTH.md')))
    assert.equal(fs.readFileSync(path.join(fx.dir, '.claude', 'release.json'), 'utf8'), '{ hỏng')
  })
})

describe('chạy tiến trình thật', () => {
  const env = { ...process.env, HOME: os.tmpdir(), USERPROFILE: os.tmpdir() }

  test('node health.mjs <dự án mẫu> --no-write: flow-check con + findTool thật chạy được, đếm nợ kỹ thuật, exit 0', () => {
    const fx = app({ 'src/a.js': '// TODO: x\n' })
    const r = spawnSync(process.execPath, [SCRIPT, fx.dir, '--no-write'], { encoding: 'utf8', env, timeout: 120000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /^Khám xong: đỏ 0 · vàng 0 · xanh 3\./)
    assert.deepEqual(fs.readdirSync(fx.dir).sort(), ['src'])
  })

  test('node health.mjs <thư mục không có> ⇒ exit 3', () => {
    const r = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'khong-co-thu-muc-nay-health')], { encoding: 'utf8', env, timeout: 30000 })
    assert.equal(r.status, 3)
    assert.match(r.stderr, /không thấy thư mục app/)
  })
})

// Test cho lib/log-scan.mjs: node --test hooks/lib/log-scan.test.mjs
// Mọi secret giả ghép lúc chạy (nối chuỗi) để chính file này không chứa token nguyên văn — tránh tự bị cổng quét secret chặn khi commit.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOG_DIRS, findLogs, scanLogs } from './log-scan.mjs'

const GHP = 'ghp_' + 'a'.repeat(36)
const STRIPE = 'sk_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => [b64u({ alg: 'HS256', typ: 'JWT' }), b64u(payload), 'x'.repeat(43)].join('.')

const made = []
// Thư mục tạm có dấu cách + tiếng Việt: bắt lỗi quote đường dẫn.
function project(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'log scan dự án '))
  made.push(d)
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(d, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return d
}
// rmSync của Node trên Windows lặng lẽ không xoá đường dẫn có chữ có dấu: xoá từng file/thư mục.
function rmTree(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) rmTree(path.join(p, n))
    try { fs.rmdirSync(p) } catch { /* còn tiến trình giữ thư mục thì thôi */ }
  } else {
    try { fs.unlinkSync(p) } catch { /* như trên */ }
  }
}
after(() => { for (const d of made) rmTree(d) })

const brief = (r) => r.findings.map((f) => `${f.file}:${f.line}:${f.name}`).sort()

describe('findLogs', () => {
  test('thấy test-results/ và playwright-report/ (kể cả lồng như frontend/ của Wails) và mọi file *.log, kể cả .wrangler/logs; bỏ node_modules, .git, thư mục build', () => {
    const d = project({
      'test-results/a/error-context.md': 'x',
      'test-results/a/sau hơn/b.txt': 'x',
      'playwright-report/index.html': 'x',
      'frontend/test-results/c.txt': 'x',
      '.wrangler/logs/wrangler-1.log': 'x',
      'e2e/server.log': 'x',
      'npm-debug.LOG': 'x',
      'src/a.ts': 'x',
      'readme.md': 'x',
      'node_modules/p/test-results/n.txt': 'x',
      'node_modules/p/x.log': 'x',
      '.git/hooks/y.log': 'x',
      'dist/build.log': 'x',
    })
    const r = findLogs(d)
    assert.deepEqual(r.files, [
      '.wrangler/logs/wrangler-1.log', 'e2e/server.log', 'frontend/test-results/c.txt', 'npm-debug.LOG',
      'playwright-report/index.html', 'test-results/a/error-context.md', 'test-results/a/sau hơn/b.txt',
    ])
    assert.deepEqual(r.sources, ['frontend/test-results/', 'playwright-report/', 'test-results/', '3 file *.log'])
    assert.equal(r.truncated, false)
    assert.deepEqual(LOG_DIRS, ['test-results', 'playwright-report'])
  })

  test('không có log nào ⇒ rỗng; vượt maxFiles ⇒ truncated (không im lặng cắt)', () => {
    assert.deepEqual(findLogs(project({ 'src/a.ts': 'x' })), { files: [], sources: [], truncated: false })
    const d = project({ 'test-results/1.txt': 'x', 'test-results/2.txt': 'x', 'test-results/3.txt': 'x' })
    const r = findLogs(d, { maxFiles: 2 })
    assert.equal(r.files.length, 2)
    assert.equal(r.truncated, true)
  })

  test('maxDepth: log nằm sâu hơn giới hạn không được tìm (dir ngoài cùng là độ sâu 0)', () => {
    const d = project({ 'a/b/c/d/e/deep.log': 'x', 'a/shallow.log': 'x' })
    assert.deepEqual(findLogs(d, { maxDepth: 2 }).files, ['a/shallow.log'])
  })
})

describe('scanLogs', () => {
  test('log sạch ⇒ không có phát hiện, đếm đúng số file', () => {
    const d = project({ 'test-results/a.txt': 'GET / 200\n', 'e2e/server.log': 'listening on 5173\n' })
    const r = scanLogs(d)
    assert.deepEqual(r.findings, [])
    assert.equal(r.files, 2)
  })

  test('log có khoá ⇒ thấy đúng file:dòng:tên mẫu; value đã che (không lộ giá trị)', () => {
    const d = project({
      'test-results/run/stdout.txt': `bắt đầu\nlogin ok token=${GHP}\n`,
      'playwright-report/index.html': `<pre>${STRIPE}</pre>`,
      'e2e/server.log': `ok\nok\n${jwt({ role: 'authenticated', sub: 'u1' })}\n`,
    })
    const r = scanLogs(d)
    assert.deepEqual(brief(r), ['e2e/server.log:3:jwt', 'playwright-report/index.html:1:stripe', 'test-results/run/stdout.txt:2:github'])
    assert.ok(!JSON.stringify(r).includes(GHP.slice(0, 8)))
    assert.ok(r.findings.every((f) => /^.{4}…$/.test(f.value)))
  })

  test('khoá công khai (JWT role anon) không bị báo; JWT service_role có tên riêng', () => {
    const d = project({ 'a.log': `anon=${jwt({ role: 'anon' })}\n`, 'b.log': `svc=${jwt({ role: 'service_role' })}\n` })
    assert.deepEqual(brief(scanLogs(d)), ['b.log:1:jwt-service-role'])
  })

  test('log UTF-16 (PowerShell ghi `> out.log`) vẫn bắt được khoá', () => {
    const d = project({})
    fs.writeFileSync(path.join(d, 'out.log'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`k = "${GHP}"\n`, 'utf16le')]))
    assert.deepEqual(brief(scanLogs(d)), ['out.log:1:github'])
  })

  test('file log quá lớn / vượt maxFiles KHÔNG bị coi là sạch', () => {
    const d = project({ 'big.log': 'a'.repeat(5000), 'test-results/1.txt': 'x', 'test-results/2.txt': 'x' })
    const big = scanLogs(d, { maxFileBytes: 1000 })
    assert.deepEqual(big.findings.map((f) => [f.file, f.line]), [['big.log', null]])
    assert.match(big.findings[0].name, /quá lớn/)
    const many = scanLogs(d, { maxFiles: 2 })
    assert.ok(many.findings.some((f) => f.file === '.' && /quá 2 file log/.test(f.name)))
  })

  test('file nhị phân trong test-results (ảnh, zip trace) bỏ qua, không làm đỏ giả', () => {
    const d = project({})
    fs.mkdirSync(path.join(d, 'test-results'), { recursive: true })
    fs.writeFileSync(path.join(d, 'test-results', 'screenshot.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]), Buffer.from(GHP)]))
    fs.writeFileSync(path.join(d, 'test-results', 'trace.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4, 0]), Buffer.from(GHP)]))
    const r = scanLogs(d)
    assert.equal(r.files, 2)
    assert.deepEqual(r.findings, [])
  })

  test('không có log nào ⇒ files = 0 (người gọi coi là "không áp dụng", không phải đạt)', () => {
    assert.deepEqual(scanLogs(project({ 'src/a.ts': `const k="${GHP}"` })), { files: 0, sources: [], findings: [] })
  })
})

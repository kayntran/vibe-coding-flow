// Test cho CLI solutions.mjs: node --test ~/.claude/hooks/solutions.test.mjs
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'solutions.mjs')
const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'solutions-cli-'))); roots.push(d); return d }
const cli = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input })
const bai = (o = {}) => JSON.stringify({
  dang_loi: 'Quên đổi .env.example', tom_tat: 'Thêm biến mà không cập nhật .env.example', tags: ['env'],
  vi_sao_khong_suy_ra: 'Chỉ lộ khi người khác clone repo', cach_tranh: 'Thêm cả vào .env.example', ...o,
})
const files = (root) => fs.readdirSync(path.join(root, 'docs', 'solutions')).filter((n) => n !== 'INDEX.md')

describe('ghi', () => {
  test('JSON từ stdin ⇒ tạo file, exit 0', () => {
    const root = tmp()
    const r = cli(['ghi', root, '-'], bai())
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /docs\/solutions\/\d{4}-\d{2}-\d{2}-quen-doi-env-example\.md/)
    assert.equal(files(root).length, 1)
  })
  test('thiếu hoặc rỗng vi_sao_khong_suy_ra ⇒ exit 1, một câu đời thường, không tạo file', () => {
    const root = tmp()
    for (const v of ['', '  ']) {
      const r = cli(['ghi', root, '-'], bai({ vi_sao_khong_suy_ra: v }))
      assert.equal(r.status, 1)
      assert.match(r.stderr, /điều này đọc code là biết, không cần ghi/)
      assert.equal(r.stderr.trim().split('\n').length, 1)
    }
    const r = cli(['ghi', root, '-'], JSON.stringify({ dang_loi: 'x', tom_tat: 'y' }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /đọc code là biết/)
    assert.equal(fs.existsSync(path.join(root, 'docs', 'solutions')), false)
  })
  test('stdin trống hoặc không phải JSON ⇒ exit 1', () => {
    const root = tmp()
    assert.equal(cli(['ghi', root, '-'], '').status, 1)
    assert.equal(cli(['ghi', root, '-'], 'không phải json').status, 1)
  })
})

describe('gap', () => {
  test('lần 1 (ghi) → gap: lan 2 và in thang đề xuất, exit 0', () => {
    const root = tmp()
    cli(['ghi', root, '-'], bai())
    const r = cli(['gap', root, 'quen-doi-env-example'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /2 lần/)
    for (const k of ['luật có sẵn', 'no-restricted-*/depguard', 'ast-grep', 'test', 'hook', 'lời dặn']) assert.ok(r.stdout.includes(k), k)
  })
  test('đã có máy kiểm ⇒ không in thang', () => {
    const root = tmp()
    cli(['ghi', root, '-'], bai({ may_kiem: 'lint' }))
    const r = cli(['gap', root, 'quen-doi-env-example'])
    assert.equal(r.status, 0)
    assert.doesNotMatch(r.stdout, /ast-grep/)
  })
  test('không có bài học / thiếu tham số ⇒ exit 1', () => {
    const root = tmp()
    assert.equal(cli(['gap', root, 'khong-co']).status, 1)
    assert.equal(cli(['gap', root]).status, 1)
  })
})

describe('ra-soat', () => {
  test('bài học cũ hơn --days được liệt kê', () => {
    const root = tmp()
    cli(['ghi', root, '-'], bai({ ngay: '2026-01-01' }))
    const r = cli(['ra-soat', root])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /quen-doi-env-example/)
    assert.match(cli(['ra-soat', root, '--days', '99999']).stdout, /Không có bài học nào quá hạn/)
  })
  test('--days sai ⇒ exit 1', () => {
    assert.equal(cli(['ra-soat', tmp(), '--days', 'abc']).status, 1)
    assert.equal(cli(['ra-soat', tmp(), '--days']).status, 1)
  })
})

describe('index + dùng sai', () => {
  test('index sinh INDEX.md; lệnh lạ / thiếu root ⇒ exit 1', () => {
    const root = tmp()
    cli(['ghi', root, '-'], bai())
    const r = cli(['index', root])
    assert.equal(r.status, 0, r.stderr)
    assert.match(fs.readFileSync(path.join(root, 'docs', 'solutions', 'INDEX.md'), 'utf8'), /tự sinh bởi solutions\.mjs/)
    assert.equal(cli(['la', root]).status, 1)
    assert.equal(cli(['index']).status, 1)
  })
})

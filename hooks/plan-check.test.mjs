import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPlan, parseTasks, specCodes } from './plan-check.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-check.mjs')
const task = (mark, id, code, files, verify = '`pnpm test` → 3 test đạt') => `- [${mark}] ${id} việc (phủ ${code})\n  Files: ${files}\n  Verify: ${verify}\n`
const codes = (r) => r.findings.map((f) => f.code)

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-check-'))
  const g = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
  g('add', '.'); g('commit', '-qm', 'a'); g('checkout', '-qb', 'viec')
  return { dir, g }
}

test('specCodes bỏ mục Để sau và khối code, nhận cả AC, S, P', () => {
  const c = specCodes('## Làm được gì\n- AC-01 x\n| S-02 | a |\n- P-03: b\n### Để sau\n- AC-09\n## Kỹ thuật\n- AC-04\n```\nAC-77\n```\n')
  assert.deepEqual([...c].sort(), ['AC-01', 'AC-04', 'P-03', 'S-02'])
})

test('parseTasks đọc tick, Files, mã ở dòng thụt; bỏ danh sách thường', () => {
  const t = parseTasks('- [ ] không phải task\n- [x] T1 làm (phủ AC-01)\n  Files: `a/b.ts:12`, c.ts (mới)\n  Verify: `x` → y\n  Phủ thêm AC-02\n\n- [ ] T2 khác\n')
  assert.equal(t.length, 2)
  assert.equal(t[0].done, true)
  assert.deepEqual(t[0].files.map((f) => [f.path, f.isNew]), [['a/b.ts', false], ['c.ts', true]])
  assert.deepEqual([...t[0].codes].sort(), ['AC-01', 'AC-02'])
  assert.equal(t[1].verify, '')
})

test('yêu cầu chưa có task và mã lạ đều bị báo', () => {
  const { dir } = repo({ 'a.ts': '1' })
  const r = checkPlan({ planText: task(' ', 'T1', 'AC-01, AC-09', 'a.ts'), specText: '- AC-01\n- AC-02\n', repo: dir })
  assert.deepEqual(codes(r).sort(), ['ma-la', 'thieu-task'])
})

test('file không có thật bị báo; file mới chưa tick thì không; glob được bỏ qua', () => {
  const { dir } = repo({ 'a.ts': '1' })
  assert.deepEqual(codes(checkPlan({ planText: task(' ', 'T1', 'AC-01', 'khong-co.ts'), specText: '- AC-01', repo: dir })), ['file-khong-co'])
  assert.deepEqual(codes(checkPlan({ planText: task(' ', 'T1', 'AC-01', 'moi.ts (mới), src/**'), specText: '- AC-01', repo: dir })), [])
})

test('Verify phải có lệnh và kết quả mong đợi; thiếu Files bị báo', () => {
  const { dir } = repo({ 'a.ts': '1' })
  assert.deepEqual(codes(checkPlan({ planText: task(' ', 'T1', 'AC-01', 'a.ts', 'kiểm tra lại cho chắc'), specText: '- AC-01', repo: dir })), ['thieu-verify'])
  assert.deepEqual(codes(checkPlan({ planText: '- [ ] T1 việc (phủ AC-01)\n  Verify: `x` → y\n', specText: '- AC-01', repo: dir })), ['thieu-files'])
})

test('ô tick đối chiếu thay đổi trên nhánh, kể cả phần chưa commit', () => {
  const { dir, g } = repo({ 'a.ts': '1', 'b.ts': '1' })
  const plan = task('x', 'T1', 'AC-01', 'a.ts')
  assert.ok(checkPlan({ planText: plan, specText: '- AC-01', repo: dir }).notes.some((n) => /chưa có thay đổi/.test(n)), 'nhánh chưa đổi gì thì chỉ ghi chú')
  fs.writeFileSync(path.join(dir, 'b.ts'), '2')
  assert.deepEqual(codes(checkPlan({ planText: plan, specText: '- AC-01', repo: dir })), ['tick-chua-doi'])
  fs.writeFileSync(path.join(dir, 'a.ts'), '2')
  assert.deepEqual(codes(checkPlan({ planText: plan, specText: '- AC-01', repo: dir })), [])
  g('add', '.'); g('commit', '-qm', 'b')
  assert.deepEqual(codes(checkPlan({ planText: plan, specText: '- AC-01', repo: dir })), [])
})

test('sửa rồi hoàn tác thì không tính là đã đổi', () => {
  const { dir, g } = repo({ 'a.ts': '1', 'b.ts': '1' })
  fs.writeFileSync(path.join(dir, 'a.ts'), '2')
  g('add', '.'); g('commit', '-qm', 'b')
  fs.writeFileSync(path.join(dir, 'a.ts'), '1')
  fs.writeFileSync(path.join(dir, 'b.ts'), '2')
  assert.deepEqual(codes(checkPlan({ planText: task('x', 'T1', 'AC-01', 'a.ts'), specText: '- AC-01', repo: dir })), ['tick-chua-doi'])
})

test('file sẽ xoá hoặc đổi tên: chưa tick thì không báo, đã tick mà còn file thì báo, đã xoá thì đạt', () => {
  const { dir } = repo({ 'a.ts': '1' })
  const of = (mark) => codes(checkPlan({ planText: task(mark, 'T1', 'AC-01', 'a.ts (xoá), khac.ts (đổi tên)'), specText: '- AC-01', repo: dir }))
  assert.deepEqual(of(' '), [])
  assert.ok(of('x').includes('chua-xoa'))
  fs.unlinkSync(path.join(dir, 'a.ts'))
  assert.deepEqual(of('x'), [])
})

test('mã nằm trên tiêu đề vẫn được tính', () => {
  assert.deepEqual([...specCodes('### AC-01 Đăng nhập\n### Để sau AC-02\n')], ['AC-01'])
})

test('dòng trống giữa các phần không làm mất Files, Verify', () => {
  const t = parseTasks('- [ ] T1 việc\n\n  Files: a.ts\n\n  Verify: `x` → y\nChữ ngoài\n  Files: b.ts\n')
  assert.deepEqual(t[0].files.map((f) => f.path), ['a.ts'])
  assert.equal(t[0].verify, '`x` → y')
})

test('--done đòi mọi ô đã tick', () => {
  const { dir } = repo({ 'a.ts': '1' })
  assert.deepEqual(codes(checkPlan({ planText: task(' ', 'T1', 'AC-01', 'a.ts'), specText: '- AC-01', repo: dir, done: true })), ['chua-tick'])
})

test('plan cũ không có task và SPEC thiếu mã chỉ ghi chú, không báo lỗi', () => {
  assert.deepEqual(codes(checkPlan({ planText: '# Plan\n- làm a\n', specText: '- AC-01', repo: null })), [])
  const { dir } = repo({ 'a.ts': '1' })
  const r = checkPlan({ planText: task(' ', 'T1', 'AC-01', 'a.ts'), specText: 'chưa có mã', repo: dir })
  assert.ok(r.notes.some((n) => /chưa đánh mã/.test(n)))
  assert.deepEqual(codes(r).filter((c) => c === 'thieu-task'), [])
})

test('CLI: 0 sạch, 1 có phát hiện, 2 không chạy được; không chạy lệnh trong Verify', () => {
  const { dir } = repo({ 'a.ts': '1' })
  const canary = path.join(dir, 'da-chay.txt')
  const planDir = path.join(dir, 'docs')
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, 'SPEC.md'), '- AC-01\n')
  const plan = path.join(planDir, 'PLAN.md')
  fs.writeFileSync(plan, task(' ', 'T1', 'AC-01', 'a.ts', `\`node -e "require('fs').writeFileSync('${canary.replace(/\\/g, '/')}','x')"\` → xong`))
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' })
  assert.equal(run(plan).status, 0)
  assert.ok(!fs.existsSync(canary))
  fs.writeFileSync(path.join(planDir, 'SPEC.md'), '- AC-01\n- AC-02\n')
  const bad = run(plan)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /AC-02/)
  assert.equal(run(path.join(dir, 'khong-co.md')).status, 2)
  assert.equal(run().status, 2)
})

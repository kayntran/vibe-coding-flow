import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { plan } from './codex-run.mjs'

test('codex-run: -C thành thư mục chạy, -o ghi qua file tạm, prompt có dấu cách chuyển sang stdin', () => {
  const p = plan(['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '-C', 'D:/AI/Vibe Coding/app', '-o', 'D:/AI/Vibe Coding/out/r.md', 'Tìm lỗi ở đây'],
    { cwd: 'D:/w', tmp: os.tmpdir() })
  assert.equal(p.cwd, path.resolve('D:/AI/Vibe Coding/app'))
  assert.equal(p.outFile, path.resolve('D:/AI/Vibe Coding/out/r.md'))
  assert.match(p.tmpOut, /\/codex-run-[^/]+\/out\.md$/)
  assert.ok(fs.statSync(path.dirname(p.tmpOut)).isDirectory(), 'thư mục tạm riêng đã được tạo độc quyền')
  assert.ok(!p.tmpOut.includes(' '), 'đường dẫn tạm an toàn cho cmd.exe')
  fs.rmSync(path.dirname(p.tmpOut), { recursive: true, force: true })
  assert.deepEqual(p.args, ['exec', '--sandbox', 'read-only', '-m', 'gpt-x', '-o', p.tmpOut, '-'])
  assert.equal(p.prompt, 'Tìm lỗi ở đây')
})

test('codex-run: thư mục Temp có dấu cách/chữ có dấu ⇒ file -o tạm nằm trong thư mục chạy, truyền đường dẫn tương đối an toàn', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'))
  const p = plan(['exec', '-o', 'r.md', '-C', run, '-'], { cwd: run, tmp: 'C:\\Users\\Nguyễn Văn\\Temp' })
  assert.match(p.tmpOut, /^\.codex-run-[^/]+\/out\.md$/)
  assert.equal(path.dirname(p.tmpDir), path.resolve(run))
  assert.deepEqual(p.args, ['exec', '-o', p.tmpOut, '-'])
  fs.rmSync(run, { recursive: true, force: true })
})

test('codex-run: prompt đã qua stdin ("-") giữ nguyên, đối số an toàn không đổi', () => {
  const p = plan(['exec', '-c', 'model_reasoning_effort=high', '-'], { cwd: 'D:/w', stdinPrompt: 'đề' })
  assert.deepEqual(p.args, ['exec', '-c', 'model_reasoning_effort=high', '-'])
  assert.equal(p.prompt, 'đề')
  assert.equal(p.cwd, 'D:/w')
})

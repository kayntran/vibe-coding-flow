// Test đối chiếu máy ảo Devin (SPEC docs/specs/2026-10-31-may-ao-devin, AC-16): mọi nơi tự mở app / chạy test có mở app
// phải hỏi `devin-vm.mjs where` (hoặc trỏ skill flow-devin) thay vì tự quyết chạy trên máy user. Thêm nơi tiêu thụ mới ⇒ thêm
// vào CONSUMERS; cố ý không áp dụng ⇒ thêm vào NOT_APPLICABLE kèm lý do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const CONSUMERS = {
  'skills/flow-qa/SKILL.md': ['devin-vm.mjs where', 'flow-devin'],
  'agents/qa-tester.md': ['devin-vm.mjs where', 'flow-devin', 'devin-vm.mjs sleep'],
  'agents/debugger.md': ['devin-vm.mjs where', 'flow-devin'],
  'skills/flow-merge/SKILL.md': ['mac-check.mjs', 'flow-devin'],
  'CLAUDE.md': ['flow-devin'],
}

// Nơi có nhắc Playwright/mở app nhưng cố ý không đi qua máy ảo.
const NOT_APPLICABLE = {
  'hooks/ui-check.mjs': 'chạy ở máy user, trỏ vào app (trên máy ảo thì qua cổng forward)',
  'skills/flow-publish/SKILL.md': 'thử nhanh trên địa chỉ thật sau phát hành, không mở app trên máy',
  'skills/flow-team/SKILL.md': 'chỉ cấp port; port là cổng forward khi chạy máy ảo',
}

test('mỗi nơi tiêu thụ nhắc đúng các cụm của máy ảo Devin', () => {
  for (const [rel, musts] of Object.entries(CONSUMERS)) {
    const text = read(rel)
    for (const must of musts) assert.ok(text.includes(must), `${rel} thiếu "${must}" — nơi mở app phải hỏi devin-vm.mjs where (skill flow-devin)`)
  }
})

test('skill flow-devin có đủ các bước bắt buộc', () => {
  const text = read('skills/flow-devin/SKILL.md')
  for (const must of ['devin-vm.mjs where', 'job', 'sync', 'sleep', 'gui', 'forward', '--env', 'Nơi chạy:', 'real-audio', 'DEVIN_VM=off'])
    assert.ok(text.includes(must), `skills/flow-devin/SKILL.md thiếu "${must}"`)
})

test('agent nào tự chạy app/Playwright thì phải nằm trong CONSUMERS hoặc NOT_APPLICABLE', () => {
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `agents/${f}`)
  for (const rel of agents) {
    if (!/tự chạy app|chạy app|Playwright/i.test(read(rel))) continue
    assert.ok(rel in CONSUMERS || rel in NOT_APPLICABLE, `${rel} mở app nhưng chưa đi qua máy ảo Devin — thêm vào CONSUMERS (và sửa file) hoặc NOT_APPLICABLE kèm lý do`)
  }
})

test('mục NOT_APPLICABLE trỏ tới file có thật', () => {
  for (const rel of Object.keys(NOT_APPLICABLE)) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} không còn — gỡ khỏi NOT_APPLICABLE`)
})

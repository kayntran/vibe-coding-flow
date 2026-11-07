// Kiểm cấu trúc bộ skill flow: khai báo đúng, không vượt ngưỡng tài liệu, không trỏ tới skill không tồn tại.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'skills')
const names = fs.readdirSync(DIR).filter((n) => n.startsWith('flow-') && fs.existsSync(path.join(DIR, n, 'SKILL.md')))
const read = (n) => fs.readFileSync(path.join(DIR, n, 'SKILL.md'), 'utf8')
const FLOWS = ['flow-feature', 'flow-bugfix', 'flow-release', 'flow-health']
const INTERNAL = ['flow-team', 'flow-sessions', 'flow-devin']

test('đủ bộ skill đã chốt, flow-production đã tách', () => {
  for (const n of [...FLOWS, 'flow-new-app', 'flow-spec', 'flow-ux', 'flow-ui-demo', 'flow-ui-design', 'flow-plan', 'flow-build', 'flow-fix', 'flow-qa', 'flow-review', 'flow-security', 'flow-merge', 'flow-worktree', 'flow-impact', 'flow-architecture', 'flow-explain', 'flow-status', 'flow-publish', 'flow-rollback', 'flow-backup', 'flow-key-leak', 'flow-maintain', 'flow-scale', ...INTERNAL]) {
    assert.ok(names.includes(n), `thiếu ${n}`)
  }
  assert.ok(!names.includes('flow-production'))
})

test('mỗi skill khai đúng tên, có khi dùng và khi không dùng, không quá dài', () => {
  for (const n of names) {
    const t = read(n)
    assert.match(t, new RegExp(`^name: ${n}$`, 'm'), n)
    const d = t.match(/^description: (.+)$/m)?.[1] ?? ''
    assert.match(d, /Dùng khi/, `${n}: mô tả thiếu "Dùng khi"`)
    assert.match(d, /KHÔNG/, `${n}: mô tả thiếu "KHÔNG"`)
    assert.ok(t.split('\n').length < 500, `${n}: thân quá 500 dòng`)
    if (!/^["']/.test(d)) assert.doesNotMatch(d, /: /, `${n}: mô tả có ": " chưa đặt trong ngoặc, hỏng YAML`)
  }
})

test('skill nội bộ không hiện trong menu', () => {
  for (const n of INTERNAL) assert.match(read(n), /^user-invocable: false$/m, n)
})

test('không skill nào trỏ tới skill flow không tồn tại', () => {
  for (const n of names) {
    for (const [, ref] of read(n).matchAll(/`(flow-[a-z-]+)`/g)) {
      if (['flow-check', 'flow-gate', 'flow-dispatch'].includes(ref)) continue
      assert.ok(names.includes(ref), `${n} trỏ tới ${ref}`)
    }
  }
})

test('skill luồng chỉ ghi thứ tự: ngắn, có cột xử lý', () => {
  for (const n of FLOWS) {
    const t = read(n)
    assert.ok(t.split('\n').length <= 45, `${n} quá dài`)
    assert.match(t, /\| Bước \| Skill \|/, n)
  }
  for (const n of ['flow-feature', 'flow-bugfix', 'flow-release']) assert.match(read(n), /Hỏng thì/, n)
})

test('bài đo chọn skill chỉ nhắm tới skill có thật', () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/evals/skill-routing.json'), 'utf8'))
  for (const c of cases) if (c.want !== 'none') assert.ok(names.includes(c.want), c.want)
})

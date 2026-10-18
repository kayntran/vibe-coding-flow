// Giữ điểm vào CLAUDE.md ngắn và đủ cụm bắt buộc (AC-10; học repository-harness: trần byte + cụm phải có mặt).
// Bản cho Codex sinh từ chính file này nên cũng phải dưới trần 24 KiB của hostgen (kiểm ở hostgen.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')

test('CLAUDE.md ngắn: ≤ 110 dòng, ≤ 12 KiB', () => {
  const lines = text.split(/\r?\n/).length
  const bytes = Buffer.byteLength(text, 'utf8')
  assert.ok(lines <= 110, `${lines} dòng — chuyển chi tiết sang skill, giữ điểm vào ngắn`)
  assert.ok(bytes <= 12 * 1024, `${bytes} byte`)
})

test('CLAUDE.md có đủ cụm bắt buộc', () => {
  for (const must of [
    'tiếng Việt', '## Cách trao đổi', '## Phong cách UI', '## Nguyên tắc', '**Định tuyến**',
    'flow-spec', 'flow-impact', 'flow-qa', 'flow-review', 'flow-merge', 'flow-team', 'flow-worktree', 'flow-architecture',
    'flow-production', 'flow-maintain', 'flow-scale', 'flow-sessions',
    'sổ chốt', 'models.mjs', 'cli-check.mjs', 'updates.mjs', 'bản xem', 'không lách',
  ]) assert.ok(text.includes(must), `thiếu "${must}"`)
})

test('CLAUDE.md không ghi cứng số phiên bản model (dùng tên dòng + models.mjs)', () => {
  assert.doesNotMatch(text, /gpt-\d|claude-(opus|sonnet|haiku)-\d|gemini-\d/i)
})

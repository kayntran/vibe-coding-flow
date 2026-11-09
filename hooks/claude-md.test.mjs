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
    'flow-feature', 'flow-bugfix', 'flow-release', 'flow-health', 'flow-publish', 'flow-maintain', 'flow-scale', 'flow-system-design', 'flow-sessions', 'flow-devin',
    'sổ chốt', 'models.mjs', 'cli-check.mjs', 'updates.mjs', 'bản xem', 'không lách',
  ]) assert.ok(text.includes(must), `thiếu "${must}"`)
})

test('luật phong cách UI tách ra rules/ui-style.md, nạp theo file giao diện, CLAUDE.md trỏ tới', () => {
  const rule = fs.readFileSync(path.join(ROOT, 'rules', 'ui-style.md'), 'utf8').replaceAll('\r\n', '\n')
  assert.match(rule, /^---\npaths:\n(?: {2}- ".+"\n)+---\n/)
  assert.match(rule, /\*\*\/\*\.\{tsx,jsx,vue,svelte/)
  for (const must of ['Mỗi màn hình một việc chính', 'Nhãn 1–3 chữ', 'Bắt buộc có chữ rõ', 'màn hình trống', 'Phản hồi bằng trạng thái', 'Lỗi một dòng'])
    assert.ok(rule.includes(must), must)
  assert.ok(text.includes('~/.claude/rules/ui-style.md'))
  assert.ok(text.includes('bắt buộc có chữ rõ'))
})

test('khối AGENTS cho Codex từ CLAUDE.md + rules/ thật vẫn dưới trần 24 KiB và có luật UI', async () => {
  const { codexAgentsBlock } = await import('./lib/hostgen.mjs')
  const dir = path.join(ROOT, 'rules')
  const rules = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
  const block = codexAgentsBlock(text, rules)
  assert.ok(block.includes('Mỗi màn hình một việc chính'))
})

test('CLAUDE.md không ghi cứng số phiên bản model (dùng tên dòng + models.mjs)', () => {
  assert.doesNotMatch(text, /gpt-\d|claude-(opus|sonnet|haiku)-\d|gemini-\d/i)
})

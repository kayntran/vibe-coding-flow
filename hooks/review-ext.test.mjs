// Test cho review-ext.mjs (phần thuần, không gọi model): node --test ~/.claude/hooks/review-ext.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReview, buildPrompt, parseArgs, GROK_ENV } from './review-ext.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-ext.mjs')
const R = { findings: [{ severity: 'MAJOR', summary: 's', path: 'a.js', line: 1, failure_scenario: 'f', fix: 'x' }], areas_checked: 'a' }

describe('extractReview', () => {
  test('lấy JSON nằm giữa chữ dẫn', () => {
    assert.deepEqual(extractReview(`Tôi sẽ đọc diff.\n${JSON.stringify(R)}\nXong.`), R)
  })
  test('JSON in hai lần liền nhau ⇒ lấy cái đầu', () => {
    assert.deepEqual(extractReview(JSON.stringify(R) + '\n' + JSON.stringify({ ...R, areas_checked: 'b' })), R)
  })
  test('bỏ qua object không có findings và ngoặc trong chuỗi', () => {
    const r2 = { findings: [], areas_checked: 'có } và { trong chuỗi "x"' }
    assert.deepEqual(extractReview(`{"a":1} rồi ${JSON.stringify(r2)}`), r2)
  })
  test('không có JSON ⇒ null', () => {
    assert.equal(extractReview('Tôi sẽ chỉ đọc luật dự án.'), null)
    assert.equal(extractReview('{"findings": [ hỏng'), null)
  })
})

describe('buildPrompt', () => {
  const p = { brief: 'BRIEF', schema: '{"s":1}', base: 'main', note: 'thêm X', diff: '+dòng mới' }
  test('diff nhỏ ⇒ dán thẳng, brief đứng đầu (cache được)', () => {
    const s = buildPrompt(p)
    assert.ok(s.startsWith('BRIEF'))
    assert.ok(s.includes('git diff main...HEAD') && s.includes('thêm X') && s.includes('{"s":1}') && s.endsWith('+dòng mới'))
  })
  test('có diffFile ⇒ trỏ file, không dán diff', () => {
    const s = buildPrompt({ ...p, diffFile: 'C:/x/r.diff' })
    assert.ok(s.includes('C:/x/r.diff') && !s.includes('+dòng mới'))
  })
})

test('GROK_ENV tắt đủ 5 nguồn của Claude và Cursor', () => {
  assert.equal(Object.keys(GROK_ENV).filter((k) => k.endsWith('_ENABLED')).length, 10)
  assert.equal(GROK_ENV.GIT_PAGER, 'cat')
  assert.equal(GROK_ENV.GROK_CLAUDE_MCPS_ENABLED, '0')
  assert.equal(GROK_ENV.GROK_CURSOR_HOOKS_ENABLED, '0')
})

test('parseArgs: mặc định + ghi đè', () => {
  const o = parseArgs(['--model', 'grok', '--wt', '.', '--out', 'o.json', '--timeout', '600'])
  assert.equal(o.brief, 'review-brief.md')
  assert.equal(o.base, 'main')
  assert.equal(o.timeout, 600)
})

test('CLI thiếu tham số ⇒ exit 1, không gọi model', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--model', 'gpt'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--model grok\|flash/)
})

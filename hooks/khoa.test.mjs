import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ds, lay, promptHook, stash, thay } from './khoa.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'khoa-'))
// Khoá giả ghép lúc chạy để file test không chứa chuỗi giống khoá thật.
const OPENAI = ['sk', 'proj', 'A'.repeat(20) + 'b1c2D3e4F5g6H7i8J9k0'].join('-')
const GH = 'ghp_' + 'Ab1'.repeat(13)

test('tin có khoá ⇒ chặn, cất vào kho theo tên gợi ý hoặc TÊN= trong tin, không lộ giá trị trong lời báo', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const out = promptHook({ prompt: `đây là key ${OPENAI}\nMY_GH=${GH}` }, { vault })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /OPENAI_API_KEY, MY_GH/)
  assert.ok(!out.reason.includes(OPENAI) && !out.reason.includes(GH))
  const v = fs.readFileSync(vault, 'utf8')
  assert.ok(v.includes(`OPENAI_API_KEY=${OPENAI}\n`) && v.includes(`MY_GH=${GH}\n`))
})

test('tin không có khoá ⇒ không làm gì; khoá trùng tên khác giá trị ⇒ thêm hậu tố, cùng giá trị ⇒ giữ tên', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  assert.equal(promptHook({ prompt: 'sửa nút Lưu giúp tôi' }, { vault }), null)
  assert.equal(fs.existsSync(vault), false)
  stash(OPENAI, { vault })
  assert.deepEqual(stash(OPENAI, { vault }).saved.map((s) => s.name), ['OPENAI_API_KEY'])
  const other = OPENAI.replace('b1c2', 'z9y8')
  assert.deepEqual(stash(other, { vault }).saved.map((s) => s.name), ['OPENAI_API_KEY_2'])
})

test('"key: sk-…" ⇒ tên gợi ý OPENAI_API_KEY (từ chung không thành tên biến); TÊN= ghi rõ ⇒ ghi đè đúng tên (đổi khoá)', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  assert.deepEqual(stash(`openai key: ${OPENAI}`, { vault }).saved.map((s) => s.name), ['OPENAI_API_KEY'])
  assert.deepEqual(stash(`token=${GH}`, { vault }).saved.map((s) => s.name), ['GITHUB_TOKEN'])
  const fresh = OPENAI.replace('b1c2', 'q7w8')
  assert.deepEqual(stash(`OPENAI_API_KEY=${fresh}`, { vault }).saved.map((s) => s.name), ['OPENAI_API_KEY'])
  assert.ok(fs.readFileSync(vault, 'utf8').includes(`OPENAI_API_KEY=${fresh}\n`))
  assert.deepEqual(stash(`TOKEN_2024=${GH}`, { vault }).saved.map((s) => s.name), ['TOKEN_2024'], 'tên có số giữ nguyên')
})

test('hai khoá cùng loại trên một dòng ⇒ cất đủ cả hai; khoá trùng tên gợi ý ⇒ _2 kèm lời báo cách thay khoá cũ', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const other = OPENAI.replace('b1c2', 'z9y8')
  const out = promptHook({ prompt: `dev ${OPENAI}, prod ${other}` }, { vault })
  assert.match(out.reason, /OPENAI_API_KEY, OPENAI_API_KEY_2/)
  assert.match(out.reason, /thay OPENAI_API_KEY bằng khoá mới/)
  const v = fs.readFileSync(vault, 'utf8')
  assert.ok(v.includes(OPENAI) && v.includes(other))
})

test('thay: khoá TÊN_2 thay cho TÊN; lay --as chép vào đúng tên app đọc', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const proj = path.join(d, 'app')
  fs.mkdirSync(proj)
  const other = OPENAI.replace('b1c2', 'z9y8')
  stash(`${OPENAI} ${other}`, { vault })
  lay('OPENAI_API_KEY_2', proj, { vault, as: 'OPENAI_API_KEY' })
  assert.equal(fs.readFileSync(path.join(proj, '.env'), 'utf8'), `OPENAI_API_KEY=${other}\n`)
  thay('OPENAI_API_KEY', 'OPENAI_API_KEY_2', { vault })
  assert.equal(fs.readFileSync(vault, 'utf8'), `OPENAI_API_KEY=${other}\n`)
})

test('lay vào thư mục con của monorepo ⇒ .env được thêm vào .gitignore ở gốc repo', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const root = path.join(d, 'mono')
  const web = path.join(root, 'apps', 'web')
  fs.mkdirSync(web, { recursive: true })
  spawnSync('git', ['init', '-q', root])
  stash(OPENAI, { vault })
  const msg = lay('OPENAI_API_KEY', web, { vault })
  assert.match(msg, /\/apps\/web\/\.env/)
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '/apps/web/.env\n')
  assert.doesNotMatch(lay('OPENAI_API_KEY', web, { vault }), /gitignore/, 'đã bị bỏ qua ⇒ không thêm lần hai')
})

test('lay vào .env đã nằm trong git ⇒ báo phải bỏ khỏi git, không nói là đã bảo vệ', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const root = path.join(d, 'r')
  fs.mkdirSync(root)
  spawnSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  spawnSync('git', ['-C', root, 'add', '.env'])
  stash(OPENAI, { vault })
  assert.match(lay('OPENAI_API_KEY', root, { vault }), /⚠ \.env đang nằm trong git/)
})

test('kho khoá chỉ chủ máy đọc được (0600), kể cả file có sẵn', { skip: process.platform === 'win32' }, () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  fs.writeFileSync(vault, 'CU=1\n', { mode: 0o644 })
  stash(OPENAI, { vault })
  assert.equal(fs.statSync(vault).mode & 0o777, 0o600)
})

test('lay chép khoá vào .env của dự án, thêm .gitignore khi là repo git; ds chỉ in tên', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const proj = path.join(d, 'app')
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  stash(OPENAI, { vault })
  const msg = lay('OPENAI_API_KEY', proj, { vault })
  assert.match(msg, /Đã thêm \.env vào \.gitignore/)
  assert.ok(fs.readFileSync(path.join(proj, '.env'), 'utf8').includes(`OPENAI_API_KEY=${OPENAI}`))
  assert.equal(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), '.env\n')
  const list = ds(proj, { vault })
  assert.match(list, /Kho chung: OPENAI_API_KEY/)
  assert.ok(!list.includes(OPENAI))
  assert.throws(() => lay('CHUA_CO', proj, { vault }), /chưa có CHUA_CO/)
  assert.throws(() => lay('a b', proj, { vault }), /không hợp lệ/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ds, lay, luu, promptHook, REMINDER, thay } from './khoa.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'khoa-'))
// Khoá giả ghép lúc chạy để file test không chứa chuỗi giống khoá thật.
const OPENAI = ['sk', 'proj', 'A'.repeat(20) + 'b1c2D3e4F5g6H7i8J9k0'].join('-')
const GH = 'ghp_' + 'Ab1'.repeat(13)

test('tin có khoá hoặc nhắc tới khoá ⇒ chỉ thêm lời nhắc không in khoá (không chặn, không cất, không chép chữ trong tin)', () => {
  for (const prompt of [`đây là key ${OPENAI}`, 'lưu giúp tôi API key OpenAI', 'mật khẩu database là gì?', `MY_GH=${GH}`]) {
    const out = promptHook({ prompt })
    assert.equal(out?.decision, undefined, prompt)
    assert.equal(out.hookSpecificOutput.additionalContext, REMINDER, prompt)
    assert.ok(!JSON.stringify(out).includes(OPENAI) && !JSON.stringify(out).includes(GH))
  }
  assert.equal(promptHook({ prompt: 'sửa nút Lưu giúp tôi' }), null)
  assert.equal(promptHook({}), null)
})

test('lời nhắc khoá: bắt DEEPSEEK_API_KEY=, CLIENT_SECRET=, "key: …", chữ tổ hợp NFD; bỏ qua chữ thường gặp', () => {
  for (const prompt of ['DEEPSEEK_API_KEY=9f8a7b6c5d4e3f2a1b', 'CLIENT_SECRET=abcd1234efgh5678', 'key: abc123def456ghi', 'mật khẩu'.normalize('NFD') + ' db là gì']) {
    assert.ok(promptHook({ prompt }), prompt)
  }
  for (const prompt of ['khoá nút Lưu khi đang gửi', 'mở khoá tài khoản user', 'giới hạn token của model', 'đọc file .env mẫu', 'token=abc']) {
    assert.equal(promptHook({ prompt }), null, prompt)
  }
})

test('luu: cất khoá vào kho, ghi đè tên cũ, giá trị rỗng/nhiều dòng hoặc tên sai bị từ chối, không in giá trị', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const msg = luu('OPENAI_API_KEY', `${OPENAI}\n`, { vault })
  assert.ok(!msg.includes(OPENAI))
  const fresh = OPENAI.replace('b1c2', 'q7w8')
  luu('OPENAI_API_KEY', fresh, { vault })
  assert.equal(fs.readFileSync(vault, 'utf8'), `OPENAI_API_KEY=${fresh}\n`)
  assert.throws(() => luu('OPENAI_API_KEY', '  ', { vault }), /rỗng/)
  assert.throws(() => luu('OPENAI_API_KEY', 'a\nb', { vault }), /nhiều dòng/)
  assert.throws(() => luu('a b', 'x', { vault }), /không hợp lệ/)
})

test('thay: khoá TÊN_2 thay cho TÊN; lay --as chép vào đúng tên app đọc', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const proj = path.join(d, 'app')
  fs.mkdirSync(proj)
  const other = OPENAI.replace('b1c2', 'z9y8')
  luu('OPENAI_API_KEY', OPENAI, { vault })
  luu('OPENAI_API_KEY_2', other, { vault })
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
  luu('OPENAI_API_KEY', OPENAI, { vault })
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
  luu('OPENAI_API_KEY', OPENAI, { vault })
  assert.match(lay('OPENAI_API_KEY', root, { vault }), /⚠ \.env đang nằm trong git/)
})

test('kho khoá chỉ chủ máy đọc được (0600), kể cả file có sẵn', { skip: process.platform === 'win32' }, () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  fs.writeFileSync(vault, 'CU=1\n', { mode: 0o644 })
  luu('OPENAI_API_KEY', OPENAI, { vault })
  assert.equal(fs.statSync(vault).mode & 0o777, 0o600)
})

test('lay chép khoá vào .env của dự án, thêm .gitignore khi là repo git; ds chỉ in tên', () => {
  const d = tmp()
  const vault = path.join(d, 'kho.env')
  const proj = path.join(d, 'app')
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  luu('OPENAI_API_KEY', OPENAI, { vault })
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

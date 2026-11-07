#!/usr/bin/env node
// skill-eval.mjs — đo AI có chọn đúng skill flow theo mô tả không. Bài đo: kit/evals/skill-routing.json.
//   node skill-eval.mjs prompt [--skills <thư mục>]       in đề bài (chỉ mô tả skill + câu user) để đưa cho một model rẻ
//   node skill-eval.mjs score <answers.json> [--old]      answers = mảng tên skill theo thứ tự câu; --old chấm theo bộ cũ
// Exit: 0 chạy xong · 2 sai cách dùng.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/evals/skill-routing.json'), 'utf8'))
const [cmd, ...rest] = process.argv.slice(2)

function descriptions(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('flow-') && fs.existsSync(path.join(dir, n, 'SKILL.md'))).map((n) => {
    const m = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8').match(/^description:\s*(.+)$/m)
    return { name: n, description: m ? m[1].replace(/^["']|["']$/g, '') : '' }
  })
}

if (cmd === 'prompt') {
  const i = rest.indexOf('--skills')
  const list = descriptions(i >= 0 ? rest[i + 1] : path.join(ROOT, 'skills'))
  console.log(`Có các skill sau. Với mỗi câu của user, chọn đúng MỘT skill nên nạp đầu tiên, hoặc "none" nếu không skill nào cần. Trả về DUY NHẤT một mảng JSON tên skill theo thứ tự câu.\n`)
  for (const s of list) console.log(`- ${s.name}: ${s.description}`)
  console.log('\nCâu của user:')
  cases.forEach((c, n) => console.log(`${n + 1}. ${c.say}`))
  console.error(`mô tả: ${list.length} skill, ${Buffer.byteLength(list.map((s) => s.description).join(''))} byte`)
} else if (cmd === 'score' && rest[0]) {
  const key = rest.includes('--old') ? 'old' : 'want'
  const got = JSON.parse(fs.readFileSync(rest[0], 'utf8'))
  if (got.length !== cases.length) { console.error(`cần ${cases.length} câu trả lời, có ${got.length}`); process.exit(2) }
  const wrong = cases.flatMap((c, n) => (got[n] === c[key] ? [] : [`${c.say} → ${got[n]} (đúng: ${c[key]})`]))
  console.log(`đúng ${cases.length - wrong.length}/${cases.length}`)
  wrong.forEach((w) => console.log(`  sai: ${w}`))
} else {
  console.error('dùng: skill-eval.mjs prompt [--skills <dir>] | score <answers.json> [--old]')
  process.exit(2)
}

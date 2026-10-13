#!/usr/bin/env node
// health: "khám sức khoẻ" một dự án app — SPEC AC-50. Chạy các máy kiểm sẵn có của flow-check (trùng lặp, code chết, kiến trúc lệch, kích thước, lỗ hổng thư viện)
// + thư viện lỗi thời, liên kết hỏng trong docs, điểm nóng, nợ kỹ thuật, tài liệu nhắc file không còn ⇒ ghi docs/HEALTH.md (ngày · đỏ · vàng · xanh · so với lần trước
// + việc nên làm) và mốc health.lastAt trong .claude/release.json. Không chạy gì tốn tiền; thiếu công cụ ⇒ "chưa kiểm được: <công cụ> (lệnh cài)", không đỏ.
// Dùng: node ~/.claude/hooks/health.mjs [<thư mục app>] [--no-write]     (mặc định thư mục hiện tại; --no-write = chỉ in, không ghi file nào)
// Exit: 0 không có mục đỏ · 1 có mục đỏ · 3 dùng sai / không thấy thư mục.  Logic ở lib/health.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTool } from './flow-check.mjs'
import { runCommand } from './lib/clis.mjs'
import { HEALTH_REL, collect, recordHealth, todoList } from './lib/health.mjs'

export const USAGE = `health [<thư mục app>] [--no-write]
  khám sức khoẻ: chạy máy kiểm sẵn có + thư viện lỗi thời, liên kết hỏng, điểm nóng, nợ kỹ thuật ⇒ ghi ${HEALTH_REL}
  --no-write  chỉ in kết quả, không ghi ${HEALTH_REL} và không ghi mốc khám
exit: 0 không có mục đỏ · 1 có mục đỏ · 3 dùng sai / không thấy thư mục`

function parseArgs(argv) {
  const o = { dir: undefined, write: true }
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { help: true }
    if (a === '--no-write') o.write = false
    else if (a.startsWith('-')) return { error: `cờ lạ: ${a}` }
    else if (o.dir !== undefined) return { error: 'chỉ nhận một thư mục' }
    else o.dir = a
  }
  return o
}

// runCommand của lib/clis không có cwd ⇒ đổi cwd của tiến trình đúng lúc spawn (spawn chạy đồng bộ trong executor của Promise) rồi trả lại ngay,
// nên chạy song song vẫn đúng thư mục (cùng cách flow-check làm).
function defaultRun(file, args, o = {}) {
  const prev = process.cwd()
  try {
    if (o.cwd) process.chdir(o.cwd)
    return runCommand(file, args, { timeoutMs: o.timeoutMs, env: { ...process.env, NO_COLOR: '1' } })
  } finally {
    process.chdir(prev)
  }
}

const lineOf = (i) => `${i.title}${i.summary ? `: ${i.summary}` : ''}`

// deps tiêm để test: { run, which, now, stdout, stderr, cwd, collect }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const errOut = deps.stderr ?? process.stderr
  const o = parseArgs(argv)
  if (o.help) { out.write(`${USAGE}\n`); return 0 }
  if (o.error) { errOut.write(`health từ chối: ${o.error}\n${USAGE}\n`); return 3 }
  const dir = path.resolve(deps.cwd ?? process.cwd(), o.dir ?? '.')
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { errOut.write(`health: không thấy thư mục app: ${dir}\n`); return 3 }

  errOut.write('Đang khám sức khoẻ (có thể mất vài phút)…\n')
  const report = await (deps.collect ?? collect)({ dir, run: deps.run ?? defaultRun, which: deps.which ?? findTool, now: deps.now })
  const saved = recordHealth(dir, report, { write: o.write, stateOpts: deps.stateOpts })

  const { red, yellow, green, unchecked } = saved.counts
  const L = [`Khám xong: đỏ ${red} · vàng ${yellow} · xanh ${green}${unchecked ? ` · chưa kiểm được ${unchecked}` : ''}.`]
  const v = { first: 'lần khám đầu tiên', better: 'tốt lên', worse: 'tệ đi', mixed: 'có mục tốt lên, có mục tệ đi', same: 'không đổi' }[saved.cmp.verdict]
  L.push(`So với lần trước${saved.cmp.since ? ` (${saved.cmp.since})` : ''}: ${v}.`)
  for (const i of report.items.filter((x) => x.level === 'red')) L.push(`ĐỎ — ${lineOf(i)}`)
  for (const i of report.items.filter((x) => x.level === 'yellow')) L.push(`VÀNG — ${lineOf(i)}`)
  for (const i of report.items.filter((x) => x.level === 'unchecked')) L.push(i.why[0].toUpperCase() + i.why.slice(1))
  const todos = todoList(report.items)
  if (todos.length) L.push('Việc nên làm:', ...todos.slice(0, 5).map((t, k) => `  ${k + 1}. ${t}`))
  if (!o.write) L.push('(--no-write: chưa ghi file nào)')
  else {
    L.push(saved.wrote ? `Đã ghi ${HEALTH_REL}.` : `Không ghi được ${HEALTH_REL} (kiểm quyền ghi thư mục docs).`)
    if (saved.state === 'corrupt') L.push('Chưa ghi được mốc khám: .claude/release.json đang hỏng (không ghi đè). Sửa hoặc xoá file đó rồi khám lại.')
    else if (saved.state === 'failed') L.push('Chưa ghi được mốc khám vào .claude/release.json.')
  }
  out.write(`${L.join('\n')}\n`)
  return red ? 1 : 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}

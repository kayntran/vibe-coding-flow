#!/usr/bin/env node
// skills-check.mjs — dự án đã có skill/MCP CHÍNH HÃNG của từng thư viện chưa, dùng được không (AC-32). Dùng lib/skills-check.mjs + kit/official.json.
// Công cụ CLI (không phải hook): flow-spec gọi trước khi viết PLAN. Chỉ ĐỌC cấu hình, không gọi mạng, không cài gì — lệnh cài chỉ được in ra
// để captain hỏi user. Không bao giờ in khoá/giá trị cấu hình; khoá gõ thẳng chỉ được báo bằng tên server.
//
//   node skills-check.mjs [--host claude|codex|devin] [--dir <thư mục dự án>] [--lib a,b] [--json]
//     --host  app đang dùng (mặc định claude)      --dir  mặc định thư mục hiện tại      --lib  chỉ kiểm các thư viện này (mặc định tất cả)
//
// Exit: 0 chạy được, không có cấu hình sai · 1 có thư viện usable=misconfigured (khoá gõ thẳng, Supabase ghi được/production, lệnh MCP hỏng…)
//       · 2 không chạy được (sai cách dùng, không đọc được kit/official.json).
import fs from 'node:fs'
import { HOSTS, check, loadOfficial, safe } from './lib/skills-check.mjs'

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg) }

const USAGE = `skills-check.mjs — kiểm skill/MCP chính hãng đã cài chưa
  --host claude|codex|devin   app đang dùng (mặc định claude)
  --dir <thư mục>             thư mục dự án (mặc định thư mục hiện tại)
  --lib a,b                   chỉ kiểm các thư viện này
  --json                      ra JSON { ok, host, dir, results[] }
exit: 0 ổn · 1 có cấu hình sai (misconfigured) · 2 không chạy được`

function parseArgs(argv) {
  const o = { host: 'claude', dir: process.cwd(), libs: null, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => (argv[++i] === undefined ? fail(`${a} cần một giá trị\n${USAGE}`) : argv[i])
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--json') o.json = true
    else if (a === '--host') o.host = val()
    else if (a === '--dir') o.dir = val()
    else if (a === '--lib') o.libs = val().split(',').map((s) => s.trim()).filter(Boolean)
    else fail(`đối số không hợp lệ: ${safe(a)}\n${USAGE}`)
  }
  return o
}

function render(o, rows) {
  const lines = [`host=${o.host} dir=${o.dir}`]
  for (const r of rows) {
    const extra = r.status === 'none' ? '(hãng không có bản chính hãng)' : [`env=${r.scope.env}`, ...('readOnly' in r.scope ? [`readOnly=${r.scope.readOnly}`] : []), ...Object.keys(r.parts).map((p) => `[${p}]`)].join(' ')
    lines.push(`${r.lib.padEnd(11)} ${r.status.padEnd(15)} ${r.usable.padEnd(13)} ${r.status === 'installed' || r.status === 'none' ? extra : ''}`.trimEnd())
    if (r.status === 'none') lines.push(`  ${r.note}`)
    for (const p of r.problems) lines.push(`  ! ${p}`)
    for (const w of r.warnings) lines.push(`  ? ${w}`)
    if (r.installCmd) lines.push(`  cài: ${r.installCmd}`)
    if (r.installAlt) lines.push(`  hoặc (MCP): ${r.installAlt}`)
  }
  return lines
}

function main(argv) {
  const o = parseArgs(argv)
  if (o.help) return { lines: [USAGE], code: 0 }
  if (!Object.hasOwn(HOSTS, o.host)) fail(`host không hỗ trợ: ${safe(o.host)}\n${USAGE}`)
  if (!fs.existsSync(o.dir) || !fs.statSync(o.dir).isDirectory()) fail(`không có thư mục: ${safe(o.dir)}`)
  let official
  try { official = loadOfficial() } catch (e) { fail(`không đọc được kit/official.json (${e.code ?? e.message})`) }
  for (const l of o.libs ?? []) if (!Object.hasOwn(official, l)) fail(`thư viện không có trong official.json: ${safe(l)} (có: ${Object.keys(official).join(', ')})`)
  const rows = check(o.dir, o.host, { libs: o.libs ?? undefined, official })
  const code = rows.some((r) => r.usable === 'misconfigured') ? 1 : 0
  if (o.json) return { lines: [JSON.stringify({ ok: code === 0, host: o.host, dir: o.dir, results: rows })], code }
  return { lines: render(o, rows), code }
}

try {
  const { lines, code } = main(process.argv.slice(2))
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exitCode = code
} catch (e) {
  process.stderr.write(`skills-check: ${e instanceof Fail ? e.message : e.stack || e}\n`)
  process.exitCode = 2
}

#!/usr/bin/env node
// secret-scan.mjs — quét secret / ký tự ẩn bằng lib/secrets.mjs. Công cụ CLI (không phải hook): cài đặt, session-start, flow-check gọi.
// Không bao giờ in giá trị secret đầy đủ (chỉ 4 ký tự đầu + …) và không in nội dung dòng/ký tự ẩn.
//
//   node secret-scan.mjs --hidden <file|dir…>   ký tự ẩn (zero-width, bidi, tag U+E0000–E007F) trong file luật/skill/agent; thư mục ⇒ đệ quy
//   node secret-scan.mjs --build <dir>          secret (kể cả khoá service_role) trong dist/ build/ .next/ out/ dưới <dir>
//   node secret-scan.mjs --diff [file|-]        diff (mặc định stdin): quét CẢ dòng xoá + file nhạy cảm/dữ liệu riêng
//   node secret-scan.mjs --text [file|-]        văn bản thường (mặc định stdin)
//   thêm --json để ra JSON { ok, findings[, errors] } thay cho dòng chữ
//
// Exit: 0 sạch · 1 có phát hiện · 2 không chạy được (sai cách dùng, không đọc được file/thư mục; không coi là sạch).
import fs from 'node:fs'
import { scanDiff, scanDir, scanHiddenPaths, scanText } from './lib/secrets.mjs'

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg) }

const USAGE = `secret-scan.mjs — quét secret / ký tự ẩn
  --hidden <file|dir…>   ký tự ẩn trong file luật/skill/agent
  --build <dir>          secret trong bản build (dist/ build/ .next/ out/)
  --diff [file|-]        diff (mặc định stdin), gồm cả dòng xoá
  --text [file|-]        văn bản (mặc định stdin)
  --json                 ra JSON
exit: 0 sạch · 1 có phát hiện · 2 không chạy được`

const readInput = (src) => {
  try {
    return fs.readFileSync(src === undefined || src === '-' ? 0 : src, 'utf8')
  } catch (e) {
    return fail(`không đọc được ${src === undefined || src === '-' ? 'stdin' : src} (${e.code ?? e.message})`)
  }
}

const maskedLine = (f) => {
  const where = f.line == null ? f.file : `${f.file}:${f.line}`
  return `${where} — ${f.name}${f.value ? ` (${f.value})` : ''}${f.removed ? ' [dòng đã xoá]' : ''}`
}
const hiddenLine = (f) => `${f.file}:${f.line}:${f.col} — ký tự ẩn ${f.kind} ×${f.count} (${f.codepoints.join(' ')})`

function main(argv) {
  const json = argv.includes('--json')
  const args = argv.filter((a) => a !== '--json')
  const [mode, ...rest] = args
  if (mode === '-h' || mode === '--help') return { lines: [USAGE], code: 0 }
  let findings
  let errors = []
  let render = maskedLine
  if (mode === '--hidden') {
    if (!rest.length) fail(`--hidden cần ít nhất một file hoặc thư mục\n${USAGE}`)
    ;({ findings, errors } = scanHiddenPaths(rest))
    render = hiddenLine
  } else if (mode === '--build') {
    if (rest.length !== 1) fail(`--build cần đúng một thư mục\n${USAGE}`)
    try { findings = scanDir(rest[0], { build: true }) } catch (e) { fail(`không quét được ${rest[0]} (${e.code ?? e.message})`) }
  } else if (mode === '--diff' || mode === '--text') {
    if (rest.length > 1) fail(USAGE)
    const input = readInput(rest[0])
    findings = mode === '--diff'
      ? scanDiff(input)
      : scanText(input).map((f) => ({ file: rest[0] && rest[0] !== '-' ? rest[0] : '<stdin>', ...f }))
  } else {
    fail(`${mode ? `đối số không hợp lệ: ${mode}` : 'thiếu đối số'}\n${USAGE}`)
  }

  const code = findings.length ? 1 : errors.length ? 2 : 0
  if (json) return { lines: [JSON.stringify({ ok: code === 0, findings, ...(errors.length ? { errors } : {}) })], code }
  const lines = findings.map(render)
  const errLines = errors.map((e) => `${e.file} — ${e.error}`)
  lines.push(code === 0 ? 'OK: sạch' : findings.length ? `FAIL: ${findings.length} phát hiện${errors.length ? `, ${errors.length} chỗ không quét được` : ''}` : `FAIL: ${errors.length} chỗ không quét được`)
  return { lines, errLines, code }
}

try {
  const { lines, errLines = [], code } = main(process.argv.slice(2))
  process.stdout.write(`${lines.join('\n')}\n`)
  if (errLines.length) process.stderr.write(`${errLines.join('\n')}\n`)
  process.exitCode = code
} catch (e) {
  process.stderr.write(`secret-scan: ${e instanceof Fail ? e.message : e.stack || e}\n`)
  process.exitCode = 2
}

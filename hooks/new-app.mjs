#!/usr/bin/env node
// new-app: tạo app mới từ số 0 (skill flow-new-app). Thư viện: lib/new-app.mjs. Mẫu: kit/templates/<loại>/ (template.json + overlay/**), bản ghim: kit/templates/versions.json.
//   doctor --type web|desktop|extension [--pm pnpm|npm] [--json]
//          kiểm máy đủ phần mềm chưa (Node, Git, pnpm/npm; app máy tính: Go, Wails, WebView2/Xcode; và công cụ máy kiểm flow-check coi là bắt buộc theo kit/checkers.json: osv-scanner, ast-grep…).
//          KHÔNG cài gì; thiếu gì thì in đúng lệnh cài của hệ điều hành đang chạy (Windows hoặc Mac). Có phần mềm nhưng KHÔNG CHẠY ĐƯỢC (EPERM/EACCES: bị chặn quyền/sandbox) ⇒ báo riêng, không bảo là chưa có.
//   create --type <loại> --name <tên> [--dir <thư mục cha>] [--pm pnpm|npm] [--json]
//          tạo <thư mục cha>/<tên> bằng lệnh chính hãng ghim bản + lớp phủ của kit, bật git và điểm lưu "Tạo app". Thư mục đích đã có đồ ⇒ từ chối, không đè.
// Exit: 0 xong · 1 lỗi hoặc từ chối (mạng, quyền, ổ đĩa, thư mục đã có đồ…) · 2 dùng sai · 3 máy thiếu phần mềm (doctor/create).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NewAppError, TYPES, create, doctor, installLines, loadTemplate } from './lib/new-app.mjs'

const USAGE = `dùng: new-app.mjs <lệnh> [...]
  doctor --type web|desktop|extension [--pm pnpm|npm] [--json]       kiểm máy, in lệnh cài nếu thiếu (không cài gì)
  create --type <loại> --name <tên> [--dir <thư mục cha>] [--pm pnpm|npm] [--json]
                                                                      tạo app mới (tên: chữ thường không dấu, số, gạch ngang)
exit: 0 xong · 1 lỗi/từ chối · 2 dùng sai · 3 thiếu phần mềm`

const VALUE_FLAGS = new Set(['--type', '--name', '--dir', '--pm'])
const BOOL_FLAGS = new Set(['--json', '--help', '-h'])
const clean = (s, max = 1500) => String(s ?? '').replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').slice(0, max)
const usage = (msg) => new NewAppError(`${msg}\n${USAGE}`, { exit: 2 })

function parse(argv) {
  const o = { pos: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (BOOL_FLAGS.has(a)) o[a.replace(/^-+/, '')] = true
    else if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw usage(`${a} cần một giá trị`)
      o[a.slice(2)] = argv[++i]
    } else if (a.startsWith('-')) throw usage(`cờ lạ ${clean(a, 40)}`)
    else o.pos.push(a)
  }
  return o
}

function needType(o) {
  if (!o.type) throw usage(`thiếu --type (${TYPES.join(' | ')})`)
  if (!TYPES.includes(o.type)) throw usage(`--type "${clean(o.type, 30)}" chưa có mẫu (${TYPES.join(' | ')})`)
  return o.type
}

function doctorLines(r, label) {
  if (r.ok) {
    const have = Object.entries(r.found).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k} ${v}`))
    return [`Máy đủ phần mềm để tạo ${label} (${have.join(', ')}). Trình quản lý gói sẽ dùng: ${r.pm}.`]
  }
  const blocked = r.blocked ?? []
  return [
    ...(r.missing.length ? [
      `Máy còn thiếu ${r.missing.length} thứ để tạo ${label}:`,
      ...r.missing.flatMap((m) => [`- ${m.tool}: ${m.why}`, ...installLines(m.install, r.platform)]),
      'Cài xong (mở cửa sổ dòng lệnh mới) rồi chạy lại doctor.',
    ] : []),
    ...(blocked.length ? [
      `Có ${blocked.length} phần mềm trên máy nhưng không chạy được (bị chặn quyền hoặc môi trường cô lập):`,
      ...blocked.map((b) => `- ${b.tool}: ${b.why}`),
    ] : []),
  ]
}

function createLines(r, label) {
  const lines = [`Đã tạo app "${r.name}" (${label}) ở ${r.dir}.`, `Điểm lưu: "${r.luu.name}" (${r.luu.tag}).`]
  const o = r.overlay
  lines.push(`Lớp phủ của kit: thêm ${o.added.length} file${o.replaced.length ? `, thay ${o.replaced.length} file mẫu` : ''}${o.removed.length ? `, gỡ ${o.removed.join(', ')}` : ''}.`)
  lines.push(`Chạy thử: cd "${r.dir}" && ${r.next.dev}`, `Mở: ${r.next.url}${r.next.open ? ` (${r.next.open})` : ''}`)
  for (const n of r.notes) lines.push(`Lưu ý: ${n}`)
  return lines
}

// → { lines, errLines, code }. io (cho test): run, platform, env, nodeVersion, kit, now, log — xem lib/new-app.mjs.
export async function main(argv, io = {}) {
  let json = false
  try {
    const o = parse(argv)
    json = Boolean(o.json)
    if (o.help || o.h) return { lines: [USAGE], errLines: [], code: 0 }
    if (!o.pos.length) throw usage('thiếu lệnh (doctor hoặc create)')
    const [cmd, ...rest] = o.pos
    if (rest.length) throw usage(`thừa đối số: ${clean(rest.join(' '), 60)}`)
    if (cmd === 'doctor') {
      const type = needType(o)
      const r = doctor({ type, io, pm: o.pm })
      const label = loadTemplate(type, io.kit).label ?? type
      const code = r.ok ? 0 : 3
      return { lines: json ? [JSON.stringify(r)] : doctorLines(r, label).map((l) => clean(l)), errLines: [], code }
    }
    if (cmd === 'create') {
      const type = needType(o)
      if (!o.name) throw usage('thiếu --name (tên app)')
      const r = create({ type, name: o.name, parent: o.dir ?? process.cwd(), pm: o.pm, io })
      const label = loadTemplate(type, io.kit).label ?? type
      return { lines: json ? [JSON.stringify(r)] : createLines(r, label).map((l) => clean(l)), errLines: [], code: 0 }
    }
    throw usage(`lệnh lạ: ${clean(cmd, 40)}`)
  } catch (e) {
    if (e instanceof NewAppError) {
      if (json) return { lines: [JSON.stringify({ ok: false, code: e.exit, kind: e.kind, error: e.message, details: e.lines })], errLines: [], code: e.exit }
      return { lines: [], errLines: [`${e.exit === 2 ? '' : 'lỗi: '}${[e.message, ...e.lines].map((l) => clean(l)).join('\n')}`], code: e.exit }
    }
    return { lines: [], errLines: [`new-app: lỗi không lường trước: ${clean(e?.stack ?? e, 1500)}`], code: 1 }
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const { lines, errLines, code } = await main(process.argv.slice(2), { log: (s) => process.stderr.write(`… ${s}\n`) })
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`)
  if (errLines.length) process.stderr.write(`${errLines.join('\n')}\n`)
  process.exitCode = code
}

#!/usr/bin/env node
// luu: CLI điểm lưu của dự án (chỉ trên máy, không đẩy lên mạng). Thư viện: lib/luu.mjs. Spec: docs/specs/2026-10-12-flow-v7-dot3 (AC-16).
//   bat  <thư mục>                         chưa có git ⇒ git init + .gitignore + commit đầu + điểm lưu "Bắt đầu"; đã có git ⇒ không làm gì
//   tao  <thư mục> "<tên đời thường>"      điểm lưu tại vị trí hiện tại; còn file đang sửa dở ⇒ lưu chúng thành commit mới rồi gắn điểm (quét khoá, trừ dữ liệu); không còn gì dở và đã có điểm ở đây ⇒ không tạo trùng
//   ds   <thư mục> [--json]                danh sách điểm lưu, mới nhất trước
//   tim  <thư mục> "<câu>" [--json]        điểm lưu khớp câu (không dấu, không phân biệt hoa thường), xếp hạng
//   xem  <thư mục> <điểm> [--json]         những gì sẽ bị gỡ nếu quay về điểm đó
//   quay <thư mục> <điểm> [--viec-do giu|bo] [--doi-luat] [--khong-kiem]
//                                          quay về điểm đó bằng MỘT commit mới (không xoá lịch sử); chỉ chạy ở nhánh chính, thư mục chính
// <điểm> = tag (luu/… hoặc bỏ tiền tố luu/) HOẶC tên đời thường ("thêm trang đăng nhập", không dấu / hoa thường cũng được) khi khớp DUY NHẤT một điểm; khớp nhiều ⇒ exit 2 liệt kê để chọn tag.
// --viec-do (khi còn file đang sửa dở): cả hai đều cất việc dở thành một điểm lưu trước khi quay; `giu` = quay xong đặt lại các file dở đó vào thư mục làm việc (chưa lưu), `bo` = cất rồi thôi (thư mục làm việc về đúng điểm đã chọn).
// Sau khi quay xong, `quay` chạy máy kiểm của kit (hooks/flow-check.mjs, có thể mất vài phút) và in MỘT dòng tổng (đạt / N mục chưa đạt + lệnh xem chi tiết), không chặn; --khong-kiem để bỏ qua.
// Captain CHỈ chạy `quay` sau khi user đã gật trong chat; chạm file luật (exit 4) thì phải hỏi user riêng câu "quay về sẽ nới luật kiểm X, đồng ý?" rồi mới thêm --doi-luat. Dữ liệu trong app (db, data/, uploads/, storage/ + mẫu thêm trong .claude/luu.json) và trạng thái phát hành (.claude/release.json) không quay theo.
// Exit: 0 xong · 1 lỗi hoặc từ chối (khoá bí mật, sai nhánh, việc git dở…) · 2 dùng sai · 3 có việc dở mà thiếu --viec-do · 4 quay chạm file luật mà thiếu --doi-luat.
// Chỉ để test: biến môi trường FLOW_LUU_NOW (ISO) đổi "bây giờ" khi đặt tên điểm lưu.
import { LuuError, bat, ds, quay, tao, tim, xem } from './lib/luu.mjs'

const USAGE = `dùng: luu.mjs <lệnh> <thư mục dự án> [...]
  bat  <dir>                      bật điểm lưu (git init nếu chưa có) + điểm "Bắt đầu"
  tao  <dir> "<tên>"              tạo điểm lưu tại vị trí hiện tại
  ds   <dir> [--json]             danh sách điểm lưu
  tim  <dir> "<câu>" [--json]     tìm điểm lưu theo lời
  xem  <dir> <điểm> [--json]      những gì sẽ bị gỡ nếu quay về điểm đó
  quay <dir> <điểm> [--viec-do giu|bo] [--doi-luat] [--khong-kiem]
  <điểm> = tag luu/… hoặc tên đời thường (khớp duy nhất một điểm)
  --viec-do giu = quay xong đặt lại file dở vào thư mục làm việc · bo = cất rồi thôi (cả hai đều lưu thành điểm trước)
exit: 0 xong · 1 lỗi/từ chối · 2 dùng sai · 3 việc dở: cần --viec-do · 4 chạm file luật: cần --doi-luat`

const out = (s) => process.stdout.write(`${s}\n`)
const clean = (s, max = 1000) => String(s ?? '').replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/gu, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').slice(0, max)
const usage = (msg) => new LuuError(`${msg}\n${USAGE}`, { exit: 2 })

function parse(argv) {
  const o = { json: false, doiLuat: false, khongKiem: false, viecDo: undefined, help: false, pos: [] }
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (rest || !a.startsWith('--') && a !== '-h') o.pos.push(a)
    else if (a === '--') rest = true
    else if (a === '--json') o.json = true
    else if (a === '--doi-luat') o.doiLuat = true
    else if (a === '--khong-kiem') o.khongKiem = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--viec-do' || a.startsWith('--viec-do=')) {
      const v = a === '--viec-do' ? argv[++i] : a.slice('--viec-do='.length)
      if (v !== 'giu' && v !== 'bo') throw usage('--viec-do chỉ nhận "giu" (giữ) hoặc "bo" (bỏ)')
      o.viecDo = v
    } else throw usage(`cờ lạ ${a}`)
  }
  return o
}

const nowOf = () => {
  const d = new Date(process.env.FLOW_LUU_NOW ?? '')
  return Number.isNaN(d.getTime()) ? new Date() : d
}

function cmdBat(dir) {
  const r = bat(dir, { now: nowOf() })
  if (r.nested) return [`Thư mục này nằm trong một dự án git khác (${r.root}); điểm lưu dùng thư mục gốc đó. Không đổi gì.`]
  if (!r.created) return ['Đã có git ở đây, không đổi gì.']
  return [`Đã bật điểm lưu${r.initialized ? ' (tạo git mới)' : ''}: điểm "Bắt đầu" (${r.tag}).`]
}

function cmdTao(dir, name) {
  const r = tao(dir, name, { now: nowOf() })
  if (!r.created) return [`Chỗ này đã là điểm lưu "${r.name}" (${r.tag}) nên không tạo thêm.`]
  return [`Đã lưu điểm "${r.name}" (${r.tag}, commit ${r.commit.slice(0, 7)})${r.files?.length ? `, gồm ${r.files.length} file đang sửa dở` : ''}.`]
}

function cmdDs(dir, json) {
  const list = ds(dir)
  if (json) return [JSON.stringify(list)]
  if (!list.length) return ['Chưa có điểm lưu nào.']
  return list.map((p) => `${p.time}  "${p.name}"  ${p.tag}  ${p.commit}  ${p.since === 0 ? 'mới nhất' : `${p.since} việc sau đó`}`)
}

function cmdTim(dir, query, json) {
  const list = tim(dir, query)
  if (json) return [JSON.stringify(list)]
  if (!list.length) return ['Không có điểm lưu nào khớp.']
  return list.flatMap((p, i) => [`${i + 1}. "${p.name}" — ${p.time} · ${p.tag} · ${p.commit}`, ...p.matched.subjects.map((s) => `   việc khớp: ${s}`)])
}

// Trạng thái phát hành (.claude/release.json) ghi sự thật bên ngoài (bản đang chạy, đã thử quay lại…) nên quay không đụng tới, như dữ liệu.
const STATE_NOTE = ' Trạng thái phát hành cũng giữ nguyên.'
const list = (items, max = 8) => items.slice(0, max).join('; ') + (items.length > max ? `; …và ${items.length - max} mục nữa` : '')

function cmdXem(dir, tag, json) {
  const r = xem(dir, tag)
  if (json) return [JSON.stringify(r)]
  const lines = [`Quay về "${r.target.name}" (${r.target.time}) sẽ gỡ:`]
  lines.push(r.after.length ? `- ${r.after.length} điểm lưu sau đó (vẫn còn trong lịch sử, quay lại được): ${list(r.after.map((p) => `"${p.name}" (${p.time})`))}` : '- không có điểm lưu nào sau đó')
  lines.push(r.commitCount ? `- ${r.commitCount} việc đã làm sau đó: ${list(r.commits.map((c) => c.subject))}` : '- không có việc nào sau đó')
  if (r.dirty.length) lines.push(`- việc đang dở chưa lưu (${r.dirty.length} file: ${list(r.dirty, 6)}): sẽ được lưu tạm trước, cần chọn --viec-do giu (quay xong đặt lại vào thư mục làm việc) hoặc bo (cất rồi thôi)`)
  if (r.worktrees.length) lines.push(`- bản làm việc khác đang mở: ${list(r.worktrees.map((w) => `${w.path}${w.branch ? ` (nhánh ${w.branch})` : ''}`))}`)
  if (r.unmerged.length) lines.push(`- nhánh chưa gộp vào nhánh chính: ${list(r.unmerged)}`)
  lines.push(`- ${r.changes.length} file sẽ đổi${r.changes.length ? `: ${list(r.changes.map((c) => c.file), 6)}` : ''}`)
  if (r.ruleFiles.length) lines.push(`- LUẬT KIỂM TRA sẽ đổi (cần người dùng đồng ý riêng, rồi thêm --doi-luat): ${list(r.ruleFiles)}`)
  if (r.keptData.length) lines.push(`- giữ nguyên dữ liệu: ${list(r.keptData)}`)
  lines.push(`Dữ liệu trong app (database, tệp tải lên) không quay theo.${STATE_NOTE}`)
  if (r.blocker) lines.push(`Chưa quay được lúc này: ${r.blocker}`)
  return lines
}

function cmdQuay(dir, tag, o) {
  const r = quay(dir, tag, { viecDo: o.viecDo, doiLuat: o.doiLuat, now: nowOf(), ...(o.khongKiem ? { runCheck: null } : {}) })
  if (r.status === 'same') return [`Đang ở đúng "${r.target.name}" rồi, không có gì để quay.`]
  const lines = [`Đã quay về "${r.target.name}" (${r.target.time}).`]
  if (r.saved) {
    if (r.restored.length) lines.push(`Việc đang dở đã lưu thành điểm "${r.saved.name}" (${r.saved.tag}).`, `Đã đặt lại vào thư mục làm việc (${r.restored.length} file, chưa lưu): ${list(r.restored, 6)}.`)
    else lines.push(`Việc đang dở đã lưu thành điểm "${r.saved.name}" rồi bỏ khỏi thư mục làm việc.`, `Muốn lấy lại: luu.mjs quay <thư mục> ${r.saved.tag}`)
  }
  lines.push(r.tag ? `Điểm lưu mới: commit ${r.commit}, ${r.tag}.` : `Không có gì khác để ghi thêm (commit ${r.commit}).`)
  lines.push(`Điểm vừa rời: "${r.left.name}" (${r.left.tag}, commit ${r.left.commit}).`)
  lines.push(`Quay nhầm thì chạy: luu.mjs quay <thư mục> ${r.left.tag}${r.restored.length ? ' --viec-do bo (cất thêm việc dở vừa đặt lại)' : ''}`)
  lines.push(`Dữ liệu trong app (database, tệp tải lên) không quay theo${r.keptData.length ? `; giữ nguyên: ${list(r.keptData)}` : ''}.${STATE_NOTE}`)
  if (r.check) lines.push(...r.check.lines)
  return lines
}

// → { lines, json }: json = true khi lines là JSON nguyên văn (không cắt, không lọc).
function run(argv) {
  const o = parse(argv)
  if (o.help) return { lines: [USAGE], json: false }
  const asJson = o.json && ['ds', 'tim', 'xem'].includes(o.pos[0])
  return { lines: dispatch(o), json: asJson }
}

function dispatch(o) {
  const [cmd, dir, arg, ...extra] = o.pos
  if (!cmd) throw usage('thiếu lệnh')
  if (!dir) throw usage(`${clean(cmd, 40)}: thiếu thư mục dự án`)
  switch (cmd) {
    case 'bat': if (arg) throw usage('bat chỉ nhận thư mục'); return cmdBat(dir)
    case 'tao': if (!arg) throw usage('tao cần tên điểm lưu'); return cmdTao(dir, [arg, ...extra].join(' '))
    case 'ds': if (arg) throw usage('ds chỉ nhận thư mục'); return cmdDs(dir, o.json)
    case 'tim': if (!arg) throw usage('tim cần câu để tìm'); return cmdTim(dir, [arg, ...extra].join(' '), o.json)
    case 'xem': if (!arg || extra.length) throw usage('xem cần đúng một điểm lưu'); return cmdXem(dir, arg, o.json)
    case 'quay': if (!arg || extra.length) throw usage('quay cần đúng một điểm lưu'); return cmdQuay(dir, arg, o)
    default: throw usage(`lệnh lạ: ${clean(cmd, 40)}`)
  }
}

try {
  const { lines, json } = run(process.argv.slice(2))
  out(json ? lines.join('\n') : lines.map((l) => clean(l)).join('\n'))
} catch (e) {
  if (e instanceof LuuError) {
    const text = [e.message, ...e.lines].map((l) => clean(l)).join('\n')
    if (e.exit === 3 || e.exit === 4) out(text)
    else process.stderr.write(`${e.exit === 2 ? '' : 'lỗi: '}${text}\n`)
    process.exitCode = e.exit
  } else {
    process.stderr.write(`luu: lỗi không lường trước: ${clean(e?.stack ?? e, 1500)}\n`)
    process.exitCode = 1
  }
}

#!/usr/bin/env node
// solutions: CLI rút kinh nghiệm (bài học ở <dự án>/docs/solutions). Thư viện: lib/solutions.mjs.
//   ghi <projectRoot> -          JSON từ stdin (hoặc JSON ngay trên dòng lệnh); thiếu vi_sao_khong_suy_ra ⇒ từ chối, exit 1
//   gap <projectRoot> <dang_loi> gặp lại: tăng lan + tai_phat; lan ≥ 2 mà chưa có máy kiểm ⇒ in đề xuất theo thang
//   ra-soat <projectRoot> [--days 30]  liệt kê bài học quá hạn rà soát
//   index <projectRoot>          sinh docs/solutions/INDEX.md
// stdout: chữ cho người đọc; lỗi ⇒ exit 1 + một dòng stderr.
import fs from 'node:fs'
import { gap, ghi, index, raSoat } from './lib/solutions.mjs'

const USAGE = 'dùng: solutions.mjs <ghi <root> -|gap <root> <dang_loi>|ra-soat <root> [--days N]|index <root>>'
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function readJson(raw) {
  const s = raw === '-' ? fs.readFileSync(0, 'utf8') : raw
  if (s === undefined || s.trim() === '') throw new Error('thiếu JSON bài học (đưa qua stdin: ghi <root> -)')
  try { return JSON.parse(s) } catch { throw new Error('JSON bài học không đọc được') }
}

function run(argv) {
  const [cmd, root, ...rest] = argv
  const out = []
  if (!root) throw new Error(USAGE)
  if (cmd === 'ghi') {
    const r = ghi(root, readJson(rest[0]))
    out.push(`Đã ghi bài học: ${r.rel}`)
  } else if (cmd === 'gap') {
    if (!rest[0]) throw new Error(USAGE)
    const r = gap(root, rest[0])
    out.push(`Đã ghi nhận gặp lại "${r.dang_loi}": ${r.lan} lần (tái phát ${r.tai_phat})`, ...r.de_xuat)
  } else if (cmd === 'ra-soat') {
    const i = rest.indexOf('--days')
    const days = i >= 0 ? rest[i + 1] : undefined
    if (i >= 0 && (days === undefined || days === '')) throw new Error('--days cần một số')
    const list = raSoat(root, days === undefined ? {} : { days: Number(days) })
    if (!list.length) out.push('Không có bài học nào quá hạn rà soát.')
    else out.push(`${list.length} bài học quá hạn rà soát:`, ...list.map((b) => `- ${b.dang_loi} · rà gần nhất ${b.ra_soat} (${b.tuoi} ngày) · gặp ${b.lan} lần · máy kiểm: ${b.may_kiem} · ${b.file}`))
  } else if (cmd === 'index') {
    const r = index(root)
    out.push(r.bo_qua ? `Bỏ qua ${r.rel}: ${r.bo_qua}` : r.ghi ? `Đã sinh ${r.rel}` : `${r.rel} đã mới nhất`)
  } else throw new Error(USAGE)
  return out
}

try {
  process.stdout.write(`${run(process.argv.slice(2)).join('\n')}\n`)
} catch (e) {
  process.stderr.write(`lỗi: ${oneLine(e?.message ?? e)}\n`)
  process.exitCode = 1
}

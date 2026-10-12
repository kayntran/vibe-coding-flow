#!/usr/bin/env node
// kho: CLI kho nghiên cứu của dự án (thẻ ở <dự án>/docs/research). Thư viện: lib/kho.mjs.
//   moi <cau-hoi|repo> <projectRoot> -   JSON thẻ từ stdin (hoặc JSON ngay trên dòng lệnh); tạo docs/research/<slug>.md + cập nhật INDEX.md
//   tim <projectRoot> "<từ khoá>"        thẻ khớp (không dấu, không phân biệt hoa/thường); thẻ hết hạn được đánh dấu
//   index <projectRoot>                  sinh docs/research/INDEX.md (không ghi đè bản viết tay)
//   lay <projectRoot> <thẻ> [--ref <nhánh>]  tải repo "chỉ học" đúng commit (đủ 40 hex) vào ~/.claude/cache/chi-hoc/<thẻ>@<băm url>@<commit> (AI báo user TRƯỚC khi tải);
//                                        không ghi gì vào thẻ (thẻ nằm trong git, không được chứa đường dẫn máy)
// Biến môi trường: FLOW_CHI_HOC_DIR (đổi thư mục bản sao), FLOW_KHO_CHO_LOCAL=1 (cho tải từ repo cục bộ, chỉ để thử).
// stdout: chữ cho người đọc; lỗi ⇒ exit 1 + một dòng stderr. Mọi dòng in ra (kể cả chữ lấy từ thẻ) đi qua cùng bộ lọc với brief của researcher:
// bỏ ký tự ẩn / điều khiển, che khoá bí mật — AI đọc đầu ra này nên thẻ đặt tay không được cài chữ vô hình.
import fs from 'node:fs'
import { index, lay, moi, safeLine, tim } from './lib/kho.mjs'

const USAGE = 'dùng: kho.mjs <moi <cau-hoi|repo> <root> -|tim <root> "<từ khoá>"|index <root>|lay <root> <thẻ> [--ref <nhánh>]>'
const oneLine = (s, max = 300) => safeLine(s, max)

function readJson(raw) {
  const s = raw === '-' ? fs.readFileSync(0, 'utf8') : raw
  if (s === undefined || s.trim() === '') throw new Error('thiếu JSON của thẻ (đưa qua stdin: moi <loai> <root> -)')
  try { return JSON.parse(s) } catch { throw new Error('JSON của thẻ không đọc được') }
}

function run(argv) {
  const [cmd, a, b, ...rest] = argv
  const out = []
  if (cmd === 'moi') {
    if (!a || !b) throw new Error(USAGE)
    const input = readJson(rest[0])
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON của thẻ phải là một đối tượng')
    const r = moi(b, { ...input, loai: a })
    out.push(`Đã tạo thẻ: ${r.rel}`)
    if (r.ep_chi_hoc) out.push('Licence hạn chế (GPL/AGPL/cấm thương mại) ⇒ thẻ ở chế độ chi-hoc: chỉ học logic, không chép code.')
    out.push(...r.canh_bao.map((w) => `Lưu ý: ${w}`))
    if (r.index.bo_qua) out.push(`Mục lục: ${r.index.bo_qua}`)
  } else if (cmd === 'tim') {
    if (!a) throw new Error(USAGE)
    const list = tim(a, [b, ...rest].filter((x) => x !== undefined).join(' '))
    if (!list.length) out.push('Không có thẻ nào khớp.')
    for (const v of list) {
      out.push(`- [${v.slug}] ${oneLine(v.tieu_de, 120)} — ${oneLine(v.ket_luan, 200) || '(chưa có kết luận)'} · ${v.do_tin || '?'} · ${v.da_het_han ? `⚠ HẾT HẠN từ ${v.het_han}: chỉ tra phần cũ` : `còn hạn đến ${v.het_han || '?'}`}${v.che_do === 'chi-hoc' ? ' · chi-hoc' : ''} · ${v.rel}`)
    }
  } else if (cmd === 'index') {
    if (!a) throw new Error(USAGE)
    const r = index(a)
    out.push(r.bo_qua ? `Bỏ qua ${r.rel}: ${r.bo_qua}` : r.ghi ? `Đã sinh ${r.rel}` : `${r.rel} đã mới nhất`)
  } else if (cmd === 'lay') {
    if (!a || !b) throw new Error(USAGE)
    const i = rest.indexOf('--ref')
    if (i >= 0 && !rest[i + 1]) throw new Error('--ref cần tên nhánh')
    const r = lay(a, b, i >= 0 ? { ref: rest[i + 1] } : {})
    out.push(r.da_co ? `Bản sao đã có: ${r.duong_dan}` : `Đã tải ${r.slug} (commit ${r.commit.slice(0, 10)}) vào ${r.duong_dan}`)
  } else throw new Error(USAGE)
  return out
}

try {
  process.stdout.write(`${run(process.argv.slice(2)).map((l) => oneLine(l, 600)).join('\n')}\n`)
} catch (e) {
  process.stderr.write(`lỗi: ${oneLine(e?.message ?? e)}\n`)
  process.exitCode = 1
}

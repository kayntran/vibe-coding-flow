// brief: bộ đọc khoá `plan=` / `lane=` / `base=` trong brief giao worker, DÙNG CHUNG cho flow-dispatch (agent) và flow-gate (audit subagent-stop).
// Chỉ phân tích chuỗi + chuẩn hoá đường dẫn; không ghi log, không ném lỗi với đầu vào bất kỳ.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Git bash đưa đường dẫn kiểu /c/Users/... — đổi sang C:/Users/... để Node hiểu.
export function toNative(p) {
  return process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p
}

// Giá trị `key=` trong brief → danh sách ứng viên (rỗng nếu không có khoá hoặc giá trị rỗng). Nhận "..." / '...' / `...`;
// không nháy thì lấy tới khoá `xxx=` kế tiếp, dấu `;` hoặc hết dòng (đường dẫn có dấu cách như "D:\AI\Vibe Coding\PLAN.md" vẫn đủ),
// kèm các ứng viên ngắn dần theo từng dấu cách (khi sau đường dẫn còn chữ thường như "plan=PLAN.md (xem thêm)"); người gọi chọn cái tồn tại.
export function briefValues(text, key) {
  const m = new RegExp(
    `(?:^|[\\s;,(\\[])${key}=(?:"([^"\\n]*)"|'([^'\\n]*)'|\`([^\`\\n]*)\`|([^\\n]*?)(?=\\s+[A-Za-z_][\\w-]*=|\\s*;|\\s*$))`, 'im',
  ).exec(text)
  if (!m) return []
  const quoted = m[1] ?? m[2] ?? m[3]
  const raw = (quoted ?? m[4] ?? '').trim().replace(/^[<"'`]+|[>"'`.,;:)\]]+$/g, '').trim()
  if (!raw) return []
  if (quoted !== undefined) return [raw]
  return [raw, ...[...raw.matchAll(/\s+/g)].map((s) => raw.slice(0, s.index).replace(/[.,;:)\]]+$/, '')).reverse()]
}

// Giá trị một từ (tên làn, tên nhánh) của `key=`: ứng viên ngắn nhất (không dấu cách); khoá thiếu/rỗng ⇒ null.
export function briefWord(text, key) {
  return briefValues(text, key).at(-1) ?? null
}

// Đường dẫn trong brief → tuyệt đối: /c/… (git bash), ~/… (thư mục home), tương đối tính từ cwd.
export function resolvePath(raw, cwd) {
  let p = toNative(raw)
  if (/^~([\\/]|$)/.test(p)) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(cwd, p)
}

// Đường dẫn plan= đã chuẩn hoá: ứng viên đầu tiên đang tồn tại, không có cái nào tồn tại thì ứng viên đầu (để người gọi báo lỗi); thiếu plan= ⇒ null.
export function briefPlan(text, cwd) {
  const cands = briefValues(text, 'plan').map((c) => resolvePath(c, cwd))
  return cands.find((c) => fs.existsSync(c)) ?? cands[0] ?? null
}

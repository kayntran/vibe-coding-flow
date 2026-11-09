# Gọi model ngoài qua review-ext.mjs

Dùng ở bước 3 của `flow-review`. Luật `--note` và mã thoát 3 (KHÔNG gửi khi có khoá) nằm ở SKILL.md.

**Wrapper:** `review-ext.mjs` kiểm CLI sẵn sàng, chọn model, **gửi sạch**, bóc JSON đúng `review-schema.json`.

## Lệnh

```bash
node ~/.claude/hooks/review-ext.mjs --model grok|flash|codex|opus --wt "<WT>" --brief <BRIEF> --out "<S>/review-<tên>.json" --note "<1–2 câu nhánh làm gì>" < /dev/null
```
(Bash `run_in_background`; `<S>` scratchpad, `<WT>` gốc worktree, `<BRIEF>` = `review-brief.md` hoặc `review-brief-security.md`.)

Exit 0 xong · 1 lỗi/CLI chưa sẵn sàng/hết giờ ⇒ dự phòng (xem SKILL.md) · 3 xem SKILL.md. Codex >30 phút không ra file ⇒ dự phòng.

**Paseo:** đang ở Paseo, trừ Windows ⇒ lượt Codex chạy thành phiên Paseo trên bản sao đã lọc (`review-ext.mjs --prepare` … `--collect`,
skill `flow-paseo`). Windows ⇒ `review-ext.mjs --model codex` như lệnh trên [8338].

**Gửi sạch:** bỏ file bí mật/dữ liệu riêng khỏi diff và workspace, quét khoá cả dòng đã xoá, reviewer đọc thư mục tạm, không nhận
biến môi trường dạng khoá. Chỉ gửi code, không gửi dữ liệu thật và khoá.

**Codex hết lượt:** `review-ext.mjs --model codex` tự thử mọi tài khoản Codex đã đăng nhập trên máy (`~/.codex`, `~/.codex-*`) trước khi
báo hết lượt; dòng "đã chuyển sang tài khoản…" báo lại user.

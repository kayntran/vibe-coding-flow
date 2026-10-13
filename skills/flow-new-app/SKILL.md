---
name: flow-new-app
description: Tạo app mới từ số 0 cho người không code — kiểm máy, tạo dự án từ mẫu an toàn (webapp, app máy tính Wails, extension trình duyệt) có sẵn kiến trúc, máy kiểm, header bảo mật, màn đầu trống (không dữ liệu giả), bật điểm lưu, chạy và mở màn đầu. Dùng khi user nói kiểu "làm cho tôi một app…", "tôi muốn có webapp/app máy tính/extension…" mà chưa có thư mục dự án. KHÔNG dùng cho dự án đã có (dùng flow-spec), app điện thoại (chưa có mẫu — nói rõ, đề nghị webapp chạy được trên điện thoại).
---

# Flow — app mới từ số 0

Kết thúc skill = user mở được app, thấy màn đầu trống (tên app + một câu mời, không dữ liệu giả), `flow check` xanh. Sau đó sang `flow-spec` (cổng giao
diện: 5 bản demo ngay trong app này).

## 1. Hỏi gọn (AskUserQuestion, ≤3 câu, chỉ câu chưa rõ)
- Loại app: **webapp** (mở bằng trình duyệt, dùng được cả trên điện thoại) · **app máy tính** (cài trên Windows/Mac,
  làm việc với file trên máy) · **extension** (gắn vào Chrome, làm việc trên trang web đang xem). Điện thoại ⇒ chưa có
  mẫu; đề nghị webapp.
- Tên app (đặt tên thư mục, không dấu) + nơi đặt (mặc định thư mục cha của phiên).
- App có tài khoản người dùng / dữ liệu riêng từng người ⇒ "dữ liệu để đâu?" [d8dk] — gợi ý theo nhu cầu, đọc
  `recipes/` cùng thư mục: Supabase (có trang xem dữ liệu, đăng nhập sẵn — khuyên khi chưa có gì) · Cloudflare D1 (gọn
  một nhà, chạy thử không cần cài thêm) · Postgres trên VPS (user đã có máy chủ) · dịch vụ user đang dùng. Ghi sổ chốt.
  Chỉ dùng trên máy, không tài khoản ⇒ bỏ câu này.

## 2. Kiểm máy
`node ~/.claude/hooks/new-app.mjs doctor --type web|desktop|extension` ⇒ thiếu gì thì đưa ĐÚNG lệnh cài nó in (winget/
brew) để user tự chạy, đợi user báo xong rồi chạy lại doctor. Không cài ngầm.

## 3. Tạo
`node ~/.claude/hooks/new-app.mjs create --type <t> --name <tên> --dir <thư mục cha>` — lệnh tạo chính hãng ghim bản +
lớp phủ của kit (`AI_RULES.md`, `docs/arch.json` + `ARCHITECTURE.md`, `.claude/ui.json`, header/CSP, màn đầu trống, test
mẫu có `data-s`) + bật git + điểm lưu "Tạo app". Lỗi ⇒ nói lại đúng câu đời thường nó in (mạng, quyền, ổ đĩa, phần mềm
diệt virus) + việc user cần làm; không thử lách.
Mở phiên làm việc trong thư mục app mới (hoặc thêm thư mục vào phiên) trước khi sửa tiếp — mọi sửa sau đó theo
`flow-worktree`.

## 4. Chạy và mở
Chạy lệnh dev nó in (port riêng: `node ~/.claude/hooks/wt-env.mjs alloc <thư mục>`), mở app cho user (preview/trình
duyệt; app máy tính: cửa sổ app), chụp màn đầu. `node ~/.claude/hooks/flow-check.mjs --dir <thư mục>` phải xanh.
Báo user theo khuôn: app đã mở ở đâu · thấy gì · bước tiếp là chọn giao diện (5 bản demo).

## 5. Nền dữ liệu
Áp công thức đã chọn (`recipes/<tên>.md`) như task đầu của PLAN tính năng đầu tiên: đăng nhập, chặn quyền, kiểm dữ
liệu vào, DB thử cho từng làn, test `P-nn` + lần "tắt chặn quyền". Khoá bí mật chỉ ở biến môi trường (`.env.local` /
biến của nền tảng), không bao giờ trong code chạy ở trình duyệt; user tự dán khoá — AI không nhập khoá hộ.

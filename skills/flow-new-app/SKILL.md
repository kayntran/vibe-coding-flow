---
name: flow-new-app
description: Tạo app mới từ số 0 cho người không code — kiểm máy, tạo dự án từ mẫu an toàn (webapp, app máy tính Wails, extension trình duyệt) có sẵn kiến trúc, máy kiểm, header bảo mật, màn đầu trống (không dữ liệu giả), bật điểm lưu, chạy và mở màn đầu. Dùng khi user nói kiểu "làm cho tôi một app…", "tôi muốn có webapp/app máy tính/extension…" mà chưa có thư mục dự án. KHÔNG dùng cho dự án đã có (flow-feature), app điện thoại (chưa có mẫu — nói rõ, đề nghị webapp chạy được trên điện thoại).
---

# Flow — app mới từ số 0

Kết thúc skill = user mở được app, thấy màn đầu trống (tên app + một câu mời, không dữ liệu giả), `flow check` xanh. Sau đó đi theo `flow-feature`,
bắt đầu bằng hiểu người dùng (`flow-ux`) rồi 5 bản demo (`flow-ui-demo`) ngay trong app này. Tính năng đầu tiên có DESIGN.md
(`flow-system-design`): xếp hạng quy mô, phí tháng ước tính, các chỗ chống spam từ ngày đầu.

## 1. Hỏi gọn (AskUserQuestion, ≤3 câu, chỉ câu chưa rõ)
- Loại app: **webapp** (mở bằng trình duyệt, dùng được cả trên điện thoại) · **app máy tính** (cài trên Windows/Mac,
  làm việc với file trên máy) · **extension** (gắn vào Chrome, làm việc trên trang web đang xem). Điện thoại ⇒ chưa có
  mẫu; đề nghị webapp.
- Tên app (đặt tên thư mục, không dấu) + nơi đặt (mặc định thư mục cha của phiên).
- App có tài khoản người dùng / dữ liệu riêng từng người ⇒ **hỏi nhu cầu, không hỏi tên dịch vụ** [nyfb]: đã có máy chủ hay dịch vụ
  dữ liệu nào chưa · có cần trang xem/sửa dữ liệu bằng tay không · mỗi tháng chịu chi bao nhiêu · năm đầu khoảng bao nhiêu người dùng.
  Chỉ dùng trên máy, không tài khoản ⇒ bỏ câu này.

## 1b. Thiết kế rút gọn rồi mới chọn nơi lưu
Chạy `flow-system-design` bước 1–3 (yêu cầu, hạng quy mô, ước lượng + phí tháng) từ câu trả lời trên, rồi AI tự chọn nơi lưu theo
công thức `noi-luu-*.md` của skill đó (Supabase · Cloudflare D1 · Postgres trên VPS · dịch vụ user đang dùng). Báo user một câu: chọn gì,
vì sao (theo nhu cầu vừa nói), phí tháng ước tính kèm "theo bảng giá ngày …". Gợi ý gói miễn phí Supabase ⇒ nói luôn cảnh báo tạm dừng
và không sao lưu ghi trong công thức. Ghi sổ chốt.

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
Ngay sau khi tạo: chốt **những thứ khó đổi sau** theo đúng mục loại app trong `references/chot-tu-dau.md` [sww8]. Dựng **bộ token tối thiểu** (`~/.claude/skills/flow-ui-design/references/tokens.md`: 3 tầng, đủ 8 nhóm, trạng thái, sáng/tối, độ dày)
vào đúng chỗ của stack, màn đầu dùng token đó; chọn xong bản demo thì chốt lại giá trị [zgp6].

## 4. Chạy và mở
Chạy lệnh dev nó in (port riêng: `node ~/.claude/hooks/wt-env.mjs alloc <thư mục>`), mở app cho user (preview/trình
duyệt; app máy tính: cửa sổ app), chụp màn đầu. `node ~/.claude/hooks/flow-check.mjs --dir <thư mục>` phải xanh.
Báo user theo khuôn: app đã mở ở đâu · thấy gì · bước tiếp là chốt luồng và chọn giao diện.

## 5. Nền dữ liệu
Áp công thức nơi lưu đã chọn (`noi-luu-<tên>.md` trong skill `flow-system-design`) như task đầu của PLAN tính năng đầu tiên: đăng nhập, chặn quyền, kiểm dữ
liệu vào, DB thử cho từng làn, test `P-nn` + lần "tắt chặn quyền". Khoá bí mật chỉ ở biến môi trường (`.env.local` /
biến của nền tảng), không bao giờ trong code chạy ở trình duyệt; khoá đi qua kho khoá (`khoa.mjs luu` rồi `lay`), không viết giá trị vào code hay câu trả lời.

## Đọc khi cần

- `references/chot-tu-dau.md` — ngay sau khi tạo (bước 3), chỉ đọc mục đúng loại app

---
name: flow-new-app
description: Tạo app mới từ số 0 cho người không code — hỏi một buổi business rồi một buổi công nghệ (flow-business, flow-stack), kiểm máy, tạo dự án từ mẫu an toàn (webapp, webapp có trang công khai cho Google và link chia sẻ, app máy tính Wails, extension trình duyệt) có sẵn kiến trúc, máy kiểm, header bảo mật, màn đầu trống (không dữ liệu giả), bật điểm lưu, chạy và mở màn đầu. Dùng khi user nói kiểu "làm cho tôi một app…", "tôi muốn có webapp/app máy tính/extension…" mà chưa có thư mục dự án. KHÔNG dùng cho dự án đã có (flow-feature), app điện thoại (chưa có mẫu — nói rõ, đề nghị webapp chạy được trên điện thoại).
---

# Flow — app mới từ số 0

Kết thúc skill = user mở được app, thấy màn đầu trống (tên app + một câu mời, không dữ liệu giả), `flow check` xanh. Sau đó đi theo `flow-feature`,
bắt đầu bằng hiểu người dùng (`flow-ux`) rồi 5 bản demo (`flow-ui-demo`) ngay trong app này. Tính năng đầu tiên có DESIGN.md
(`flow-system-design`): xếp hạng quy mô, phí tháng ước tính, các chỗ chống spam từ ngày đầu.

## 1. Hai buổi hỏi trước khi tạo (thay cho 3 câu hỏi gọn)
Chưa có thư mục app nên cả hai buổi ghi nháp ở `<thư mục cha>/.flow-nhap/<tên-app>/` (thư mục cha = `--dir` của lệnh tạo ở bước 3).
- **Tên thư mục** (không dấu) và nơi đặt (mặc định thư mục cha của phiên): suy từ lời user kể; chưa rõ thì gộp vào vòng 1 của buổi business.
- Chạy `flow-business` ra `BUSINESS.md` (khách, tiền, pháp lý, giọng nói; user gật bản tóm tắt), rồi `flow-stack` ra `STACK.md` (gói nền, loại
  app, khung, cơ sở dữ liệu, đăng nhập, nơi chạy, thu tiền; user gật). Hai buổi hỏi hết, bước sau không hỏi lại, không tự chọn thay.
- Từ `STACK.md` lấy `loai_app`: `web` · `web-public` (trang công khai lên Google, link chia sẻ hiện đúng ảnh và tên) · `desktop` · `extension`.
  Điện thoại ⇒ chưa có mẫu; `flow-stack` đã khuyên webapp.
- User bảo bỏ qua hai buổi này ⇒ hỏi một câu loại app, ghi vào sổ chốt "chưa có BUSINESS/STACK"; lần làm tính năng đầu `flow-feature` bước 0 sẽ chạy lại.

## 2. Kiểm máy
`node ~/.claude/hooks/new-app.mjs doctor --type web|web-public|desktop|extension` ⇒ thiếu gì thì đưa ĐÚNG lệnh cài nó in (winget/
brew) để user tự chạy, đợi user báo xong rồi chạy lại doctor. Không cài ngầm.

## 3. Tạo
`node ~/.claude/hooks/new-app.mjs create --type <loai_app trong STACK.md> --name <tên> --dir <thư mục cha>` — lệnh tạo chính hãng ghim bản +
lớp phủ của kit (`AI_RULES.md`, `docs/arch.json` + `ARCHITECTURE.md`, `.claude/ui.json`, header/CSP, màn đầu trống, test
mẫu có `data-s`) + bật git + điểm lưu "Tạo app". Lỗi ⇒ nói lại đúng câu đời thường nó in (mạng, quyền, ổ đĩa, phần mềm
diệt virus) + việc user cần làm; không thử lách.
**Ngay sau khi tạo:** chép hai nháp vào `docs/BUSINESS.md` và `docs/STACK.md` của app (giữ nguyên nội dung), commit một lần, dọn
`.flow-nhap/<tên-app>/` bằng `don.mjs`; thêm vào `AI_RULES.md` mục "Công nghệ đã chốt" trỏ `docs/STACK.md` và một dòng trỏ `docs/BUSINESS.md`.
Mở phiên làm việc trong thư mục app mới (hoặc thêm thư mục vào phiên) trước khi sửa tiếp — mọi sửa sau đó theo
`flow-worktree`.
Rồi chốt **những thứ khó đổi sau** theo đúng mục loại app trong `references/chot-tu-dau.md` [sww8]. Dựng **bộ token tối thiểu** (`~/.claude/skills/flow-ui-design/references/tokens.md`: 3 tầng, đủ 8 nhóm, trạng thái, sáng/tối, độ dày)
vào đúng chỗ của stack, màn đầu dùng token đó; giọng và từ cấm của chữ trên màn lấy từ mục "Từ điển và giọng nói" của `BUSINESS.md`; chọn xong bản demo thì chốt lại giá trị [zgp6].

## 4. Chạy và mở
Chạy lệnh dev nó in (port riêng: `node ~/.claude/hooks/wt-env.mjs alloc <thư mục>`), mở app cho user (preview/trình
duyệt; app máy tính: cửa sổ app), chụp màn đầu. `node ~/.claude/hooks/flow-check.mjs --dir <thư mục>` phải xanh.
Báo user theo khuôn: app đã mở ở đâu · thấy gì · bước tiếp là chốt luồng và chọn giao diện.

## 5. Nền dữ liệu
Áp công thức nơi lưu đã chốt trong `STACK.md` (`noi-luu-<tên>.md` trong skill `flow-system-design`) như task đầu của PLAN tính năng đầu tiên: đăng nhập, chặn quyền, kiểm dữ
liệu vào, DB thử cho từng làn, test `P-nn` + lần "tắt chặn quyền". Khoá bí mật chỉ ở biến môi trường (`.env.local` /
biến của nền tảng), không bao giờ trong code chạy ở trình duyệt; khoá đi qua kho khoá (`khoa.mjs luu` rồi `lay`), không viết giá trị vào code hay câu trả lời.

## Đọc khi cần

- `references/chot-tu-dau.md` — ngay sau khi tạo (bước 3), chỉ đọc mục đúng loại app

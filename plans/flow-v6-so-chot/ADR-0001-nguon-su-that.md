# ADR-0001 · Nguồn sự thật của sổ chốt

## Bối cảnh
Quyết định dự án trước đây nằm rải rác (memory của Claude, `*.decisions.md`, mục "Đã chốt:" trong progress.md). Cần một
chỗ duy nhất, đi cùng code qua git, nhiều nhánh/worktree ghi song song được mà người dùng không phải xử lý xung đột.
Khó đảo ngược: mọi dự án sẽ có dữ liệu theo định dạng này.

## Quyết định
- File nhỏ là nguồn sự thật: mỗi quyết định một file `.claude/so-chot/<phạm vi>/<mã>-<slug>.md`, phạm vi `chung` hoặc
  thư mục spec `YYYY-MM-DD-<slug>`.
- `INDEX.md`, `ROADMAP.md`, `ROADMAP-luu-tru.md` là bản xem tự sinh, nằm trong git, gắn `merge=union` (cùng `IDEAS.md`)
  nên gộp nhánh không bao giờ xung đột; phần nạp vào phiên luôn tính từ nguồn, không từ INDEX.
- Đổi trạng thái bằng front matter (`trang_thai`), không dời file, không xoá; ↩️ suy ra từ `thay_cho` của bản mới.
- Mã quyết định 8 ký tự ngẫu nhiên `[a-z0-9]` (hiện 4 ký tự đầu); mã ý tưởng `y-` + 6 ký tự.
- Hook SessionStart chỉ đọc repo; ghi INDEX/ROADMAP chỉ ở mod khi ghi và ở bước gộp.

## Hệ quả
- Hai nhánh ghi song song không trùng tên file, không xung đột; dòng `union` trùng/lẫn được sinh lại ở lần ghi kế tiếp.
- Mọi công cụ (hook, mod, skill, migration) phải đi qua `hooks/lib/so-chot.mjs`; đổi định dạng sau này cần ADR mới.
- Bước gộp có thêm việc đóng sổ (`so-chot.mjs xong`: ghi xong + cất kho) trước khi push.

## Trạng thái
Accepted (2026-10-02)

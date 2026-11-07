---
name: flow-rollback
description: Đưa app đang chạy thật về bản trước và thử nhanh lại. Dùng khi user bảo "quay lại bản trước", "bản mới lỗi, trả về bản cũ", hoặc khi cần thử quay lại một lần theo nhắc của release. KHÔNG tự chạy khi thử nhanh trượt mà user chưa bảo; KHÔNG dùng cho hoàn tác code chưa phát hành (luu.mjs) hay xem lỗi (flow-publish).
---

# Quay lại bản trước

Việc này đổi thứ người dùng thật đang dùng, nên **chỉ làm khi user bảo**. Thử nhanh trượt sau phát hành ⇒ chỉ báo: lỗi gì, người
dùng đang thấy gì, bản nào đang chạy; không tự quay.

## Trước khi quay, nói bằng lời

- **Dữ liệu không quay theo** (D1, KV, R2, database), chỉ phần mềm quay.
- Bản mới đã đổi cấu trúc dữ liệu ⇒ bản cũ có thể không đọc được dữ liệu mới. Nói rõ điều này và hỏi lại trước khi chạy; hướng sửa dữ liệu nằm trong công thức của nền.

## Quay

- Cloudflare Workers: `node ~/.claude/hooks/release.mjs rollback [--version-id <mã>] [--url https://…]`.
- VPS: `node ~/.claude/hooks/release.mjs vps --rollback --run` (thiếu `--run` chỉ in lệnh).
- Pages, Supabase, tiện ích, desktop: không có lệnh ⇒ làm theo công thức của nền trong `../flow-publish/recipes/`.

Lệnh quay lại không qua kiểm trước phát hành vì đây là cứu hộ.

## Xong khi nào

Thử nhanh đạt trên địa chỉ thật. Trượt sau khi đã quay ⇒ lỗi có thể nằm ở dữ liệu hoặc cấu hình; nói rõ, không quay tiếp, tìm
nguyên nhân bằng `release.mjs logs` (skill `flow-publish` bước 4) hoặc agent `debugger`.

## Thử quay lại định kỳ

Sau lần phát hành đầu chỉ có một bản nên chưa thử được. **Sau lần thứ 2** chưa thử thì `release` in nhắc: nói user "người
dùng sẽ thấy bản cũ vài giây", user gật thì quay, rồi phát hành lại bản mới. **Từ lần thứ 3** vẫn chưa thử thì kiểm trước phát hành cảnh báo; user gật là qua.

## Báo user

**Đã làm gì · người dùng sẽ thấy gì · còn gì cần bạn làm**, luôn kèm câu "dữ liệu không quay theo". Bản lỗi vẫn còn trong nhánh
chính: nói việc sửa tiếp là gì (skill `flow-bugfix`).

# Tình huống khi gộp

## File trùng tên ở thư mục chính (bước 4)

File nằm sẵn ở thư mục chính trùng tên với file của nhánh ⇒ thuộc việc dở của phiên khác thì giữ nguyên và hỏi user; còn lại AI so nội dung, cất sang thư mục
sao lưu rồi gộp tiếp; không đưa lệnh cho user chép, không sửa kit.

## Bị ngắt giữa chừng (bước 10)

Chạy lại từ bước 5: `xong` idempotent, không tạo thay đổi trùng (đã `xong` thì không ghi lại, không có thay đổi thì không commit).

## `merge --ff-only` bị từ chối (bước 11)

Không ép, không stash hộ, không đụng file dở của phiên khác. Main có commit mới ⇒ `EnterWorktree` `path`
quay lại, làm lại bước 1–10; trùng file dở ⇒ hỏi user.

## CI đỏ sau push

Agent `debugger` với run id (`gh run view <id> --log-failed`) ⇒ sửa trên nhánh mới theo skill `flow-fix`.

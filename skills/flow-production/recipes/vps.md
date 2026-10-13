# Công thức phát hành: VPS

Hợp khi app chạy trên máy chủ riêng của user (xem thêm `skills/flow-new-app/recipes/postgres-vps.md` cho phần dựng
máy). Cần: ssh vào máy chủ bằng khoá (không hỏi mật khẩu), Playwright trong dự án. Kit giữ **ít nhất 3 bản gần nhất**
và KHÔNG tự xoá bản nào — chỉ liệt kê bản cũ để user dọn tay.

## Hai kiểu
- `--mode symlink`: chép bản build vào `<root>/releases/<mã commit>/`, trỏ `current` sang đó (`--service` + `--sudo`
  nếu cần khởi động lại dịch vụ systemd). Bản trước được nhớ trong `.previous`.
- `--mode docker`: đổi `IMAGE_TAG` rồi `docker compose up -d` trong `<root>`; bản trước nhớ ở `.previous-image-tag`.
  Image phải được dựng/đẩy trước đó với thẻ là mã commit.

## Phát hành
1. Xem kế hoạch (không chạy gì): `node ~/.claude/hooks/release.mjs vps --mode symlink --host user@máy --root /srv/app [--dist dist] [--service tên] [--sudo]`
   — in lệnh phát hành, lệnh quay lại (một lệnh), lệnh liệt kê bản cũ hơn 3 bản. Kể cho user bằng lời.
2. User gật ⇒ chạy thật: thêm `--run --url https://<địa-chỉ-thật> [--zap-exit N] [--has-data] [--first-release]`.
   Tự chạy preflight (chặn ⇒ chưa đụng máy chủ), chép/chuyển bản, chạy `@smoke`; trượt ⇒ tự quay về bản trước.
   Đạt ⇒ kit nhớ cấu hình máy chủ trong `.claude/release.json` (lần sau khỏi nhập lại) và đặt mốc nhắc xem lỗi.

## Quay lại
`node ~/.claude/hooks/release.mjs vps --rollback --run --url https://<địa-chỉ-thật>` (không qua preflight — cứu hộ).
Đạt ⇒ ghi "đã thử quay lại". Nói user: dữ liệu database không quay theo. Chưa có bản trước ⇒ lệnh báo lỗi, không đụng gì.

## Xem lỗi
`node ~/.claude/hooks/release.mjs logs --since 24h` (symlink: nhật ký `journalctl` mức lỗi của `--service`; docker:
`docker compose logs`). Lỗi nối ssh ⇒ kiểm khoá ssh và tên máy chủ.

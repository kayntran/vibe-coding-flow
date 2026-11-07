# Công thức phát hành: tiện ích trình duyệt (Chrome / Edge / Firefox)

Không có lệnh quay lại, và bản mới phải qua duyệt của store nên **không thử được trên bản thật trước khi lên**. Việc
của AI: đóng gói + thử bản nạp tay + dẫn user bấm từng bước. User tự bấm **Gửi duyệt** (cần tài khoản nhà phát hành).
Preflight chạy trước như mọi nền (SKILL bước 2). Mọi bước dưới đây: (chưa chạy thật với store).

## Trước khi gửi
1. Tăng số phiên bản trong manifest (số sau luôn lớn hơn số trước).
2. Đóng gói: `pnpm exec wxt zip` (dự án WXT) — ra file `.zip` trong `.output/`.
3. Thử bản `.zip` bằng cách nạp tay: Chrome → `chrome://extensions` → bật **Chế độ nhà phát triển** → **Tải tiện ích đã giải nén**.
   Chạy luồng chính, chạy `@smoke` nếu có. Khoá bí mật không được nằm trong gói (preflight đã quét).
4. Nói user bằng lời: bản mới sẽ chờ duyệt (thường vài giờ đến vài ngày), trong lúc đó người dùng vẫn dùng bản cũ.

## Gửi duyệt (user bấm)
- **Chrome Web Store:** Developer Dashboard → chọn tiện ích → **Package** → **Upload new package** → chọn `.zip` →
  **Submit for review**. Chỉ tiện ích trên 10.000 người dùng/7 ngày mới được phát hành dần theo phần trăm.
- **Edge Add-ons / Firefox AMO:** làm tương tự trên trang nhà phát hành của họ (tải gói lên → gửi duyệt).
- Tự động hoá `pnpm exec wxt submit` cần OAuth Google Cloud — quá khó cho người mới, chỉ khi user đòi (`--dry-run` để thử khoá).

## Quay lại bản trước
Không có lệnh. Hai đường, chọn một và nói rõ cho user:
- **Chrome:** Dashboard → **Package** → **Roll back to previous version** (đăng lại bản trước với SỐ HIỆU MỚI, khoảng
  1 phút, không cần duyệt; cũng huỷ được bản đang chờ duyệt).
- **Store khác / không có nút:** sửa mã về bản cũ, **tăng số phiên bản** (không dùng lại số cũ), đóng gói và gửi duyệt lại.
Sau khi thử một lần thật, ghi `rollbackTested: true` vào `.claude/release.json`. Xem lỗi: không có nhật ký trung
tâm — hỏi user có báo lỗi nào từ trang **Reviews/Support** của store không.

<!-- Mẫu trang chăm sóc app (AC-23b). Chép vào docs/RUNBOOK.md, điền chỗ <…>, xoá chú thích. Viết cho người không code:
     câu ngắn, nói việc cần làm, không dán khoá/mật khẩu. Mục không áp dụng thì bỏ. -->
# Chăm sóc <tên app>

## App ở đâu
- Địa chỉ: <https://…> · Chạy trên: <Cloudflare Workers / Pages / VPS / …> · Dữ liệu nằm ở: <D1 / Supabase / máy chủ…>
- Tài khoản cần có: <dịch vụ → ai đứng tên>. Phí hàng tháng: <số tiền hoặc "miễn phí">.

## Xem app có lỗi không
- Nhờ AI: nói "app có lỗi không" — AI đọc nhật ký rồi kể lại bằng lời.
- Nhật ký nằm ở: <Cloudflare Workers Logs / Supabase Logs / máy chủ>. Gói miễn phí chỉ giữ <3 ngày / 1 ngày>.
- Mốc nhắc xem lỗi: 1 ngày và 7 ngày sau mỗi lần phát hành (tự nhắc khi mở phiên làm việc).

## Cập nhật app
- Nhờ AI: nói "phát hành bản mới". AI quét bảo mật, kiểm điều kiện, đưa bản mới lên và chạy thử nhanh trước khi mở cho mọi người.
- Bản mới chỉ mở cho mọi người khi bài thử nhanh đạt; trượt thì người dùng vẫn thấy bản cũ.

## Quay lại bản trước
- Nhờ AI: nói "quay lại bản trước". Cách làm cho nền này: <lệnh `release rollback` / các bước bấm trong bảng điều khiển>.
- Lưu ý: dữ liệu (database, file) KHÔNG quay theo, chỉ phần mềm.

## Sao lưu và khôi phục
- <Có: chi tiết ở docs/BACKUP.md — tự chạy mỗi <n> giờ, cất ở <chỗ>; khôi phục thử gần nhất <ngày>.>
- <Không: "Chưa sao lưu — đã hỏi và bạn chọn không" / "Supabase miễn phí: nên nâng Pro nếu dữ liệu quan trọng".>

## Khi khoá bí mật bị lộ
- Nói với AI "khoá bị lộ". Thứ tự: tạo khoá mới → thay vào app → phát hành → thu hồi khoá cũ. Không gửi khoá qua chat.
- Các khoá của app (chỉ TÊN, không giá trị): <TÊN_KHOÁ → dịch vụ → nơi đặt>.

## Việc định kỳ
- Mỗi 30 ngày: nhờ AI "khám sức khoẻ app" (cập nhật thư viện, kiểm lỗ hổng, kiểm sao lưu).

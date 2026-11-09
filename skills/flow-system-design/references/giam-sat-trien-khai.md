# Giám sát và triển khai

Dùng ở bước 8 của `flow-system-design`.

## Mục lục
- Log có cấu trúc
- Bốn tín hiệu vàng
- Cảnh báo
- Theo dõi chi phí
- Xem lỗi bản thật
- Môi trường theo hạng
- Phát hành dần, cờ tính năng, quay lại
- Hạ tầng dạng code
- Khi nào CHƯA cần
- Nguồn

Kết quả ghi vào mục "Giám sát" và "Triển khai" của DESIGN.md. Cỡ M chỉ cần dòng nào khác mặc định của dự án.

## Log có cấu trúc

Log có cấu trúc (mỗi dòng log là một đối tượng JSON có trường cố định, máy lọc được).

- Trường tối thiểu: `ts`, `level`, `route`, `userId` (hoặc mã ẩn danh), `tenantId`, `requestId`, `event`, `outcome`, `ms`.
- Ghi: đăng nhập thành/bại, bị từ chối quyền, việc tốn tiền (gửi SMS, gọi AI, thanh toán), lỗi lời gọi ngoài, việc nền lỗi.
- **Không ghi:** mật khẩu, token, khoá, cookie, chuỗi kết nối, số thẻ, mã OTP, toàn bộ body request, nội dung prompt có dữ liệu
  riêng. Che số điện thoại/email (`09******12`).
- Giới hạn độ dài trường, không nối thẳng chuỗi người dùng nhập vào dòng log (chống giả dòng log).
- Một `requestId` đi xuyên Worker → queue → consumer để lần theo một việc.
- Log ngừng âm thầm cũng là sự cố: có một số đo "số dòng log/giờ" hoặc kiểm tay mỗi tuần (kinh nghiệm).

## Bốn tín hiệu vàng

| Tín hiệu | Nghĩa | Đo gì trên app kit |
|---|---|---|
| Độ trễ | Bao lâu mới trả lời | 95% request của luồng chính; tách request lỗi ra đo riêng |
| Lưu lượng | Bao nhiêu việc | Request/phút, lượt đặt/đơn/tin gửi mỗi giờ |
| Lỗi | Bao nhiêu thất bại | Tỉ lệ 5xx, tỉ lệ việc nền lỗi, tỉ lệ SMS/email không giao |
| Độ bão hoà | Còn bao xa trần | Hàng đọc/ghi D1 so với trần ngày, tồn đọng queue, tiền AI đã tiêu so với trần |

Trên Workers/D1, "bão hoà" thường là **trần gói** chứ không phải CPU máy ⇒ đo số đã dùng so với trần (tra bảng số liệu có ngày).

## Cảnh báo

- Chỉ báo người khi **người dùng đang bị ảnh hưởng** và **có việc để làm** ngay. Còn lại vào báo cáo tuần.
- Mỗi cảnh báo ghi: ngưỡng, ai nhận (người vận hành duy nhất ⇒ email + điện thoại), việc đầu tiên phải làm.
- Bộ tối thiểu (ngưỡng là kinh nghiệm, không phải số đo):

| Cảnh báo | Ngưỡng gợi ý | Việc đầu tiên |
|---|---|---|
| Tỉ lệ lỗi luồng chính | > 2% trong 10 phút | Xem lỗi bản thật, quay lại nếu vừa phát hành |
| Trang chính không trả lời | 2 lần kiểm liên tiếp | Xem trạng thái Cloudflare/Supabase |
| Tồn đọng queue | Tăng liên tục 30 phút | Xem consumer, dead letter queue |
| Chi phí ngày | > 2× trung bình 7 ngày | Xem có bị spam, bật chặn |
| Gần trần gói | ≥ 80% trần ngày/tháng | Nâng gói hoặc giảm tải trước khi bị chặn |

- Không cảnh báo theo CPU, bộ nhớ, từng lỗi lẻ: không hành động được, người nhận sẽ tắt thông báo.

## Theo dõi chi phí

- Khoản đội nhanh nhất: AI, SMS, email, băng thông file. Mỗi khoản có **trần cứng** trong code (theo người dùng/ngày và
  toàn app/ngày) ⇒ chạm trần thì ngừng gửi và báo, không âm thầm tiêu tiếp.
- Đếm ở phía mình (bảng đếm theo ngày) — không chờ hoá đơn cuối tháng.
- Bật cảnh báo/giới hạn chi tiêu của nhà cung cấp nếu có (kiểm trang gốc từng nơi). AI Gateway có rate limit trả 429
  khi vượt, giúp tránh hoá đơn bất ngờ.
- Nhắc user: "Tháng này app tiêu X, dự kiến Y" — câu hỏi đời thường: "Hoá đơn vượt bao nhiêu thì phải báo bạn ngay?"
  → khuyên: vượt 1,5× tháng trước.

## Xem lỗi bản thật

- Lỗi người dùng gặp trên bản đang chạy phải xem được không cần mở máy người dùng: `flow-publish` lo cách xem.
- Lỗi gửi kèm `requestId`, phiên bản app, route; không kèm dữ liệu riêng.
- App máy tính/extension: báo crash riêng, xem phần đó trong thiết kế app máy tính.

## Môi trường theo hạng

| Hạng | Môi trường | Ghi chú |
|---|---|---|
| Prototype | dev (máy) + prod | Không có người dùng thật nhiều ⇒ không cần staging |
| MVP | dev + bản xem thử theo nhánh (preview) + prod | DB riêng cho preview, **không** dùng dữ liệu thật |
| Đang tăng | dev + staging + prod | Staging giống prod về cấu hình, dữ liệu giả |
| Quy mô lớn | Như trên + phát hành dần theo phần trăm | |

Luật: khoá bí mật và DB tách riêng từng môi trường; bản thử không gửi SMS/email thật (chuyển sang hộp thư thử).

## Phát hành dần, cờ tính năng, quay lại

- Quy trình đưa bản lên mạng: `flow-release`. Quay về bản trước: `flow-rollback`.
- Cờ tính năng (feature flag — công tắc bật/tắt một phần app không cần phát hành lại). Cần khi: tính năng rủi ro (tiền, AI tốn
  phí), muốn tắt nhanh khi quá tải, hoặc bật cho vài tiệm/khách trước. Mặc định: một bảng hoặc khoá KV `flags`, không mua
  dịch vụ riêng. Xoá cờ sau khi ổn định 2–4 tuần (kinh nghiệm) — cờ cũ là code chết.
- Phát hành dần (canary — cho một phần nhỏ người dùng bản mới trước): chưa cần dưới hạng đang tăng; trước đó dùng cờ theo tenant.
- Migration DB đi trước code và tương thích ngược ⇒ quay code không làm hỏng dữ liệu.
- App máy tính, extension: không quay ép được ⇒ phát hành theo kênh (thử nghiệm → ổn định) và giữ server tương thích bản cũ.

## Hạ tầng dạng code

IaC (hạ tầng dạng code — mô tả DB, queue, tên miền bằng file trong git thay vì bấm trên trang quản trị).
- Mặc định kit: file cấu hình `wrangler` và thư mục migration trong git là đủ — đã là hạ tầng dạng code cho Workers/D1.
- Supabase: migration và policy RLS trong git, không sửa tay trên trang quản trị.
- Terraform/Pulumi: chưa cần tới khi có từ 2 môi trường giống nhau phải dựng lại thường xuyên, hoặc nhiều nhà cung cấp
  cần tạo cùng lúc (kinh nghiệm).

## Khi nào CHƯA cần

- Hệ thống trace phân tán, bảng điều khiển tự dựng: chưa cần khi có dưới ~3 thành phần chạy riêng; dùng log có sẵn của nền tảng.
- Trực sự cố theo ca, quy trình sau sự cố dài: một người vận hành ⇒ ghi một dòng "chuyện gì, sửa gì" là đủ.
- Staging riêng ở prototype; Terraform ở MVP một nhà cung cấp.

## Nguồn

- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://sre.google/sre-book/monitoring-distributed-systems/
- https://developers.cloudflare.com/ai-gateway/configuration/rate-limiting/
- https://developers.cloudflare.com/d1/platform/pricing/ (D1 Free chặn khi chạm trần ngày)
- https://github.com/codejunkie99/system-design-skill (walking skeleton, deploy sớm)
- Chưa có nguồn trong bộ nghiên cứu: ngưỡng cảnh báo cụ thể, cờ tính năng, phát hành dần, IaC, cảnh báo chi tiêu của
  từng nhà cung cấp.

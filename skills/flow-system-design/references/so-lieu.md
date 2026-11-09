# Số liệu giá và giới hạn gói (có ngày)

Dùng ở bước 3 và 10 của `flow-system-design`.

**Kiểm lại trang gốc trước khi báo giá cho user.** Tra ngày 2026-11-09. Đây là file DUY NHẤT của skill được ghi giá và giới hạn.
Ghi trong DESIGN.md: "(tra <trang> ngày 2026-11-09)". Trang gốc đổi số ⇒ sửa file này, không sửa rải rác.

## Mục lục
- Cloudflare Workers
- Cloudflare D1
- Cloudflare KV, R2, Queues
- Durable Objects, Rate Limiting binding, Workers AI, Turnstile
- Supabase
- Resend
- Điểm dễ bất ngờ
- Chưa xác minh

## Cloudflare Workers

| Mục | Free | Paid | URL |
|---|---|---|---|
| CPU mỗi request | 10 ms | mặc định 30 s, nâng tới 5 phút | https://developers.cloudflare.com/workers/platform/limits/ (trang cập nhật 2026-10-29) |
| Bộ nhớ mỗi isolate | 128 MB | 128 MB | như trên |
| Subrequest mỗi request | 50 | 10.000 (nâng tới 10 triệu) | như trên |
| Kết nối ra ngoài đồng thời đang chờ header | 6 | 6 | như trên |
| Request mỗi ngày | 100.000 | không giới hạn | như trên |
| Cron Triggers | 5 / tài khoản | 250 | như trên |
| Số Worker | 100 | 500 | như trên |
| Giá | 0 | tối thiểu $5/tháng, gồm 10 triệu request + 30 triệu ms CPU; quá: $0,30/triệu request, $0,02/triệu ms CPU | https://developers.cloudflare.com/workers/platform/pricing/ |

## Cloudflare D1

| Mục | Free | Paid | URL |
|---|---|---|---|
| Cỡ một DB | 500 MB | 10 GB | https://developers.cloudflare.com/d1/platform/limits/ |
| Tổng lưu trữ / tài khoản | 5 GB | 1 TB | như trên |
| Số DB | 10 | 1.000.000 (100.000 đầu gồm sẵn) | như trên |
| Truy vấn / lần gọi Worker | 50 | 1.000 | như trên |
| Cỡ tối đa một hàng / BLOB / chuỗi | 2 MB | 2 MB | như trên |
| Thời gian tối đa một câu SQL | 30 s | 30 s | như trên |
| Tham số bind / câu | 100 | 100 | như trên |
| Hàng đọc | 5 triệu/ngày, chạm trần ⇒ chặn truy vấn | 25 tỷ/tháng gồm sẵn, quá $0,001/triệu | https://developers.cloudflare.com/d1/platform/pricing/ |
| Hàng ghi | 100.000/ngày, chạm trần ⇒ chặn | 50 triệu/tháng gồm sẵn, quá $1,00/triệu | như trên |
| Lưu trữ | 5 GB | 5 GB gồm sẵn, quá $0,75/GB-tháng | như trên |
| Time Travel (khôi phục về mốc thời gian) | 7 ngày | 30 ngày | https://developers.cloudflare.com/d1/reference/time-travel/ |
| Bản đọc phụ (read replication) | — | không tính thêm tiền lưu trữ/tính toán, vẫn tính hàng đọc/ghi | https://developers.cloudflare.com/d1/best-practices/read-replication/ |

## Cloudflare KV, R2, Queues

| Mục | Free | Paid | URL |
|---|---|---|---|
| KV đọc / ghi | 100.000 đọc/ngày; 1.000 ghi/ngày (khoá khác nhau) | không giới hạn | https://developers.cloudflare.com/kv/platform/limits/ |
| KV ghi cùng một khoá | tối đa 1 lần/giây | như Free | như trên |
| KV cỡ giá trị · cỡ khoá · thao tác/lần gọi | ≤ 25 MiB · ≤ 512 byte · 1.000 | như Free | như trên |
| R2 lưu trữ (Standard) | 10 GB-tháng miễn phí | $0,015/GB-tháng | https://developers.cloudflare.com/r2/pricing/ |
| R2 Class A (ghi, liệt kê) | 1 triệu/tháng | $4,50/triệu | như trên |
| R2 Class B (đọc) | 10 triệu/tháng | $0,36/triệu | như trên |
| R2 tải ra internet | miễn phí | miễn phí | như trên |
| Queues thao tác | 10.000/ngày; giữ tin cố định 24 giờ | 1 triệu/tháng gồm sẵn, quá $0,40/triệu | https://developers.cloudflare.com/queues/platform/pricing/ |
| Queues cách đếm | mỗi 64 KB ghi/đọc/xoá = 1 thao tác; mỗi lần thử lại = thêm 1 đọc | như Free | như trên |
| Queues giới hạn | tin ≤ 128 KB; thử lại tối đa 100 lần; batch ≤ 100 tin; 5.000 tin/giây/hàng đợi; giữ tới 14 ngày; backlog 25 GB; 250 consumer chạy đồng thời; hoãn gửi tối đa 24 giờ | | https://developers.cloudflare.com/queues/platform/limits/ |

## Durable Objects, Rate Limiting binding, Workers AI, Turnstile

| Mục | Free | Paid | URL |
|---|---|---|---|
| DO request | 100.000/ngày | 1 triệu/tháng gồm sẵn, quá $0,15/triệu | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO thời gian chạy | 13.000 GB-s/ngày | 400.000 GB-s gồm sẵn, quá $12,50/triệu GB-s | như trên |
| DO lưu trữ SQLite | 5 triệu đọc/ngày, 100.000 ghi/ngày, 5 GB | tính kiểu D1; lưu trữ $0,20/GB-tháng | như trên |
| DO giới hạn | mềm ~1.000 request/giây/đối tượng; CPU 30 s/request (nâng tới 5 phút); tin WebSocket nhận ≤ 32 MiB; 20 tin WebSocket đến = 1 request tính phí, tin đi không tính | | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Rate Limiting binding | cửa sổ chỉ 10 hoặc 60 giây; gọi `env.X.limit({ key })` | | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Workers AI | 10.000 Neurons/ngày (đặt lại 00:00 UTC) | $0,011/1.000 Neurons; ví dụ llama-3.2-1b $0,027/triệu token vào, $0,201/triệu token ra | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Turnstile | tối đa 20 widget, 10 hostname/widget, xác minh không giới hạn | Enterprise: không giới hạn widget, 200 hostname/widget | https://developers.cloudflare.com/turnstile/plans/ |

## Supabase

Nguồn chung: https://supabase.com/pricing (tra 2026-11-09).

| Mục | Free | Pro (từ $25/tháng) | Team (từ $599/tháng) |
|---|---|---|---|
| DB gồm sẵn | 500 MB | 8 GB/dự án, quá $0,125/GB | như Pro |
| Người dùng hoạt động/tháng (MAU) | 50.000 | 100.000, quá $0,00325/MAU | như Pro |
| Storage (file) | 1 GB | 100 GB, quá $0,0213/GB | như Pro |
| Tải ra (egress) | 5 GB | 250 GB, quá $0,09/GB | như Pro |
| Cỡ file tải lên tối đa | 50 MB | trang ghi 500 GB (chưa đối chiếu) | như Pro |
| Tạm dừng khi không dùng | sau 1 tuần | không | không |
| Sao lưu | không có | 7 ngày | 14 ngày |
| Realtime | 200 kết nối đồng thời, 2 triệu tin | 500 kết nối (quá $10/1.000), 5 triệu tin (quá $2,50/triệu) | như Pro |
| Edge Functions | 500.000 lượt | 2 triệu (quá $2/triệu) | như Pro |
| Máy chạy DB | CPU chia sẻ, 500 MB RAM | Micro (tín dụng $10 phủ một dự án); Small $15, Medium $60, Large $110, XL $210 /tháng/dự án | như Pro |

## Resend

Nguồn: https://resend.com/pricing (tra 2026-11-09).

| Mục | Free | Pro |
|---|---|---|
| Số email | 3.000/tháng, 100/ngày | $20/tháng cho 50.000; $35/tháng cho 100.000; không trần ngày |
| Domain | 3 | 10 |
| Tốc độ mỗi giây | trang nói "giống mọi gói", không ghi số | như Free |

## Điểm dễ bất ngờ

| Điểm | Người dùng sẽ gặp | Làm gì |
|---|---|---|
| D1 Free chạm trần hàng đọc/ghi ngày ⇒ **chặn truy vấn**, không tính thêm tiền | Quá tải hiện ra là lỗi cả app tới hết ngày (UTC), không phải hoá đơn | App có người thật ⇒ gói trả phí; index đúng để giảm hàng đọc |
| D1 tính cả hàng index khi ghi (suy luận) | Một lần lưu có thể tính nhiều hàng ghi | Đừng thêm index thừa |
| Supabase Free tạm dừng sau 1 tuần không dùng | App demo/ít dùng tự "chết", phải bật lại tay | App có người thật ⇒ gói Pro |
| Supabase Free **không có sao lưu** | Xoá nhầm hay hỏng là mất hẳn | Gói Pro hoặc tự sao lưu (`flow-backup`) |
| Rate Limiting binding **đếm riêng từng địa điểm**, gần đúng, nhất quán cuối cùng | Kẻ xấu gọi từ nhiều nơi có thể vượt giới hạn | Đủ cho chống spam thường; cần chặt toàn cục (trần tiền, gửi mã) ⇒ đếm trong Durable Object hoặc DB |
| Workers Free CPU rất thấp mỗi request | Băm mật khẩu kiểu Argon2/scrypt, xử lý ảnh, PDF có thể bị cắt giữa chừng (suy luận, chưa đo) | Gói trả phí hoặc đẩy việc nặng ra queue |
| KV ghi cùng khoá tối đa 1 lần/giây | Bộ đếm lượt xem trong KV mất số | Bộ đếm nóng ⇒ Durable Object hoặc DB |
| Queues Free giữ tin cố định 24 giờ | Consumer hỏng qua đêm là mất tin | App có việc nền quan trọng ⇒ gói trả phí, đặt thời gian giữ dài hơn |
| D1 Time Travel khôi phục **ghi đè tại chỗ**, ngắt truy vấn đang chạy | Mất mọi thứ ghi sau mốc chọn | Lưu bookmark trước khi khôi phục để hoàn tác |
| Resend Free trần 100 email/ngày | Đợt đăng ký đông hoặc gửi hàng loạt bị từ chối giữa chừng | Gửi hàng loạt ⇒ gói trả phí, gửi qua queue |
| R2 tải ra internet miễn phí; Supabase tính egress | Cùng lượng tải file, hoá đơn khác hẳn | File tải nhiều ⇒ R2 |

## Chưa xác minh

- Durable Objects: trang giới hạn tự mâu thuẫn về dung lượng mỗi đối tượng (bảng ghi 10 GB, FAQ nói Free 1 GB).
- Supabase Pro "upload tối đa 500 GB": chưa đối chiếu trang giới hạn của docs; giới hạn kết nối DB chưa tra.
- Turnstile: trang gói không nói rõ bản thường có miễn phí; số lấy từ bảng gói.
- D1 read replication: trang không nói đã chính thức (GA) hay còn beta.
- D1 có tính hàng index vào hàng ghi không: suy luận, chưa thấy trang giá nói rõ.
- Resend: số email/giây chưa có trên trang. Chưa tra SES, Postmark, Cloudflare Email.
- AI Gateway: có giới hạn tần suất trả 429 (https://developers.cloudflare.com/ai-gateway/configuration/rate-limiting/); giá và log chi phí chưa tra.
- Postgres trên VPS (Hetzner, DigitalOcean…): chưa lấy giá.
- Giá SMS/OTP (Twilio…): chưa lấy giá.

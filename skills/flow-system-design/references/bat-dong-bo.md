# Việc chạy nền, hàng đợi, hẹn giờ

Dùng ở bước 5–8 của `flow-system-design`.

## Mục lục
- Khi nào CHƯA cần queue
- Chọn cách chạy nền
- Thử lại có lùi dần và có trần
- Hàng đợi chết (dead-letter queue)
- Consumer chịu được tin trùng
- Thứ tự tin
- Giới hạn CPU của Workers
- Gửi hàng loạt
- Webhook nhận vào
- Nguồn

Mở khi có việc chạy nền, gửi đi hàng loạt, gọi dịch vụ ngoài chậm, hoặc việc hẹn giờ. Mọi queue trong thiết kế phải ghi rõ hai thứ:
**giao tin kiểu gì** (ít nhất một lần ⇒ có thể trùng) và **consumer chống trùng bằng gì**.

## Khi nào CHƯA cần queue

- Việc xong trong vài trăm ms ngay trong request và lỗi thì người dùng bấm lại được ⇒ chưa cần.
- Hạng prototype, không gửi đi gì ⇒ chưa cần.
- Chỉ cần "làm sau khi trả phản hồi, mất cũng không sao" (ghi log phân tích) ⇒ chạy tiếp sau phản hồi trong cùng Worker, chưa cần queue.
- Việc định kỳ đơn giản (dọn dữ liệu hết hạn mỗi đêm) ⇒ Cron Trigger là đủ.

**Cần queue khi** có ít nhất một: người dùng phải chờ vài giây cho một thao tác (kinh nghiệm); việc vượt trần CPU một request;
gọi dịch vụ ngoài hay lỗi/chậm (email, SMS, AI, webhook gửi đi) mà phải thử lại; đợt dồn đoán trước được (đầu tháng gia hạn hàng
loạt, khuyến mãi) cần san tải; gửi cho nhiều người một lúc.

## Chọn cách chạy nền

| Cách | Hợp | Cần biết |
|---|---|---|
| Làm tiếp sau khi trả phản hồi (cùng Worker) | Việc phụ ngắn, mất cũng được | Không thử lại, không đảm bảo xong (chưa xác minh trong research) |
| **Cloudflare Queues** (mặc định cho việc nền) | Email, SMS, AI, xuất file, xử lý ảnh, webhook gửi đi | Có thử lại, lô tin, hoãn gửi, hàng đợi chết; tin có trần cỡ và thời gian giữ ⇒ tra bảng số liệu có ngày |
| Cron Trigger | Việc định kỳ: dọn dữ liệu, đối soát thanh toán, gửi tóm tắt ngày | Số cron có trần theo gói; cron chỉ nên **đẩy việc vào queue**, không tự làm việc nặng |
| Durable Object (đối tượng có trạng thái riêng, chạy một bản) | Việc phải tuần tự theo một khoá (một phòng chat, một tài khoản), bộ đếm chính xác | Mỗi đối tượng có trần request/giây mềm |
| App máy tính (Wails) | Việc nặng trên máy user | Goroutine nền + báo tiến trình lên giao diện; app tắt là dừng ⇒ lưu tiến độ để chạy tiếp |

Người dùng chờ kết quả việc nền ⇒ trả ngay mã việc (job id), màn hình hỏi lại trạng thái hoặc nhận qua SSE; không giữ request mở.

## Thử lại có lùi dần và có trần

- Mỗi lần gọi ra ngoài có **timeout** (không chờ vô hạn).
- Thử lại với **lùi dần theo cấp số** (1 s, 2 s, 4 s, 8 s… cộng chút ngẫu nhiên) để không dội lại dịch vụ đang ốm.
- Có **trần số lần** (vd 5) và trần tổng thời gian; hết trần ⇒ chuyển sang hàng đợi chết, không thử mãi.
- Chỉ thử lại lỗi tạm (timeout, 429, 5xx). Lỗi vĩnh viễn (400, sai địa chỉ email, thẻ bị từ chối) ⇒ dừng ngay, ghi lý do.
- Dịch vụ trả 429 có `Retry-After` ⇒ chờ đúng thời gian đó.
- Trên Cloudflare Queues mỗi lần thử lại tính thêm một thao tác ⇒ thử lại vô tội vạ là tốn tiền.

## Hàng đợi chết (dead-letter queue)

Hàng đợi chết (DLQ — nơi chứa tin đã thử hết lần mà vẫn lỗi) để tin hỏng không chặn tin khác và không mất im lặng.

- Mỗi queue quan trọng có một DLQ. Cảnh báo khi DLQ có tin (đây là triệu chứng người dùng sẽ thấy: email không tới, đơn không giao).
- Có cách gửi lại tin từ DLQ sau khi sửa lỗi (lệnh hoặc nút trong trang quản trị).
- Chưa cần: queue cho việc mất cũng không sao.

## Consumer chịu được tin trùng

Queue và webhook giao **ít nhất một lần** ⇒ cùng một tin có thể đến hai lần (thử lại sau khi đã làm xong nhưng chưa kịp báo).

- Mỗi tin mang khoá ý định (ID đơn, ID sự kiện, khoá idempotency). Consumer ghi "đã xử lý khoá X" **trong cùng giao dịch** với việc
  chính; gặp lại X ⇒ bỏ qua.
- Gọi dịch vụ ngoài có hỗ trợ khoá idempotency (Stripe) ⇒ truyền khoá đó qua.
- Gửi email/SMS (không gói vào giao dịch được vì là việc bên ngoài): **giành lượt trước khi gửi** — chèn bản ghi
  (người nhận, loại thư, ID nguồn) trạng thái "đang gửi" có ràng buộc duy nhất; chèn được mới gọi nhà cung cấp, xong đổi "đã gửi".
  Ghi "đã gửi" SAU khi gửi là sai: hỏng giữa hai bước ⇒ chạy lại gửi đôi. Nhà cung cấp từ chối rõ ràng (tin chưa đi) ⇒ đổi "lỗi",
  nhả lượt để thử lại. Chỉ khi không rõ kết quả mới giữ "đang gửi"; kẹt quá lâu ⇒ không tự gửi lại, báo người
  xem (thiếu một tin hiếm khi hại bằng gửi đôi tốn tiền); nhà cung cấp có khoá chống trùng thì truyền thêm.
- Bài kiểm: đẩy cùng một tin hai lần ⇒ đúng một email, đúng một lần trừ điểm.

## Thứ tự tin

- **Không dựa vào thứ tự** tin đến. Lô tin, thử lại, nhiều consumer song song đều làm đảo thứ tự; webhook Stripe nói rõ không đảm bảo thứ tự.
- Cần trạng thái mới nhất ⇒ consumer đọc lại đối tượng từ nguồn gốc (gọi API lấy đối tượng), không áp tin theo thứ tự nhận.
- So phiên bản/thời điểm sửa trên đối tượng, bỏ tin cũ hơn bản đang có.
- Thật sự cần tuần tự theo một khoá (các bước của một đơn) ⇒ dồn qua một Durable Object theo khoá đó.

## Giới hạn CPU của Workers

- Mỗi request Worker có trần CPU; bản Free rất thấp (số cụ thể: tra bảng số liệu có ngày). Băm mật khẩu kiểu Argon2/scrypt, xử lý
  ảnh, tạo PDF, đọc file Excel lớn có thể vượt (suy luận, chưa đo) ⇒ đẩy ra queue consumer (có trần CPU cao hơn ở gói trả phí) hoặc
  dịch vụ chuyên dụng.
- Trần số lần gọi ra ngoài (subrequest) mỗi request ⇒ gửi 1.000 email trong một request là sai thiết kế; chia lô qua queue.
- Việc rất dài (vài phút) ⇒ chia thành nhiều tin nhỏ, mỗi tin một phần, lưu tiến độ trong DB.

## Gửi hàng loạt

- Không gửi trong request của người bấm nút. Request chỉ tạo "đợt gửi" + đẩy tin vào queue theo lô.
- Tôn trọng giới hạn tốc độ của nhà cung cấp email/SMS và trần ngày của gói (gói miễn phí email có trần ngày thấp ⇒ tra bảng số liệu có ngày).
- Mỗi người nhận một bản ghi trạng thái (chờ · đã gửi · lỗi · bỏ qua vì đã huỷ nhận) ⇒ gửi lại được phần lỗi, không gửi trùng phần đã xong.
- Kiểm danh sách huỷ nhận trước khi gửi. Có nút dừng đợt gửi.
- Ước chi phí đợt gửi trước khi bấm (số người × đơn giá) và chặn nếu vượt trần tháng (N7 ở bước 1).

## Webhook nhận vào

- Xác minh chữ ký trên **thân thô** của request, rồi trả 2xx **ngay**; việc nặng đẩy vào queue.
- Lưu ID sự kiện đã xử lý, bỏ qua trùng.
- Stripe thử lại tới vài ngày; Lemon Squeezy chỉ thử lại vài phút ⇒ cần job đối soát định kỳ (cron) so với API nhà cung cấp để bắt sự kiện bị lỡ (suy luận).
- Đợt dồn đầu tháng (gia hạn hàng loạt) ⇒ queue san tải.

## Nguồn

- Queues giới hạn và giá (thử lại, lô, giữ tin, hoãn, thử lại tính thêm thao tác): https://developers.cloudflare.com/queues/platform/limits/ · https://developers.cloudflare.com/queues/platform/pricing/
- Trần CPU, subrequest, Cron Triggers: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects: https://developers.cloudflare.com/durable-objects/platform/limits/
- Mọi queue nêu kiểu giao + idempotency; hiệu ứng ra ngoài phải idempotent: https://github.com/pinchen147/system-design-skill
- Timeout + thử lại có trần + idempotency cho thao tác tính tiền/gửi: https://github.com/codejunkie99/system-design-skill
- Chờ vài giây ⇒ bất đồng bộ; đợt dồn ⇒ queue: https://github.com/study8677/architecture-copilot (references/signals.md)
- Việc chậm đẩy khỏi request: https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
- Webhook (thân thô, trả 2xx nhanh, trùng, thứ tự, queue cho đợt dồn): https://docs.stripe.com/webhooks · idempotency: https://docs.stripe.com/api/idempotent_requests
- Lemon Squeezy thử lại ngắn: https://docs.lemonsqueezy.com/help/webhooks/webhook-requests
- Trần ngày email: https://resend.com/pricing
- Chưa có nguồn trong bộ research: tên/cấu hình dead-letter queue của Cloudflare Queues, Queues giao "ít nhất một lần", làm tiếp sau phản hồi (`waitUntil`) không thử lại, consumer có trần CPU cao hơn, lùi dần + ngẫu nhiên, trần 5 lần.

# Giá và giới hạn gói: tra ở đâu, tra thế nào

Dùng ở bước 3 (ước lượng chi phí) và khi chọn nơi lưu, nơi chạy của `flow-system-design`.

**Skill không ghi số giá hay giới hạn gói.** Nhà cung cấp đổi thông số liên tục; số chép vào skill sẽ cũ mà AI vẫn tin. Cần số ⇒ tra
trang chính thức ngay lúc thiết kế.

## Cách tra

1. Tìm trong kho trước: `node ~/.claude/hooks/kho.mjs tim <projectRoot> "<nhà cung cấp> giá giới hạn"`. Thẻ còn hạn ⇒ dùng, ghi
   "dùng kết quả ngày …". Thẻ hết hạn ⇒ tra lại phần đó.
2. Không có thẻ ⇒ đọc trang chính thức ở bảng dưới (WebFetch), chỉ lấy đúng con số thiết kế cần.
3. Ghi số vào DESIGN.md kèm nguồn: `(tra <URL> ngày YYYY-MM-DD)`.
4. Lưu thẻ kho cho lần sau (`kho.mjs moi cau-hoi <projectRoot> -`), hạn ngắn vì giá đổi nhanh.
5. Báo phí cho user luôn kèm câu "theo bảng giá ngày …, có thể đã đổi".

## Trang chính thức

| Nhà cung cấp | Giá | Giới hạn |
|---|---|---|
| Cloudflare Workers | https://developers.cloudflare.com/workers/platform/pricing/ | https://developers.cloudflare.com/workers/platform/limits/ |
| Cloudflare D1 | https://developers.cloudflare.com/d1/platform/pricing/ | https://developers.cloudflare.com/d1/platform/limits/ |
| Cloudflare KV | https://developers.cloudflare.com/kv/platform/pricing/ | https://developers.cloudflare.com/kv/platform/limits/ |
| Cloudflare R2 | https://developers.cloudflare.com/r2/pricing/ | https://developers.cloudflare.com/r2/platform/limits/ |
| Cloudflare Queues | https://developers.cloudflare.com/queues/platform/pricing/ | https://developers.cloudflare.com/queues/platform/limits/ |
| Cloudflare Durable Objects | https://developers.cloudflare.com/durable-objects/platform/pricing/ | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Cloudflare Workers AI | https://developers.cloudflare.com/workers-ai/platform/pricing/ | https://developers.cloudflare.com/workers-ai/platform/limits/ |
| Cloudflare Rate Limiting binding | — | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Cloudflare Turnstile | https://developers.cloudflare.com/turnstile/plans/ | cùng trang |
| Supabase | https://supabase.com/pricing | https://supabase.com/docs/guides/platform/billing-on-supabase |
| Resend (email) | https://resend.com/pricing | cùng trang |
| Dịch vụ khác (SMS, AI, VPS…) | trang pricing chính thức của chính hãng | trang limits/quotas chính thức |

Trang đổi địa chỉ ⇒ tìm lại trên site chính hãng, không lấy số từ blog hay bài so sánh.

## Câu phải hỏi trang giá (kiểu bất ngờ hay gặp, không phải số)

Mỗi nơi chạy/nơi lưu sắp chọn, tra cho được câu trả lời các câu này và ghi vào DESIGN.md:

- Gói miễn phí hết hạn mức thì **chặn** (app báo lỗi) hay **tự tính tiền thêm**? Người dùng thấy gì khi chạm trần?
- Có **tự tạm dừng** khi lâu không dùng không? Mở lại mất bao lâu, ai phải bấm?
- Gói đang chọn có **sao lưu** không, giữ mấy ngày, khôi phục có ghi đè tại chỗ không?
- Giới hạn tần suất đếm **toàn cục** hay **riêng từng vùng/địa điểm** (đếm riêng thì vượt được trần)?
- Tính tiền theo gì (request, dòng đọc/ghi, token, dung lượng, tải ra) — khoản nào đội nhanh nhất khi đông người?
- Có trần cứng nào chặn kiến trúc (CPU mỗi request, cỡ một DB, cỡ một tin queue, số kết nối) không?
- Có đặt được **cảnh báo chi tiêu / trần chi tiêu** không?

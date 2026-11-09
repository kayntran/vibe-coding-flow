# Thiết kế API

Dùng ở bước 6 của `flow-system-design`.

## Mục lục
- Kiểu API
- Định dạng lỗi thống nhất
- Phân trang
- Khoá chống gửi trùng (idempotency)
- Giới hạn tần suất
- Phiên bản cho client cũ
- Kiểm dữ liệu vào và trường được ghi
- Quyền trên từng đối tượng
- Nguồn

## Kiểu API

| Kiểu | Dùng khi | Chưa cần khi |
|---|---|---|
| **REST + JSON** (mặc định) | Gần như mọi màn: đọc, tạo, sửa, xoá | — |
| SSE (máy chủ đẩy một chiều qua HTTP) | Chữ AI hiện dần, tiến trình job, thông báo một chiều | Kết quả về dưới ~1 giây ⇒ một request thường |
| WebSocket (kết nối hai chiều giữ mở) | Chat, nhiều người cùng sửa, trò chơi; trên Cloudflare đặt trong Durable Object | Chỉ cần cập nhật vài chục giây một lần ⇒ hỏi lại định kỳ (polling) là đủ |
| GraphQL, gRPC | Không dùng mặc định trong kit | Luôn chưa cần ở hạng prototype/MVP |

- Mỗi endpoint: ai được gọi · đầu vào · đầu ra · lỗi có thể có · có tốn tiền/gửi ra ngoài không (⇒ cần idempotency + giới hạn tần suất).
- Đặt tên theo danh từ số nhiều: `GET /api/notes`, `POST /api/notes`, `PATCH /api/notes/:id`. Hành động không phải CRUD: `POST /api/notes/:id/summarize`.
- WebSocket trên Durable Objects: tin đến tính phí theo lô, tin đi không tính ⇒ tra bảng số liệu có ngày trước khi chọn cho tải lớn.

## Định dạng lỗi thống nhất

Một khuôn cho mọi lỗi, để màn hình hiện đúng câu và để log tìm được:

```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "Bạn đã dùng hết 20 lượt tóm tắt hôm nay.", "requestId": "01J…" } }
```

| Mã HTTP | Khi | `code` ví dụ |
|---|---|---|
| 400 | Dữ liệu vào sai | `VALIDATION_FAILED` + `fields` |
| 401 | Chưa đăng nhập / phiên hết | `UNAUTHENTICATED` |
| 403 | Đăng nhập rồi nhưng không có quyền | `FORBIDDEN` |
| 404 | Không có, **hoặc có mà không được xem** (đừng lộ là có tồn tại) | `NOT_FOUND` |
| 409 | Trùng, xung đột phiên bản, hết chỗ | `CONFLICT` |
| 429 | Vượt giới hạn tần suất / hạn mức | `RATE_LIMITED`, `QUOTA_EXCEEDED` |
| 500 | Lỗi của mình | `INTERNAL` (không kèm stack, không kèm SQL) |

- `message` là câu người dùng đọc được; `code` cố định để client cũ xử lý. Không đổi nghĩa `code` đã phát hành.
- Đăng nhập/quên mật khẩu: cùng một câu, cùng mã, thời gian phản hồi tương đương cho mọi trường hợp (chống dò tài khoản).

## Phân trang

| Cách | Hợp | Không hợp |
|---|---|---|
| **Keyset** (nhớ khoá của hàng cuối: `?after=<id>`; mặc định) | Cuộn vô hạn, feed, danh sách dài, bảng hay được thêm | Nhảy tới "trang 37" |
| Offset (`?page=3`) | Bảng quản trị nhỏ, cần nhảy trang, vài nghìn hàng | Bảng lớn: vẫn phải đọc hết hàng bị bỏ qua (chậm, D1 tính tiền hàng đọc), hàng mới chèn làm lệch trang |

- Luôn có trần cỡ trang phía máy chủ (vd tối đa 100), kể cả khi client xin 10.000.
- Keyset cần index khớp thứ tự sắp xếp, và khoá sắp xếp duy nhất (`created_at, id`).

## Khoá chống gửi trùng (idempotency)

Bắt buộc cho thao tác **tốn tiền hoặc gửi ra ngoài**: tạo đơn, trừ điểm, gửi email/SMS, gọi AI tính phí, tạo thanh toán.
Mạng chập chờn ⇒ người dùng bấm lại / client tự thử lại ⇒ không có khoá là trừ tiền hai lần.

- Client sinh khoá ngẫu nhiên (UUID v4) cho mỗi ý định, gửi header `Idempotency-Key`; thử lại dùng **đúng khoá cũ**.
- Máy chủ lưu (khoá, người dùng, băm tham số, kết quả). Gặp lại khoá ⇒ trả **kết quả lần đầu**, kể cả khi lần đầu lỗi.
- Cùng khoá nhưng tham số khác ⇒ báo lỗi, không làm.
- Dọn khoá sau ≥ 24 giờ. Không đưa dữ liệu nhạy cảm vào khoá. Chỉ cần cho POST (GET, PUT, DELETE vốn đã lặp an toàn nếu viết đúng).
- Webhook nhận vào (Stripe, Lemon Squeezy) cũng có thể đến trùng ⇒ lưu ID sự kiện đã xử lý, bỏ qua lần sau.
- Chưa cần khi: thao tác đọc, hoặc ghi mà làm hai lần cho cùng kết quả (đặt tên, bật/tắt cài đặt).

## Giới hạn tần suất

- Vượt ⇒ trả **429** kèm header `Retry-After` (số giây chờ); client hiện câu dễ hiểu và đợi, không thử lại dồn dập.
- Đặt theo **người dùng** (đã đăng nhập) hoặc theo IP + tài khoản đích (đăng nhập, quên mật khẩu, gửi mã). Chỉ theo IP là chưa đủ.
- Rate Limiting binding của Cloudflare: rẻ, đủ chống spam thường, nhưng đếm riêng từng địa điểm và gần đúng ⇒ trần tiền/hạn mức
  cứng (lượt AI, số SMS) phải đếm ở một nơi duy nhất (Durable Object hoặc DB) trước khi gọi dịch vụ trả phí.
- Cửa công khai không cần đăng nhập (đăng ký, form liên hệ, danh sách chờ) ⇒ thêm Turnstile (thử thách chống bot).
- AI Gateway có giới hạn riêng trả 429 cho mọi request đi qua ⇒ lớp phòng hoá đơn, không thay hạn mức theo người.
- Giới hạn cả **cỡ** request: thân request, số phần tử mảng, cỡ file — input không được quyết vòng lặp hay bộ nhớ.

## Phiên bản cho client cũ

Extension Chrome và app máy tính nằm trên máy user, cập nhật chậm hoặc không bao giờ (extension MV3 không tải mã từ xa được) ⇒
đổi API làm hỏng bản cũ đang chạy.

- Chỉ **thêm** trường, không đổi nghĩa/bỏ trường trong cùng phiên bản. Client bỏ qua trường lạ.
- Client gửi phiên bản của mình (header `X-Client-Version`). Máy chủ có "phiên bản tối thiểu được hỗ trợ"; dưới mức ⇒ trả mã riêng
  (`CLIENT_TOO_OLD`) để client hiện màn "cần cập nhật" thay vì vỡ.
- Thay đổi phá vỡ ⇒ đường mới (`/api/v2/…`), giữ đường cũ tới khi số client cũ về gần 0 (đo từ header).
- Webapp thuần (client và máy chủ phát hành cùng lúc): chưa cần phiên bản trong URL.

## Kiểm dữ liệu vào và trường được ghi

- Kiểm mọi đầu vào ở máy chủ theo schema (kiểu, độ dài, khoảng giá trị); kiểm ở client chỉ để tiện người dùng.
- **Allow-list trường được ghi** cho từng endpoint: không gán thẳng body vào bản ghi DB. Không có thì kẻ xấu gửi thêm
  `role: "admin"`, `plan: "pro"`, `tenant_id` của người khác (lỗi mass assignment — gán hàng loạt trường).
- Kiểm cả đối tượng lồng nhau. Trường chỉ máy chủ được đặt (`owner_id`, `tenant_id`, `created_at`) lấy từ phiên, không từ body.
- Bài kiểm: gửi thêm trường đặc quyền ⇒ bị bỏ qua, bản ghi không đổi.

## Quyền trên từng đối tượng

- Mỗi đọc, sửa, xoá, xuất theo ID ⇒ kiểm **người đang đăng nhập có quyền với đúng đối tượng đó** (lỗi IDOR — sửa số ID trên URL là
  xem được của người khác; đứng đầu danh sách lỗi API của OWASP).
- Truy vấn luôn kèm phạm vi: `WHERE id = ? AND tenant_id = ?` (D1) hoặc RLS (Supabase). Danh tính lấy từ phiên.
- Kiểm cả quyền theo chức năng: endpoint quản trị kiểm vai trò ở máy chủ, không chỉ ẩn nút.
- Bài kiểm: hai tài khoản A, B; B gọi đọc/sửa/xoá/xuất đối tượng của A ⇒ 404 hoặc 403, dữ liệu A không đổi. Chạy bằng đúng vai trò
  và kết nối như bản thật. Chi tiết kiểm sau khi code ⇒ `flow-security`.

## Nguồn

- OWASP API Top 10 2023 (API1 quyền đối tượng, API3 quyền trên trường, API4 tiêu thụ tài nguyên, API6 luồng nghiệp vụ nhạy cảm): https://api-security.owasp.org/editions/2023/en/0x11-t10
- IDOR: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
- Mass assignment: https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- Idempotency: https://docs.stripe.com/api/idempotent_requests · webhook trùng: https://docs.stripe.com/webhooks
- Keyset vs offset: https://use-the-index-luke.com/no-offset
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · AI Gateway: https://developers.cloudflare.com/ai-gateway/configuration/rate-limiting/
- Giới hạn cỡ request, việc nặng cần đăng nhập: https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
- Phản hồi giống nhau chống dò tài khoản: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- Extension MV3: https://developer.chrome.com/docs/extensions/develop/migrate/improve-security · DO WebSocket: https://developers.cloudflare.com/durable-objects/platform/limits/
- Chưa có nguồn trong bộ research: khuôn lỗi JSON cụ thể, header `Retry-After` đi kèm 429 (theo chuẩn HTTP, chưa mở trang), header `X-Client-Version`, bảng chọn SSE/WebSocket/polling.

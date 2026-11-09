# Làm thừa và thiếu thiết kế

Dùng ở bước 9 của `flow-system-design`, trước khi chốt DESIGN.md.

## Mục lục
- Câu hỏi chặn chung
- Dấu hiệu làm thừa
- Đề bài bẫy
- Thiếu thiết kế: thứ KHÔNG được cắt

## Câu hỏi chặn chung

Với mỗi thành phần trong sơ đồ, hỏi theo thứ tự; trượt câu nào ⇒ bỏ thành phần, đưa vào lộ trình kèm ngưỡng:
1. Yêu cầu nào trong SPEC hoặc con số nào trong mục ước lượng **bắt buộc** có nó?
2. Bỏ nó đi thì người dùng gặp gì, ở ngưỡng nào?
3. Ai vận hành nó lúc 2 giờ sáng? (team 1–2 người không code ⇒ thứ tự chạy là thứ có thể sập không ai sửa)
4. Có bản managed hoặc tính năng sẵn của stack (Workers, D1, Queues, Supabase) làm được không?
5. Khi nào xem lại — ghi ngưỡng đo được.

Lý do "chuẩn ngành", "để sau scale", "công ty lớn dùng" không phải lý do.

## Dấu hiệu làm thừa

Ngưỡng ở cột cuối là kinh nghiệm của các repo thiết kế đã đọc, không phải số đo.

| Dấu hiệu | Câu hỏi chặn | Thay bằng | Khi nào mới đúng |
|---|---|---|---|
| Microservices cho team 1–2 người | Có hai nhóm người đang chặn nhau khi phát hành không? | Một khối chia module ranh giới rõ (`flow-architecture`) | Nhiều đội chặn nhau; một phần cần nhịp phát hành hoặc co giãn khác hẳn, đo được |
| Kafka | Bao nhiêu sự kiện/giây? Ai cần đọc lại lịch sử sự kiện? | Cloudflare Queues, hoặc bảng outbox + cron | Hàng chục nghìn sự kiện/giây, nhiều bên tiêu thụ cần phát lại |
| Kubernetes | Có bao nhiêu dịch vụ tự chạy? Ai trực? | Workers, Supabase, một VPS có trình quản lý tiến trình | Hàng chục dịch vụ tự host, có người vận hành riêng |
| Redis "cho nhanh" không có con số | Truy vấn nào chậm, chậm bao nhiêu, đọc:ghi bao nhiêu? | Index đúng, Cache API, KV | Đọc:ghi ~100:1 và DB đã là điểm nghẽn đo được; cần bộ đếm/khoá phân tán thật |
| Chia DB (shard) trước khi có triệu dòng | Bảng lớn nhất có bao nhiêu dòng, DB bao nhiêu GB? | Index, phân trang keyset, lưu trữ dữ liệu cũ, nâng gói | Bảng hàng chục–trăm triệu dòng hoặc DB vài trăm GB, ghi chạm trần một máy |
| Tự host thứ đã có managed (Postgres VPS, tự viết đăng nhập, tự dựng máy gửi mail) | Ai sao lưu, vá lỗi, thay khi máy chết? | Supabase/D1, thư viện đăng nhập, dịch vụ email | Chi phí managed ở 10× vượt ngân sách rõ rệt và có người vận hành |
| 3 môi trường cho prototype | Có người dùng thật chưa? | dev + prod; MVP thêm bản xem thử theo nhánh | Hạng đang tăng, có dữ liệu thật cần bảo vệ khi thử |
| Event sourcing (lưu mọi sự kiện, trạng thái là kết quả phát lại) | Ai cần dựng lại trạng thái tại mọi thời điểm? | Bảng trạng thái + bảng nhật ký thao tác | Nghiệp vụ kế toán/kiểm toán bắt buộc phát lại; ghi ADR |
| GraphQL cho một client | Có bao nhiêu client với nhu cầu dữ liệu khác nhau? | REST/RPC đơn giản, một endpoint mỗi màn | Nhiều client bên ngoài cần tự chọn trường |
| CQRS (tách hẳn đường đọc và ghi) | Đọc và ghi có mô hình khác nhau thật không? | Một mô hình, thêm view/bảng tổng hợp khi cần | Đọc cần mô hình khác hẳn và chậm đo được |
| Đa vùng, chạy hai nơi cùng lúc | Uptime hứa trong hợp đồng là bao nhiêu? | Nền tảng managed + sao lưu + RTO rõ | Hợp đồng ≥ 99,95% hoặc luật bắt dữ liệu ở vùng riêng |
| Search engine riêng (Elasticsearch…) | Tìm trên bao nhiêu dòng, cần gì hơn khớp từ khoá? | Full-text sẵn của D1 (FTS5) hoặc Postgres | Hàng triệu tài liệu, cần xếp hạng/gõ sai/nhiều ngôn ngữ |
| Vector DB cho vài trăm đoạn văn | Tài liệu có vừa một prompt không? | Đưa thẳng vào prompt, tìm từ khoá | Kho lớn hơn nhiều lần cửa sổ ngữ cảnh |
| WebSocket cho dữ liệu đổi mỗi phút | Người dùng cần thấy thay đổi trong bao nhiêu giây? | Tải lại định kỳ 30–60 s | Chat, cộng tác, vị trí trực tiếp — cần dưới vài giây |
| Clean/Hexagonal/DDD đủ lớp cho app CRUD | Lớp này chặn được lỗi gì? | Module theo miền + một lớp truy cập dữ liệu | Nghiệp vụ phức tạp, nhiều quy tắc thay đổi độc lập |
| Tự viết rate limiter | Rate Limiting binding/Turnstile có đủ không? | Binding có sẵn; Durable Objects khi cần đếm chặt toàn cục | Hạn mức tính tiền chính xác theo gói |
| NoSQL "vì scale" | Truy vấn có cần nối bảng, giao dịch? | SQL (D1/Postgres) | Khối lượng ghi khổng lồ, mô hình khoá–giá trị thuần |

Mốc tham chiếu: khoảng 100 request/giây trung bình thì một dịch vụ là đủ; khoảng 17 lượt ghi/giây một DB có giao dịch dư sức;
hầu hết hệ thống thật dừng ở bậc 4–6 của thang scale (một máy → tách DB → bản đọc phụ → cache → CDN → web không giữ trạng thái).

## Đề bài bẫy

**Bẫy chính.** Startup 6 người, 2.000 đơn/ngày; sếp muốn 4 microservice (đơn, kho, thanh toán, thông báo) + Kafka.

Phép tính: 2.000 / 86.400 ≈ 0,023 đơn/giây; cao điểm ×5 ≈ 0,12 đơn/giây; mỗi đơn ~50 request ⇒ ~6 request/giây lúc đông.
Một dịch vụ + một DB gánh dư hàng trăm lần (mốc ~100 request/giây, ~17 ghi/giây ở trên).

Đáp án đúng:
- Một khối chia 4 module đúng ranh giới sếp muốn (đơn, kho, thanh toán, thông báo); module chỉ gọi nhau qua hàm công khai,
  không đọc bảng của nhau ⇒ sau này tách thành dịch vụ không phải viết lại. Ép bằng `flow-architecture`.
- Một DB, giao dịch cho "trừ kho + tạo đơn" — 4 dịch vụ sẽ biến việc này thành giao dịch phân tán, khó đúng.
- Việc nền (gửi email, webhook, đối soát) qua một hàng đợi đơn giản (Cloudflare Queues), không Kafka.
- Ghi rõ tín hiệu để tách: một module cần phát hành theo nhịp khác và đang chặn người khác; một module cần co giãn khác
  hẳn, đo được; đội lên nhiều nhóm sửa chung một chỗ.
- Nói với sếp bằng đánh đổi, không gạt đi: "4 dịch vụ + Kafka = 4 đường phát hành, 4 chỗ theo dõi, một hệ thống tin nhắn
  cần người trực, cho tải mà một máy làm dư. Mình giữ đúng 4 ranh giới, tách khi thấy tín hiệu X."

**Bẫy phụ.**
- App nội bộ 40 nhân viên muốn Kubernetes "cho chuyên nghiệp" ⇒ Workers/Supabase; K8s cần người trực mà team không có.
- App 300 người dùng muốn Redis cache mọi trang ⇒ đo trước; index + Cache API; Redis chỉ khi DB nghẽn đo được.
- Prototype muốn dev/staging/prod + Terraform ⇒ dev + prod, cấu hình `wrangler` trong git là đủ.

## Thiếu thiết kế: thứ KHÔNG được cắt

App nhỏ vẫn phải có, vì để sau là mất tiền, lộ dữ liệu hoặc đập đi:

| Không cắt | Vì sao (kiểu hỏng) | Mức tối thiểu |
|---|---|---|
| Chống lạm dụng ở mọi điểm công khai/tốn tiền (đăng ký, gửi mã, gọi AI, form liên hệ, tải file) | Bot spam, SMS pumping (bị lợi dụng gửi SMS tới số đồng loã, mình trả tiền), hoá đơn AI | Turnstile + rate limit theo người/IP + trần chi phí/ngày |
| Phân quyền theo đối tượng | Đổi ID là xem đồ người khác — lỗi số 1 của OWASP API | Mọi truy vấn kèm chủ sở hữu/tenant; test hai tài khoản |
| Cô lập dữ liệu giữa khách hàng | Đổi sau phải sửa mọi truy vấn | Tenant ID từ phiên; RLS hoặc lớp repo bắt buộc |
| Sao lưu + thử khôi phục | Mất dữ liệu không lấy lại được | Bật sao lưu của nền tảng, thử khôi phục một lần (`flow-backup`) |
| Idempotency cho tiền | Bấm hai lần trừ tiền hai lần; webhook đến trùng | Khoá chống gửi trùng; lưu ID sự kiện webhook đã xử lý |
| Webhook có kiểm chữ ký | Kẻ xấu giả "đã thanh toán" | Kiểm chữ ký trên thân thô |
| Mô hình dữ liệu, kiểu ID, định dạng file người dùng lưu | Khó đảo ngược nhất | Quyết trong DESIGN.md, ghi ADR |
| Timeout cho lời gọi ngoài | Một dịch vụ chậm kéo sập app | Timeout mọi lời gọi |
| Khoá bí mật ở server | Khoá lộ trong bundle/app là bị dùng ngay | Biến bí mật của nền tảng |
| Xem lỗi bản thật + quay lại bản trước | Lỗi không ai biết, không lùi được | `flow-publish`, `flow-rollback` |
| Xoá dữ liệu khi người dùng yêu cầu | Nghĩa vụ pháp lý ở nhiều nơi | Luồng xoá/ẩn danh hoá có sẵn trong mô hình dữ liệu |

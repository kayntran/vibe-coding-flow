# Cache

Dùng ở bước 6–7 của `flow-system-design`.

## Mục lục
- Khi nào CHƯA cần cache
- Các tầng cache trên stack kit
- Cách đọc ghi
- TTL và xoá khi dữ liệu đổi
- Cache stampede
- Cache và quyền
- Tín hiệu chỉnh cache

Mở khi có chỗ đọc nhiều hoặc chậm. Cache (bản sao dữ liệu để đọc nhanh hơn) là **bản dẫn xuất**: mất là dựng lại được từ nguồn gốc; không bao giờ là nơi duy nhất giữ dữ liệu.

## Khi nào CHƯA cần cache

Mặc định **không có cache**. Mỗi tầng cache thêm một kiểu lỗi: người dùng thấy dữ liệu cũ, lộ dữ liệu người khác, khó lần lỗi.

- Hạng prototype/MVP và đọc:ghi dưới ~100:1 (kinh nghiệm) ⇒ chưa cần.
- Truy vấn chậm vì **thiếu index** ⇒ thêm index, không cache.
- Chậm vì gọi DB nối tiếp nhiều lần trong một request ⇒ gộp truy vấn trước.
- Dữ liệu riêng từng người, mỗi người đọc vài lần/ngày ⇒ tỉ lệ trúng thấp, cache chỉ thêm rủi ro.
- Chưa có số đo độ trễ / tải DB ⇒ đo trước (`flow-scale`), rồi mới quyết.

**Cần khi** có ít nhất một: cùng dữ liệu được đọc rất nhiều lần (trang công khai, bảng giá, cấu hình), CPU DB > ~70% kéo dài
do đọc (kinh nghiệm), gọi dịch vụ ngoài chậm/tốn tiền mà kết quả dùng lại được (tỉ giá, kết quả AI cho cùng đầu vào).

## Các tầng cache trên stack kit

| Tầng | Hợp cho | Cần biết |
|---|---|---|
| Trình duyệt (`Cache-Control` trên phản hồi) | File tĩnh có băm trong tên (cache lâu), ảnh | Dữ liệu riêng ⇒ `private` hoặc `no-store`; dữ liệu nhạy cảm ⇒ header chống cache |
| CDN Cloudflare (cache tại mạng biên) | File tĩnh, trang công khai giống nhau cho mọi người | **Không** cache phản hồi có dữ liệu riêng người dùng; cookie/đăng nhập ⇒ bỏ qua cache |
| KV (kho khoá-giá trị của Cloudflare) | Cấu hình, cờ tính năng, kết quả tính sẵn đọc nhiều ghi ít | Ghi cùng một khoá bị giới hạn tần suất ⇒ không làm bộ đếm; bản đọc ở nơi khác có thể cũ một lúc sau khi ghi (chưa xác minh khoảng thời gian); trần cụ thể tra trang giá chính thức lúc thiết kế |
| Trong app (biến trong bộ nhớ isolate Worker) | Dữ liệu nhỏ, đổi rất hiếm, dùng trong vài giây | Mỗi isolate một bản, mất bất cứ lúc nào; không dùng cho dữ liệu phải nhất quán |
| DB (bảng tổng hợp, cột tính sẵn, bản đọc phụ) | Thống kê, số đếm hiển thị, danh sách xếp hạng | Vẫn là SQL, có giao dịch; thường là bước đầu tiên nên thử |

Thứ tự thử: index/gộp truy vấn ⇒ bảng tổng hợp trong DB ⇒ CDN cho phần công khai ⇒ KV ⇒ (quy mô lớn) cache phân tán riêng.

## Cách đọc ghi

| Kiểu | Cách | Hợp khi | Nhược |
|---|---|---|---|
| **Cache-aside** (mặc định) | Đọc cache; trượt ⇒ đọc DB, ghi vào cache kèm TTL; ghi DB ⇒ xoá khoá cache | Đọc nhiều ghi ít, chấp nhận cũ trong TTL | Lần đầu chậm; xoá quên là dữ liệu cũ |
| Write-through | Ghi DB và cập nhật cache cùng lúc | Dữ liệu vừa ghi phải đọc thấy ngay, khoá ít | Ghi chậm hơn; ghi kép có thể lệch nếu một bên lỗi |
| Tính sẵn theo lịch | Job (cron) tính kết quả, ghi vào KV/bảng | Bảng xếp hạng, thống kê ngày | Cũ tới lần chạy sau |

## TTL và xoá khi dữ liệu đổi

- **Mọi khoá cache có TTL** (thời gian sống). Không TTL = dữ liệu cũ vĩnh viễn khi quên xoá.
- Chọn TTL bằng câu hỏi hành vi: "người dùng thấy số cũ bao lâu thì vẫn ổn?" — bảng giá vài phút, cấu hình vài chục giây, số dư tài khoản **không cache**.
- Ghi dữ liệu ⇒ xoá khoá liên quan ngay trong đường ghi (không đợi TTL). Liệt kê trong thiết kế: thay đổi nào xoá khoá nào.
- Khó liệt kê ⇒ đưa phiên bản vào khoá (`bang-gia:v12`): đổi dữ liệu thì tăng số, khoá cũ tự hết hạn.
- Không cache: tiền, quyền, trạng thái gói, tồn kho khi đặt chỗ — đọc thẳng nguồn gốc lúc quyết định.

## Cache stampede

Khoá nóng hết hạn ⇒ hàng trăm request cùng trượt, cùng đổ vào DB một lúc (cache stampede — đàn bò giẫm đạp).

- Cộng thêm thời gian ngẫu nhiên vào TTL để các khoá không hết hạn cùng lúc.
- Khoá rất nóng: tính lại nền trước khi hết hạn (tính sẵn theo lịch), hoặc cho một request tính lại, request khác trả bản cũ một lúc.
- Gom request trùng: trên Workers có thể dồn qua một Durable Object theo khoá để chỉ một lần gọi DB (suy luận, chưa đo).
- Chưa cần: khoá đọc vài lần/phút.

## Cache và quyền

Lỗi đắt nhất của cache là **trả dữ liệu người này cho người khác**.

- Khoá cache của dữ liệu phụ thuộc tenant/người dùng **phải chứa `tenant_id`/`user_id`**: `t:{tenant_id}:report:{id}`.
- **Kiểm quyền trước khi trả** giá trị lấy từ cache, như khi đọc DB; cache không thay kiểm quyền.
- CDN: phản hồi phụ thuộc phiên đăng nhập không được để CDN chung cache; kiểm header `Cache-Control` trên mọi route có dữ liệu riêng.
- Bài kiểm: A đọc trang riêng (vào cache), B đăng nhập đọc cùng đường dẫn ⇒ B không thấy dữ liệu của A.

## Tín hiệu chỉnh cache

Kinh nghiệm, không phải số đo:

| Tín hiệu | Làm |
|---|---|
| Tỉ lệ trúng < ~90% | Chỉnh TTL, khoá cache (quá chi tiết?), trước khi thêm tầng |
| Người dùng báo thấy số cũ | Thiếu xoá khoá trong đường ghi, hoặc TTL quá dài |
| DB vẫn tải cao dù có cache | Cache sai chỗ; đo truy vấn nào nặng nhất |
| Tải DB vọt khi khoá hết hạn | Stampede ⇒ TTL ngẫu nhiên, tính sẵn |

Theo dõi: tỉ lệ trúng, độ trễ có/không cache, số lần xoá khoá — ghi vào mục giám sát của DESIGN.md.

# Chọn kiểu kiến trúc

Dùng ở bước 5 của `flow-system-design`.

## Mục lục
- Mặc định
- Các kiểu kiến trúc
- App máy tính: dữ liệu tại máy hay trên máy chủ
- Tín hiệu chuyển kiểu
- Thang tiến hoá
- Walking skeleton
- Quy tắc sơ đồ Mermaid
- Nguồn

## Mặc định

**Một khối chia module** (modular monolith — một app triển khai một lần, bên trong chia miền rõ ràng, module chỉ gọi nhau qua
cửa đã khai). Khớp `flow-architecture`: ranh giới module ghi ở `docs/arch.json`, máy kiểm ép luật. Trên stack kit: một Worker
(hoặc một app Wails) + một DB SQL. Kiểu khác chỉ được chọn khi chỉ ra **yêu cầu hoặc con số** bắt buộc có nó.

## Các kiểu kiến trúc

| Kiểu | Hợp khi | Chưa cần khi | Cái giá |
|---|---|---|---|
| Một khối (monolith) | Prototype, một người, một miền | — | Không chia module thì lớn lên thành rối; khó giao việc song song |
| **Một khối chia module** (mặc định) | MVP tới đang tăng; 1–10 người | Prototype vứt đi sau 2 tuần | Phải giữ kỷ luật ranh giới (`flow-architecture` lo) |
| Serverless (hàm chạy theo request, nền tảng tự co giãn — Workers) | Tải lên xuống thất thường, không muốn quản máy | — đây là nền mặc định của kit, không phải lựa chọn thêm | Trần CPU/bộ nhớ mỗi request, việc dài phải chạy nền; tra bảng số liệu có ngày |
| Hướng sự kiện (event-driven — phần này phát tin, phần kia nghe và làm sau) | Việc chậm, gửi đi hàng loạt, gọi dịch vụ ngoài hay lỗi, đợt dồn có thể đoán | Mọi việc xong trong một request dưới vài trăm ms | Khó lần theo lỗi, phải chịu tin trùng và sai thứ tự; dùng từng chỗ (queue), không cả hệ |
| Microservices (nhiều dịch vụ triển khai riêng) | Nhiều đội chặn nhau khi phát hành; một phần cần co giãn hoặc độ tin cậy khác hẳn | Team dưới ~10 người, chưa có đội trực, chưa đo được điểm nghẽn | Gọi qua mạng thay gọi hàm, giao dịch xuyên dịch vụ, nhiều thứ để sập lúc 2 giờ sáng |
| App máy tính dữ liệu tại máy (local-first) | Một người một máy, dữ liệu riêng tư, cần chạy offline | Cần chia sẻ nhóm, nhiều thiết bị ngay từ đầu | Đồng bộ và sao lưu là việc của app; bản cũ ở máy user không tự cập nhật |
| Máy khách – máy chủ (client-server) | Nhóm dùng chung, nhiều thiết bị, thu tiền, quản trị tập trung | Một người, không cần đăng nhập | Cần mạng, cần đăng nhập, có chi phí máy chủ |

Bẫy hay gặp: startup 6 người, 2.000 đơn/ngày, sếp muốn 4 microservice + Kafka ⇒ đáp đúng là một khối chia module + một DB +
hàng đợi đơn giản cho việc nền, ranh giới module sạch, kèm tín hiệu cụ thể để tách sau. Nói với user bằng đánh đổi (tiền, người
trực, tốc độ ra tính năng), không gạt đi.

## App máy tính: dữ liệu tại máy hay trên máy chủ

| Câu hỏi hành vi | Nghiêng về |
|---|---|
| Có cần dùng khi mất mạng? | Có ⇒ tại máy |
| Một người dùng trên nhiều máy, hoặc cả nhóm cùng sửa? | Có ⇒ máy chủ (hoặc tại máy + đồng bộ) |
| Thu tiền, khoá bản quyền? | Kiểm bản quyền cần máy chủ, dữ liệu vẫn có thể ở máy |
| Mất máy là mất dữ liệu có chấp nhận được? | Không ⇒ cần sao lưu/đồng bộ lên máy chủ |

Chừa chỗ ngay cả khi chưa đồng bộ: ID tạo được tại máy (không dùng số tăng dần), cột `updated_at`, đánh dấu xoá thay xoá hẳn ⇒ sau
bật đồng bộ không phải đổi schema. Extension Chrome và app máy tính đều là **client cũ**: nằm trên máy user, không cập nhật cùng lúc
với máy chủ (extension MV3 cấm tải mã từ xa) ⇒ API máy chủ phải chịu được bản cũ (xem bước 6 trong SKILL.md).

## Tín hiệu chuyển kiểu

Ngưỡng là kinh nghiệm, không phải số đo; đo trước bằng `flow-scale`, tìm đúng chỗ nghẽn rồi mới đổi.

| Tín hiệu đo được | Làm (theo thứ tự, dừng khi hết tín hiệu) |
|---|---|
| CPU DB chính > ~70% kéo dài, đọc xếp hàng | Index + sửa truy vấn ⇒ cache ⇒ bản đọc phụ |
| Tỉ lệ trúng cache < ~90% | Chỉnh TTL và khoá cache, chưa thêm tầng |
| P99 cao, P50 ổn | Tìm một bước chậm (gọi ngoài, truy vấn thiếu index), sửa đúng bước đó |
| Người dùng chờ vài giây cho một thao tác | Chuyển thao tác đó chạy nền + báo tiến trình |
| Đợt dồn đoán trước được (khuyến mãi, đầu tháng) | Queue để san tải, giới hạn tần suất |
| Mục tiêu uptime tăng một bậc | Liệt kê và bỏ từng điểm đơn lỗi |
| Bảng hàng chục–trăm triệu hàng, DB vài trăm GB | Lưu trữ dữ liệu cũ, rồi mới nghĩ chia nhỏ (shard) |
| Một thay đổi phải sửa khắp nơi | Sửa ranh giới module trước, chưa tách service |
| Nhiều đội chặn nhau khi phát hành | Mới tách service theo ranh giới đội |

## Thang tiến hoá

Đi từng bậc, **chỉ lên khi có tín hiệu ở bảng trên**. Scale dọc (máy/gói to hơn) trước, ngang (nhiều máy) sau.

1. Một máy / một Worker + một DB.
2. Tách DB ra khỏi máy app (trên Cloudflare/Supabase đã sẵn từ đầu).
3. Bản đọc phụ (replica) cho đọc nhiều.
4. Cache cho chỗ đọc nóng (KV, trong app).
5. CDN cho file tĩnh và trang công khai.
6. App không giữ trạng thái + cân bằng tải (Workers đã sẵn).
7. Queue cho việc chậm và đợt dồn.
8. Chia nhỏ dữ liệu (shard) theo khoá, nhiều vùng.

**Đa số hệ thống thật dừng ở bậc 4–6.** Trên Workers, bậc 2, 5, 6 gần như có sẵn ⇒ việc thật sự phải quyết thường chỉ là 3, 4, 7.

## Walking skeleton

Bản mỏng nhất chạy được **từ đầu tới cuối** (màn hình → API → DB → triển khai lên địa chỉ thật) trước khi đắp tính năng.

- Gồm: một màn, một endpoint, một bảng, đăng nhập nếu có, triển khai thật, một bài kiểm đầu-cuối.
- Mục đích: lộ sớm lỗi ghép nối, cấu hình, quyền, triển khai — thứ đắt nhất khi phát hiện muộn.
- Là task đầu tiên trong mục "thứ tự build" của plan (`flow-plan`); `flow-release` dùng lại đường triển khai này.
- Chưa cần: dữ liệu giả đẹp, đủ màn, tối ưu.

## Quy tắc sơ đồ Mermaid

- Tối đa **12 nút**. Nhiều hơn ⇒ tách sơ đồ tổng + sơ đồ con cho phần đào sâu ở bước 7.
- Nhãn tiếng Việt, đời thường: `user[Người dùng]`, `api[Worker API]`, `db[(D1)]`. DB dùng hình trụ `[( )]`, queue ghi rõ chữ "hàng đợi".
- Mũi tên có nhãn động từ khi không hiển nhiên: `api -->|ghi đơn| db`.
- Mỗi hộp trong sơ đồ có đúng một dòng trong luồng chính đánh số, và ngược lại; lệch ⇒ sửa trước khi đưa ra.
- Không vẽ thành phần thuộc hạng cao hơn hạng hiện tại; ghi chúng vào lộ trình.
- Dịch vụ ngoài (thanh toán, email, AI) vẽ viền nét đứt hoặc ghi "(ngoài)" để thấy rõ chỗ có thể chết mà mình không sửa được.

## Nguồn

- Bảng tín hiệu scale, mặc định modular monolith: https://github.com/study8677/architecture-copilot (references/signals.md)
- Thang tiến hoá, "đa số dừng ở bậc 4–6", dọc trước ngang sau, bẫy over-decomposition: https://github.com/proyecto26/system-design-skills (skills/scaling-evolution/references/scaling-ladder.md, evals/)
- Monolith + một DB SQL trước, walking skeleton, Mermaid ≤ 12 nút: https://github.com/codejunkie99/system-design-skill
- Phương án đơn giản nhất trước, cơ chế phân tán phải có con số: https://github.com/pinchen147/system-design-skill
- Extension MV3 cấm mã từ xa: https://developer.chrome.com/docs/extensions/develop/migrate/improve-security
- Mẫu cần tránh làm mặc định (Clean/Hexagonal/DDD không bàn chi phí): https://github.com/wshobson/agents/blob/main/plugins/backend-development/skills/architecture-patterns/SKILL.md
- Bảng serverless/event-driven, local-first vs client-server, ngưỡng "~10 người": suy luận, chưa có nguồn riêng.

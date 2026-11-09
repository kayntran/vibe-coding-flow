# Bảo mật trong thiết kế

Dùng ở bước 8 của `flow-system-design`.

## Mục lục
- Phạm vi
- Đăng nhập: dùng thứ có sẵn
- Phân quyền theo vai trò
- Cô lập dữ liệu giữa khách hàng
- IDOR và mass assignment
- Khoá bí mật để đâu
- Mã hoá
- Phân tích mối đe doạ nhanh (STRIDE)
- OWASP Top 10 2025 thành câu hỏi thiết kế
- OWASP API Top 10 2023 thành câu hỏi thiết kế
- Khi nào CHƯA cần

## Phạm vi

Đây là quyết định **trước khi code**: ai đăng nhập bằng gì, ai thấy dữ liệu nào, khoá để đâu, chỗ nào bị lạm dụng.
Kiểm code đã viết (khoá lọt, lỗ hổng thư viện, test chéo quyền) là việc của `flow-security`. Khoá đã lộ: `flow-key-leak`.
Kết quả ghi vào mục "Bảo mật" của DESIGN.md; mỗi luật "làm ngay" thành một `AC-nn` có bài kiểm.

## Đăng nhập: dùng thứ có sẵn

- **Không tự viết** đăng nhập, băm mật khẩu, phiên, quên mật khẩu. Dùng Supabase Auth (nếu đã dùng Supabase) hoặc thư viện
  như Better Auth (chạy được trên Workers — kiểm lại docs trước khi chốt). Lý do cho user: ít lỗ chiếm tài khoản hơn, ít việc vận hành.
- Thư viện vẫn để lại việc của mình: giới hạn tần suất đăng nhập/đăng ký/quên mật khẩu theo tài khoản và IP; thông báo lỗi
  giống nhau khi sai mật khẩu hay tài khoản không có (chống dò tài khoản); phiên huỷ ở server khi đăng xuất.
- Cookie phiên: Secure, HttpOnly, SameSite tối thiểu Lax; không để token trong localStorage.
- Đăng nhập Google: dùng `sub` làm định danh, không dùng email; kiểm `aud`, `iss`, `exp`.
- Quản trị viên: bật 2 lớp (MFA) từ ngày đầu.
- Chi tiết theo loại (đăng ký, quên mật khẩu, mời, xoá tài khoản): bản mẫu tài khoản ở bước 4 trong SKILL.md.

## Phân quyền theo vai trò

RBAC (phân quyền theo vai trò — gán người vào vai, gán quyền cho vai). Mặc định:
- Vai ít và cố định: `owner`, `member`, (`viewer` nếu SPEC cần). Không làm bảng quyền tuỳ biến tới khi khách hỏi.
- Vai gắn theo **từng tổ chức** (bảng thành viên: người × tổ chức × vai), không gắn cứng trên người dùng.
- Kiểm quyền ở server cho **mọi** endpoint, kể cả endpoint "chỉ màn admin gọi" (API5: ẩn nút không phải là phân quyền).
- Việc nhạy cảm (đổi vai, xoá tổ chức, xuất dữ liệu) ghi nhật ký: ai, lúc nào, làm gì, trên gì.

## Cô lập dữ liệu giữa khách hàng

Multi-tenant (nhiều khách hàng/tổ chức dùng chung một app và một DB). Quyết từ đầu, đổi sau phải sửa mọi truy vấn.

| Luật | Trên Supabase | Trên D1 / Postgres VPS |
|---|---|---|
| Tenant ID lấy từ phiên ở server, không lấy từ URL/body | `auth.uid()` → bảng thành viên | Middleware đọc phiên, gắn vào ngữ cảnh request |
| Ép lọc theo tenant ở lớp dữ liệu | Bật RLS (lọc theo hàng ngay trong DB) **và ép** trên mọi bảng; role chạy request không bỏ qua RLS | D1 không có RLS ⇒ mọi truy vấn đi qua một lớp repo bắt buộc nhận tenant ID |
| Khoá quyền cao chỉ ở server | `service_role` bỏ qua RLS ⇒ chỉ ở server | Chuỗi kết nối chỉ ở server |
| Cache key có tenant | Mọi khoá KV/cache phụ thuộc tenant có tenant ID | như trái |
| Hạn mức theo tenant | Rate limit, queue, file theo tenant/gói để một khách không làm chậm khách khác | như trái |
| Test chéo tenant | Đăng nhập A, gọi ID của B ⇒ bị từ chối, chạy bằng đúng role thật | như trái |

Supabase thêm: đánh index cột mà policy lọc; bọc `(select auth.uid())`; view đặt `security_invoker = true`.

## IDOR và mass assignment

- IDOR (đổi ID trong đường dẫn là xem được đồ người khác). Chặn: mọi đọc/sửa/xoá/xuất kiểm quyền trên **từng đối tượng**;
  truy vấn luôn kèm điều kiện chủ sở hữu/tenant. ID khó đoán (UUID, ULID) chỉ là lớp phụ — link lộ vẫn phải bị từ chối.
- Mass assignment (gửi thêm trường như `role`, `isAdmin`, `tenantId` vào form là được ghi). Chặn: chỉ nhận danh sách trường
  được sửa (allow-list) cho từng endpoint; không đổ thẳng body vào bản ghi; kiểm cả đối tượng lồng nhau.
- Bài kiểm bắt buộc: hai tài khoản hai tenant gọi chéo mọi endpoint có ID; gửi thêm `role: "owner"` ⇒ bị bỏ qua.

## Khoá bí mật để đâu

| Nơi | Được để khoá bí mật? |
|---|---|
| Biến bí mật của Workers, Supabase Edge Functions, biến môi trường server | Có |
| Code, git, file cấu hình commit, log | Không |
| Bundle trình duyệt, extension, app máy tính (Wails) | Không — ai cũng giải nén đọc được |
| App máy tính/extension cần gọi dịch vụ trả phí | Gọi qua server của mình bằng phiên người dùng; server giữ khoá |

Khoá công khai được phép ở client: Supabase anon/publishable (vì đã có RLS), site key Turnstile. Lộ khoá: `flow-key-leak`.

## Mã hoá

- Đường truyền: HTTPS mọi nơi (Cloudflare, Supabase mặc định có). Dữ liệu nhạy cảm không nằm trong URL.
- Lưu trữ: dịch vụ managed đã mã hoá đĩa ⇒ không tự làm thêm.
- Mã hoá từng trường chỉ khi dữ liệu rất nhạy (số giấy tờ, token OAuth của bên thứ ba, ghi chú y tế); khoá giải mã ở server.
- Mật khẩu: để thư viện đăng nhập băm (Argon2id hoặc tương đương), không tự chọn thuật toán.

## Phân tích mối đe doạ nhanh (STRIDE)

Mỗi luồng chính đi một lượt 6 câu, ghi mối đe doạ có thật vào mục "Bảo mật":

| Chữ | Nghĩa | Câu hỏi |
|---|---|---|
| S — Spoofing | Giả danh | Ai giả làm người khác được? (đăng nhập, webhook không ký) |
| T — Tampering | Sửa dữ liệu | Client sửa giá, số lượng, vai được không? |
| R — Repudiation | Chối đã làm | Việc nhạy cảm có nhật ký không? |
| I — Information disclosure | Lộ thông tin | Lỗi, link, cache có lộ dữ liệu người khác không? |
| D — Denial of service | Làm sập/tốn tiền | Điểm công khai nào gọi mãi được? |
| E — Elevation of privilege | Leo quyền | Người thường gọi được việc của admin không? |

## OWASP Top 10 2025 thành câu hỏi thiết kế

| Mục | Câu hỏi |
|---|---|
| A01 Kiểm soát truy cập hỏng | Mọi đối tượng có kiểm chủ sở hữu/tenant ở server chưa? |
| A02 Cấu hình sai | Header bảo mật, CORS, bucket công khai, trang debug đã chốt chưa? |
| A03 Chuỗi cung ứng | Thư viện ít và có tiếng; khoá phiên bản; ai cập nhật? |
| A04 Lỗi mật mã | Có tự chế mã hoá/băm không? (không được) |
| A05 Injection | Chỗ nào nối chuỗi vào SQL/HTML/lệnh, kể cả đầu ra AI? |
| A06 Thiết kế không an toàn | Luồng tốn tiền có giới hạn nghiệp vụ, chống làm trùng chưa? |
| A07 Lỗi xác thực | Dùng thư viện đăng nhập; có giới hạn thử sai, MFA admin chưa? |
| A08 Toàn vẹn phần mềm/dữ liệu | Webhook có ký? Bản cập nhật app có ký? |
| A09 Log và cảnh báo | Sự kiện bảo mật có ghi và có ai được báo? |
| A10 Xử lý tình huống bất thường | Lỗi giữa chừng có để dữ liệu nửa vời hoặc lộ chi tiết lỗi? |

## OWASP API Top 10 2023 thành câu hỏi thiết kế

| Mục | Câu hỏi |
|---|---|
| API1 Quyền theo đối tượng | Đổi ID là thấy đồ người khác? |
| API2 Xác thực | Endpoint nào quên đòi phiên? |
| API3 Quyền theo trường | Trả thừa trường (email, giá vốn) hoặc nhận thừa trường? |
| API4 Tiêu thụ không giới hạn | Trần cỡ request, cỡ trang, số lần gọi, tiền mỗi người? |
| API5 Quyền theo chức năng | Người thường gọi được endpoint admin? |
| API6 Luồng nghiệp vụ nhạy cảm | Đăng ký, mã giảm giá, đặt chỗ bị bot dùng hàng loạt? |
| API7 SSRF | Server tải URL người dùng nhập? Chặn dải nội bộ chưa? |
| API8 Cấu hình sai | Môi trường thử có mở ra ngoài với dữ liệu thật? |
| API9 Kiểm kê | Có danh sách endpoint và phiên bản, tắt bản cũ? |
| API10 Tin API bên ngoài | Dữ liệu từ dịch vụ ngoài có được kiểm trước khi dùng? |

## Khi nào CHƯA cần

- Mã hoá từng trường, quản lý khoá riêng (KMS): chưa cần khi không lưu dữ liệu nhạy cao.
- Bảng quyền tuỳ biến, quyền theo thuộc tính: tới khi có khách trả tiền đòi.
- DB riêng cho từng khách: tới khi hợp đồng đòi hoặc một khách quá lớn so với phần còn lại.
- Tường lửa ứng dụng tự cấu hình chi tiết: Cloudflare mặc định + rate limit là đủ ở MVP (kinh nghiệm).

# Dữ liệu: nơi lưu, mô hình, migration, sao lưu

Dùng ở bước 6 của `flow-system-design`.

## Mục lục
- Chọn nơi lưu
- Mô hình dữ liệu
- Khoá định danh
- Index theo truy vấn chính
- Giao dịch và chống đặt trùng
- Nguồn gốc và bản dẫn xuất
- Outbox thay ghi kép
- Migration tương thích hai chiều
- Giữ bao lâu, xoá thế nào
- Sao lưu và kiểm khôi phục
- Khi nào bản đọc phụ, chia nhỏ
- Nguồn

## Chọn nơi lưu

**SQL trước.** Dữ liệu nghiệp vụ (người dùng, đơn, nội dung) vào DB quan hệ có giao dịch. NoSQL, search engine riêng, vector DB
chỉ thêm khi một truy vấn cụ thể không làm được bằng SQL + index. File (ảnh, PDF) vào R2/Supabase Storage, DB chỉ giữ đường dẫn.

| Nơi lưu | Chọn khi | Chưa hợp khi | Cần biết |
|---|---|---|---|
| **D1** (SQLite của Cloudflare) | Webapp trên Workers, dữ liệu theo người/nhóm vừa phải, muốn ít thành phần nhất | Ghi đồng thời rất nhiều vào một chỗ; truy vấn phân tích nặng; DB sắp chạm trần cỡ một DB | Một bản ghi chính (primary) nhận mọi ghi (suy luận); quyền đọc/ghi phải kiểm trong code; tính tiền theo hàng đọc/ghi; Free chặn khi chạm trần ngày |
| **Supabase Postgres** | Cần đăng nhập + phân quyền ở lớp dữ liệu (RLS — luật trong DB quyết hàng nào ai thấy) + Storage + realtime có sẵn; truy vấn phức tạp | Chỉ cần vài bảng đơn giản và đã ở Workers | Phải bật RLS cho mọi bảng; khoá `service_role` bỏ qua RLS, chỉ để ở máy chủ; Free tạm dừng khi không dùng và không sao lưu |
| **Postgres trên VPS** | Đã có người kỹ thuật vận hành, cần toàn quyền cấu hình, quy mô lớn nơi phí managed đội | Team 1–2 người không code (N8 ở bước 1) | Tự lo sao lưu, vá bảo mật, giám sát, ổ đầy — mỗi thứ là một chỗ sập lúc 2 giờ sáng |
| SQLite tại máy (app Wails) | Dữ liệu tại máy, offline | Cần chia sẻ nhóm | Sao lưu là việc của app; xem bước 5 trong SKILL.md |

Số cụ thể (trần cỡ DB, hàng đọc/ghi, sao lưu từng gói) ⇒ tra bảng số liệu có ngày.

## Mô hình dữ liệu

- Liệt kê **thực thể** (người dùng, nhóm, đơn…) và **quan hệ** (1-n, n-n qua bảng nối) trước khi vẽ kiến trúc.
- Nhiều công ty dùng chung (multi-tenant) ⇒ cột `tenant_id` trên **mọi** bảng có dữ liệu khách từ ngày đầu; tenant lấy từ phiên đăng
  nhập đã xác minh ở máy chủ, không từ client. Thêm sau = sửa mọi truy vấn.
- Mỗi bảng có `created_at`, `updated_at`. Xoá mềm (`deleted_at`) quyết ngay từ đầu nếu có thùng rác/hoàn tác: thêm sau phải sửa mọi truy vấn.
- Tiền lưu số nguyên đơn vị nhỏ nhất + mã tiền tệ, không lưu số thực. Thời gian lưu UTC.
- Định dạng file người dùng lưu, hợp đồng dữ liệu xuất ra ngoài ⇒ khó sửa sau, chốt ngay.

## Khoá định danh

- Khoá công khai (hiện trên URL, API) dùng **UUID v4/v7 hoặc ULID** (chuỗi ngẫu nhiên khó đoán; v7/ULID xếp được theo thời gian nên
  index đỡ phân mảnh — kinh nghiệm). Không lộ số tăng dần: lộ số lượng khách/đơn, dễ dò ID kế tiếp.
- ID khó đoán chỉ là **lớp phụ**: link lộ ra vẫn phải bị từ chối nếu người xem không có quyền (xem kiểm quyền từng đối tượng ở bước 6).
- App có đồng bộ/offline ⇒ ID phải tạo được tại máy khách ⇒ UUID/ULID bắt buộc.
- Đăng nhập Google: lưu `sub` làm định danh, không dùng email (email đổi được).

## Index theo truy vấn chính

- Viết ra 3–5 truy vấn chính (màn chính, danh sách, tìm theo người dùng) ⇒ mỗi truy vấn một index khớp điều kiện lọc + sắp xếp.
- D1 tính tiền theo hàng đọc: truy vấn không index quét cả bảng ⇒ vừa chậm vừa tốn, Free nhanh chạm trần (suy luận từ cách tính giá).
- Supabase: đánh index cột mà luật RLS lọc (`tenant_id`, `user_id`); bọc `(select auth.uid())` để tính một lần mỗi câu.
- Chưa cần: index cho truy vấn chưa có; mỗi index làm ghi chậm và tốn thêm.

## Giao dịch và chống đặt trùng

- Thao tác nhiều bước phải cùng thành hoặc cùng bại (trừ tiền + tạo đơn) ⇒ bọc trong một giao dịch.
- Tài nguyên có hạn (chỗ ngồi, tồn kho, lượt dùng) ⇒ khoá cấp nghiệp vụ: `UPDATE … SET con_lai = con_lai - 1 WHERE id = ? AND con_lai > 0`
  rồi kiểm số hàng bị đổi; không đọc-rồi-ghi hai bước (hai request đồng thời cùng thấy "còn 1").
- D1: dùng `batch()` để chạy nhiều câu như một giao dịch; giao dịch kiểu `BEGIN … COMMIT` tương tác chưa xác minh là dùng được — kiểm docs D1 trước khi dựa.

## Nguồn gốc và bản dẫn xuất

- Mỗi nơi lưu ghi rõ là **nguồn gốc** (sự thật, mất là mất hẳn) hay **bản dẫn xuất** (cache, bảng thống kê, chỉ mục tìm kiếm — dựng lại được từ nguồn gốc).
- Bản dẫn xuất phải có cách dựng lại (job chạy lại từ đầu). Chỉ nguồn gốc cần sao lưu đủ mục tiêu RPO/RTO.
- Trạng thái thanh toán: một nguồn sự thật duy nhất (bảng quyền của người dùng cập nhật từ webhook), màn hình chỉ đọc từ đó.

## Outbox thay ghi kép

Ghi DB rồi gọi dịch vụ ngoài (gửi email, đẩy queue) trong cùng code ⇒ một bên thành một bên bại là lệch. Cách làm:
ghi thay đổi + một hàng vào bảng `outbox` **trong cùng giao dịch** ⇒ job/consumer đọc outbox, gửi đi, đánh dấu đã gửi; người nhận
phải chịu được tin trùng. Chưa cần khi: thao tác phụ mất cũng không sao (log phân tích) hoặc chưa có dịch vụ ngoài nào.

## Migration tương thích hai chiều

Đổi schema theo kiểu **mở rộng → chuyển → thu gọn**, mỗi bước triển khai riêng:

1. Thêm cột/bảng mới, cho phép trống; code cũ vẫn chạy.
2. Triển khai code ghi cả cũ lẫn mới, đọc mới nếu có.
3. Chép dữ liệu cũ sang (backfill), kiểm số hàng.
4. Chuyển đọc hẳn sang mới; theo dõi một chu kỳ.
5. Mới bỏ cột cũ — khi chắc không còn client nào dùng (extension/app máy tính cũ có thể còn sống nhiều tháng).

- **Thứ tự triển khai:** migration thêm chạy **trước** code dùng nó; migration xoá chạy **sau** khi code thôi dùng. Ghi thứ tự trong plan.
- Trước migration trên D1: lưu bookmark Time Travel để có đường lùi. Supabase: chắc chắn có sao lưu gần nhất.
- Không đổi tên cột trong một bước; đổi tên = thêm mới + chép + bỏ cũ.

## Giữ bao lâu, xoá thế nào

- Mỗi loại dữ liệu có hạn giữ: phiên đăng nhập, log, mã OTP, file tạm, tài khoản đã xoá. Dữ liệu hết hạn **tự xoá** bằng job định kỳ.
- Xoá tài khoản: xoá/ẩn danh dữ liệu cá nhân, giữ phần luật bắt (hoá đơn); sao lưu cũng phải hết hạn theo chu kỳ của nó.
- Khách châu Âu: có quyền đòi xoá không chậm trễ khi hết cần thiết hoặc rút đồng ý (có ngoại lệ, không phải tư vấn pháp lý).
- Dữ liệu nhạy cảm không nằm trong URL, không vào log.

## Sao lưu và kiểm khôi phục

- Sao lưu chưa thử khôi phục = chưa có sao lưu. Chọn, bật, thử ⇒ `flow-backup`.
- D1 Time Travel: khôi phục về mốc thời gian, **ghi đè tại chỗ** và ngắt truy vấn đang chạy; kiểm số hàng ở mốc trước khi tin; chưa clone ra bản riêng được.
- Supabase Free không có sao lưu ⇒ app có người thật không ở Free.
- File trên R2/Storage cần chính sách riêng; DB khôi phục mà file không theo là lệch.

## Khi nào bản đọc phụ, chia nhỏ

- Prototype, MVP: **chưa cần**. Index + sửa truy vấn trước.
- Bản đọc phụ (replica): khi CPU DB chính > ~70% kéo dài và đọc chiếm áp đảo (kinh nghiệm). D1 có read replication; dùng
  `withSession()` + bookmark để người vừa ghi đọc lại thấy ngay dữ liệu của mình.
- Chia nhỏ (shard): bảng hàng chục–trăm triệu hàng, DB vài trăm GB (kinh nghiệm). Trên D1 cách tự nhiên là một DB mỗi tenant khi
  tenant tách bạch (suy luận) — chỉ quyết khi có số đo.

## Nguồn

- Nguồn gốc/dẫn xuất, outbox, migration nêu chiều tương thích + thứ tự triển khai, kiểm khôi phục: https://github.com/pinchen147/system-design-skill
- D1 giới hạn và giá: https://developers.cloudflare.com/d1/platform/limits/ · https://developers.cloudflare.com/d1/platform/pricing/
- D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/ · bản đọc phụ: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security · gói: https://supabase.com/pricing
- Tenant từ danh tính đã xác minh: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
- ID khó đoán chỉ là lớp phụ: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
- Giao dịch, khoá cấp nghiệp vụ: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x11-V2-Validation-and-Business-Logic.md
- Tự xoá dữ liệu hết hạn, không để trong URL: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md · quyền xoá: https://gdpr-info.eu/art-17-gdpr/
- Dùng `sub` của Google: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- Ngưỡng replica/shard: https://github.com/study8677/architecture-copilot (references/signals.md)
- Chưa có nguồn: UUID v7/ULID đỡ phân mảnh index, D1 `batch()` thay giao dịch tương tác, tiền lưu số nguyên, các bước mở rộng → thu gọn chi tiết.

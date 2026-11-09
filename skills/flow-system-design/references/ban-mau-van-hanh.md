# Bản mẫu: vận hành, quản trị và cài đặt

Dùng ở bước 4 của `flow-system-design`.

## Mục lục

- Trang quản trị
- Nhật ký thao tác (audit log)
- Đa ngôn ngữ/múi giờ/tiền tệ
- Cài đặt người dùng
- Cờ tính năng/chế độ bảo trì
- Đồng ý cookie/analytics/phiên bản điều khoản

Cách dùng: nhận ra loại ⇒ hỏi các câu lúc viết SPEC (`flow-spec`) ⇒ "Làm ngay" thành `AC-nn` kèm bài kiểm ⇒ "Chừa chỗ" vào mục kiến
trúc của plan ⇒ "Chưa làm" vào lộ trình theo ngưỡng. Giá và giới hạn gói: tra trang giá chính thức lúc thiết kế, không ghi ở đây.

## Trang quản trị

Nhận ra khi: "trang admin", "quản trị", "xem tất cả người dùng", "khoá tài khoản", "hoàn tiền bằng tay", "trang cho nhân viên hỗ trợ".

Hỏi user (lúc viết SPEC):
- Ai được vào trang quản trị? → khuyên: lúc đầu chỉ bạn; nhân viên về sau có quyền riêng từng việc, không dùng chung tài khoản.
- Admin có được xem nội dung riêng của người dùng? → khuyên: không mặc định; khi hỗ trợ phải bấm "Xem như người dùng", có ghi nhật ký.
- Thao tác nào cần xác nhận lại? → khuyên: xoá, hoàn tiền, đổi quyền — nhập lại mã 2 lớp, có chữ rõ nêu tên đối tượng.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | 2 lớp (MFA — mã thứ hai ngoài mật khẩu) BẮT BUỘC cho mọi tài khoản admin; quyền admin kiểm ở server trên từng endpoint, không chỉ ẩn menu; xác thực lại trước thao tác nhạy cảm; phiên admin hạn ngắn | Bảng `quyen(vai_tro, hanh_dong)` thay cho một cột `is_admin` đúng/sai | Chỉ cho vào trang quản trị từ thiết bị/mạng được phép (Cloudflare Access) — khi có nhân viên thứ hai |
| Chi phí | — | — | — |
| Chịu tải | Danh sách trong trang quản trị phân trang keyset, không tải cả bảng người dùng | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Khoá bỏ qua phân quyền (`service_role` của Supabase, token D1 quyền ghi) chỉ nằm ở server; xem/xuất dữ liệu người dùng ghi nhật ký; không bao giờ hiện mật khẩu/token | — | — |
| Theo dõi sự cố | Nhật ký thao tác mọi hành động admin; cảnh báo khi admin đăng nhập từ thiết bị lạ | — | — |

Bài kiểm bắt buộc:
- Tài khoản thường gọi thẳng `/admin/api/nguoi-dung` ⇒ 403.
- Tài khoản admin chưa bật 2 lớp ⇒ không vào được trang quản trị.
- Admin khoá một tài khoản ⇒ có dòng nhật ký ghi ai làm, khoá ai, lúc nào, lý do.

Hay sai:
- Trang quản trị chỉ bảo vệ ở giao diện; API phía sau ai gọi cũng được.
- Đường dẫn "bí mật" kiểu `/admin-xyz123` thay cho kiểm quyền.
- Nhiều người dùng chung một tài khoản admin ⇒ không biết ai đã làm gì.

## Nhật ký thao tác (audit log)

Nhận ra khi: "ai đã sửa cái này", "lịch sử hoạt động", "nhật ký", "truy vết", "kiểm toán", "xem nhân viên đã làm gì".

Hỏi user (lúc viết SPEC):
- Người dùng có được xem nhật ký của nhóm mình? → khuyên: chủ nhóm xem được; thành viên thì không.
- Giữ nhật ký bao lâu? → khuyên: 1 năm; lâu hơn nếu ngành có luật bắt.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ ghi thêm, không có API sửa/xoá; role app không có quyền UPDATE/DELETE bảng này (đặt trong DB, không chỉ trong code); chống chèn dòng giả: ghi dạng JSON, cắt độ dài | — | Chuỗi băm nối tiếp hoặc ghi sang kho riêng không ai sửa được — khi đối tác/kiểm toán yêu cầu bằng chứng toàn vẹn |
| Chi phí | Ghi việc rủi ro cao (đăng nhập, đổi quyền, xoá, nhập/xuất, tiền, mọi việc của admin), không ghi mọi lần đọc | — | — |
| Chịu tải | Ghi cùng lần với thao tác chính (cùng `batch()`/giao dịch) hoặc qua Queue; index (tenant, luc) | Bảng `nhat_ky(luc UTC, ai, tenant, hanh_dong, doi_tuong, ket_qua, ip_bam, ma_request)` | Chuyển sang kho log riêng — khi bảng lên vài chục triệu dòng (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | KHÔNG ghi mật khẩu, token, khoá, chuỗi kết nối, số thẻ; trước/sau chỉ ghi trường đổi, che trường nhạy cảm; xoá tài khoản ⇒ ẩn danh người thực hiện, giữ sự kiện | — | — |
| Theo dõi sự cố | Mỗi dòng có ID request để nối với log lỗi; cảnh báo khi việc ghi nhật ký ngừng (log chết lặng) | — | — |

Bài kiểm bắt buộc:
- Đổi mật khẩu ⇒ nhật ký có sự kiện "đổi mật khẩu" nhưng không có mật khẩu cũ/mới.
- Role của app chạy `DELETE` trên bảng nhật ký ⇒ DB từ chối.
- Tên người dùng chứa ký tự xuống dòng ⇒ không tạo được dòng nhật ký giả.

Hay sai:
- Ghi nguyên body request vào nhật ký ⇒ lộ mật khẩu, token.
- Cho app quyền xoá nhật ký "để dọn" ⇒ kẻ chiếm app xoá được dấu vết.
- Nhật ký không có tenant ⇒ không lọc được cho chủ nhóm, dễ lộ chéo.

## Đa ngôn ngữ/múi giờ/tiền tệ

Nhận ra khi: "tiếng Anh", "đa ngôn ngữ", "khách nước ngoài", "giờ địa phương", "hiện giá USD", "bán sang nước khác".

Hỏi user (lúc viết SPEC):
- Lúc ra mắt có mấy ngôn ngữ? → khuyên: một (tiếng Việt), nhưng chữ giao diện để trong tệp dịch ngay từ đầu.
- Giờ hiện theo máy người xem hay theo doanh nghiệp? → khuyên: theo máy người xem; báo cáo doanh thu theo giờ doanh nghiệp.
- Bán bằng mấy loại tiền? → khuyên: một loại; giá loại khác (nếu hiện) chỉ để tham khảo.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | — | — | — |
| Chi phí | — | — | Dịch bằng AI hoặc người — khi có ngôn ngữ thứ hai thật sự được dùng |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Thời gian lưu UTC (ISO 8601 hoặc epoch), hiện bằng `Intl.DateTimeFormat` theo múi giờ người xem; tiền lưu số nguyên theo đơn vị nhỏ nhất kèm mã tiền tệ (ISO 4217), không dùng số thực; định dạng bằng `Intl.NumberFormat`; chữ giao diện gọi theo khoá trong tệp dịch, không viết cứng | Cột `ngon_ngu`, `mui_gio` (tên IANA như `Asia/Ho_Chi_Minh`) trong cài đặt người dùng; cột `tien_te` cạnh mọi số tiền | Tỉ giá tự động, giá theo vùng — khi bán thật bằng nhiều loại tiền |
| Theo dõi sự cố | Test bắt khoá dịch thiếu giữa các ngôn ngữ (thêm ngôn ngữ là thứ dùng chung ⇒ `flow-impact`) | — | — |

Bài kiểm bắt buộc:
- Đơn tạo lúc 23:30 giờ Việt Nam ⇒ người xem ở Việt Nam thấy đúng ngày đó; người xem đặt múi giờ UTC thấy 16:30 cùng ngày.
- Cộng 3 món 19.990đ ⇒ tổng đúng 59.970đ, lưu dạng số nguyên.
- Mọi khoá trong tệp tiếng Việt đều có trong tệp ngôn ngữ thứ hai (khi thêm) ⇒ thiếu là test đỏ.

Hay sai:
- Lưu giờ địa phương không kèm múi ⇒ đổi múi giờ/giờ mùa hè là lệch.
- Tiền dùng số thực ⇒ lệch vài đồng khi cộng nhiều món.
- Chữ viết cứng trong code ⇒ thêm ngôn ngữ phải lục từng file.

## Cài đặt người dùng

Nhận ra khi: "trang cài đặt", "tuỳ chọn", "bật/tắt thông báo", "chế độ tối", "đổi tên hiển thị", "ngôn ngữ của tôi".

Hỏi user (lúc viết SPEC):
- Cài đặt theo máy hay theo tài khoản? → khuyên: theo tài khoản (đổi trên điện thoại thì máy tính cũng đổi), trừ chế độ tối và cỡ chữ theo máy.
- Có cài đặt nào nhóm/công ty ép cho thành viên? → khuyên: chưa, để sau.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Endpoint lưu cài đặt chỉ nhận trường cho phép (allow-list), kiểm kiểu và giá trị; không cho đổi `vai_tro`, `goi`, `email` qua đây (chống mass assignment — gửi kèm trường đặc quyền để tự nâng quyền) | — | — |
| Chi phí | — | — | — |
| Chịu tải | Đọc cài đặt một lần cùng phiên, không truy vấn lại mỗi request | Bảng khoá-giá trị hoặc cột JSON có schema, giá trị mặc định nằm trong code ⇒ thêm cài đặt mới không cần migration | Cài đặt cấp tổ chức để thành viên kế thừa — khi có gói nhóm |
| Dữ liệu (riêng tư, xoá, sao lưu) | Đổi email/mật khẩu KHÔNG nằm trong form cài đặt mà là luồng riêng có nhập lại mật khẩu và xác nhận; xoá tài khoản xoá cài đặt | — | — |
| Theo dõi sự cố | — | — | — |

Bài kiểm bắt buộc:
- Gửi lưu cài đặt kèm `"vai_tro": "admin"` ⇒ trường bị bỏ qua, vai trò không đổi.
- Gửi giá trị sai kiểu (`ngon_ngu: 123`) ⇒ 400, không lưu.
- Thêm một cài đặt mới trong code ⇒ người dùng cũ tự nhận giá trị mặc định, không lỗi.

Hay sai:
- Gán thẳng body request vào bản ghi người dùng.
- Cho đổi email ngay trong form cài đặt, không xác nhận ⇒ đường chiếm tài khoản.
- Chỉ lưu cài đặt trong `localStorage` ⇒ đổi máy là mất.

## Cờ tính năng/chế độ bảo trì

Nhận ra khi: "bật cho vài người dùng thử", "tắt tạm tính năng", "bảo trì", "ra mắt từ từ", "thử A/B", "tắt nhanh nếu lỗi".

Hỏi user (lúc viết SPEC):
- Khi bảo trì người dùng thấy gì? → khuyên: trang "Đang bảo trì, quay lại lúc HH:MM"; thứ đang gõ dở không bị mất.
- Bảo trì có chặn cả admin? → khuyên: không, admin vẫn vào để kiểm.
- Có cần thử A/B (hai bản, đo bản nào tốt hơn)? → khuyên: chưa.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Cờ kiểm ở server (ẩn nút không đủ — API vẫn gọi được); chỉ admin bật/tắt cờ, có ghi nhật ký | — | — |
| Chi phí | Cờ là biến môi trường hoặc một dòng KV/DB, không cần dịch vụ trả phí | Hàm `coBat(ten, nguoiDung)` một chỗ; chia nhóm phần trăm bằng băm ổn định ID người dùng | Dịch vụ cờ/A-B riêng — khi trên 10 cờ cùng lúc hoặc cần đo tỉ lệ chuyển đổi (kinh nghiệm, không phải số đo) |
| Chịu tải | Đọc cờ một lần mỗi request; KV đồng bộ chậm (đổi cờ mất một lúc mới tới mọi nơi) — chấp nhận được cho cờ, không dùng cho thứ cần tức thì | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Bảo trì: API trả 503 kèm `Retry-After`, client giữ dữ liệu chưa gửi; tắt cờ không xoá dữ liệu của tính năng | — | — |
| Theo dõi sự cố | Ghi lúc nào ai bật/tắt cờ để nối với lỗi tăng; cờ đã bật cho 100% thì gỡ (đưa vào lượt `flow-maintain`) | — | — |

Bài kiểm bắt buộc:
- Cờ tắt ⇒ gọi thẳng API của tính năng nhận 404/403.
- Bật bảo trì ⇒ API người dùng trả 503, đường admin vẫn 200.
- Cùng một người dùng trong nhóm 10% ⇒ mọi lần đều nhận cùng kết quả cờ.

Hay sai:
- Cờ chỉ ẩn nút ở giao diện.
- Bảo trì làm mất bản nháp người dùng đang gõ.
- Cờ không bao giờ được dọn ⇒ code đầy nhánh chết.

## Đồng ý cookie/analytics/phiên bản điều khoản

Nhận ra khi: "banner cookie", "Google Analytics", "đo lượt truy cập", "điều khoản sử dụng", "chính sách riêng tư", "người dùng phải đồng ý".

Hỏi user (lúc viết SPEC):
- Có khách ở châu Âu không? → khuyên: nếu có, công cụ đo chỉ chạy sau khi người dùng bấm đồng ý; nếu không, dùng công cụ đo không cookie và vẫn có trang chính sách riêng tư.
- Điều khoản đổi thì người dùng cũ phải đồng ý lại? → khuyên: đổi lớn (giá, cách dùng dữ liệu) thì hiện hộp đồng ý khi đăng nhập; đổi nhỏ thì báo.
- Cần biết ai đồng ý phiên bản nào, lúc nào (khi tranh chấp)? → khuyên: có.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | — | — | — |
| Chi phí | Công cụ đo nhẹ, không cookie (vd Cloudflare Web Analytics) trước khi gắn công cụ nặng | — | — |
| Chịu tải | Script đo tải sau, không chặn hiện trang | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Bảng `dong_y(nguoi_dung, loai, phien_ban, luc, cach)` chỉ ghi thêm; điều khoản có số phiên bản; không gửi email/ID người dùng vào công cụ đo; nút từ chối dễ bấm như nút đồng ý; rút đồng ý được bất cứ lúc nào | Cột `dieu_khoan_phien_ban` trên người dùng để chặn khi lệch phiên bản hiện hành | Công cụ quản lý đồng ý theo vùng (CMP) — khi chạy quảng cáo hoặc khách EU chiếm phần đáng kể |
| Theo dõi sự cố | — | — | — |

Bài kiểm bắt buộc:
- Chưa bấm đồng ý ⇒ trang không gửi request nào tới công cụ đo.
- Nâng phiên bản điều khoản ⇒ người dùng cũ đăng nhập thấy hộp đồng ý; bấm xong có dòng `dong_y` mới đúng phiên bản.
- Rút đồng ý trong cài đặt ⇒ lần tải trang sau script đo không chạy.

Hay sai:
- Gắn Google Analytics ngay từ đầu mà không hỏi.
- Chỉ lưu "đã đồng ý = true", không phiên bản, không thời điểm ⇒ không chứng minh được khi tranh chấp.
- Banner chỉ có nút "Đồng ý".

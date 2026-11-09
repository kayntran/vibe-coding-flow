# Bản mẫu: dữ liệu, danh sách và việc nền

Dùng ở bước 4 của `flow-system-design`.

## Mục lục

- Danh sách dài/phân trang
- Tìm kiếm
- Nhập/xuất Excel-CSV
- Thống kê/dashboard
- Việc chạy nền/hẹn giờ/nhắc việc
- Tạo báo cáo/PDF/xuất hàng loạt
- Xoá mềm/thùng rác/hoàn tác/lịch sử phiên bản
- Đặt chỗ/tồn kho/hạn mức có hạn
- Bộ đếm nóng/lượt thích/lượt xem/bảng xếp hạng

Cách dùng: nhận ra loại ⇒ hỏi các câu lúc viết SPEC (`flow-spec`) ⇒ "Làm ngay" thành `AC-nn` kèm bài kiểm ⇒ "Chừa chỗ" vào mục kiến
trúc của plan ⇒ "Chưa làm" vào lộ trình theo ngưỡng. Giá và giới hạn gói: tra trang giá chính thức lúc thiết kế, không ghi ở đây.

## Danh sách dài/phân trang

Nhận ra khi: "danh sách", "xem thêm", "cuộn vô hạn", "trang 1 2 3", "lọc theo", "sắp xếp theo", "bảng khách hàng".

Hỏi user (lúc viết SPEC):
- Người dùng cần nhảy thẳng tới trang 57, hay chỉ "Xem thêm"? → khuyên: "Xem thêm"/cuộn; nhảy trang chỉ cho bảng quản trị nếu thật cần.
- Có cần hiện "Tổng 12.345 kết quả"? → khuyên: không; nếu cần thì "Hơn 1.000".
- Lọc/sắp xếp theo những gì? → khuyên: 2–3 kiểu chính (mới nhất, tên, trạng thái); thêm khi có người xin.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Cỡ trang có trần ở server (vd 100), client xin hơn thì cắt; mọi truy vấn có điều kiện phạm vi người dùng/tenant (khách hàng thuê app) | — | — |
| Chi phí | Phân trang keyset (nhớ mốc hàng cuối, lấy "các hàng sau mốc") thay OFFSET: OFFSET vẫn đọc cả các hàng bị bỏ qua, mà D1 tính theo số hàng đọc | — | — |
| Chịu tải | Index ghép khớp (cột lọc, cột sắp xếp, id); mốc là cặp (giá trị sắp xếp, id) để không lệch khi trùng giá trị | Hàm `phanTrang(truyVan, moc, co)` dùng chung; mốc gói thành chuỗi mờ để client không tự chế | Tổng gần đúng/cache số tổng — khi người dùng thật xin xem số tổng |
| Dữ liệu (riêng tư, xoá, sao lưu) | Mốc không chứa dữ liệu nhạy cảm; quyền kiểm lại mỗi trang, không dựa vào mốc | — | — |
| Theo dõi sự cố | Log truy vấn chậm hơn 500 ms (kinh nghiệm, không phải số đo) | — | — |

Bài kiểm bắt buộc:
- Chèn 5 hàng mới giữa lúc lấy trang 1 và trang 2 ⇒ trang 2 không lặp hàng của trang 1, không sót hàng.
- Gọi `?co=10000` ⇒ nhận tối đa 100 hàng.
- Người A dùng mốc copy từ phiên người B ⇒ vẫn chỉ thấy dữ liệu của A.

Hay sai:
- OFFSET + `COUNT(*)` mỗi lần ⇒ trang sau chậm dần, hoá đơn đọc tăng.
- Sắp xếp theo cột không duy nhất (ngày) mà không kèm id ⇒ sót/lặp hàng.
- Tải hết về trình duyệt rồi chia trang ở client.

## Tìm kiếm

Nhận ra khi: "ô tìm kiếm", "tìm theo tên", "gõ là gợi ý", "tìm không dấu", "lọc nâng cao", "tìm sản phẩm".

Hỏi user (lúc viết SPEC):
- Gõ "nguyen" có ra "Nguyễn" không? → khuyên: có (tìm không dấu, không phân biệt hoa thường).
- Tìm trong dữ liệu của chính mình hay toàn bộ nội dung công khai? → khuyên: theo SPEC; công khai thì phải chống bot.
- Gõ sai chính tả vẫn ra kết quả? → khuyên: chưa cần lúc đầu.
- Hỏi bằng câu tự nhiên ("áo mặc đi biển") có cần hiểu ý? → khuyên: chưa; đó là tìm theo ngữ nghĩa, làm như một tính năng gọi AI riêng.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Tìm công khai: rate limit theo IP; từ khoá 2–100 ký tự; escape `%` và `_` trong LIKE; luôn bind tham số, không nối chuỗi SQL | — | — |
| Chi phí | Gõ-là-gợi-ý: debounce (chờ người dùng ngừng gõ khoảng 300 ms mới gửi), huỷ request cũ | — | Dịch vụ tìm riêng (Meilisearch, Typesense, Algolia…) — khi cần sửa sai chính tả, xếp hạng theo độ liên quan, hoặc trên 1 triệu bản ghi mà full-text vẫn trên 500 ms (kinh nghiệm, không phải số đo) |
| Chịu tải | Bậc 1: LIKE `'tu_khoa%'` trên cột đã chuẩn hoá (bỏ dấu, chữ thường) có index; LIKE `'%x%'` không dùng được index ⇒ quét cả bảng, chỉ chấp nhận khi bảng nhỏ | Cột `ten_khong_dau` chuẩn hoá lúc ghi; hàm `timKiem()` bọc một chỗ để nâng bậc không sửa màn | Bậc 2 full-text (FTS5 trên D1/SQLite, `tsvector` + GIN trên Postgres) — khi cần tìm giữa chữ/nhiều từ, hoặc LIKE quét bảng trên 300 ms (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Lọc quyền ngay trong truy vấn tìm, không tìm rộng rồi lọc ở client; xoá bản ghi ⇒ xoá luôn khỏi chỉ mục full-text/dịch vụ ngoài | — | — |
| Theo dõi sự cố | Log từ khoá ra 0 kết quả (không kèm danh tính) để biết người dùng tìm gì mà không có | — | — |

Bài kiểm bắt buộc:
- Tìm "nguyen" ⇒ ra "Nguyễn Văn A".
- Tìm "%" hoặc "_" ⇒ không trả cả bảng.
- Người A tìm đúng tên bản ghi riêng của B ⇒ 0 kết quả.

Hay sai:
- Dựng Elasticsearch cho 5.000 bản ghi.
- LIKE `'%x%'` không giới hạn trên bảng lớn, mở công khai ⇒ một bot làm chậm cả app.
- Người dùng xoá dữ liệu nhưng chỉ mục tìm kiếm bên ngoài vẫn còn.

## Nhập/xuất Excel-CSV

Nhận ra khi: "nhập từ Excel", "import danh sách", "xuất ra Excel", "tải CSV", "tải dữ liệu của tôi", "chuyển dữ liệu từ app cũ".

Hỏi user (lúc viết SPEC):
- File nhập lớn nhất bao nhiêu dòng? → khuyên: 10.000 dòng mỗi lần; hơn thì chia file.
- Có dòng lỗi thì sao? → khuyên: xem trước, báo rõ dòng nào lỗi vì sao, người dùng bấm "Nhập N dòng đúng".
- Dòng trùng (đã có email này) thì sao? → khuyên: bỏ qua và báo; có tuỳ chọn "Cập nhật dòng trùng".
- Xuất lâu thì chờ hay báo sau? → khuyên: vài nghìn dòng tải ngay; lớn hơn chạy nền, xong báo trong app.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Xuất: ô bắt đầu bằng `=` `+` `-` `@` (và tab, xuống dòng đầu ô) thêm dấu `'` phía trước — chống CSV injection (Excel coi ô là công thức và chạy); nhập: trần cỡ file và số dòng ở server, kiểm từng trường như form, chỉ nhận cột cho phép (allow-list) | — | — |
| Chi phí | Ghi theo lô vài trăm dòng mỗi lần, không mỗi dòng một request; D1 có trần số câu và số tham số mỗi lần gọi ⇒ chia lô cho vừa | — | — |
| Chịu tải | File lớn: tải lên R2, xử lý trong Queue (hàng đợi việc nền), không làm trong request vì Worker có trần CPU | Bảng `lan_nhap` (trang_thai, so_dong_ok, so_dong_loi, file_loi) | Đọc file kiểu luồng từng đoạn — khi file thường trên 50 MB (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Xuất chỉ dữ liệu người đó có quyền; file xuất để R2 riêng tư, link ký hạn ngắn, tự xoá sau 7 ngày | Cột `ma_lan_nhap` trên mỗi hàng được nhập ⇒ hoàn tác được cả một lần nhập | — |
| Theo dõi sự cố | Nhật ký thao tác cho mọi lần nhập/xuất (dữ liệu ra khỏi app hoặc vào hàng loạt) | — | — |

Bài kiểm bắt buộc:
- Bản ghi tên `=HYPERLINK("http://x","bam")` ⇒ trong file xuất ô là `'=HYPERLINK(...)`.
- Nhập file 10.001 dòng ⇒ từ chối với lời báo rõ, không ghi dòng nào.
- Nhập file có thêm cột `vai_tro` = `admin` ⇒ cột bị bỏ qua, vai trò không đổi.

Hay sai:
- Xuất thẳng chuỗi người dùng nhập vào file CSV.
- Đọc cả file lớn trong một request ⇒ hết giờ/hết bộ nhớ.
- Nhập từng dòng không gom lô, lỗi giữa chừng để lại nửa dữ liệu không biết dòng nào đã vào.

## Thống kê/dashboard

Nhận ra khi: "thống kê", "dashboard", "biểu đồ doanh thu", "báo cáo theo tháng", "bao nhiêu người dùng hôm nay", "trang tổng quan".

Hỏi user (lúc viết SPEC):
- Số liệu cần mới tới phút hay mỗi giờ là đủ? → khuyên: mỗi giờ; chỉ 1–2 con số quan trọng (đơn hôm nay) mới cần ngay lập tức.
- "Một ngày" tính theo giờ nào? → khuyên: giờ doanh nghiệp (Asia/Ho_Chi_Minh), ghi rõ trên màn.
- Ai được xem? → khuyên: chủ tài khoản/admin; nhân viên chỉ xem phần của mình.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Quyền xem kiểm ở server; mọi số liệu lọc theo tenant | — | — |
| Chi phí | Không `SUM`/`COUNT` trên cả bảng mỗi lần mở dashboard (D1 tính theo hàng đọc; D1 Free chặn truy vấn khi chạm trần đọc ngày) | Bảng `tong_hop_ngay(tenant, ngay, chi_so, gia_tri)` cập nhật bằng Cron hoặc khi ghi | Kho phân tích riêng (Workers Analytics Engine, ClickHouse…) — khi bảng sự kiện trên 10 triệu dòng hoặc truy vấn tổng hợp trên 2 giây (kinh nghiệm, không phải số đo) |
| Chịu tải | Index (tenant, ngay); trần khoảng ngày mỗi lần xem (vd tối đa 1 năm) | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Lưu thời gian UTC, quy sang múi giờ doanh nghiệp lúc gom ngày; số liệu chia sẻ ra ngoài chỉ là số gộp | — | — |
| Theo dõi sự cố | Job tổng hợp ghi lần chạy thành công cuối; màn hiện "Cập nhật lúc …" | Cảnh báo khi job tổng hợp lỡ 2 lần liên tiếp | — |

Bài kiểm bắt buộc:
- Đơn lúc 23:30 giờ Việt Nam ngày 1 ⇒ tính vào ngày 1, không sang ngày 2.
- Tài khoản tenant A gọi API thống kê với ID tenant B ⇒ 403.
- Chạy job tổng hợp 2 lần trong cùng ngày ⇒ số không nhân đôi (ghi đè theo khoá ngày, không cộng dồn).

Hay sai:
- `COUNT` cả bảng mỗi lần mở trang tổng quan.
- Gom ngày theo UTC ⇒ đơn buổi sáng sớm giờ Việt Nam nằm ở ngày hôm trước.
- Job tổng hợp cộng dồn, chạy lại một lần là số sai gấp đôi.

## Việc chạy nền/hẹn giờ/nhắc việc

Nhận ra khi: "gửi nhắc trước 1 ngày", "mỗi sáng tự…", "chạy lúc nửa đêm", "hẹn giờ đăng", "xử lý xong thì báo tôi", "tự động gia hạn".

Hỏi user (lúc viết SPEC):
- Trễ bao nhiêu thì chấp nhận được? → khuyên: nhắc việc trễ tới 5 phút là ổn.
- Lỡ giờ (máy chủ lỗi) thì chạy bù hay bỏ? → khuyên: chạy bù nếu trễ dưới 1 giờ; quá thì bỏ và ghi lại.
- Nhắc theo giờ của ai? → khuyên: giờ của người nhận (múi giờ trong cài đặt của họ).

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Trần số việc hẹn đang chờ mỗi người (vd 100) | — | — |
| Chi phí | Cron Trigger (lịch chạy định kỳ của Workers) quét bảng việc hẹn theo index (chay_luc, trang_thai), lấy theo lô; Queues tính theo thao tác và mỗi lần thử lại tính thêm ⇒ đặt trần thử lại | — | — |
| Chịu tải | Việc lâu đẩy vào Queue, không làm trong Cron hay request; mỗi việc idempotent (chạy 2 lần cũng chỉ có tác dụng 1 lần) bằng đổi trạng thái có điều kiện `WHERE trang_thai = 'cho'` | Bảng `viec_hen(id, loai, chay_luc UTC, trang_thai, so_lan_thu, loi_cuoi)`; dead-letter queue (hàng chứa việc thử mãi vẫn lỗi) | Workflows hoặc hàng đợi riêng theo loại — khi trên 5.000 việc/giờ hoặc chuỗi nhiều bước phải chờ nhau (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Giờ chạy lưu UTC + múi giờ người nhận; xoá tài khoản ⇒ huỷ mọi việc hẹn của họ | — | — |
| Theo dõi sự cố | Mỗi job ghi "lần chạy thành công cuối"; cảnh báo khi quá hạn (job chết lặng là kiểu hỏng hay gặp nhất) | Đếm việc trong hàng chết | — |

Bài kiểm bắt buộc:
- Chạy job nhắc 2 lần liên tiếp trong cùng phút ⇒ người dùng nhận đúng 1 nhắc.
- Việc lỗi mãi ⇒ thử tới trần rồi vào hàng chết, không thử vô hạn.
- Người dùng múi giờ UTC+7 hẹn 08:00 ⇒ việc chạy lúc 01:00 UTC.

Hay sai:
- Dùng `setTimeout`/`setInterval` trong Worker để hẹn giờ ⇒ không sống qua hết request.
- Việc không idempotent ⇒ thử lại là gửi trùng email/trừ tiền hai lần.
- Không ai biết job đã ngừng chạy từ tuần trước.

## Tạo báo cáo/PDF/xuất hàng loạt

Nhận ra khi: "xuất PDF", "in hoá đơn", "tạo báo cáo tháng", "tải tất cả", "gửi hàng loạt", "nén thành file zip".

Hỏi user (lúc viết SPEC):
- Người dùng chờ được bao lâu? → khuyên: dưới 5 giây thì chờ tại chỗ; lâu hơn chạy nền, xong báo trong app.
- File tạo xong giữ bao lâu? → khuyên: 7 ngày rồi tự xoá, bấm tạo lại được.
- Một lần tạo tối đa bao nhiêu? → khuyên: 1.000 hoá đơn mỗi lần.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Rate limit số lần tạo theo người; chống bấm trùng bằng idempotency key (mã chống gửi trùng) + nút chuyển "Đang tạo…" | — | — |
| Chi phí | Tạo một lần, lưu R2, tải lại dùng bản đã có; dịch vụ dựng PDF ngoài/trình duyệt ảo tính tiền theo lần ⇒ đặt trần | Cột `bam_noi_dung` (dấu vân tay dữ liệu) để biết dữ liệu chưa đổi thì dùng lại file | — |
| Chịu tải | Việc quá vài giây đi Queue, chia lô; Worker có trần CPU và bộ nhớ ⇒ không dựng file lớn trong request | Bảng `lan_xuat(trang_thai, tien_do, file_key, het_han)` | Máy riêng cho việc nặng (container/VPS) — khi một file cần trên 1 phút CPU hoặc Worker chạm trần bộ nhớ |
| Dữ liệu (riêng tư, xoá, sao lưu) | File chứa dữ liệu riêng: R2 không công khai, link ký hạn ngắn; tự xoá theo hạn | — | — |
| Theo dõi sự cố | Log thời gian tạo và lỗi; cảnh báo hàng đợi ứ | — | — |

Bài kiểm bắt buộc:
- Bấm "Xuất" 2 lần trong 1 giây ⇒ chỉ một việc được tạo.
- Người B mở link file của A (hoặc link đã hết hạn) ⇒ bị từ chối.
- Yêu cầu 1.001 hoá đơn ⇒ báo "Chia nhỏ, tối đa 1.000", không tạo việc.

Hay sai:
- Dựng PDF ngay trong request ⇒ hết giờ, hết bộ nhớ, người dùng bấm lại càng nặng.
- File xuất để public "cho dễ tải".
- Không giới hạn ⇒ một người xuất cả DB nhiều lần mỗi giờ.

## Xoá mềm/thùng rác/hoàn tác/lịch sử phiên bản

Nhận ra khi: "thùng rác", "lỡ xoá", "khôi phục", "hoàn tác", "xem bản cũ", "lịch sử chỉnh sửa", "ai sửa lúc nào".

Hỏi user (lúc viết SPEC):
- Xoá rồi lấy lại được trong bao lâu? → khuyên: 30 ngày trong thùng rác, sau đó xoá hẳn.
- Người dùng xoá tài khoản hoặc yêu cầu xoá dữ liệu thì thùng rác thế nào? → khuyên: xoá hẳn ngay, không chờ 30 ngày (trừ thứ luật bắt giữ như hoá đơn).
- Cần xem/khôi phục bản sửa trước không? → khuyên: chỉ cho tài liệu quan trọng, giữ 20 bản gần nhất.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Quyền khôi phục = quyền xoá; "Xoá vĩnh viễn" có chữ rõ nêu tên đối tượng | — | — |
| Chi phí | Job dọn xoá hẳn hàng quá hạn (không thì DB phình mãi, mà D1 có trần cỡ mỗi DB) | — | — |
| Chịu tải | Cột `xoa_luc` (NULL = còn) quyết từ đầu; MỌI truy vấn lọc qua view hoặc hàm bọc chung; unique có điều kiện (partial index) để tên đã xoá không chặn tạo tên mới | Bảng `phien_ban(ban_ghi_id, so, noi_dung, sua_boi, luc)` | Lưu phiên bản dạng chênh lệch (diff) — khi bảng phiên bản lớn hơn 10 lần bảng chính (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Tách "thùng rác của người dùng" khỏi "sao lưu của app": D1 Time Travel khôi phục cả DB về một mốc, ghi đè tại chỗ ⇒ không dùng để cứu một bản ghi; xoá hẳn trong hạn đã hứa (quyền được xoá, GDPR Điều 17) kèm file R2 và chỉ mục tìm kiếm | Cột `xoa_boi`, `xoa_han` | — |
| Theo dõi sự cố | Nhật ký xoá hẳn và khôi phục | — | — |

Bài kiểm bắt buộc:
- Xoá mềm một bản ghi ⇒ không xuất hiện ở danh sách, tìm kiếm, xuất file, API theo ID.
- Khôi phục ⇒ hiện lại đầy đủ, kể cả file đính kèm.
- Hàng quá 30 ngày ⇒ job dọn xoá hẳn cả dòng lẫn file R2.

Hay sai:
- Thêm xoá mềm khi đã có 50 truy vấn ⇒ sót một chỗ là "đã xoá vẫn hiện".
- Unique trên tên làm người dùng không tạo lại được tên đã xoá.
- Tưởng Time Travel là thùng rác ⇒ khôi phục một bản ghi làm mất mọi thay đổi của người khác sau mốc.

## Đặt chỗ/tồn kho/hạn mức có hạn

Nhận ra khi: "đặt lịch", "đặt bàn", "giữ chỗ", "còn hàng", "số lượng có hạn", "mỗi người được 3 lượt", "bán vé", "suất".

Hỏi user (lúc viết SPEC):
- Giữ chỗ bao lâu trong lúc người dùng thanh toán? → khuyên: 10 phút, hết thì tự nhả.
- Hết chỗ thì người dùng thấy gì? → khuyên: báo "Hết chỗ"; nút "Báo tôi khi có chỗ" để sau.
- Có cho đặt quá số chỗ (overbooking) không? → khuyên: không.
- Huỷ trước bao lâu thì được hoàn? → khuyên: theo chính sách của bạn; mặc định trước 24 giờ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Idempotency key khi bấm Đặt; trần số chỗ đang giữ cùng lúc mỗi người (chống giữ hết rồi bỏ); rate limit đặt | — | Hàng chờ ảo chống bot săn vé — khi mở bán có trên 1.000 người chờ cùng lúc (kinh nghiệm, không phải số đo) |
| Chi phí | — | — | — |
| Chịu tải | Chống đặt trùng NGAY TRONG DB, không kiểm-rồi-ghi ở code: ràng buộc unique (tài nguyên, khung giờ), hoặc một câu `UPDATE … SET con_lai = con_lai - 1 WHERE id = ? AND con_lai >= 1` rồi xem số hàng bị đổi; D1 không có giao dịch tương tác ⇒ dùng câu có điều kiện hoặc `batch()`; Postgres dùng giao dịch có khoá (`SELECT … FOR UPDATE`) hoặc unique | Cột `trang_thai` (giu / xac_nhan / huy / het_han) + `giu_den`; bảng hàng chờ | Một Durable Object giữ mỗi suất — khi một suất nhận trên vài trăm lượt đặt/giây (kinh nghiệm, không phải số đo); overbooking có chủ đích — khi tỉ lệ huỷ phút chót đo được đủ cao và ổn định |
| Dữ liệu (riêng tư, xoá, sao lưu) | Giữ lịch sử đặt/huỷ (đối soát tiền, khiếu nại); thời gian UTC | — | — |
| Theo dõi sự cố | Đếm lần bị từ chối vì hết chỗ và lỗi vi phạm unique; chỗ giữ hết hạn được nhả bằng job, có log | — | — |

Bài kiểm bắt buộc:
- 20 request đặt đồng thời vào suất còn 1 chỗ ⇒ đúng 1 thành công, 19 nhận "Hết chỗ".
- Giữ chỗ quá 10 phút không thanh toán ⇒ chỗ được nhả, người khác đặt được.
- Bấm Đặt 2 lần cùng idempotency key ⇒ một đơn, cùng phản hồi.

Hay sai:
- `SELECT` còn chỗ ở code rồi mới `INSERT` ⇒ hai người cùng được một chỗ.
- Giữ chỗ không có hạn ⇒ "chỗ ma" không ai dùng mà không ai đặt được.
- Nhả chỗ bằng `setTimeout` ⇒ Worker kết thúc là không bao giờ nhả.

## Bộ đếm nóng/lượt thích/lượt xem/bảng xếp hạng

Nhận ra khi: "lượt thích", "thả tim", "lượt xem", "số người đang xem", "bảng xếp hạng", "top tuần", "bài nổi bật".

Hỏi user (lúc viết SPEC):
- Lượt xem cần chính xác tuyệt đối hay gần đúng? → khuyên: gần đúng, cập nhật vài phút một lần.
- Thích nhiều lần được không, bỏ thích được không? → khuyên: mỗi người một lần, bỏ được.
- Xem lại trang có tính thêm lượt? → khuyên: mỗi người/thiết bị tính một lượt mỗi ngày.
- Bảng xếp hạng làm mới bao lâu? → khuyên: mỗi giờ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Lượt thích: unique (nguoi_dung, doi_tuong), chỉ người đăng nhập; lượt xem: khử trùng theo người/thiết bị mỗi ngày, bỏ bot | — | Lọc gian lận lượt xem — khi lượt xem dùng để trả tiền hoặc xếp hạng có thưởng |
| Chi phí | Không ghi DB mỗi lượt xem: gom rồi ghi theo lô (D1/KV/Durable Objects đều tính theo lượt ghi) | — | — |
| Chịu tải | Bảng `thich` + cột đếm lưu sẵn, cộng/trừ bằng `SET dem = dem + 1` trong cùng `batch()` với dòng thích; KHÔNG dùng KV làm bộ đếm (KV đồng bộ chậm và có trần tần suất ghi cùng một khoá); bảng xếp hạng tính định kỳ vào bảng riêng | Hàm `tangDem(doiTuong)` bọc một chỗ | Bộ đếm chia mảnh (sharded counter) hoặc Durable Object mỗi đối tượng — khi một dòng nhận trên vài chục lượt ghi/giây liên tục (kinh nghiệm, không phải số đo; DO cũng có trần mềm request/giây mỗi đối tượng) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Danh sách "ai đã thích" công khai hay không theo SPEC; xoá tài khoản ⇒ trừ đếm | — | — |
| Theo dõi sự cố | Job đối soát hằng ngày so đếm lưu sẵn với đếm thật, sửa lệch và ghi số lệch | — | — |

Bài kiểm bắt buộc:
- 50 người thích cùng lúc ⇒ đếm đúng 50.
- Cùng người thích 2 lần ⇒ đếm chỉ tăng 1.
- Xoá tài khoản đã thích ⇒ sau job đối soát, đếm giảm 1.

Hay sai:
- Đọc số đếm ra code, cộng 1, ghi lại ⇒ mất lượt khi đông.
- Dùng KV làm bộ đếm ⇒ số nhảy lung tung, ghi bị từ chối.
- Ghi DB mỗi lượt xem ⇒ hoá đơn ghi tăng theo lượt truy cập.

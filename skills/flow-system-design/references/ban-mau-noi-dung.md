# Bản mẫu: nội dung và cộng đồng

Dùng ở bước 4 của `flow-system-design`.

## Mục lục

- Tải file/ảnh lên
- Bình luận/đánh giá
- Chat thời gian thực
- Bài đăng/feed
- Theo dõi/chặn/ẩn/đề cập
- Báo cáo vi phạm/kiểm duyệt
- Trang công khai có SEO/ảnh chia sẻ/link ngắn
- Điểm vào công khai không cần đăng nhập

Cách dùng: nhận ra loại ⇒ hỏi các câu lúc viết SPEC (`flow-spec`) ⇒ cột "Làm ngay" thành tiêu chí `AC-nn` kèm bài kiểm ⇒ "Chừa chỗ"
vào mục kiến trúc của plan ⇒ "Chưa làm" vào lộ trình theo ngưỡng. Giá và giới hạn gói: tra bảng số liệu có ngày, không ghi ở đây.

## Tải file/ảnh lên

Nhận ra khi: "tải ảnh lên", "đính kèm file", "ảnh đại diện", "upload tài liệu", "gửi hồ sơ PDF", "kéo thả file vào".

Hỏi user (lúc viết SPEC):
- Người dùng tải loại file nào, nặng nhất bao nhiêu? → khuyên: chỉ ảnh JPG/PNG/WebP và PDF, tối đa 10 MB; loại khác thêm khi có người xin.
- File có ai khác xem được không, hay chỉ chủ? → khuyên: mặc định chỉ chủ; muốn công khai thì người dùng bấm chia sẻ từng file.
- Mỗi người được dùng bao nhiêu dung lượng? → khuyên: gói miễn phí có trần tổng, chạm trần thì báo "Đã đầy — xoá bớt hoặc nâng gói".
- Xoá bài/xoá tài khoản thì file đi theo không? → khuyên: có, file bị xoá hẳn trong vòng 30 ngày.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ người đã đăng nhập mới xin được presigned URL (link tải lên có chữ ký, hạn vài phút) của R2; khoá Content-Type khi ký; allow-list đuôi file; sau khi tải lên đọc byte đầu (chữ ký file thật), sai loại ⇒ xoá object; rate limit (giới hạn số lần) xin link theo người dùng | Cột `trang_thai` (cho_kiem / da_kiem / bi_chan) trên bảng file để sau cắm bước quét mã độc | Quét virus/ảnh nhạy cảm tự động — khi file được người khác tải về, hoặc có báo cáo vi phạm đầu tiên |
| Chi phí | Trần dung lượng mỗi người tính ở server; job dọn object đã ký mà không bấm xác nhận; hiển thị bản thu nhỏ, không phục vụ ảnh gốc ở danh sách | Cột `kich_thuoc` + tổng theo người để đổi quota theo gói | Biến đổi ảnh nhiều cỡ/CDN ảnh — khi băng thông ảnh thành khoản lớn nhất hoá đơn (R2 không tính phí tải ra, Supabase Storage có tính — tra bảng số liệu có ngày) |
| Chịu tải | Trình duyệt đẩy thẳng lên R2, không đi qua Worker (Worker có trần bộ nhớ, file lớn sẽ vỡ); bước "xác nhận" đo cỡ thật của object, quá cỡ ⇒ xoá | Xử lý sau tải (thu nhỏ, kiểm) đặt trong hàm riêng chạy qua Queue | Tải nhiều phần (multipart) — khi file thường trên 100 MB (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Key object do app sinh (UUID), không dùng tên gốc; tên gốc làm sạch rồi lưu cột riêng; bucket không công khai, tải về qua kiểm quyền + link ký hạn ngắn; mã hoá lại ảnh để bỏ EXIF (có toạ độ GPS) | Bảng `tep` có `chu_so_huu`, `xoa_luc` để xoá theo tài khoản | Sao lưu R2 sang nơi thứ hai (`flow-backup`) — khi file là thứ người dùng không tạo lại được (hợp đồng, hồ sơ) |
| Theo dõi sự cố | Log mỗi lần tải: ai, cỡ, loại, kết quả kiểm; không log URL đã ký | — | Cảnh báo dung lượng tăng bất thường — khi có trên 1.000 người tải (kinh nghiệm, không phải số đo) |

Bài kiểm bắt buộc:
- Đổi đuôi file `.exe` thành `.jpg` rồi tải lên ⇒ bước kiểm nội dung báo sai loại, object bị xoá, người dùng thấy "File không phải ảnh".
- Xin link với cỡ khai 5 MB rồi đẩy file 50 MB ⇒ bước xác nhận đo cỡ thật, xoá object, trả lỗi; quota không bị cộng.
- Người B đổi ID trong link tải file của người A ⇒ 403, không nhận được link ký.

Hay sai:
- Tin `Content-Type` trình duyệt gửi; dùng tên file gốc làm key (lộ tên, đè file người khác, tên kiểu `../`).
- Để bucket công khai "cho dễ hiện ảnh" ⇒ ai có link là xem được hồ sơ riêng.
- Đẩy file qua Worker để "kiểm cho chắc" ⇒ file lớn làm Worker vượt trần bộ nhớ.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html · https://developers.cloudflare.com/r2/api/s3/presigned-urls/ · https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html

## Bình luận/đánh giá

Nhận ra khi: "bình luận", "đánh giá sao", "review sản phẩm", "góp ý dưới bài", "trả lời bình luận", "chấm điểm".

Hỏi user (lúc viết SPEC):
- Ai được bình luận/đánh giá? → khuyên: chỉ người đã đăng nhập; đánh giá sản phẩm chỉ người đã mua.
- Mỗi người đánh giá một món mấy lần? → khuyên: một lần, sửa được; sửa thì thay điểm cũ chứ không cộng thêm.
- Bình luận hiện ngay hay chờ duyệt? → khuyên: hiện ngay, có nút báo vi phạm; tài khoản tạo chưa tới 1 ngày mà có link thì chờ duyệt.
- Trả lời lồng mấy tầng? → khuyên: một tầng (bình luận + trả lời), không lồng sâu.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Ràng buộc unique (nguoi_dung, mon) cho đánh giá ngay trong DB; rate limit bình luận theo người; giới hạn độ dài; hiện bằng chữ đã escape, không render HTML; link trong bình luận gắn `rel="nofollow ugc"` | Cột `trang_thai` (hien / cho_duyet / an) từ ngày đầu | Lọc spam tự động/AI kiểm duyệt — khi admin phải ẩn tay trên 20 bình luận/ngày (kinh nghiệm, không phải số đo) |
| Chi phí | Mỗi lần tải chỉ một trang bình luận (D1 tính theo số hàng đọc, Supabase theo compute) | — | — |
| Chịu tải | Điểm trung bình lưu sẵn trên món (tổng điểm, số lượt), cập nhật cùng lúc ghi đánh giá — không tính AVG mỗi lần xem; index (mon_id, tao_luc); phân trang keyset (nhớ mốc hàng cuối thay vì OFFSET) | Cột `cha_id` cho trả lời | Cache trang bình luận — khi một món có trên 10.000 lượt xem/ngày (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ chủ sửa/xoá, kiểm ở server hoặc RLS (luật ai đọc/ghi dòng nào ngay trong DB); xoá tài khoản ⇒ bình luận xoá hoặc hiện "Người dùng đã xoá" theo SPEC | Cột `sua_luc`, bảng lịch sử sửa nếu SPEC cần | — |
| Theo dõi sự cố | Log mỗi lần admin ẩn/xoá | Đếm số báo vi phạm mỗi ngày | Cảnh báo khi số bình luận/giờ gấp nhiều lần bình thường — khi có cộng đồng hoạt động hằng ngày |

Bài kiểm bắt buộc:
- Gửi đánh giá lần 2 cho cùng món (kể cả 2 request đồng thời) ⇒ vẫn một dòng, điểm trung bình tính đúng.
- Bình luận chứa `<script>alert(1)</script>` ⇒ hiện ra dạng chữ, không chạy.
- Bình luận vượt ngưỡng tần suất trong 1 phút ⇒ 429, không lưu.

Hay sai:
- Kiểm "đã đánh giá chưa" ở code rồi mới ghi ⇒ bấm hai lần ra hai dòng.
- Tính AVG trên cả bảng mỗi lần mở trang sản phẩm.
- Cho viết markdown/HTML mà không làm sạch đầu ra.

Nguồn: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x11-V2-Validation-and-Business-Logic.md · https://use-the-index-luke.com/no-offset · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://supabase.com/docs/guides/database/postgres/row-level-security

## Chat thời gian thực

Nhận ra khi: "nhắn tin", "chat", "hộp thư", "thấy tin ngay không cần tải lại", "đang gõ…", "phòng chat nhóm", "hỗ trợ trực tuyến".

Hỏi user (lúc viết SPEC):
- Chat 1-1 hay nhóm, nhóm tối đa bao nhiêu người? → khuyên: 1-1 và nhóm tối đa 50 người.
- Tin nhắn giữ bao lâu, thu hồi được không? → khuyên: giữ tới khi người dùng xoá; thu hồi trong 15 phút.
- Người lạ có nhắn được không? → khuyên: chỉ người cùng nhóm/đã kết nối; người lạ vào mục "Tin chờ".
- Mất mạng rồi vào lại có cần thấy đủ tin? → khuyên: có, tự tải các tin bị lỡ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Kiểm quyền thành viên phòng ở server TRƯỚC khi nhận kết nối WebSocket (kết nối hai chiều mở liên tục); rate limit số tin theo người; giới hạn cỡ tin; luật người lạ theo SPEC | Bảng `thanh_vien_phong` có vai trò; quan hệ chặn dùng chung với tính năng chặn | Lọc nội dung tự động — khi có báo vi phạm đầu tiên |
| Chi phí | Webapp Cloudflare: Durable Objects (mỗi phòng một "đối tượng" chạy ở một chỗ, giữ kết nối và trạng thái), dùng chế độ ngủ của WebSocket để phòng im không tốn thời gian chạy; Supabase Realtime tính theo kết nối đồng thời và số tin — tra bảng số liệu có ngày; "đang gõ" gộp, tối đa một lần mỗi vài giây | — | — |
| Chịu tải | Một Durable Object mỗi phòng, KHÔNG một đối tượng cho cả app (mỗi đối tượng có trần mềm số request/giây); tin được lưu trước rồi mới phát; client tự nối lại với độ trễ tăng dần | Cột `so_thu_tu` tăng dần trong mỗi phòng để client hỏi "các tin sau số N" | Tách phòng rất lớn thành nhiều mảnh — khi có kênh trên 1.000 người (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ thành viên đọc được tin (RLS nếu Supabase, kiểm trong DO nếu Cloudflare); xoá tài khoản ⇒ xoá hoặc ẩn danh tin; ảnh trong chat theo bản mẫu tải file | Cột `thu_hoi_luc`, `xoa_luc`; mã tin do client sinh | Mã hoá đầu-cuối — chỉ khi SPEC hứa "kể cả chúng tôi cũng không đọc được"; hứa rồi thì phải làm từ đầu vì đổi sau gần như viết lại |
| Theo dõi sự cố | Đếm kết nối đang mở, lỗi gửi; log kết nối bị từ chối quyền | — | Đo độ trễ gửi-nhận — khi trên 1.000 người online cùng lúc (kinh nghiệm, không phải số đo) |

Bài kiểm bắt buộc:
- Tài khoản không thuộc phòng mở WebSocket vào phòng ⇒ kết nối bị đóng, không nhận được tin nào.
- Ngắt mạng người A 30 giây, người B gửi 3 tin ⇒ A nối lại thấy đủ 3 tin, đúng thứ tự, không trùng.
- Client gửi cùng một mã tin 2 lần (thử lại khi mạng chập chờn) ⇒ chỉ lưu và phát một tin.

Hay sai:
- Chỉ phát qua WebSocket mà không lưu ⇒ rớt mạng là mất tin.
- Một Durable Object toàn cục cho mọi phòng ⇒ nghẽn khi đông.
- Kiểm quyền vào phòng ở giao diện, server nhận mọi kết nối.

Nguồn: https://developers.cloudflare.com/durable-objects/platform/limits/ · https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://supabase.com/pricing · https://supabase.com/docs/guides/database/postgres/row-level-security

## Bài đăng/feed

Nhận ra khi: "bảng tin", "feed", "đăng bài", "dòng thời gian", "bài mới của người mình theo dõi", "cuộn vô hạn".

Hỏi user (lúc viết SPEC):
- Feed xếp theo thời gian hay "bài hay nhất"? → khuyên: mới nhất lên trước; xếp theo độ hay để sau.
- Ai xem được bài: công khai, người theo dõi, chỉ mình? → khuyên: có đủ ba mức, mặc định "người theo dõi".
- Feed hiện bài cũ tới đâu? → khuyên: 30 ngày gần nhất; cũ hơn xem ở trang hồ sơ tác giả.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Rate limit đăng bài; giới hạn độ dài và số ảnh; quyền xem lọc ngay trong truy vấn ở server, không lọc ở client | Cột `pham_vi` (cong_khai / theo_doi / rieng) | Phát hiện tài khoản đăng hàng loạt — khi admin gỡ tay bài spam mỗi ngày |
| Chi phí | Mỗi lần tải tối đa 20 bài; không đếm tổng số bài | — | — |
| Chịu tải | "Kéo khi đọc" (fan-out on read: lúc mở feed mới truy vấn bài của những người mình theo dõi); index (tac_gia_id, tao_luc); phân trang keyset theo (tao_luc, id) | Hàm `layFeed(nguoiDung, moc)` bọc một chỗ để sau đổi cách làm mà không sửa màn | "Đẩy khi ghi" (fan-out on write: chép bài vào hộp feed từng người theo dõi) — khi truy vấn feed p95 trên 300 ms hoặc người theo dõi trung bình lên vài nghìn (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Xoá bài ⇒ biến khỏi feed mọi người ngay; đổi phạm vi sang "riêng" ⇒ hết hiện ngay; xoá tài khoản ⇒ bài đi theo | Cột `xoa_luc` (xoá mềm) | — |
| Theo dõi sự cố | Ghi thời gian truy vấn feed (p95 — 95% lượt nhanh hơn số này) | — | — |

Bài kiểm bắt buộc:
- Bài "riêng" của A không xuất hiện khi B gọi thẳng API feed hay API bài theo ID.
- B đang ở trang 1, A đăng 5 bài mới ⇒ B tải trang 2 không lặp bài trang 1, không sót bài.
- Feed có 25 bài ⇒ trả 20 bài + mốc tiếp; dùng mốc lấy được đúng 5 bài còn lại.

Hay sai:
- Dùng OFFSET ⇒ càng cuộn càng chậm, có bài lặp hoặc sót khi có bài mới.
- Dựng "đẩy khi ghi" cùng hàng đợi ngay từ đầu cho app vài trăm người.
- Đếm `COUNT(*)` tổng số bài mỗi lần mở feed.

Nguồn: https://use-the-index-luke.com/no-offset · https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html

## Theo dõi/chặn/ẩn/đề cập

Nhận ra khi: "theo dõi", "follow", "kết bạn", "chặn người này", "ẩn bài", "tắt tiếng", "@tên", "nhắc tên ai đó".

Hỏi user (lúc viết SPEC):
- Bị chặn thì người kia thấy gì? → khuyên: không thấy bài, không nhắn, không đề cập được mình; họ không được báo là bị chặn.
- Theo dõi có cần được chấp nhận không? → khuyên: mặc định không cần; có công tắc "Tài khoản riêng tư" để duyệt người theo dõi.
- @đề cập có gửi thông báo không? → khuyên: có; người bị mình chặn đề cập thì không báo.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Rate limit theo dõi/bỏ theo dõi (bot theo dõi hàng loạt để gây chú ý); trần số @ mỗi bài (vd 10); luật chặn thi hành ở server trong MỌI đường: feed, bình luận, chat, thông báo, tìm kiếm, trang hồ sơ | Một bảng `quan_he(tu, toi, loai)` với loại theo_doi / chan / an / tat_tieng; một hàm `biChan(a, b)` dùng chung cho mọi tính năng | — |
| Chi phí | — | — | — |
| Chịu tải | Unique (tu, toi, loai); index cả hai chiều (ai theo dõi tôi, tôi theo dõi ai); số người theo dõi lưu sẵn như bộ đếm, không `COUNT` mỗi lần mở hồ sơ | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Danh sách chặn/ẩn chỉ chủ xem; xoá tài khoản ⇒ xoá mọi quan hệ hai chiều và trừ bộ đếm | — | — |
| Theo dõi sự cố | Log chặn kèm thời điểm để kiểm duyệt tra khi có báo cáo quấy rối | — | — |

Bài kiểm bắt buộc:
- B chặn A ⇒ A gọi API feed, bình luận, hồ sơ, tìm kiếm của B đều không thấy nội dung B.
- A viết bài có @B sau khi bị B chặn ⇒ B không nhận thông báo.
- A theo dõi B hai lần (hai request đồng thời) ⇒ một dòng quan hệ, bộ đếm tăng 1.

Hay sai:
- Chặn chỉ ẩn ở giao diện; API vẫn trả dữ liệu.
- Áp chặn ở feed nhưng quên thông báo, tìm kiếm hoặc chat.
- Bóc @ không giới hạn ⇒ một bài gửi hàng trăm thông báo rác.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html · https://api-security.owasp.org/editions/2023/en/0x11-t10 (phần chặn và @ là kiểu hỏng thường gặp, chưa có nguồn chuẩn riêng)

## Báo cáo vi phạm/kiểm duyệt

Nhận ra khi: "báo cáo", "report", "kiểm duyệt", "ẩn nội dung xấu", "duyệt bài", "khoá tài khoản vi phạm", "nội dung không phù hợp".

Hỏi user (lúc viết SPEC):
- Ai xử lý báo cáo, trong bao lâu? → khuyên: bạn (admin) xem hàng chờ mỗi ngày; nội dung bị từ 3 người khác nhau báo thì tự ẩn chờ xem.
- Bị ẩn/khoá có báo người đăng và cho khiếu nại không? → khuyên: có báo kèm lý do, cho khiếu nại một lần.
- Nội dung đã gỡ giữ lại bao lâu? → khuyên: giữ bản ẩn 90 ngày (để xử lý khiếu nại, làm bằng chứng) rồi xoá hẳn.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mỗi người báo một nội dung một lần (unique); rate limit báo cáo; ngưỡng tự ẩn đếm theo người báo khác nhau, tài khoản mới tạo tính nhẹ hơn (chống bắt nạt bằng báo cáo hàng loạt); API ẩn/khoá chỉ vai trò kiểm duyệt gọi được | Cột `ly_do` theo danh mục cố định | Điểm uy tín người báo — khi trên một nửa báo cáo bị bác (kinh nghiệm, không phải số đo) |
| Chi phí | — | — | Kiểm duyệt bằng AI — khi báo cáo trên 100/ngày (kinh nghiệm, không phải số đo); lúc đó đặt trần chi phí theo bản mẫu gọi AI |
| Chịu tải | Hàng chờ là truy vấn bảng `bao_cao` có index (trang_thai, tao_luc) | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Gỡ = chuyển `an` kèm hạn xoá, không xoá ngay; admin xem nội dung bị báo qua trang quản trị có quyền riêng | Bảng `xu_ly` (ai, lúc, hành động, lý do, khiếu nại) | — |
| Theo dõi sự cố | Nhật ký thao tác cho mọi hành động kiểm duyệt | Đếm báo cáo chờ quá 24 giờ | Cảnh báo khi hàng chờ vượt mức xử lý nổi trong ngày |

Bài kiểm bắt buộc:
- Cùng một người báo một bài 2 lần ⇒ đếm 1.
- 3 người khác nhau báo ⇒ bài ẩn với mọi người khác; tác giả vẫn thấy kèm lý do và nút khiếu nại.
- Tài khoản thường gọi thẳng API ẩn bài ⇒ 403.

Hay sai:
- Một báo cáo là tự ẩn ⇒ bị dùng để bắt nạt, dìm đối thủ.
- Xoá hẳn nội dung khi gỡ ⇒ mất bằng chứng, không xử lý được khiếu nại.
- Chỉ ẩn nút kiểm duyệt ở giao diện, API không kiểm vai trò.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://github.com/OWASP/ASVS/blob/master/5.0/en/0x11-V2-Validation-and-Business-Logic.md

## Trang công khai có SEO/ảnh chia sẻ/link ngắn

Nhận ra khi: "trang hồ sơ công khai", "chia sẻ lên Facebook/Zalo hiện ảnh", "Google tìm thấy", "link ngắn", "trang giới thiệu", "trang bán hàng".

Hỏi user (lúc viết SPEC):
- Trang nào được Google thấy? → khuyên: chỉ trang người dùng bật công khai; mặc định không.
- Link ngắn có hết hạn, có xem số lượt bấm? → khuyên: không hết hạn, có đếm lượt bấm theo ngày, chủ xoá được.
- Ảnh hiện khi dán link (ảnh chia sẻ, thẻ OG) tự tạo hay người dùng chọn? → khuyên: tự tạo từ tiêu đề + ảnh đại diện, người dùng thay được.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Link ngắn chỉ nhận `http`/`https`, rate limit tạo; không tự chuyển tới địa chỉ lấy từ tham số kiểu `?next=` (open redirect — kẻ xấu mượn tên miền mình để lừa); server mà tự tải URL người dùng nhập để lấy tiêu đề/ảnh ⇒ áp luật SSRF (chặn địa chỉ nội bộ); trang công khai không lộ email, ID nội bộ | Cột `bi_khoa` trên link ngắn để gỡ link lừa đảo | Quét link độc bằng dịch vụ ngoài — khi có báo lừa đảo đầu tiên |
| Chi phí | Ảnh chia sẻ tạo một lần rồi lưu R2, không dựng lại mỗi lần bot mạng xã hội đọc | — | — |
| Chịu tải | Trang công khai dựng ở server/edge, có `Cache-Control`; sitemap sinh theo lô | — | Cache toàn trang ở CDN — khi trang công khai trên 100.000 lượt/ngày (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Trang riêng có `noindex`; chuyển công khai → riêng ⇒ URL cũ trả 404 ngay; mã link ngắn ngẫu nhiên đủ dài, không tăng dần (tăng dần thì dò được hết link) | Slug công khai tách khỏi ID trong DB | — |
| Theo dõi sự cố | Đếm lượt bấm gộp theo ngày, không lưu IP thô | — | — |

Bài kiểm bắt buộc:
- Tạo link ngắn tới `javascript:alert(1)` hoặc `http://169.254.169.254` ⇒ bị từ chối.
- Trang chuyển sang riêng ⇒ mở URL cũ trả 404, thẻ OG không còn lộ tiêu đề.
- `/dang-nhap?next=https://trang-la.com` ⇒ sau đăng nhập chỉ chuyển trong tên miền của mình.

Hay sai:
- Mã link ngắn tăng dần (1, 2, 3…) ⇒ người ngoài liệt kê được mọi link riêng.
- Dựng ảnh chia sẻ bằng code nặng mỗi lượt xem.
- Quên `noindex` cho trang riêng; Google đã lưu thì gỡ mất nhiều ngày.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html (không chuyển hướng tới URL lấy từ query) · https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md (phần SEO/OG chưa có nguồn chuẩn riêng)

## Điểm vào công khai không cần đăng nhập

Nhận ra khi: "form liên hệ", "đăng ký nhận tin", "danh sách chờ", "waitlist", "mã mời", "góp ý không cần tài khoản", "đặt lịch tư vấn".

Hỏi user (lúc viết SPEC):
- Form gửi xong ai nhận, qua đâu? → khuyên: lưu vào app + một email tóm tắt cho bạn mỗi ngày, không gửi email mỗi lần (bị spam là hộp thư ngập).
- Có gửi email xác nhận cho người điền không? → khuyên: chỉ với danh sách chờ (bấm link xác nhận); form liên hệ thì không — để kẻ xấu không mượn form gửi thư rác tới địa chỉ người khác.
- Mã mời dùng mấy lần, hết hạn khi nào? → khuyên: mỗi mã một lần, hạn 14 ngày.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Turnstile (ô kiểm "người thật" của Cloudflare) và xác minh token ở server; rate limit theo IP (Rate Limiting binding đếm riêng từng địa điểm, gần đúng — đủ chặn spam, không đủ cho đếm chính xác); trường bẫy ẩn; giới hạn độ dài; mã mời ngẫu nhiên đủ dài, đổi trạng thái "đã dùng" bằng một câu UPDATE có điều kiện | Cột `nguon`, `ip_bam` (IP đã băm) | Chặn theo uy tín IP/quốc gia — khi spam lọt qua Turnstile trên 10 lần/ngày (kinh nghiệm, không phải số đo) |
| Chi phí | Không gửi email/SMS tới địa chỉ người lạ nhập mà chưa xác nhận (bị dùng để bơm thư, tốn tiền, hỏng uy tín tên miền gửi) | — | — |
| Chịu tải | Việc nặng (gửi email tóm tắt) chạy nền theo lịch | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ thu trường cần; email danh sách chờ có link rút tên; tin liên hệ tự xoá sau 12 tháng | Cột `dong_y_luc` (lúc người điền đồng ý nhận tin) | — |
| Theo dõi sự cố | Đếm lượt gửi mỗi ngày và tỉ lệ bị Turnstile chặn | Cảnh báo khi lượt gửi gấp 10 lần trung bình | — |

Bài kiểm bắt buộc:
- Gửi form không có token Turnstile hợp lệ ⇒ 400, không lưu, không gửi email.
- Gửi form lần thứ 6 trong 10 phút từ cùng IP ⇒ 429.
- Hai người dùng cùng một mã mời cùng lúc ⇒ đúng một người thành công.

Hay sai:
- Gắn widget Turnstile ở giao diện nhưng server không xác minh token.
- Gửi email "Cảm ơn bạn" tới mọi địa chỉ nhập vào form.
- Kiểm mã mời rồi mới đánh dấu đã dùng bằng hai câu riêng ⇒ một mã dùng được hai lần.

Nguồn: https://developers.cloudflare.com/turnstile/plans/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html (CAPTCHA chống lạm dụng chức năng, không chống DoS) · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://www.twilio.com/docs/verify/preventing-toll-fraud

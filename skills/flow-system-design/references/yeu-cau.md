# Hỏi yêu cầu chức năng và phi chức năng

Dùng ở bước 1 của `flow-system-design`.

## Mục lục
- Cách hỏi theo vòng
- Yêu cầu chức năng
- Yêu cầu phi chức năng
- Câu trả lời → ảnh hưởng thiết kế
- Ghi vào DESIGN.md
- Nguồn

## Cách hỏi theo vòng

- **Tra trước, hỏi sau.** Lấy từ SPEC, sổ chốt, code, cấu hình triển khai. Câu nào tự tra được (stack, nơi chạy, số đã đo) ⇒ không hỏi.
- **Tối đa 4 câu một vòng**, gộp trong một lần AskUserQuestion, đánh số 1–4 để user trả lời gộp ("1 ừ, 2 khoảng 500, 3 ừ, 4 không").
- **Mỗi câu có sẵn đáp án khuyên dùng**, viết sao cho user chỉ cần "ừ" là chốt. Đáp án khuyên dùng đi kèm lý do bằng tác động lên người dùng hoặc tiền.
- **Hỏi hết câu đã đủ điều kiện hỏi** trong vòng đó, không nhỏ giọt từng câu. Xong vòng ⇒ xem câu nào vừa mở ra
  (vd user nói có thu tiền ⇒ giờ mới hỏi hoàn tiền) rồi mới mở vòng sau.
- **Thứ tự vòng:** vòng 1 = câu quyết định hạng quy mô và rào pháp lý (N1, N7, N10, N11); vòng 2 = chịu đựng sự cố
  (N4, N5, N6) và người/thời hạn (N8, N9); vòng 3 chỉ cho cỡ L hoặc app mới.
- **Trần số vòng:** cỡ M 2 vòng, cỡ L/app mới 3 vòng (kinh nghiệm, không phải số đo). Hết vòng còn thiếu ⇒ dùng cột mặc định, ghi **(giả định)**.
- **User nói "không biết"** ⇒ không ép, lấy mặc định, đánh dấu (giả định) để user thấy trong tóm tắt và sửa được sau.
- **Chốt lại:** cuối vòng chót nhắc 3–5 con số đã chốt trong một câu, xin gật. Chưa gật ⇒ chưa sang bước 2.
- **Cấm hỏi kỹ thuật thuần** ("dùng Redis không?", "queue hay cron?"). AI tự quyết, ghi lý do.

## Yêu cầu chức năng

Thường đã có trong SPEC; chỉ hỏi phần còn thiếu.

| # | Hỏi user (đời thường) | Khuyên | Mặc định khi không biết |
|---|---|---|---|
| C1 | Ai dùng app: khách lẻ, nhân viên một công ty, hay nhiều công ty mà mỗi nơi chỉ thấy dữ liệu của mình? | Nói đúng một trong ba | Khách lẻ (giả định) |
| C2 | Một câu: người dùng mở app để làm xong việc gì? | Một việc chính | Lấy từ SPEC |
| C3 | Ai được xem, ai được sửa dữ liệu của ai? | Chỉ chủ và người được chủ mời | Chỉ chủ (giả định) |
| C4 | App có thu tiền, gửi email/SMS, gọi AI, cho tải file lên không? | Liệt kê cái nào có | Không (giả định) |
| C5 | Có cần dùng được khi mất mạng không? | Không, trừ app máy tính | Không (giả định) |
| C6 | Lần này chắc chắn KHÔNG làm gì? | Liệt kê 2–3 thứ dễ tưởng là có | Ghi "không làm" theo SPEC |

C4 có ⇒ mở bản mẫu đúng loại tính năng ở bước 4. C1 "nhiều công ty" ⇒ đánh dấu khó sửa sau (tách dữ liệu khách hàng).

## Yêu cầu phi chức năng

| # | Hỏi user (đời thường) | Khuyên | Mặc định (ghi giả định) |
|---|---|---|---|
| N1 | Năm đầu, một ngày bình thường có khoảng bao nhiêu người mở app? Chọn bậc: 10 · 100 · 1.000 · 10.000 · hơn nữa | Đoán theo kênh có thật (danh sách khách, nhóm, quảng cáo định chạy) | 1.000 người/ngày |
| N2 | Người dùng dồn vào giờ nào, có ngày bùng không (khuyến mãi, đầu tháng, sự kiện)? | Nêu giờ và dịp bùng | Cao điểm = 3 lần trung bình |
| N3 | Bấm nút xong phải chờ bao lâu thì người dùng bực? | Thao tác thường dưới nửa giây; việc nặng (AI, xuất file) được chờ nếu có thanh tiến trình | 95% request dưới 300 ms phía máy chủ |
| N4 | App ngừng một giờ giữa giờ làm thì sao: khách chờ được, mất đơn, hay mất tiền? | Chạy 99,9% thời gian (ngừng tối đa khoảng 43 phút/tháng) | 99,9% |
| N5 | Nếu có sự cố, mất tối đa bao nhiêu phút dữ liệu mới nhất thì còn chấp nhận được? (gọi là **RPO** — lượng dữ liệu được phép mất, tính bằng thời gian) | Tối đa 1 giờ | 1 giờ |
| N6 | Sau sự cố, app phải chạy lại trong bao lâu? (gọi là **RTO** — thời gian khôi phục) | Trong 4 giờ | 1 ngày làm việc |
| N7 | Mỗi tháng chịu trả tối đa bao nhiêu cho máy chủ và dịch vụ? Riêng AI/SMS/email trần bao nhiêu? | Đặt trần, báo động khi chạm 80% | Gói miễn phí rồi gói trả phí thấp nhất; AI/SMS có trần theo người |
| N8 | App lỗi lúc nửa đêm thì ai xử lý? Có ai biết kỹ thuật không? | Không ai trực ⇒ chỉ dùng dịch vụ có người vận hành hộ | 1 người không code, không trực đêm |
| N9 | Ngày nào phải có bản cho người thật dùng? Hôm đó cần đủ những gì? | Ra sớm một bản mỏng chạy từ đầu tới cuối, rồi đắp dần | Không gấp |
| N10 | App có lưu sức khoẻ, tài chính, giấy tờ tuỳ thân, dữ liệu trẻ em, tin nhắn riêng không? | Lưu ít nhất có thể | Chỉ thông tin cá nhân cơ bản (tên, email) |
| N11 | Người dùng ở nước nào? Có khách ở châu Âu không? | Nêu rõ | Việt Nam là chính, có thể có vài nước khác |
| N12 | Người dùng xoá tài khoản thì dữ liệu biến mất ngay, sau 30 ngày, hay giữ một phần (hoá đơn)? | Xoá sau 30 ngày, giữ hoá đơn theo luật kế toán | Như khuyên |

Mỗi mặc định là **giả định** — ghi vào mục "Giả định" của DESIGN.md, không trộn với số user đã nói.

## Câu trả lời → ảnh hưởng thiết kế

| Câu trả lời | Ảnh hưởng thiết kế |
|---|---|
| N1 dưới 100/ngày | Hạng prototype: một Worker + một DB, không cache, không queue |
| N1 100–10.000/ngày | Hạng MVP: một khối chia module, chống lạm dụng từ ngày đầu, sao lưu bật |
| N1 trên 10.000/ngày | Hạng đang tăng: tính kỹ chỗ đọc nóng, việc nền, giám sát + cảnh báo |
| N2 có ngày bùng | Việc nặng đẩy ra queue, giới hạn tần suất, đo trước bằng `flow-scale` trên bản thử |
| N3 dưới 300 ms cho người ở xa máy chủ | Đặt dữ liệu gần người dùng, bớt số lần gọi DB nối tiếp nhau trong một request |
| N3 việc nặng được chờ | Chạy nền + hiển thị tiến trình, không giữ request mở |
| N4 99,9% | Nền tảng có người vận hành hộ là đủ; không cần nhiều vùng |
| N4 99,99% trở lên | Bỏ mọi điểm đơn lỗi, nhiều vùng, có người trực ⇒ thường vượt sức team 1–2 người, ghi đánh đổi + chi phí |
| N5 vài phút | Cần khôi phục về mốc thời gian bất kỳ (D1 Time Travel; Supabase phải ở gói có sao lưu) |
| N5 một ngày | Sao lưu hằng ngày là đủ |
| N6 vài giờ | Phải có bài khôi phục đã thử thật (`flow-backup`) và các bước ghi sẵn |
| N7 thấp | Ưu tiên gói miễn phí nhưng nêu kiểu hỏng: D1 Free chặn truy vấn khi chạm trần ngày, Supabase Free tạm dừng khi không dùng và không sao lưu — tra bảng số liệu có ngày |
| N7 có trần AI/SMS | Đếm và chặn theo người dùng phía máy chủ trước khi gọi dịch vụ trả phí |
| N8 không ai vận hành | Không tự chạy máy chủ (VPS) hay DB tự quản; chỉ dịch vụ managed |
| N9 gần | Cắt phạm vi, nhưng không cắt phần khó sửa sau: mô hình dữ liệu, khoá định danh, tách dữ liệu khách hàng |
| N10 có dữ liệu nhạy cảm | Không ghi vào log, không để trong URL, kiểm quyền từng đối tượng, nhật ký truy cập, chạy `flow-security` |
| N11 có khách châu Âu | Có xoá dữ liệu theo yêu cầu và xuất dữ liệu; ghi rõ đây không phải tư vấn pháp lý |
| N12 xoá sau 30 ngày | Cột đánh dấu xoá + job dọn định kỳ; sao lưu cũng phải hết hạn theo |
| C1 nhiều công ty | Cột công ty (tenant) trong mọi bảng từ ngày đầu, quyền ở lớp dữ liệu, tenant nằm trong mọi khoá cache |
| C5 cần offline | App máy tính lưu dữ liệu tại máy, ID tạo được ở máy, dấu thời gian sửa để đồng bộ sau |

## Ghi vào DESIGN.md

- Mục 3 (phi chức năng): mỗi dòng một con số + nguồn trong ngoặc: (user nói) · (SPEC) · (giả định).
- Câu user trả lời làm đổi quyết định sản phẩm ⇒ ghi vào sổ chốt, không ghi vào progress.md.
- Giả định nào làm đổi hạng quy mô nếu sai (N1, N2) ⇒ đưa vào "Rủi ro và câu hỏi mở".

## Nguồn

- Vòng hỏi đánh số, mỗi câu kèm đáp án đề xuất: https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md
- Mặc định kèm lý do, nhận mặc định = ghi giả định, chọn tầng quy mô: https://github.com/codejunkie99/system-design-skill
- Hỏi tối đa 3 vòng, chỉ hỏi thứ không tự tra được; RPO/RTO gắn đường khôi phục: https://github.com/pinchen147/system-design-skill
- Hỏi 1–3 câu mỗi lượt, danh sách "MVP không làm": https://github.com/study8677/architecture-copilot
- Đổi uptime ra thời gian ngừng: https://github.com/proyecto26/system-design-skills/blob/main/skills/back-of-the-envelope/references/numbers-to-remember.md
- Dữ liệu nhạy cảm, tự xoá dữ liệu hết hạn: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md
- Quyền xoá (châu Âu): https://gdpr-info.eu/art-17-gdpr/
- Tách dữ liệu nhiều công ty: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
- Ngưỡng mặc định 1.000 người/ngày, 300 ms, 2–3 vòng: kinh nghiệm, chưa có nguồn.

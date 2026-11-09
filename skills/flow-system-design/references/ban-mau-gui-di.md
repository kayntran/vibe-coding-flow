# Bản mẫu: gửi đi và gọi dịch vụ ngoài

Dùng ở bước 4 của `flow-system-design` (bản mẫu theo loại tính năng), câu hỏi hành vi đem hỏi lúc `flow-spec`.

## Mục lục
- Email giao dịch
- Email marketing, bản tin và huỷ đăng ký
- SMS và mã OTP
- Thông báo đẩy (web push)
- Thông báo trong app và tuỳ chọn nhận
- Gọi dịch vụ ngoài trả phí (bản đồ, thời tiết, OCR…)

Số mặc định trong bảng (5 lần, 10 phút, 90 ngày…) là kinh nghiệm, không phải số đo — chỉnh theo app. Giá mỗi email/SMS, trần ngày của gói: tra trang giá chính thức lúc thiết kế.
Điểm chung cả nhóm: mỗi lần gửi là một khoản tiền hoặc một lần làm phiền người nhận ⇒ mọi chỗ người ngoài bấm được mà gây gửi đi đều phải có giới hạn ở server.

## Email giao dịch
Nhận ra khi: "gửi email xác nhận", "email hoá đơn", "báo qua email", "gửi mail khi có đơn", "email mã đăng nhập".

Hỏi user (lúc viết SPEC):
- Thư tới chậm 5 phút có sao không? → khuyên: không sao với hầu hết thư (riêng mã đăng nhập cần dưới 1 phút) ⇒ gửi qua hàng đợi.
- Ngày đông nhất app gửi khoảng bao nhiêu thư? → khuyên: cộng số đăng ký + đơn hàng + nhắc việc/ngày rồi đem so trần ngày của nhà cung cấp email; sát trần thì lên gói trước ngày ra mắt.
- Thư gửi đi không tới (địa chỉ sai, bị trả về) thì ai cần biết? → khuyên: app tự ngừng gửi vào địa chỉ đó và hiện "email không nhận được, hãy kiểm lại" ở trang tài khoản.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mọi form công khai gây gửi thư (đăng ký, quên mật khẩu, mời, liên hệ) giới hạn theo địa chỉ nhận + IP; người ngoài không chèn được chữ tuỳ ý vào thân thư | Móc Turnstile ở các form công khai đó | — |
| Chi phí | Đưa số thư/tháng vào ước lượng bước 3; gói miễn phí có trần ngày ⇒ chạm trần là thư mã đăng nhập ngừng đi, không báo lỗi gì cho người dùng | Một hàm gửi thư duy nhất bọc nhà cung cấp, đổi nhà cung cấp không sửa khắp nơi | Nhà cung cấp dự phòng thứ hai — cần khi một lần nhà cung cấp chính sập làm người dùng không đăng nhập được |
| Chịu tải | Gửi qua hàng đợi (Queues) có thử lại, không gửi trong request của người dùng; khoá chống gửi trùng theo (loại thư, đối tượng) để lần thử lại không gửi đôi | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Không đưa mật khẩu hay token dài hạn vào thân thư; link có token thì token dùng một lần, hạn ngắn | Bảng `email_log` (người nhận, loại, trạng thái, mã của nhà cung cấp) tự xoá sau 90 ngày | — |
| Theo dõi sự cố | Ghi trạng thái gửi/thất bại; tên miền gửi có SPF, DKIM, DMARC (thiếu ⇒ thư vào spam) | Nhận webhook trả về/khiếu nại spam để ngừng gửi địa chỉ hỏng | Bảng theo dõi tỉ lệ vào hộp thư — cần khi người dùng than "không nhận được thư" |

Bài kiểm bắt buộc:
- Hàng đợi chạy lại cùng một thư 3 lần ⇒ nhà cung cấp chỉ nhận một lệnh gửi.
- Gửi form quên mật khẩu lần thứ 6 trong 1 giờ cho cùng địa chỉ ⇒ bị từ chối, không có thư nào đi.

Hay sai:
- Gửi thư ngay trong request đăng ký ⇒ nhà cung cấp chậm hoặc lỗi là đăng ký lỗi theo.
- Dùng gói miễn phí tới lúc ra mắt; ngày đông nhất thư xác nhận ngừng đi mà không ai biết.

## Email marketing, bản tin và huỷ đăng ký
Nhận ra khi: "gửi bản tin", "newsletter", "email khuyến mãi", "gửi hàng loạt cho khách", "chiến dịch email".

Hỏi user (lúc viết SPEC):
- Người dùng đồng ý nhận thư quảng cáo lúc nào? → khuyên: ô đồng ý riêng, không tick sẵn; thư giao dịch (hoá đơn, mật khẩu) vẫn gửi dù đã huỷ bản tin.
- Bấm "huỷ đăng ký" có phải đăng nhập không? → khuyên: không — một cú bấm từ thư là xong.
- Mỗi đợt gửi bao nhiêu người? → khuyên: vài nghìn trở xuống ⇒ dùng tính năng chiến dịch của nhà cung cấp email, đừng tự dựng.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ gửi người đã đồng ý; form đăng ký bản tin công khai phải xác nhận qua thư (double opt-in — bấm link mới vào danh sách), kẻo bị dùng để spam địa chỉ người khác | — | — |
| Chi phí | Tách luồng gửi (hoặc tên miền phụ) cho thư marketing khỏi thư giao dịch — thư marketing bị đánh spam không kéo thư mật khẩu theo | Hàm gửi chung có tham số loại thư | Tự dựng hệ gửi hàng loạt — cần khi danh sách hàng trăm nghìn và phí nhà cung cấp thành khoản lớn nhất |
| Chịu tải | Gửi theo lô qua hàng đợi, giãn theo giới hạn gửi/giây của nhà cung cấp | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Bảng `email_preferences` (người, loại thư, đồng ý hay huỷ, lúc nào, bằng cách nào); link huỷ chứa token ký riêng từng người, không phải email trần | Loại thư theo chủ đề để sau cho chọn từng chủ đề | — |
| Theo dõi sự cố | Ngừng gửi địa chỉ bị trả về hoặc khiếu nại spam | Tỉ lệ huỷ mỗi đợt | — |

Bài kiểm bắt buộc:
- Người đã huỷ bản tin ⇒ đợt gửi kế tiếp bỏ qua họ; thư đặt lại mật khẩu vẫn tới.
- Sửa token trong link huỷ thành của người khác ⇒ bị từ chối.

Hay sai:
- Gửi quảng cáo cho mọi tài khoản vì "đã đăng ký app là đồng ý".
- Link huỷ dạng `?email=a@b.com` ⇒ ai cũng huỷ hộ người khác được.

## SMS và mã OTP
Nhận ra khi: "gửi mã qua SMS", "OTP", "xác minh số điện thoại", "đăng nhập bằng số điện thoại".

Hỏi user (lúc viết SPEC):
- Khách ở những nước nào? → khuyên: chỉ bật đúng nước bạn phục vụ (vd chỉ Việt Nam), còn lại chặn.
- Có thật cần SMS, hay mã qua email/app Authenticator được? → khuyên: email hoặc app trước; SMS chỉ khi khách không có email.
- Mỗi tháng chi tối đa bao nhiêu cho SMS? → khuyên: đặt một con số trần; chạm trần thì ngừng gửi và báo bạn ngay.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chặn nước không phục vụ; giới hạn số mã theo số điện thoại, theo khối đầu số, theo người dùng, IP, thiết bị; tăng dần thời gian chờ giữa các lần gửi lại; bật chống gian lận của nhà cung cấp (vd Fraud Guard của Twilio) | Turnstile trước nút "gửi mã" | — |
| Chi phí | Trần chi SMS/ngày toàn app, chạm trần thì ngừng gửi và báo chủ — chống SMS pumping (kẻ xấu bắt app gửi hàng loạt tin tới số của nhà mạng đồng loã để ăn chia cước, bạn trả tiền); giá mỗi tin theo nước đưa vào ước lượng | Bộ đếm chi phí theo ngày và theo nước | — |
| Chịu tải | Gửi qua hàng đợi với khoá chống trùng | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Mã sinh ngẫu nhiên an toàn, lưu bản băm, hạn ngắn, dùng một lần, giới hạn lần nhập sai; số điện thoại lưu một dạng chuẩn (E.164 — dạng +84…) | — | — |
| Theo dõi sự cố | Đếm SMS/giờ theo nước, cảnh báo khi vọt | Tỉ lệ mã được nhập đúng / mã gửi đi (thấp bất thường = đang bị bơm) | — |

Bài kiểm bắt buộc:
- Gửi mã lần thứ 6 trong 10 phút cho cùng số ⇒ bị từ chối, không gửi SMS.
- Số thuộc nước không phục vụ ⇒ bị từ chối, không gọi nhà cung cấp.
- Chạm trần chi ngày ⇒ lệnh gửi kế tiếp bị chặn và có cảnh báo.

Hay sai:
- Chỉ giới hạn theo số điện thoại ⇒ kẻ bơm dùng hàng nghìn số khác nhau vẫn lọt.
- Không có trần tiền ⇒ hoá đơn lớn qua một đêm.

## Thông báo đẩy (web push)
Nhận ra khi: "thông báo đẩy", "push notification", "báo lên điện thoại/máy tính kể cả khi đóng app".

Hỏi user (lúc viết SPEC):
- Lúc nào thì xin phép gửi thông báo? → khuyên: ngay sau khi người dùng làm việc cần được báo (vd đặt nhắc), không hỏi lúc vừa mở trang.
- Thông báo có hiện nội dung riêng tư (tin nhắn, số tiền) trên màn khoá không? → khuyên: chỉ "Bạn có tin mới"; mở app mới thấy chi tiết.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ server của app gửi được (khoá gửi để ở server); giới hạn số thông báo/người/ngày để người dùng không bấm chặn | — | — |
| Chi phí | — | — | — |
| Chịu tải | Gửi qua hàng đợi; dịch vụ push báo đăng ký không còn ⇒ xoá hàng đó | — | Gom thông báo thành bản tóm tắt — cần khi một người nhận hàng chục cái/ngày |
| Dữ liệu (riêng tư, xoá, sao lưu) | Địa chỉ đăng ký (endpoint) là "capability URL" — ai biết là gửi được ⇒ coi như bí mật: không log, không trả qua API; một người nhiều thiết bị; xử lý sự kiện `pushsubscriptionchange` để đăng ký lại khi hết hạn | Bảng `push_subscriptions(user_id, endpoint, keys, created_at)` | — |
| Theo dõi sự cố | Đếm gửi thành/bại | Tỉ lệ bấm mở | — |

Bài kiểm bắt buộc:
- Dịch vụ push trả "đăng ký không còn" ⇒ hàng đó bị xoá, lần sau không gửi lại.
- API danh sách thiết bị của người dùng không trả endpoint đầy đủ.

Hay sai:
- Xin quyền ngay khi vào trang ⇒ người dùng bấm Chặn, app không xin lại được.
- Coi push là chắc tới (mỗi trình duyệt một hạn mức khác nhau); việc quan trọng (mã, hoá đơn) vẫn phải có email hoặc trong app.

## Thông báo trong app và tuỳ chọn nhận
Nhận ra khi: "chuông thông báo", "thông báo trong app", "cài đặt nhận thông báo", "tắt bớt thông báo".

Hỏi user (lúc viết SPEC):
- Thông báo cũ giữ bao lâu? → khuyên: 90 ngày rồi tự xoá.
- Người dùng tắt được từng loại không? → khuyên: có, theo nhóm (bình luận, nhắc việc, thanh toán); thư bảo mật và thanh toán không tắt được.
- Có cần thấy thông báo mới ngay không, hay mở lại trang mới thấy cũng được? → khuyên: mở lại trang hoặc chuyển màn là thấy; tức thì để sau.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Người dùng gây ra thông báo cho người khác (nhắc tên @, mời) ⇒ giới hạn số lượng theo người gửi/ngày | — | — |
| Chi phí | Không hỏi số chưa đọc liên tục mỗi giây (mỗi lần là một lượt đọc DB) | — | — |
| Chịu tải | Danh sách phân trang keyset (nhớ mốc cuối, không dùng OFFSET); đếm chưa đọc bằng truy vấn có index | Một hàm `notify(người, loại, nội dung)` duy nhất, tự chọn kênh (trong app, email, push) theo tuỳ chọn | Cập nhật tức thì (Supabase Realtime hoặc Durable Objects + WebSocket) — cần khi người dùng thật sự đòi thấy ngay |
| Dữ liệu (riêng tư, xoá, sao lưu) | Kiểm thông báo thuộc đúng người khi đọc và khi đánh dấu đã đọc; bảng `notification_prefs` | Cột `read_at`; việc hẹn giờ xoá theo hạn giữ | — |
| Theo dõi sự cố | Log khi một kênh gửi thất bại trong `notify` | — | — |

Bài kiểm bắt buộc:
- A đánh dấu đã đọc thông báo của B bằng ID ⇒ bị từ chối.
- Người tắt nhóm "bình luận" ⇒ có bình luận mới không nhận email/push nhóm đó.

Hay sai:
- Mỗi tính năng tự gửi thẳng email/push ⇒ nút tắt chỉ có tác dụng ở nửa số chỗ; thêm loại thông báo mới thì chạy `flow-impact`.
- Hỏi số chưa đọc mỗi giây ⇒ đốt lượt đọc DB (D1 bản Free chặn truy vấn khi chạm trần ngày).

## Gọi dịch vụ ngoài trả phí (bản đồ, thời tiết, OCR…)
Nhận ra khi: "bản đồ", "thời tiết", "OCR", "đọc chữ trong ảnh", "dịch", "tra cứu mã số thuế", "gọi API của bên X".

Hỏi user (lúc viết SPEC):
- Dịch vụ ngoài chậm hoặc sập thì người dùng thấy gì? → khuyên: báo "tạm chưa có dữ liệu, thử lại sau", phần còn lại của app vẫn dùng được.
- Kết quả dùng lại được bao lâu (thời tiết 30 phút, toạ độ địa chỉ rất lâu)? → khuyên: lưu lại đúng thời gian đó để không trả tiền hai lần.
- Ai được bấm việc gọi dịch vụ? → khuyên: chỉ người đăng nhập, có hạn mức/ngày.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ gọi từ server; khoá API không bao giờ nằm trong trình duyệt, extension hay app máy tính; giới hạn theo người dùng; việc tốn tiền yêu cầu đăng nhập; người dùng nhập URL để app tải ⇒ chống SSRF (bắt server gọi vào mạng nội bộ): chỉ host trong danh sách, chặn dải nội bộ, tắt chuyển hướng | — | — |
| Chi phí | Trần chi/ngày toàn app + hạn mức theo người (dùng chung cơ chế hạn mức/credit ở nhóm AI, bước 4 trong SKILL.md); bật cảnh báo chi tiêu ở trang nhà cung cấp | Một hàm bọc duy nhất cho mỗi dịch vụ để đếm, cache, đổi nhà cung cấp | Hợp đồng giá sỉ — cần khi khoản này thành phí lớn nhất |
| Chịu tải | Timeout ngắn + thử lại có trần; cache kết quả (KV) theo thời gian dùng lại được | — | Chạy nền qua hàng đợi — cần khi một lần gọi mất vài giây trở lên |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ gửi ra ngoài dữ liệu tối thiểu; đọc điều khoản bên đó có giữ hay huấn luyện trên dữ liệu không; kiểm kết quả trả về như input người dùng, không tin như dữ liệu của mình | — | — |
| Theo dõi sự cố | Log mỗi lần gọi (độ trễ, lỗi, chi phí ước tính); cảnh báo khi lỗi hoặc chi phí vọt | — | — |

Bài kiểm bắt buộc:
- Người dùng vượt hạn mức ngày ⇒ bị từ chối, không có request nào ra nhà cung cấp.
- Dịch vụ ngoài treo ⇒ request của app kết thúc trong thời gian timeout với thông báo dễ hiểu.
- Hai lần tra cùng nội dung trong thời gian cache ⇒ chỉ một lần gọi ra ngoài.

Hay sai:
- Gọi thẳng từ trình duyệt kèm khoá API ⇒ khoá lộ, người lạ tiêu tiền của bạn (xử lý theo `flow-key-leak`).
- Không đặt timeout ⇒ dịch vụ ngoài treo kéo cả app treo.

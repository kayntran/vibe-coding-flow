# Tin cậy: khi một phần chết

Dùng ở bước 8 của `flow-system-design`.

## Mục lục
- Điểm chết đơn lẻ
- Nó chết thì sao — theo loại thành phần
- Timeout, retry có trần, circuit breaker
- Chạy giảm chức năng
- SLO đời thường
- RPO và RTO — mặc định theo hạng
- Sao lưu và kiểm khôi phục
- Quay lại bản trước
- Khi nào CHƯA cần
- Nguồn

Mục tiêu: mỗi hộp trong sơ đồ có một dòng ở mục "Khi có sự cố" của DESIGN.md — hỏng kiểu gì, người dùng thấy gì, hệ thống làm gì.

## Điểm chết đơn lẻ

Điểm chết đơn lẻ (single point of failure — một thứ hỏng là cả app ngừng). Cách tìm: đi theo luồng chính, hỏi từng hộp
"hộp này tắt 1 giờ thì người dùng còn làm được việc chính không?".

| Điểm hay gặp trên stack kit | Xử lý mức MVP |
|---|---|
| Một DB ghi duy nhất (D1 một primary, một dự án Supabase, một máy VPS) | Chấp nhận; bù bằng sao lưu + RTO rõ. VPS tự chạy là điểm chết thật ⇒ lý do ưu tiên managed |
| Một nhà cung cấp SMS/email/AI | Gọi qua một hàm bọc ⇒ chừa chỗ thêm nhà thứ hai |
| Một người duy nhất giữ tài khoản Cloudflare/Supabase/tên miền | Thêm người thứ hai hoặc mã khôi phục cất chỗ an toàn (kinh nghiệm) |
| Tên miền hết hạn | Bật tự gia hạn, email nhắc về hộp thư còn dùng |
| Một việc hẹn giờ (cron) chạy một chỗ | Việc phải chạy lại được không sinh trùng (idempotent) |

Nền tảng managed (Cloudflare, Supabase) đã có dự phòng bên trong ⇒ không tự dựng bản sao thứ hai ở hạng prototype/MVP.
Chỉ loại điểm chết đơn lẻ khi mục tiêu uptime tăng bậc (tín hiệu của study8677).

## Nó chết thì sao — theo loại thành phần

| Thành phần | Hỏng kiểu gì | Người dùng thấy | Làm ngay |
|---|---|---|---|
| DB | Chậm, khoá ghi, mất kết nối; D1 Free chặn truy vấn khi chạm trần ngày (lỗi, không phải hoá đơn) | "Không lưu được" | Timeout; báo rõ "chưa lưu, thử lại" và giữ chữ đã gõ; thao tác nhiều bước bọc trong giao dịch |
| Dịch vụ ngoài (thanh toán, API bên thứ ba) | Chậm, 5xx, 429, đổi định dạng | Nút quay mãi | Timeout; retry có trần chỉ cho lỗi tạm; idempotency key cho việc tốn tiền; kiểm dữ liệu trả về (API10) |
| Queue (hàng đợi việc nền) | Consumer lỗi lặp; tin giao trùng (ít nhất một lần) | Việc nền trễ | Consumer idempotent; dead letter queue (chỗ gom tin lỗi để xem lại); cảnh báo khi tồn đọng tăng |
| Cache (KV, Cache API) | Trống, cũ, nhất quán chậm | Chậm hơn, không sai | Cache chỉ là bản dẫn xuất, mất là đọc lại DB; không giữ dữ liệu duy nhất trong cache; không dùng KV cho số dư, tồn kho |
| Email/SMS | Trễ, hết hạn mức, vào spam, nhà mạng lỗi | Không nhận mã/nhắc | Gửi qua queue; nút "gửi lại" có giới hạn; đường thay (email thay SMS); lưu trạng thái giao |
| Model AI | 429, hết lượt, chậm hàng chục giây, trả rác | "Tạm bận" | Timeout, model dự phòng, trần chi phí; không chặn thao tác chính |
| Đăng nhập (Supabase Auth, thư viện) | Dịch vụ sập | Không đăng nhập mới được | Phiên đã có vẫn chạy nếu xác minh token tại chỗ (suy luận); trang trạng thái |
| Bản phát hành mới | Lỗi sau deploy | Màn trắng, lỗi 500 | Quay lại bản trước bằng `flow-rollback` |

## Timeout, retry có trần, circuit breaker

- **Timeout** (hạn chót cho mỗi lời gọi): mọi lời gọi ra ngoài đều có. Không có ⇒ request treo, chiếm kết nối, dồn tới sập.
  Mặc định (kinh nghiệm, không phải số đo): API thường 5–10 s; AI 30–60 s và phải streaming.
- **Retry có trần** (thử lại có giới hạn): chỉ thử lỗi tạm (timeout, 429, 5xx), không thử 4xx. Tối đa 2–3 lần, chờ tăng dần
  có ngẫu nhiên (backoff + jitter) để không dội cùng lúc. Việc tốn tiền chỉ thử lại khi có idempotency key (khoá chống làm trùng:
  server nhớ kết quả lần đầu, lần gửi lại trả đúng kết quả đó).
- **Chỉ thử ở một tầng.** Client 3 lần × server 3 lần × queue 3 lần = 27 lần gọi một dịch vụ đang ốm.
- **Circuit breaker** (cầu dao: lỗi liên tiếp thì ngắt, trả lỗi nhanh hoặc đường thay trong một lúc, rồi thử lại một lượt).
  Cần khi: lời gọi treo tới một dịch vụ làm nghẽn cả app và lưu lượng tới dịch vụ đó đủ lớn. CHƯA cần khi: vài request/giây,
  đã có timeout ngắn và việc đi qua queue. Workers không chia sẻ bộ nhớ giữa các bản chạy ⇒ muốn có thì giữ trạng thái ở
  KV/Durable Objects; với AI thường lớp gateway + model dự phòng là đủ.

## Chạy giảm chức năng

Graceful degradation (phần phụ hỏng, phần chính vẫn chạy). Ghi vào DESIGN.md chỉ những cặp có thật:

| Phần hỏng | Vẫn chạy |
|---|---|
| Gợi ý AI | Form nhập tay |
| Tìm kiếm | Danh sách lọc cơ bản |
| Ảnh trên R2 | Chữ cái đầu thay ảnh đại diện |
| Gửi SMS | Lịch hẹn vẫn lưu, xếp hàng gửi lại, hiện "chưa gửi nhắc" |
| Quá tải | Tắt tính năng nặng bằng cờ bật/tắt, giữ luồng chính |

## SLO đời thường

SLO (mục tiêu mức dịch vụ — lời hứa nội bộ bằng con số, đo theo tháng). Viết theo việc người dùng làm:
"99,5% lượt đặt lịch thành công, 95% xong dưới 1 s". Không viết "app ổn định".

| Uptime | Được ngừng khoảng |
|---|---|
| 99% | 3,65 ngày/năm |
| 99,5% | 3,6 giờ/tháng |
| 99,9% | 43,8 phút/tháng |
| 99,99% | 52,6 phút/năm |

Mặc định theo hạng (kinh nghiệm): prototype không đặt; MVP 99,5%; đang tăng 99,9%; quy mô lớn 99,9–99,95% cho luồng chính.
Không hứa 99,99% khi chỉ có một DB ghi và một người vận hành.
Hỏi user: "App ngừng 1 giờ giữa ngày thì bạn mất gì?" → khuyên: chấp nhận 99,5% nếu không thu tiền theo giờ.

## RPO và RTO — mặc định theo hạng

- RPO (mất dữ liệu tối đa chấp nhận — quay về được mốc cách bây giờ bao lâu).
- RTO (thời gian khôi phục tối đa — bao lâu app chạy lại).

| Hạng | RPO | RTO | Đạt bằng |
|---|---|---|---|
| Prototype | 24 giờ | 1 ngày | Xuất dữ liệu tay hoặc Time Travel mặc định |
| MVP | 1 giờ | 4 giờ | D1 Time Travel (mốc theo phút); Supabase gói trả phí có sao lưu theo ngày ⇒ RPO ~24 giờ trừ khi bật khôi phục theo thời điểm (chưa xác minh) |
| Đang tăng | 15 phút | 1 giờ | Như trên + đã diễn tập khôi phục |
| Quy mô lớn | vài phút | dưới 1 giờ | Bản sao ở vùng khác, diễn tập định kỳ |

Bảng trên là kinh nghiệm, không phải số đo; số ngày giữ bản sao lưu mỗi gói: tra bảng số liệu có ngày.
Dữ liệu tiền: nguồn sự thật nằm ở cổng thanh toán, đối soát lại được ⇒ ghi rõ trong DESIGN.md.
Hỏi user: "Mất dữ liệu của 1 giờ gần nhất có chấp nhận được không?" → khuyên: được, với MVP.

## Sao lưu và kiểm khôi phục

- Sao lưu chưa từng khôi phục thử = chưa có sao lưu.
- D1 Time Travel: khôi phục **ghi đè tại chỗ** và ngắt truy vấn đang chạy; lưu bookmark trước khi khôi phục để hoàn tác;
  kiểm số dòng trước khi tin mốc; chưa clone được ⇒ không thử khôi phục trên DB thật, thử trên DB riêng bằng xuất/nhập.
- Supabase Free không có sao lưu ⇒ không để dữ liệu thật trên Free.
- Postgres trên VPS: tự lo dump, chép ra chỗ khác, mã hoá, xoá bản cũ ⇒ thêm một việc có thể hỏng lúc 2 giờ sáng.
- File người dùng trên R2/Storage: nêu rõ có sao lưu hay không; xoá là mất nếu không có.
- DESIGN.md chỉ ghi: kho nào là nguồn gốc cần sao lưu, RPO/RTO, ai được khôi phục. Chọn, bật, đặt lịch, thử: `flow-backup`.

## Quay lại bản trước

- Mỗi lần phát hành phải quay lại được trong vài phút: `flow-rollback`.
- Quay code không trả DB về cũ ⇒ migration kiểu nở rồi co (expand/contract): thêm cột trước, code mới dùng, xoá cột cũ
  ở lần phát hành sau; mỗi bước tương thích với bản code liền trước.
- App máy tính, extension không quay ép được ⇒ server giữ tương thích với bản cũ đang chạy.

## Khi nào CHƯA cần

- Đa vùng, bản sao nóng, chạy hai nơi cùng lúc: tới khi có hợp đồng uptime ≥ 99,95% hoặc quy mô lớn.
- Circuit breaker riêng: khi chưa có dịch vụ ngoài nào nhận hàng chục request/giây.
- Diễn tập phá hỏng có chủ đích (chaos testing): không ở prototype/MVP; diễn tập khôi phục sao lưu thì CÓ.

## Nguồn

- https://developers.cloudflare.com/d1/reference/time-travel/
- https://supabase.com/pricing
- https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
- https://api-security.owasp.org/editions/2023/en/0x11-t10
- https://docs.stripe.com/api/idempotent_requests
- https://github.com/pinchen147/system-design-skill (kiểm khôi phục, đường khôi phục khớp mục tiêu, thứ tự deploy khi đổi schema)
- https://github.com/codejunkie99/system-design-skill (timeout + retry có trần cho việc tính tiền/gửi)
- https://github.com/study8677/architecture-copilot (uptime tăng bậc thì loại điểm chết đơn lẻ)
- Chưa có nguồn trong bộ nghiên cứu: circuit breaker, mức SLO/RPO/RTO theo hạng, khôi phục theo thời điểm của Supabase.

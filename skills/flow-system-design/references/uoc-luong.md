# Xếp hạng quy mô và ước lượng bằng con số

Dùng ở bước 2–3 của `flow-system-design`.

## Mục lục
- Bốn hạng quy mô
- Công thức ước lượng
- Ví dụ tính đầy đủ
- Ngưỡng kinh nghiệm
- Số độ trễ cần nhớ
- Uptime đổi ra thời gian ngừng
- Nguồn

Không ghi giá ở đây. Đơn giá và mức gồm sẵn từng gói ⇒ tra bảng số liệu có ngày của skill.

## Bốn hạng quy mô

Ngưỡng dưới đây là kinh nghiệm, không phải số đo; giả định mỗi người dùng ~20 request/ngày. Xếp theo người dùng hoạt động/ngày
**năm đầu** (N1 ở bước 1), không theo mơ ước 5 năm. Hai tiêu chí lệch nhau ⇒ lấy hạng cao hơn của request/giây đỉnh.

| Hạng | Người dùng/ngày | Request/giây TB · đỉnh | Team | Kiến trúc mặc định trên stack kit |
|---|---|---|---|---|
| Prototype | dưới 100 | dưới 0,1 · dưới 1 | 1 người, đang thử ý | Một Worker + D1 (hoặc Supabase nếu cần đăng nhập có sẵn); không cache, không queue; app máy tính: SQLite tại máy |
| MVP | 100 – 10.000 | dưới 3 · dưới 15 | 1–2 người, không trực | Một khối chia module (`flow-architecture`); Workers gói trả phí + D1 hoặc Supabase gói trả phí; Turnstile + Rate Limiting binding ở cửa công khai; Queues chỉ khi có gửi đi/việc nặng; sao lưu bật và đã thử khôi phục |
| Đang tăng | 10.000 – 500.000 | 3 – 120 · tới ~600 | 2–10 người | Vẫn một khối; thêm KV/CDN cho chỗ đọc nóng đã đo, Queues cho việc nền, cảnh báo theo triệu chứng, bản thử (staging); chuyển Postgres khi D1 chạm trần một DB hoặc ghi đồng thời nghẽn |
| Quy mô lớn | trên 500.000 | trên 120 · trên 600 | nhiều đội, có người trực | Bản đọc phụ, tách dịch vụ theo ranh giới đội, nhiều vùng, chia nhỏ dữ liệu khi có tín hiệu; vượt sức kit tự vận hành ⇒ khuyên có người kỹ thuật |

- Một service ~100 request/giây trung bình vẫn ổn (kinh nghiệm) ⇒ cả hạng "đang tăng" thường vẫn chạy được trên một khối.
- Thành phần của hạng cao hơn hạng hiện tại ⇒ đưa vào lộ trình theo ngưỡng, không làm ngay (xem bước 2 trong SKILL.md).

## Công thức ước lượng

| Đại lượng | Công thức | Ghi chú |
|---|---|---|
| Request/ngày | người dùng/ngày × request/người/ngày | Đếm cả gọi API ngầm (tự lưu, kiểm thông báo) |
| Request/giây TB | request/ngày ÷ 86.400 (thô: ÷ 100.000) | |
| Request/giây đỉnh | TB × hệ số đỉnh | Hệ số 2–5; mặc định 3 (giả định); app giờ hành chính hoặc có khuyến mãi ⇒ dùng 5 |
| Tỉ lệ đọc:ghi | thao tác đọc ÷ thao tác ghi | Quyết định có cần cache/bản đọc phụ hay không |
| Hàng ghi/ngày | thao tác ghi/ngày × hàng mỗi lần ghi | D1 tính tiền cả hàng index (suy luận) ⇒ nhân thêm số index |
| Hàng đọc/ngày | thao tác đọc/ngày × hàng phải quét | Không có index ⇒ quét cả bảng; D1 tính theo hàng đọc nên quét thừa = tốn tiền |
| Dung lượng 1 năm | ghi/ngày × byte mỗi bản ghi × 365 × 1,5 | 1,5 = dự phòng index (giả định) |
| File lưu 1 năm | file tải lên/ngày × cỡ TB × 365 | Tách riêng, lưu R2/Storage, không trong DB |
| Băng thông | request/giây đỉnh × cỡ phản hồi; tháng = request/tháng × cỡ phản hồi | Ảnh/file tính riêng |
| Chi phí tháng | Σ (lượng dùng tháng − mức gồm sẵn) × đơn giá, **từng khoản** | Khoản hay đội nhất: AI, SMS, email, lưu file; tra đơn giá trong bảng số liệu có ngày |

Luôn ghi **phép tính**, không chỉ kết quả, và nguồn mỗi đầu vào: (user nói) · (SPEC) · (giả định).

## Ví dụ tính đầy đủ

App ghi chú nhóm có nút "tóm tắt bằng AI". Đầu vào: 2.000 người/ngày (user nói); mỗi người 25 đọc + 5 ghi/ngày (giả định);
mỗi ghi 1 hàng ~1 KB + 2 index; mỗi đọc quét ~20 hàng (có index); 2 lần tóm tắt AI/người/ngày, 1.500 token vào + 300 token ra;
1 email/người/tuần; phản hồi TB 20 KB.

| Bước | Phép tính | Kết quả |
|---|---|---|
| Request/ngày | 2.000 × 30 | 60.000 |
| Request/giây TB | 60.000 ÷ 86.400 | ~0,7 |
| Request/giây đỉnh | 0,7 × 3 (giả định) | ~2 ⇒ hạng MVP |
| Đọc:ghi | 25 : 5 | 5:1 ⇒ chưa cần cache |
| Hàng ghi/tháng | 2.000 × 5 × 30 × (1 + 2 index) | ~900.000 |
| Hàng đọc/tháng | 2.000 × 25 × 20 × 30 | ~30 triệu |
| Dung lượng 1 năm | 10.000 ghi/ngày × 1 KB × 365 × 1,5 | ~5,5 GB ⇒ so với trần một DB D1 |
| Lượt AI/tháng | 2.000 × 2 × 30 | 120.000 |
| Token AI/tháng | 120.000 × 1.500 vào; 120.000 × 300 ra | 180 triệu vào; 36 triệu ra |
| Email/tháng | 2.000 × ~4,3 | ~8.600 (+ email đăng ký, quên mật khẩu) |
| Băng thông | đỉnh 2 × 20 KB; tháng 1,8 triệu × 20 KB | 40 KB/s; ~36 GB/tháng |

Chi phí tháng: lập bảng 4 khoản (Workers request, D1 hàng đọc/ghi + lưu trữ, AI theo token, email theo số thư) = lượng ở trên trừ
mức gồm sẵn, nhân đơn giá tra ngày. Kết luận rút ra từ lượng: token AI là khoản lớn nhất và tăng thẳng theo người ⇒ "làm ngay"
trần lượt AI theo người/ngày; email vượt trần ngày của gói miễn phí ⇒ chọn gói theo bảng số liệu. Tính lại ở 10× người dùng cho mục Chi phí.

## Ngưỡng kinh nghiệm

Tất cả là kinh nghiệm của tác giả các skill tham khảo, **không phải số đo**. Dùng để nghi ngờ, rồi đo lại bằng `flow-scale`.

| Ngưỡng | Nghĩa là |
|---|---|
| ~100 request/giây TB | Một service là đủ, chưa cần tách |
| ~17 ghi/giây | Một DB có giao dịch (ACID) dư sức |
| Đọc:ghi ~100:1 | Mới bắt đầu nghĩ tới cache, CDN, bản đọc phụ |
| Đỉnh = 2–5 × TB | Thiếu số đo thì lấy 3 và ghi giả định |
| CPU DB chính > ~70% kéo dài, đọc xếp hàng | Thêm cache hoặc bản đọc phụ |
| Tỉ lệ trúng cache < ~90% | Chỉnh TTL/khoá cache trước khi thêm tầng |
| Bảng hàng chục–trăm triệu hàng, DB vài trăm GB | Mới nghĩ tới chia nhỏ dữ liệu (shard) |
| P99 cao mà P50 ổn | Tìm đúng một bước chậm, đừng scale cả hệ |
| Người dùng chờ vài giây cho một thao tác | Chuyển việc đó chạy nền |

Bậc độ lớn mỗi máy (không dẫn nguồn gốc, chỉ để so): DB quan hệ ~1.000 truy vấn/giây, kho khoá-giá trị ~10.000, cache 100.000+,
một lõi CPU ~1.000 request đơn giản/giây.

## Số độ trễ cần nhớ

| Việc | Khoảng | Ý nghĩa thiết kế |
|---|---|---|
| Đọc RAM | ~100 ns | Tính toán trong bộ nhớ gần như miễn phí |
| Đọc ngẫu nhiên SSD | ~16 µs | |
| Đọc 1 MB từ RAM · từ SSD | ~3 µs · ~49 µs | |
| Một vòng đi-về trong cùng trung tâm dữ liệu | ~0,5 ms | Gọi DB cùng vùng rẻ |
| Tìm đĩa cứng quay | ~2,5 ms | |
| Một vòng đi-về liên lục địa | 70–150 ms | 5 lần gọi DB nối tiếp từ xa = gần 0,5–0,75 giây ⇒ gộp truy vấn, đặt dữ liệu gần người dùng |

## Uptime đổi ra thời gian ngừng

| Uptime | Ngừng tối đa/năm | ≈ phút/năm | ≈ mỗi tháng |
|---|---|---|---|
| 99% | ~3,65 ngày | 5.256 | ~7,3 giờ |
| 99,5% | ~1,83 ngày | 2.628 | ~3,65 giờ |
| 99,9% | ~8,76 giờ | 525,6 | ~43,8 phút |
| 99,95% | ~4,38 giờ | 262,8 | ~21,9 phút |
| 99,99% | ~52,6 phút | 52,6 | ~4,4 phút |

Mỗi bậc "thêm một số 9" thường đòi thêm một lớp dự phòng và người trực (kinh nghiệm) ⇒ nói với user bằng phút ngừng và tiền, không bằng phần trăm.

## Nguồn

- Tầng quy mô, công thức QPS/đỉnh 2×/dung lượng/băng thông: https://github.com/codejunkie99/system-design-skill
- 100 TPS, 17 write TPS, đọc:ghi 100:1, đỉnh 2–5×: https://github.com/pinchen147/system-design-skill (HEURISTICS.md)
- Bảng tín hiệu (CPU 70%, cache 90%, P99, chờ vài giây): https://github.com/study8677/architecture-copilot (references/signals.md)
- Bậc độ lớn mỗi máy, uptime: https://github.com/proyecto26/system-design-skills/blob/main/skills/back-of-the-envelope/references/numbers-to-remember.md
- Độ trễ: https://colin-scott.github.io/personal_website/research/interactive_latency.html (số tới năm 2020, đọc từ công thức)
- D1 tính theo hàng đọc/ghi: https://developers.cloudflare.com/d1/platform/pricing/
- Ngưỡng 4 hạng (người dùng/ngày, request/giây, 20 request/người), hệ số dự phòng 1,5: kinh nghiệm, chưa có nguồn.

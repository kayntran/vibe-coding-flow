# Soát thiết kế

Dùng ở bước soát (sau bước 10) của `flow-system-design`.

## Mục lục
- Cách dùng
- Mức nặng nhẹ
- Danh sách soát một DESIGN.md
- Soát hệ thống có sẵn
- Ghi kết quả

## Cách dùng

- Cỡ M: tự đi hết danh sách, ghi một dòng kết quả ở mục "Soát" cuối DESIGN.md.
- Cỡ L, app mới: dán danh sách này vào đề soát plan bằng model khác (`flow-plan`), một lượt chung.
- Hệ thống có sẵn: dùng cùng danh sách, cộng phần "Soát hệ thống có sẵn". Chỉ báo, không sửa.
- Mỗi mục trả lời: đạt · trượt (kèm chỗ) · không áp dụng (kèm lý do). Mục chưa kiểm ghi "chưa rõ", không ghi "đạt".

## Mức nặng nhẹ

| Mức | Nghĩa | Xử lý |
|---|---|---|
| Nặng | Có thể mất tiền, mất/lộ dữ liệu, sập luồng chính | Sửa DESIGN.md trước khi viết PLAN |
| Vừa | Đắt khi sửa sau, hoặc hỏng ở 10× hiện tại | Sửa hoặc ghi rủi ro + ngưỡng vào lộ trình |
| Nhẹ | Thiếu nguồn, thiếu chữ, khó đọc | Sửa nếu nhanh |

## Danh sách soát một DESIGN.md

| # | Câu soát | Mức |
|---|---|---|
| 1 | Hạng quy mô ghi ở đầu, có lý do; mọi thành phần khớp hạng, thành phần hạng cao hơn nằm ở lộ trình? | Vừa |
| 2 | Mọi con số phi chức năng có nguồn (SPEC, user nói, đo, tra ngày, giả định)? Không có từ mơ hồ ("nhanh", "scale tốt")? | Vừa |
| 3 | Giả định được đánh dấu riêng, mỗi giả định có cách xác nhận hoặc đo lại? | Nhẹ |
| 4 | Ước lượng có phép tính (request/giây trung bình và cao điểm, dung lượng 1 năm, chi phí tháng từng khoản), không chỉ kết quả? | Vừa |
| 5 | Sơ đồ khớp chữ: mỗi hộp có trong luồng chính, mỗi bước luồng có hộp; không quá ~12 hộp? | Nhẹ |
| 6 | Mỗi thành phần có dòng "nó chết thì sao" (hỏng kiểu gì, người dùng thấy gì, hệ thống làm gì)? | Nặng |
| 7 | Đã chỉ ra điểm chết đơn lẻ và chấp nhận/xử lý có lý do (sao lưu, RTO)? | Vừa |
| 8 | Mọi điểm vào công khai hoặc tốn tiền mỗi lần gọi (đăng ký, gửi mã, AI, upload, tìm kiếm công khai, form) có rate limit + trần chi phí + không lộ thông tin dò được? | Nặng |
| 9 | Cô lập dữ liệu: tenant/chủ sở hữu lấy từ phiên server; ép ở lớp dữ liệu (RLS hoặc lớp repo); cache key có tenant; có bài test chéo? | Nặng |
| 10 | Quyền theo đối tượng và theo trường cho mọi endpoint có ID; không nhận thừa trường (mass assignment)? | Nặng |
| 11 | Việc tốn tiền/gửi ra ngoài có idempotency key; webhook kiểm chữ ký và khử trùng theo ID sự kiện; consumer queue idempotent? | Nặng |
| 12 | Có sao lưu cho mọi kho nguồn gốc, RPO/RTO ghi số, có lần thử khôi phục? | Nặng |
| 13 | Khoá bí mật chỉ ở server; không có khoá trong extension/app máy tính/bundle? | Nặng |
| 14 | Mọi lời gọi ngoài có timeout; retry có trần, chỉ ở một tầng? | Vừa |
| 15 | Chi phí ở 10× người dùng đã tính; nêu khoản đội nhanh nhất; khoản đó có trần cứng? | Vừa |
| 16 | Gói Free có bị chặn khi chạm trần (D1) hoặc tạm dừng/không sao lưu (Supabase) mà dữ liệu thật đang nằm trên đó? | Nặng |
| 17 | Mô hình dữ liệu, kiểu ID, định dạng file người dùng lưu, hợp đồng API công khai đã quyết (không "tạm rồi tính")? | Vừa |
| 18 | Migration tương thích ngược, có thứ tự phát hành; client cũ (app máy tính, extension) có phiên bản tối thiểu + màn bảo cập nhật? | Vừa |
| 19 | Có cách xem lỗi bản thật, cảnh báo chỉ khi người dùng bị ảnh hưởng, và cách quay lại bản trước? | Vừa |
| 20 | Mỗi quyết định lớn có: chọn gì, đã loại gì, vì sao, khi nào xem lại? | Vừa |
| 21 | Quyết định khó đảo ngược có ADR (bản ghi quyết định kiến trúc)? | Vừa |
| 22 | Lộ trình mỗi dòng có ngưỡng đo được ("CPU DB > 70% liên tục 1 tuần"), không ghi "khi cần"? | Vừa |
| 23 | Làm thừa: mỗi thành phần trả lời được "yêu cầu/con số nào bắt buộc có nó"? Không microservices/Kafka/K8s/Redis thiếu con số? | Vừa |
| 24 | Đã đào sâu 2–3 phần rủi ro nhất thay vì dàn đều? | Nhẹ |
| 25 | Có mục rủi ro và câu hỏi mở; câu hỏi cho user là về hành vi app/tiền, không về lựa chọn kỹ thuật? | Nhẹ |

## Soát hệ thống có sẵn

**Đọc gì (theo thứ tự, dừng khi đủ trả lời danh sách):**
1. `docs/ARCHITECTURE.md`, `docs/arch.json`, DESIGN.md cũ trong `docs/specs/`.
2. Cấu hình triển khai: file `wrangler` (binding D1/KV/R2/Queues/DO, cron, route), `supabase/` (migration, policy), workflow CI,
   `wails.json`, `manifest.json` của extension, file mẫu biến môi trường.
3. Schema + migration: bảng, index, cột tenant, RLS bật/ép chưa.
4. Điểm vào: route/handler công khai, webhook, cron, consumer queue.
5. Chỗ gọi ra ngoài: tìm `fetch(`, SDK AI/SMS/email/thanh toán — có timeout, retry, trần chưa.
6. Lần theo 1–2 luồng chính từ màn hình tới DB và ngược lại.
7. Đếm sơ: số file, số module, số bảng — để xếp hạng quy mô thật.

**Gắn nhãn mỗi phát hiện:**
- **Đã thấy** — có bằng chứng `path:line` hoặc dòng cấu hình.
- **Suy ra** — từ dấu hiệu gián tiếp (không thấy rate limit trong route ⇒ suy ra chưa có), ghi dấu hiệu.
- **Chưa rõ** — không đọc được (cấu hình trên trang quản trị, gói đang dùng); ghi câu cần hỏi user hoặc lệnh cần chạy.

**Khuôn báo mỗi phát hiện** (xếp nặng → nhẹ):

| Người dùng gặp gì | Ở ngưỡng nào | Sửa tốn gì | Mức | Nhãn + bằng chứng |
|---|---|---|---|---|
| "Ai cũng bấm gửi mã liên tục được, mỗi lần mất tiền SMS" | Ngay khi bị bot tìm thấy | Nhỏ: thêm rate limit + Turnstile, 1 ngày | Nặng | Đã thấy: route gửi mã không có giới hạn |
| "Danh sách đơn chậm dần, quá 3 s" | Khoảng 50.000 đơn | Vừa: thêm index + phân trang keyset | Vừa | Suy ra: truy vấn lọc theo cột chưa có index |

- "Sửa tốn gì" nói bằng thời gian/rủi ro cho user: nhỏ (dưới 1 ngày) · vừa (vài ngày, có migration) · lớn (đổi mô hình dữ liệu,
  cần kế hoạch riêng).
- Muốn sửa ⇒ việc riêng qua `flow-feature`; đo tải thật ⇒ `flow-scale`; kiểm code bảo mật ⇒ `flow-security`;
  khám tổng thể định kỳ ⇒ `flow-health`.

## Ghi kết quả

Một dòng cuối DESIGN.md: `Soát: <tự soát | model> · nhận #6, #11 · bác #23 (Queues đã có lý do: gửi 60.000 SMS/tháng)`.
Soát hệ thống có sẵn: báo trong chat theo khuôn trên, tối đa 10 phát hiện, nặng trước.

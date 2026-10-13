---
name: flow-scale
description: Đo app chịu được bao nhiêu người cùng lúc, tìm chỗ nghẽn, sửa rồi đo lại — luôn trên bản thử riêng, không đụng bản thật. Dùng khi user nói kiểu "app chậm", "sắp đông người", "có chịu nổi 500 người không", "kiểm tra tải", "load test", "k6". KHÔNG dùng để kiểm lỗi chức năng (dùng flow-qa) hay rà bảo mật (dùng flow-review).
---

# Flow — đo tải, tìm chỗ nghẽn, sửa, đo lại

Tải quá tay trên gói miễn phí làm **app thật ngưng tới 00:00 UTC** (hết hạn mức ngày). Vì vậy: chỉ đo bản thử, tăng
dần, dừng khi chạm 70% hạn mức.

## 1. Hỏi mục tiêu bằng lời (AskUserQuestion, không hỏi kỹ thuật)
- "Lúc đông nhất, khoảng bao nhiêu người dùng app cùng lúc?" (gợi ý các mức: 20 · 100 · 500 · 2.000).
- "Họ hay làm gì nhất?" (mở trang chủ, đăng nhập, lưu dữ liệu…) ⇒ thành kịch bản đo.
- Có sẵn mục tiêu trong SPEC/sổ chốt ⇒ dùng, không hỏi lại. Ghi mục tiêu vào sổ chốt.

## 2. Chuẩn bị bản thử (bắt buộc trước khi đo)
- Bản thử riêng: Workers `wrangler deploy --env staging` với D1/KV/R2 riêng; Supabase thì dự án hoặc nhánh thử riêng,
  dữ liệu mẫu. Chưa có ⇒ dựng trước, hỏi user một câu nếu cần tạo tài nguyên mới.
- **Từ chối đo** nếu địa chỉ đích là bản thật (tên miền chính, `.env` của thư mục chính, database thật). `wrangler dev`
  cục bộ chỉ đo máy bạn, không đại diện — chỉ dùng thử kịch bản. Mẫu `load.js` cũng tự chặn: chỉ nhận `localhost` hoặc
  địa chỉ có nhãn phụ `staging|stg|test|dev|preview` (vd `staging.shop.com`, `app-staging.<tên>.workers.dev`);
  `<tên>.workers.dev`, `<tên>.pages.dev`, `<tên>.dev` trơn bị coi là bản thật. Bản thử đúng mà không có nhãn ⇒ đặt tên
  lại cho có nhãn, hoặc `-e ALLOW_HOST=1` — chỉ khi user xác nhận đó không phải bản thật. Mẫu cũng KHÔNG đi theo
  chuyển hướng (bản thử trả 3xx sang bản thật ⇒ trượt, kèm lời báo, tải không dội sang đó) và chỉ nhận `PATHS` là đường
  dẫn bắt đầu bằng `/` (không `@`, `\`, `//` đầu) để không đổi được địa chỉ đích.
- Tính **dư địa** từ mục tiêu: số yêu cầu một người tạo trong một phiên × số người ≈ tổng yêu cầu/ngày; so với trần
  gói miễn phí: Workers **100.000 yêu cầu/ngày** (CPU 10 ms mỗi lần), D1 **100.000 dòng ghi/ngày** và 5 triệu dòng đọc.
  Một lần đo thật chạy ≤ 10% trần (≈ 10.000 yêu cầu); vượt ⇒ hạ tải hoặc hỏi user có chuyển gói trả phí không.
- k6 chưa cài ⇒ hỏi user rồi cài: Windows `winget install k6 --source winget`, Mac `brew install k6` (không cần
  Docker). k6 licence AGPL: chỉ chạy như công cụ ngoài, không nhúng vào app, không phân phối bản sửa. Chỉ chạy máy
  local, không dùng Grafana Cloud (tốn quota).

## 3. Đo, tăng dần
Mẫu: `kit/k6/load.js` (chép vào dự án, chỉnh `PATHS`). Chạy bước nhỏ trước:
```
k6 run -e BASE_URL=https://<bản-thử> -e VUS=5  -e DURATION=30s kit/k6/load.js
k6 run -e BASE_URL=https://<bản-thử> -e VUS=<mục-tiêu/4> -e DURATION=60s kit/k6/load.js
k6 run -e BASE_URL=https://<bản-thử> -e VUS=<mục-tiêu>   -e DURATION=2m  kit/k6/load.js
```
Mỗi bước xanh mới sang bước sau; thấy 429/1015/1102 hoặc lỗi > 10% ⇒ dừng ngay (mẫu tự dừng).

**Ngưỡng mặc định** (mẫu đã đặt sẵn): lỗi < 1% · 95% yêu cầu < 500 ms · 99% < 1,5 s · kiểm đúng nội dung > 99%.
**k6 thoát mã 99 = trượt ngưỡng ⇒ báo "chưa đạt"**, không tự nới ngưỡng cho xanh. Ngưỡng khác chỉ khi user đổi.

## 4. Trượt ⇒ tìm nút thắt (rẻ trước)
- Workers: bảng Observability (CPU, độ trễ), `wrangler tail --env staging`; lỗi 1102 = vượt CPU/lần gọi.
- D1: `wrangler d1 insights <db>` (thử nghiệm, có thể đổi), xem `meta.rows_read` của câu chậm, rồi
  `EXPLAIN QUERY PLAN <câu>` — thấy `SCAN` toàn bảng ⇒ thiếu chỉ mục.
- Supabase: `supabase inspect db calls|outliers|cache-hit|locks|long-running-queries` + Performance Advisor
  (cache-hit nên > 99%).
- Nhiều nghi vấn ⇒ Agent `debugger` mỗi con một giả thuyết; sửa giao `coder` theo `flow-qa` pha 7 (test đỏ trước).
- Cách sửa thường gặp: thêm chỉ mục · gộp bớt lần gọi · cache kết quả · đọc ít cột/ít dòng · phân trang.

## 5. Đo lại và báo
Sửa xong chạy lại **đúng bước từng trượt**, rồi bước mục tiêu. Hai vòng vẫn trượt ⇒ nghi thiết kế, báo user kèm 2–3
hướng (vd tách việc nặng ra hàng đợi), không vá lần ba.

Báo user theo khuôn: **chịu được bao nhiêu người cùng lúc · chỗ chậm nhất là gì (nói đời thường: "lưu đơn hàng chậm
vì tìm không có mục lục") · đã sửa gì · còn gì cần bạn quyết** (vd nâng gói khi mục tiêu vượt dư địa). Ghi kết quả
ngắn vào `docs/specs/<tính năng>/notes/scale-report.md`: ngày · mục tiêu · số đo p95/p99/lỗi · dư địa so với trần.

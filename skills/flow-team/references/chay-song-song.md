# Chạy song song nhiều làn

## Mục lục
- Trước khi giao
- Khi giao
- Khi làn trả về
- Khi nào KHÔNG song song

## Trước khi giao

Bảng `## Làn` trong PLAN.md phải qua `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>` (exit 0).
Giao theo **wave** nó in ra: làn cùng wave giao trong MỘT message, wave sau chỉ giao khi wave trước đã gộp vào nhánh
tích hợp.

## Khi giao

- Mỗi làn một worker `isolation: "worktree"`, chạy nền, tối đa **3–4 làn viết code đồng thời**, mỗi làn ≈ 5–6 task.
  Captain làm UI cùng lúc.
- Brief ghi `lane=<tên>` và `scope=` đúng glob của làn trong bảng. Worker cần sửa file ngoài scope ⇒ DỪNG, trả
  `return=needs_context` kèm tên file (luật nằm sẵn trong body `coder`/`coder-lite`).
- Làn cần chạy app/dev server/`qa-tester` ⇒ cấp port: `node ~/.claude/hooks/wt-env.mjs alloc <đường worktree>` ⇒ in
  `PORT_BASE=<n>`; app dùng các port `n..n+19`, ghi `PORT_BASE` vào brief. Không bao giờ dùng port mặc định của dự án.
- Cô lập dữ liệu mỗi làn: `alloc` in thêm `FLOW_DB_NAME`, `FLOW_TEST_DATA`; `wt-env.mjs env <worktree>` in khối biến cho
  `.env.local` của worktree. Mỗi làn một database thử riêng (nhánh Supabase/Neon KHÔNG mang dữ liệu thật, `supabase
  start`, hoặc container), dữ liệu thử riêng, khoá test riêng. Brief ghi rõ; cấm chép `.env` của thư mục chính, cấm nối
  database thật.
  Worktree chỉ cô lập file: không chạy migration đồng thời lên cùng DB local.
- Việc đánh giá độc lập (research, review plan, nhiều debugger cho nhiều lỗi, 2 lượt Codex) gửi trong MỘT message.
- Giao xong không ngó chừng (không sleep/poll/đọc log) — hệ thống tự báo khi xong.

## Khi làn trả về

Trước khi nhận:
`node ~/.claude/hooks/lane-check.mjs audit <PLAN.md> <lane> --branch <nhánh làn> --base <mốc làn tách ra>`
(mốc = nhánh tích hợp nếu làn tách từ đó ở wave sau, `main` nếu wave đầu). Audit tính cả file chưa commit trong
worktree của làn.
Có file ngoài scope (`OUTSIDE`) ⇒ không gộp; xem file đó: hợp lý thì cập nhật bảng + chạy lại `plan` (có thể đụng làn
khác), không hợp lý thì trả worker gỡ ra.

## Khi nào KHÔNG song song

Số đo: hai agent khác nhau sửa song song ⇒ 41,7% PR xung đột, arXiv 2607.04697.
- Cỡ S, hoặc tổng việc < ~30 phút cho một worker ⇒ một worker làm tuần tự.
- `lane-check plan` vẫn báo OVERLAP/HOT sau một lần chỉnh bảng ⇒ gộp các làn đó thành một.
- Việc nguyên khối (một luồng logic xuyên nhiều file, refactor đổi tên rộng, nâng framework) ⇒ không tách.
- Các làn phụ thuộc nhau thành chuỗi dài (wave > 3 mà mỗi wave chỉ 1 làn) ⇒ tuần tự thật sự, bỏ song song.
- Captain không đủ sức soát diff >4 làn một lúc ⇒ giữ ≤4: nút cổ chai là review, không phải tốc độ viết.

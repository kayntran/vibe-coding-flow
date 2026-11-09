---
name: flow-team
description: Đội hình worker và cách giao việc — chọn worker nào (researcher, recon, coder, coder-lite, coder-mini, test-runner, qa-tester, debugger, Codex, Grok, agy), viết brief, đọc receipt, chạy song song nhiều worker, thang leo khi worker hỏng, ghi nhật ký. Dùng khi sắp gọi Agent tool hoặc CLI model ngoài, khi chia làn thi công song song, khi worker trả blocked/sai. KHÔNG cần cho việc captain tự làm (tìm kiếm rg, phỏng vấn, viết plan, UI, việc dưới ~5 phút).
user-invocable: false
---

# Đội hình & giao việc

**Đang chạy trong Paseo** (hook mở phiên báo, hoặc `node ~/.claude/hooks/paseo.mjs on` ra "có") ⇒ chọn vai như dưới, nhưng
giao bằng phiên Paseo theo skill `flow-paseo` thay cho Agent tool và CLI ngoài.

## Chọn worker

Vai nào, giao khi nào, không giao gì, model nào ⇒ `references/chon-worker.md`.

- **Trước mọi lần gọi CLI ngoài** (codex, agy, cursor-agent, grok, devin): `node ~/.claude/hooks/cli-check.mjs <tên>`.
  Chưa sẵn sàng ⇒ dùng worker native; chỉ đưa user lệnh đăng nhập khi lý do là `not-logged-in` (hết lượt/mất mạng thì không).
- Không truyền `model` khi gọi Agent, trừ bậc leo Opus.

Captain tự làm: tìm kiếm "X ở đâu" bằng MỘT lệnh `rg` nhiều path + nhiều `-e` (worker tìm kiếm tốn 30–45K token và
sót dòng — đo 2026-09-28) · phỏng vấn · viết plan · UI · việc dưới ~5 phút hoặc 1–2 file · việc dự án khai captain-only.

## Chạy song song

Chia nhiều làn ⇒ đọc `references/chay-song-song.md` trước khi giao. Cốt lõi:
- Bảng `## Làn` trong PLAN.md phải qua `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>` (exit 0); giao theo wave nó in ra.
- Mỗi làn một worker `isolation: "worktree"`, tối đa **3–4 làn viết code đồng thời**; brief ghi `lane=` và `scope=`.
- Cô lập dữ liệu mỗi làn: database thử riêng, dữ liệu thử riêng, khoá test riêng, ghi rõ trong brief; cấm chép `.env` của thư mục
  chính, cấm nối database thật. Worktree chỉ cô lập file: không chạy migration đồng thời lên cùng DB local.
- Làn cần chạy app/dev server/`qa-tester` ⇒ cấp port bằng `wt-env.mjs alloc`, không bao giờ dùng port mặc định của dự án.
- Giao xong không ngó chừng (không sleep/poll/đọc log) — hệ thống tự báo khi xong.
- Làn trả về: `lane-check.mjs audit` trước khi nhận; có file ngoài scope (`OUTSIDE`) ⇒ không gộp.
- KHÔNG song song khi: cỡ S hoặc tổng việc < ~30 phút · `lane-check plan` vẫn báo OVERLAP/HOT sau một lần chỉnh bảng · việc nguyên khối
  · chuỗi wave > 3 mà mỗi wave chỉ 1 làn · cần soát diff >4 làn một lúc (giữ ≤4).

Mỗi lần worker báo xong là một lần phiên chính đọc lại cả ngữ cảnh ⇒ ≥3 việc độc lập chỉ cần kết quả cuối thì xem
`references/gom-bao-xong.md`. Một worker xong gửi HAI tín hiệu: xử lý ở tín hiệu đầu, tín hiệu sau không có gì mới ⇒
không gọi tool, không nhắn user.

## Brief & receipt

Brief tự đủ, < 800 ký tự, theo `assets/brief-receipt.md` (outcome · scope · constraints · accept). Brief luôn đòi receipt
ngắn. Claim không có `path:line`/URL ⇒ vứt; khẳng định phủ định cũng cần bằng chứng. Kết quả về captain ≤ ~1.500 token;
dài hơn ⇒ worker ghi file, trả path. Hỏi tiếp cùng chủ đề ⇒ SendMessage worker cũ (giữ ngữ cảnh, rẻ hơn spawn mới).

## Thang leo

`coder-mini` → `coder-lite` → `coder` → `coder` + `model: "opus"` → captain. Leo khi `blocked` hoặc sai hai lần. Cùng model không thử
lại quá một lần; brief mơ hồ thì sửa brief.

## Nhật ký

Dự án có `.claude/worker-log.md` ⇒ mỗi lần giao, sau khi kiểm xong, thêm một dòng: ngày · worker/model/effort · việc
≤8 chữ · `ok`/`ok-noisy`/`fabricated`/`blocked`/`wrong` · một mệnh đề bằng chứng. Quá 25 dòng từ lần tổng kết trước ⇒
tổng kết theo số đếm, đề xuất nâng/hạ/bỏ worker.

## Đọc khi cần

- `references/chon-worker.md` — đọc khi chọn worker/model cho một việc (bảng vai, cách chọn model, A/B)
- `references/chay-song-song.md` — đọc khi chia nhiều làn song song, cấp port/dữ liệu cho làn, nhận làn trả về, hoặc cân nhắc có nên song song
- `references/gom-bao-xong.md` — đọc khi có ≥3 việc độc lập chỉ cần kết quả cuối, hoặc nhiều lệnh nền liên quan nhau
- `assets/brief-receipt.md` — đọc khi viết brief hoặc cần dạng receipt chuẩn

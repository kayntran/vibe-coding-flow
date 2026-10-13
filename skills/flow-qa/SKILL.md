---
name: flow-qa
description: Kiểm và sửa — chạy lint/typecheck/test, tự mở app dùng thử như người thật (Playwright), debug tới nguyên nhân gốc rồi sửa bằng test đỏ, đóng dấu QA. Dùng khi code xong trong worktree (tự chạy, trước review), hoặc khi user nói kiểu "chạy thử", "test giúp", "kiểm tra xem chạy chưa", "bị lỗi", "không chạy", "CI đỏ", "xem log". Bắt buộc khi diff đụng UI/app vì hook chặn gộp nếu thiếu dấu QA. KHÔNG dùng để review code (dùng flow-review).
---

# Flow — kiểm, test thực tế, debug

## Pha 5 — Kiểm cơ học
`node ~/.claude/hooks/flow-check.mjs --dir <worktree>` (máy kiểm theo stack: lint, typecheck, SAST, lỗ hổng thư viện,
khoá trong bản build, mã S-nn/P-nn của SPEC có trong app/test, header an toàn, luật giao diện qua `ui-check` khi dự án
có `.claude/ui.json` — công cụ thiếu ⇒ hỏi user cài, không cài ngầm) + Agent `test-runner` chạy đủ bộ test (unit,
integration, build) theo CLAUDE.md dự án. Đỏ ⇒ pha 7. Xanh ⇒ pha 6.
Bật máy kiểm giao diện ở dự án có sẵn ⇒ `node ~/.claude/hooks/ui-check.mjs --dir <repo> --baseline` một lần (chốt mốc:
lỗi cũ chỉ nhắc, lỗi mới chặn [vm5s]); app tạo từ mẫu không chốt mốc.

## Pha 6 — Test thực tế
1. Lấy QA charter trong PLAN.md (cỡ S: captain tự viết 3–5 dòng từ yêu cầu).
2. Agent `qa-tester` — brief: charter, lệnh chạy app, **port riêng** từ `node ~/.claude/hooks/wt-env.mjs alloc <đường worktree>` (`PORT_BASE`),
   dữ liệu/tài khoản test (từ seed của dự án), đường ghi `<scratchpad>/qa/qa-report.md`.
   Nhiều luồng độc lập ⇒ 2–3 `qa-tester` song song, mỗi con một nhóm criteria + port riêng.
   Mỗi qa-tester/làn dùng dữ liệu riêng: `FLOW_DB_NAME`, `FLOW_TEST_DATA` từ `wt-env.mjs alloc` (DB thử riêng: nhánh DB
   không dữ liệu thật / `supabase start` / container), khoá test; không bao giờ trỏ vào database thật hay `.env` của thư mục chính.
   Diff có màn mới ⇒ thêm bài **người mới**: một `qa-tester` riêng chỉ nhận mục tiêu việc chính bằng lời ("thêm một
   đơn hàng rồi đánh dấu đã giao"), KHÔNG được đọc code/SPEC/PLAN; tự làm từ màn đầu, ghi chỗ kẹt, chỗ phải đoán, số lần
   bấm nhầm. Kẹt/đoán ⇒ lỗi giao diện (tín hiệu sửa, không phải cổng chặn). Kèm checklist giao diện (dưới) cho phần
   máy không kiểm được.
   SPEC có `P-nn` ⇒ mỗi mã: chạy test của mã với hai người dùng thật ở lớp chặn quyền thật (DB có policy: hai user; API:
   hai phiên; giao diện: hai trình duyệt) ⇒ xanh; rồi tắt đúng chặn quyền đó TRONG worktree (không commit; vd bỏ policy,
   bỏ kiểm chủ sở hữu ở server) ⇒ chạy lại phải ĐỎ ⇒ khôi phục. Báo cáo ghi MỖI mã một dòng
   `P-01: đỏ khi tắt: có — <file test>`; thiếu mã nào hook không đóng dấu QA và nêu mã đó.
3. Đọc báo cáo, mở 1–2 ảnh của bug nặng nhất để kiểm claim.
4. Có bug ⇒ pha 7, rồi chạy lại qa-tester cho đúng criteria hỏng + một vòng hồi quy luồng chính.
5. Diff đụng giao diện ⇒ DỪNG: chạy app, mở cho user xem (hoặc 2–3 ảnh chụp màn chính), hỏi "giao diện đã ổn chưa?"
   bằng AskUserQuestion. Chưa ưng ⇒ sửa, QA lại phần đổi, hỏi lại. Gật ⇒ ghi vào báo cáo dòng
   `User duyệt giao diện: có (<ngày>, <xem gì>)` — thiếu dòng này hook không đóng dấu QA cho diff có UI. Kiểm luôn: bản
   demo thừa và thanh chuyển demo đã gỡ hết.
6. Hết bug ⇒ đóng dấu trong worktree:
   `node ~/.claude/hooks/flow-gate.mjs stamp qa <scratchpad>/qa/qa-report.md`
   Diff không đụng UI/app ⇒ được ghi file chỉ một dòng `N/A: <lý do>` rồi stamp (hook từ chối N/A khi diff có file UI).
   Báo cáo ghi commit đã kiểm + mã AC từng mục; bản cuối chép vào `docs/specs/<tính năng>/notes/qa-report.md`.

### Checklist giao diện (máy kiểm dòng có ⚙, QA soát phần còn lại)
1. ⚙ Mỗi màn đúng một nút chính. 2. ⚙ Nhãn nút 1–3 chữ, động từ, không OK/Yes/Submit/Có/Không/Xác nhận. 3. ⚙ Nút chỉ có
icon chỉ cho nhà/in/tìm kiếm; còn lại có nhãn hiện ra. 4. Hộp xác nhận chỉ cho xoá/ghi đè không hoàn tác, tiền, quyền —
nêu tên đối tượng, nút theo kết quả, focus không rơi vào nút phá huỷ. 5. Việc hoàn tác được ⇒ nút Hoàn tác thay hộp xác
nhận. 6. ⚙ Không hộp thoại lúc mở app, không banner chỉ để thông báo. 7. Lỗi một dòng cạnh ô sai, giữ giá trị đã nhập,
không mã lỗi trần. 8. Màn trống: một câu + một nút bước đầu, khác trạng thái đang tải. 9. Mọi tính năng tới được trong ≤2
lần bấm từ màn chính. 10. Đang lưu ⇒ nút đổi trạng thái; mục mới sáng lên.

## Pha 7 — Debug & sửa
1. Agent `debugger` — brief: triệu chứng, nguồn (lệnh test đỏ / `gh run` id / đường log / bug trong qa-report / lời tả
   hoặc ảnh của user), đường ghi báo cáo. Nó tìm rẻ trước [134g] và tự hỏi Codex làm ý kiến thứ hai. Debugger trả câu
   hỏi "có phải chỗ này không?" kèm ảnh ⇒ captain hỏi user (AskUserQuestion, kèm đường ảnh) TRƯỚC khi giao sửa.
   Nhiều lỗi độc lập ⇒ nhiều `debugger` song song, mỗi con một lỗi.
2. Captain kiểm kết luận vào code. Rồi Agent `coder` (`isolation: "worktree"` nếu đang ở nhánh có làn khác) —
   brief: viết test đỏ theo đề xuất của debugger TRƯỚC, sửa đúng tầng, accept = test đó + bộ liên quan xanh.
   Bug từ QA: codify thành Playwright spec đỏ; nếu tái hiện được ở tầng unit/integration thì thêm test ở tầng đó.
3. Quay pha 5. Cùng một lỗi sau 2 vòng sửa vẫn đỏ ⇒ leo thang theo skill `flow-team`. Sau 3 vòng ⇒ **dừng vá**:
   nhiều khả năng sai ở thiết kế chứ không ở dòng code. Captain xem lại kiến trúc/giả định quanh lỗi, báo user
   kèm 2–3 hướng thiết kế lại, không thử vá lần thứ tư.

---
name: flow-qa
description: Kiểm và sửa — chạy lint/typecheck/test, tự mở app dùng thử như người thật (Playwright), debug tới nguyên nhân gốc rồi sửa bằng test đỏ, đóng dấu QA. Dùng khi code xong trong worktree (tự chạy, trước review), hoặc khi user nói kiểu "chạy thử", "test giúp", "kiểm tra xem chạy chưa", "bị lỗi", "không chạy", "CI đỏ", "xem log". Bắt buộc khi diff đụng UI/app vì hook chặn gộp nếu thiếu dấu QA. KHÔNG dùng để review code (dùng flow-review).
---

# Flow — kiểm, test thực tế, debug

## Pha 5 — Kiểm cơ học
Agent `test-runner` chạy đủ bộ (lint, typecheck, unit, integration, build) theo CLAUDE.md dự án.
Đỏ ⇒ pha 7. Xanh ⇒ pha 6.

## Pha 6 — Test thực tế
1. Lấy QA charter trong PLAN.md (cỡ S: captain tự viết 3–5 dòng từ yêu cầu).
2. Agent `qa-tester` — brief: charter, lệnh chạy app, **port riêng** từ `node ~/.claude/hooks/wt-env.mjs alloc <đường worktree>` (`PORT_BASE`),
   dữ liệu/tài khoản test (từ seed của dự án), đường ghi `<scratchpad>/qa/qa-report.md`.
   Nhiều luồng độc lập ⇒ 2–3 `qa-tester` song song, mỗi con một nhóm criteria + port riêng.
3. Đọc báo cáo, mở 1–2 ảnh của bug nặng nhất để kiểm claim.
4. Có bug ⇒ pha 7, rồi chạy lại qa-tester cho đúng criteria hỏng + một vòng hồi quy luồng chính.
5. Hết bug ⇒ đóng dấu trong worktree:
   `node ~/.claude/hooks/flow-gate.mjs stamp qa <scratchpad>/qa/qa-report.md`
   Diff không đụng UI/app ⇒ được ghi file chỉ một dòng `N/A: <lý do>` rồi stamp (hook từ chối N/A khi diff có file UI).

## Pha 7 — Debug & sửa
1. Agent `debugger` — brief: triệu chứng, nguồn (lệnh test đỏ / `gh run` id / đường log / bug trong qa-report),
   đường ghi báo cáo. Nó tự hỏi Codex làm ý kiến thứ hai.
   Nhiều lỗi độc lập ⇒ nhiều `debugger` song song, mỗi con một lỗi.
2. Captain kiểm kết luận vào code. Rồi Agent `coder` (`isolation: "worktree"` nếu đang ở nhánh có làn khác) —
   brief: viết test đỏ theo đề xuất của debugger TRƯỚC, sửa đúng tầng, accept = test đó + bộ liên quan xanh.
   Bug từ QA: codify thành Playwright spec đỏ; nếu tái hiện được ở tầng unit/integration thì thêm test ở tầng đó.
3. Quay pha 5. Cùng một lỗi sau 2 vòng sửa vẫn đỏ ⇒ leo thang theo skill `flow-team`. Sau 3 vòng ⇒ **dừng vá**:
   nhiều khả năng sai ở thiết kế chứ không ở dòng code. Captain xem lại kiến trúc/giả định quanh lỗi, báo user
   kèm 2–3 hướng thiết kế lại, không thử vá lần thứ tư.

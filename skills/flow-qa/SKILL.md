---
name: flow-qa
description: Pha 5–7 của flow — kiểm cơ học (lint/typecheck/test), test thực tế như người dùng bằng qa-tester, debug và sửa lỗi. Dùng sau khi code xong trong worktree, trước review code; bắt buộc khi diff đụng UI/app vì hook chặn gộp nếu thiếu dấu QA.
---

# Flow — kiểm, test thực tế, debug

## Pha 5 — Kiểm cơ học
Agent `test-runner` chạy đủ bộ (lint, typecheck, unit, integration, build) theo CLAUDE.md dự án.
Đỏ ⇒ pha 7. Xanh ⇒ pha 6.

## Pha 6 — Test thực tế
1. Lấy QA charter trong PLAN.md (cỡ S: captain tự viết 3–5 dòng từ yêu cầu).
2. Agent `qa-tester` — brief: charter, lệnh chạy app, **port riêng** (không trùng worktree khác đang chạy),
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
3. Quay pha 5. Cùng một lỗi sau 2 vòng sửa vẫn đỏ ⇒ leo thang theo WORKERS.md; sau 3 vòng ⇒ dừng, báo user.

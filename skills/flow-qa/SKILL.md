---
name: flow-qa
description: Kiểm việc vừa làm — chạy lint, typecheck, test đủ bộ, rồi tự mở app dùng thử như người thật, báo cả phần chưa kiểm, đóng dấu QA. Dùng khi code xong trong worktree, hoặc user nói "chạy thử", "test giúp", "kiểm tra xem chạy chưa". Luôn chạy khi diff đụng UI/app. KHÔNG dùng để sửa lỗi đã biết (flow-fix), soát code (flow-review), soát riêng giao diện (flow-ui-design).
---

# Kiểm và chạy thử

Skill này chỉ kiểm và báo. Có lỗi ⇒ `flow-fix`, sửa xong quay lại đây.

**Không sửa kỳ vọng cho khớp.** Test đỏ hoặc app khác SPEC là tín hiệu, không phải thứ cần làm im.

## 0. Kiểm đúng, không thừa [1osp]

- **Một bản code, một lần kiểm.** Trước khi chạy bộ đủ: `node ~/.claude/hooks/flow-gate.mjs status`. Dòng `test: có (đúng bản code này…)`
  ⇒ dùng lại, không chạy lại. `flow-check` xanh thì ghi `Kiểm máy: xanh @<commit>` vào `progress.md`; còn đúng commit đó ⇒ cũng dùng lại.
- **Sửa lỗi xong** chỉ chạy lại test của phần vừa sửa và tiêu chí đã hỏng. Bộ đủ + `flow-check` chạy lại MỘT lần khi đã hết lỗi, không
  chạy sau mỗi lần sửa.
- **Mức dùng thử theo thay đổi:**

| Diff | Dùng thử (mục 2) |
|---|---|
| Không đụng UI/app (tài liệu, cấu hình, script) | Bỏ; báo cáo một dòng `N/A: <lý do>` |
| Rất nhỏ: một nhãn, một màu | Ảnh trước/sau, không gọi `qa-tester` |
| Cỡ S đổi hành vi | MỘT `qa-tester`, charter 3–5 dòng: đúng chỗ đổi + một vòng luồng chính |
| Cỡ M/L | Đủ mục 2; bước nào không khớp điều kiện của nó thì bỏ |

- **Ba kết quả:** `đạt` · `không đạt` · `chưa kết luận` (kiểm sai chỗ, không chạy được, kiểm qua dễ quá nên nghi cách kiểm). "Chưa kết
  luận" kèm lý do và không bao giờ tính là đạt.

## 1. Kiểm cơ học

`test-runner` (bộ đủ) và `qa-tester` (mục 2) không phụ thuộc nhau ⇒ giao cùng lúc, chạy ngầm [2t4a].
`node ~/.claude/hooks/flow-check.mjs --dir <worktree>`: máy kiểm theo stack (lint, typecheck, SAST, lỗ hổng thư viện, khoá trong bản build,
mã S-nn/P-nn của SPEC có trong app/test, header an toàn, luật giao diện qua `ui-check` khi dự án có `.claude/ui.json`).
Công cụ thiếu ⇒ hỏi user cài, không cài ngầm.

Agent `test-runner` chạy đủ bộ test theo CLAUDE.md dự án, rồi đóng dấu: `node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>`.
Bộ test có mở app (Playwright e2e) ⇒ hỏi `node ~/.claude/hooks/devin-vm.mjs where --dir <worktree>`: `devin` ⇒ chạy trên máy ảo theo skill `flow-devin` (`job`), `local` ⇒ máy user với `--workers=2`.

Đỏ ⇒ `flow-fix`. Xanh ⇒ mục 2.
Dự án có sẵn mới bật máy kiểm giao diện ⇒ `node ~/.claude/hooks/ui-check.mjs --dir <repo> --baseline` một lần (lỗi cũ chỉ nhắc, lỗi mới báo [vm5s]); app tạo từ mẫu không chốt mốc.

**AI vừa viết test ⇒ soát test giả.** Test đó có đỏ khi bỏ phần code nó kiểm không? Có kiểm kết quả thật, hay chỉ kiểm mock của chính nó, hoặc không có assert?
Test giả tính là chưa kiểm.

**User bảo bỏ test:** làm theo, ghi `Chưa kiểm: <phần nào>` vào báo cáo và `progress.md`, nhắc lại lúc gộp [rofm].

## 2. Dùng thử như người thật

1. Lấy QA charter trong PLAN.md (cỡ S: tự viết 3-5 dòng từ yêu cầu). Chọn nơi chạy:
   `node ~/.claude/hooks/devin-vm.mjs where --dir <worktree> [--need <nhãn của charter>]` ⇒ `devin` thì brief thêm `runner=devin os=<os>` (qa-tester làm theo skill `flow-devin`), `local` thì báo user một dòng lý do.
2. Agent `qa-tester` — brief: charter, lệnh chạy app, **port riêng** từ `node ~/.claude/hooks/wt-env.mjs alloc <đường worktree>` (`PORT_BASE`), dữ liệu và tài khoản test (từ seed của dự án), đường ghi `<scratchpad>/qa/qa-report.md`.
   - Nhiều luồng độc lập ⇒ 2-3 `qa-tester` song song, mỗi con một nhóm tiêu chí và port riêng.
   - Mỗi con dùng dữ liệu riêng: `FLOW_DB_NAME`, `FLOW_TEST_DATA` từ `wt-env.mjs alloc` (DB thử riêng, khoá test). Không bao giờ trỏ vào database thật hay `.env` của thư mục chính.
   - DESIGN.md có bảng ngân sách request và tải trang [r69o] ⇒ chép vào brief; `qa-tester` đếm lại từng màn, vượt là lỗi.
3. Diff có màn mới ⇒ thêm bài **người mới** (ghi vào brief lượt thường "có lượt người mới riêng" để nó không làm trùng): một `qa-tester` riêng chỉ nhận mục tiêu bằng lời ("thêm một đơn hàng rồi đánh dấu đã giao"), KHÔNG đọc code/SPEC/PLAN; tự làm từ màn đầu, ghi chỗ kẹt, chỗ phải đoán, số lần bấm nhầm. Kẹt hoặc đoán ⇒ lỗi giao diện. Bài này cũng kiểm lại giả định của `flow-ux`.
4. Diff đổi bố cục hoặc kiểu dáng ⇒ `flow-ui-design` chế độ soát (đủ 3 cỡ màn hình, danh sách luật) cho phần đã đổi, MỘT lần: luồng
   đang chạy có bước soát giao diện riêng (`flow-feature`, `flow-bugfix`) thì bước đó lo; phần đã soát lúc làm mà chưa đổi thêm thì không soát lại.
   Sửa logic trong file giao diện mà màn hình không đổi ⇒ bỏ bước này.
5. SPEC có `P-nn` ⇒ mỗi mã: chạy test với hai người dùng thật ở lớp chặn quyền thật (DB có policy: hai user; API: hai phiên; giao diện: hai trình duyệt) ⇒ xanh; tắt đúng chặn quyền đó TRONG worktree (không commit) ⇒ chạy lại phải ĐỎ ⇒ khôi phục. Báo cáo ghi mỗi mã một dòng `P-01: đỏ khi tắt: có — <file test>`; thiếu thì lệnh đóng dấu QA từ chối và nêu mã đó.
6. Đọc báo cáo, mở 1-2 ảnh của bug nặng nhất để kiểm lời báo. Có bug ⇒ `flow-fix`, rồi chạy lại đúng tiêu chí hỏng và một vòng luồng chính.

## 3. Cho user xem giao diện

| Thay đổi | Làm |
|---|---|
| Màn mới, làm lại giao diện, đổi bố cục hay luồng | DỪNG: mở app (máy ảo thì ảnh chụp hoặc cổng `forward`; xong cho máy ngủ) hoặc 2-3 ảnh màn chính, hỏi "giao diện đã ổn chưa?" bằng AskUserQuestion. Chưa ưng ⇒ sửa, QA lại phần đổi, hỏi lại |
| Rất nhỏ: một nhãn, một màu | Gửi ảnh trước/sau, không dừng chờ [rofm] |

Đây là lần hỏi "giao diện đã ổn chưa?" DUY NHẤT sau khi làm thật; `flow-ui-design` và bước soát của luồng dùng chung lời gật này. Trước khi
hỏi: việc không phụ thuộc câu trả lời (`flow-security`, sửa lỗi không đụng giao diện) cho chạy trước [2t4a]. User vắng (`flow-away`) ⇒ không
hỏi, không ghi dòng duyệt, để thiếu dấu và đưa vào báo cáo sáng.
Đang ở Paseo ⇒ mở app cho user xem trong trình duyệt của Paseo (skill `flow-paseo`, mục "Cho user xem app").
User gật ⇒ ghi vào báo cáo `User duyệt giao diện: có (<ngày>, <xem gì>)`. Chưa gật thì không ghi dòng này. Sửa rất nhỏ ghi `Sửa giao diện rất nhỏ: đã gửi ảnh`.
Kiểm luôn: bản demo thừa và thanh chuyển demo đã gỡ hết.

## 4. Báo cáo và đóng dấu

Báo cáo ghi: commit đã kiểm · mã AC từng mục · `Nơi chạy:` (máy ảo Devin <os> (<id>) / máy user — lý do) · **phần chưa kiểm và vì sao**. Không có mục nào chưa kiểm thì ghi rõ.
Bản cuối chép vào `docs/specs/<tính năng>/notes/qa-report.md`.

Hết bug ⇒ trong worktree: `node ~/.claude/hooks/flow-gate.mjs stamp qa <scratchpad>/qa/qa-report.md`

Lệnh này từ chối khi: diff có UI mà báo cáo thiếu dòng user duyệt, hoặc chỉ ghi N/A · thiếu dòng `P-nn` · không đọc được SPEC.
Diff không đụng UI/app ⇒ báo cáo được phép chỉ một dòng `N/A: <lý do>`.
Không đóng dấu được, gồm cả sửa UI rất nhỏ chưa có lời gật ⇒ không viết dòng giả; để thiếu dấu và báo một dòng lúc gộp. Thiếu dấu không chặn gộp [unj0].

Báo user: đã thử gì · người dùng sẽ gặp gì · còn gì chưa kiểm. Không dán log.

# Chọn worker và model

## Ai làm gì

| Vai | Ai | Giao khi | Không giao |
|---|---|---|---|
| Research prior art | `researcher` (Sonnet high) — tự tìm GitHub + gọi thêm **Grok** + **agy** để có thêm góc nhìn | ý tưởng cỡ M/L, dò edge case cỡ L | quyết định |
| Đọc thô / tra docs | `recon` (Sonnet high) | đọc >30KB trong repo, tra API/CVE, trả kết luận `path:line` | quyết định |
| Code có mẫu | `coder-lite` (Sonnet high) | i18n, docs, sửa lặp, test theo spec rõ, lint/type, bug hẹp có test tái hiện | logic mới, schema, đồng thời, bảo mật |
| Code khó | `coder` (Sonnet xhigh) | service, SQL/transaction/schema, khoá đồng thời, bảo mật, logic mới | việc chép lặp |
| Việc nhỏ | `coder-mini` (Haiku medium) | mini project độc lập, tính năng cỡ S 1–2 file có mẫu, sửa nhanh có test tái hiện | logic mới phức tạp, schema, bảo mật, UI |
| Kiểm cơ học | `test-runner` (Haiku medium) | lint/typecheck/test/build, trả CHỈ phần đỏ | đoán nguyên nhân, sửa code |
| Test thực tế | `qa-tester` (Sonnet high) | chạy app, lái Playwright như người dùng theo QA charter | sửa code |
| Debug | `debugger` (Sonnet xhigh, hỏi thêm **Codex**) | test đỏ, CI đỏ, log server, stack trace ⇒ nguyên nhân gốc | sửa code |
| Soát plan | chuỗi Codex Sol high → Opus high qua agy → `code-reviewer` opus (đang ở Codex: Sol high), 1 lượt — CHỈ cỡ L (skill `flow-plan`) | sau khi viết PLAN.md, thay cho việc user duyệt plan | cỡ S/M (captain tự soát) |
| Review code + bảo mật + hiệu năng | theo rủi ro (thường: **Grok** · nhạy cảm: **Codex Sol high** + Grok · tiền/dữ liệu: + **Gemini Flash**), tất cả qua `review-ext.mjs --model …` | MỘT lần cho cả tính năng, trước khi gộp (skill `flow-review`) | sau từng giai đoạn/làn |
| Review dự phòng | Codex → Grok → Gemini Flash → `code-reviewer` (Opus medium) | lượt nào lỗi thì sang model kế chưa dùng | — |

## Model

- **Model luôn là bản mới nhất của dòng** (`kit/roles.json`): Claude ghi tên dòng (`sonnet|opus|haiku`) trong
  frontmatter agent; CLI ngoài lấy id bằng `node ~/.claude/hooks/models.mjs pick <app> <vai>` — KHÔNG ghi cứng id.
  User đổi model cho vai bằng lời ⇒ `models.mjs set <vai> <app> <dòng>[:mức]` (ghi `~/.claude/flow.local.json`, giữ khi
  cập nhật kit), `reset <vai>` để trả mặc định.
- **agy** dùng cho research và soát plan (Opus mới nhất), không dùng review code.
- Ưu tiên provider khác cho vai **đánh giá** (review, research, ý kiến debug thứ hai): người viết ≠ người chấm.
- Viết code giữ Sonnet — A/B 2026-09-29, 39 lượt việc thật, 2 giám khảo chấm mù: Sonnet xhigh 46,0/50 cao nhất ở
  DB+khoá và bảo mật (~$0,8/việc); Sonnet high 45,1 rẻ nhất ($0,39). Sonnet low/medium tụt mạnh ở việc khó. Codex
  viết code chưa đo — muốn dùng thì A/B trước; khi Codex viết thì Claude review.

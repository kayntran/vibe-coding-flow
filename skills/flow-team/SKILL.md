---
name: flow-team
description: Đội hình worker và cách giao việc — chọn worker nào (researcher, recon, coder, coder-lite, test-runner, qa-tester, debugger, Codex, Grok, agy), viết brief, đọc receipt, chạy song song nhiều worker, thang leo khi worker hỏng, ghi nhật ký. Dùng khi sắp gọi Agent tool hoặc CLI model ngoài, khi chia làn thi công song song, khi worker trả blocked/sai. KHÔNG cần cho việc captain tự làm (tìm kiếm rg, phỏng vấn, viết plan, UI, việc dưới ~5 phút).
---

# Đội hình & giao việc

## Ai làm gì

| Vai | Ai | Giao khi | Không giao |
|---|---|---|---|
| Research prior art | `researcher` (Sonnet high) — tự tìm GitHub + gọi thêm **Grok 4.7** và **agy** để có thêm góc nhìn | ý tưởng cỡ M/L, dò edge case cỡ L | quyết định |
| Đọc thô / tra docs | `recon` (Sonnet high) | đọc >30KB trong repo, tra API/CVE, trả kết luận `path:line` | quyết định |
| Code có mẫu | `coder-lite` (Sonnet high) | i18n, docs, sửa lặp, test theo spec rõ, lint/type, bug hẹp có test tái hiện | logic mới, schema, đồng thời, bảo mật |
| Code khó | `coder` (Sonnet xhigh) | service, SQL/transaction/schema, khoá đồng thời, bảo mật, logic mới | việc chép lặp |
| Kiểm cơ học | `test-runner` (Haiku 4.5) | lint/typecheck/test/build, trả CHỈ phần đỏ | đoán nguyên nhân, sửa code |
| Test thực tế | `qa-tester` (Sonnet high) | chạy app, lái Playwright như người dùng theo QA charter | sửa code |
| Debug | `debugger` (Sonnet xhigh, hỏi thêm **Codex**) | test đỏ, CI đỏ, log server, stack trace ⇒ nguyên nhân gốc | sửa code |
| Review plan | **Codex gpt-6.1-sol high** (+ **Grok 4.7** cỡ L) | sau khi viết PLAN.md | — |
| Review code + bảo mật + hiệu năng | **Codex gpt-6.1-sol high ×2** | trước mỗi lần gộp (skill `flow-review`) | — |
| Review dự phòng | `code-reviewer` (Opus 5.5 medium) | CHỈ khi Codex lỗi/không có | — |

- **agy** (Antigravity CLI) CHỈ dùng cho research, KHÔNG dùng review. Model: `claude-opus-4-6-thinking`; hết lượt dùng ⇒
  `gemini-3.1-pro-high`.
- Ưu tiên provider khác cho vai **đánh giá** (review, research, ý kiến debug thứ hai): người viết ≠ người chấm.
- Viết code giữ Sonnet — A/B 2026-09-29, 39 lượt việc thật, 2 giám khảo chấm mù: Sonnet xhigh 46,0/50 cao nhất ở
  DB+khoá và bảo mật (~$0,8/việc); Sonnet high 45,1 rẻ nhất ($0,39). Sonnet low/medium tụt mạnh ở việc khó. Codex
  viết code chưa đo — muốn dùng thì A/B trước; khi Codex viết thì Claude review.
- Model ghim id đầy đủ trong frontmatter agent, không alias. Không truyền `model` khi gọi Agent, trừ bậc leo Opus.

Captain tự làm: tìm kiếm "X ở đâu" bằng MỘT lệnh `rg` nhiều path + nhiều `-e` (worker tìm kiếm tốn 30–45K token và
sót dòng — đo 2026-09-28) · phỏng vấn · viết plan · UI · việc dưới ~5 phút hoặc 1–2 file · việc dự án khai captain-only.

## Chạy song song

- Plan chia **wave**: wave 0 = contract/type dùng chung, gộp trước; wave sau = làn song song, mỗi làn một bộ file
  KHÔNG giao nhau. File nóng (lockfile, migration, root config, i18n chung, registry) thuộc đúng một làn.
- Mỗi làn một worker `isolation: "worktree"`, chạy nền, tối đa 3–4 worker viết code; captain làm UI cùng lúc.
- Worktree chỉ cô lập file: mỗi worktree **port riêng**, không chạy migration đồng thời lên cùng DB local.
- Việc đánh giá độc lập (research, review plan, nhiều debugger cho nhiều lỗi, 2 lượt Codex) gửi trong MỘT message.
- Giao xong không ngó chừng (không sleep/poll/đọc log) — hệ thống tự báo khi xong.

## Brief & receipt

Brief tự đủ (worker không đọc được hội thoại), < 800 ký tự, chỉ phần riêng của việc (quy ước chung nằm sẵn trong
body agent). Spec dài ⇒ ghi file rồi trỏ đường dẫn.

```
outcome=<một kết quả kiểm được>
scope=<path được sửa; còn lại chỉ đọc>
constraints=<điều cấm quan trọng>
accept=<lệnh chính xác, xanh = xong>
```

Receipt: `return=done|done_with_concerns|needs_context|blocked; paths=…; checks=<output accept có số thật>; blocker=…; stop`
(`test-runner`: `return=green|red|blocked`). Claim không có `path:line`/URL ⇒ vứt; khẳng định phủ định cũng cần bằng
chứng. Kết quả về captain ≤ ~1.500 token; dài hơn ⇒ worker ghi file, trả path. Hỏi tiếp cùng chủ đề ⇒ SendMessage
worker cũ (giữ ngữ cảnh, rẻ hơn spawn mới).

## Thang leo

`coder-lite` → `coder` → `coder` + `model: "opus"` → captain. Leo khi `blocked` hoặc sai hai lần. Cùng model không thử
lại quá một lần; brief mơ hồ thì sửa brief.

## Nhật ký

Dự án có `.claude/worker-log.md` ⇒ mỗi lần giao, sau khi kiểm xong, thêm một dòng: ngày · worker/model/effort · việc
≤8 chữ · `ok`/`ok-noisy`/`fabricated`/`blocked`/`wrong` · một mệnh đề bằng chứng. Quá 25 dòng từ lần tổng kết trước ⇒
tổng kết theo số đếm, đề xuất nâng/hạ/bỏ worker.

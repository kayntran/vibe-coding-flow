# Flow v2 — vibe coding chuyên nghiệp, đa provider

Bản đề xuất 2026-10-01. Tổng hợp từ 4 lượt research (Anthropic Claude Code docs, GitHub spec-kit,
Kiro, obra/superpowers, Playwright docs, arXiv 2607.21656, Fowler…) + kiểm thực tế trên máy này.
Chưa áp dụng — chờ user chốt các câu hỏi cuối file.

## 0. Nguyên tắc

1. **Phân cỡ trước, quy trình sau.** Diff tả được bằng một câu ⇒ bỏ spec/plan (Anthropic best-practices).
   Quy trình nặng cho việc nhỏ là lỗi phổ biến nhất (Fowler: Kiro sinh 16 acceptance criteria cho một bug nhỏ).
2. **Người viết ≠ người review.** Plan do Claude viết ⇒ provider khác review. Code do Claude viết ⇒ Codex review,
   rồi Claude (captain) kiểm lại từng finding bằng test đỏ. Lý do kiểm lại: paper 2607.21656 đo Codex review
   code Claude làm tụt pass rate 91,4% → 82,8% nếu sửa mù theo finding.
3. **Bằng chứng thay lời khẳng định.** Mọi cổng qua bằng output lệnh, screenshot, file — không bằng "đã xong".
4. **Máy ép, không nhờ trí nhớ.** Cổng quan trọng là hook chặn cứng; luật chữ chỉ giữ phần cần phán đoán.

## 1. Phân cỡ

| Cỡ | Dấu hiệu | Pha chạy |
|---|---|---|
| S | 1–2 file, tả bằng một câu, không đổi schema/API | 4 → 5 → 6 (nếu đụng UI) → 8 → 9 |
| M | nhiều file, một module, có quyết định nhỏ | đủ pha, plan ngắn, review plan 1 provider |
| L | tính năng mới, schema, nhiều module, bảo mật | đủ pha, research + ADR + review plan 2 provider |

Captain nói cỡ trong một dòng đầu tiên; user cãi được.

## 2. Các pha

### Pha 1 — Ý tưởng, phỏng vấn, research (song song)

- **Captain phỏng vấn** bằng AskUserQuestion: tối đa 5 câu/vòng, mỗi câu có đáp án khuyến nghị (spec-kit clarify).
- **Cùng lúc, research prior art** (cỡ M/L), chạy song song:
  - `recon` (Claude): `gh search repos "<kw>" --stars=">100" --archived=false --sort=updated`, đọc code thật,
    DeepWiki/grep.app nếu có MCP, lọc theo license (không license = không được chép) và độ bảo trì.
  - `grok` (xAI, có web search tích hợp, vai `researcher`): cách người khác giải bài tương tự, thư viện mới,
    thảo luận HN/Reddit.
  - Kết quả: `research.md` — bảng `repo | license | pushed | dùng lại gì | path:line` + 3 đường:
    dùng thư viện / học logic từ repo / tự viết, kèm khuyến nghị.
- **Artifact:** `docs/specs/<ngày>-<chủ-đề>/SPEC.md` — mục tiêu, user story, acceptance criteria dạng
  `KHI … THÌ HỆ THỐNG PHẢI …` (mỗi dòng dịch thẳng thành test), ngoài phạm vi, yêu cầu phi chức năng.
- **Cổng 1:** user duyệt SPEC.

### Pha 2 — Plan kỹ thuật (captain, plan mode)

- Kiến trúc, data model, interface/contract, chọn thư viện (dựa research.md).
- **ADR** cho mỗi quyết định khó đảo ngược: `docs/adr/NNNN-<tên>.md` = bối cảnh + quyết định + hệ quả.
  ADR đã Accepted không sửa; đổi ý = ADR mới Supersedes.
- **Tiêu chí dễ mở rộng/bảo trì** (kiểm khi viết): không abstraction cho thứ dùng một lần; tách theo trách nhiệm,
  không theo layer; contract rõ giữa module; không phụ thuộc vòng.
- **Chia làn + wave:** wave 0 = contract/type dùng chung (một người làm, merge trước); wave 1..n = các làn
  không giao file. File nóng (lockfile, migration, root config, i18n chung, registry) thuộc đúng một làn.
- Mỗi task có chu trình test riêng (task nhỏ nhất mang được test của nó).
- **Kế hoạch test:** unit / integration / e2e cần thêm + **QA charter** (kịch bản dùng thật, lấy từ acceptance criteria).
- **Artifact:** `PLAN.md` cạnh SPEC.md.

### Pha 3 — Review plan (đa provider, song song, chỉ đọc)

- Codex `gpt-6.1-sol` high: kiểm chéo SPEC ↔ PLAN, lỗ hổng logic, rủi ro mở rộng/bảo trì/bảo mật/hiệu năng.
- Grok (vai `design-doc-reviewer`, `--permission-mode plan`) — chỉ cỡ L hoặc khi Codex lỗi.
- Brief reviewer: **chỉ báo lỗi đúng đắn, thiếu yêu cầu, rủi ro** — cấm đề xuất thêm tính năng
  (reviewer bị ép tìm lỗi sẽ đẩy plan thành over-engineering).
- Captain hợp nhất finding, sửa plan, ghi finding bị bác + lý do.
- **Cổng 2:** user duyệt plan (ExitPlanMode).

### Pha 4 — Thi công song song

- Mỗi làn một worker trong worktree riêng, chạy nền, tối đa 3–4 worker viết code.
  Làn logic → `coder`, làn lặp → `coder-lite`. Captain làm UI cùng lúc.
- TDD: test đỏ trước, rồi code cho xanh.
- Worktree chỉ cô lập file: mỗi worktree một port riêng, không chạy migration đồng thời lên cùng DB local.
- Worker trả receipt 4 trạng thái: `done | done_with_concerns | needs_context | blocked`.
- Sai 2 lần ⇒ leo thang: `coder-lite` → `coder` → `coder` + Opus → captain.

### Pha 5 — Kiểm cơ học

- `test-runner`: lint, typecheck, unit, integration, build — trả CHỈ phần đỏ + phân tích lỗi
  (test nào, `path:line`, nguyên nhân khả dĩ).
- Đỏ ⇒ pha 7.

### Pha 6 — Test thực tế như người dùng (bắt buộc khi đụng UI/app)

- Worker mới `qa-tester` (Sonnet high) nhận QA charter từ PLAN: vai người dùng, trạng thái đầu, dữ liệu,
  bằng chứng cần có, điểm dừng.
- Tự chạy app rồi lái như người thật:
  - Webapp: dev server + Playwright (CLI hoặc MCP), mỗi worktree một port.
  - Wails: `wails dev` + Playwright trỏ vào dev server; app thật trên Windows: WebView2 bật
    `--remote-debugging-port` rồi `connectOverCDP`. Electron: `electron.launch`. Tauri: WebdriverIO.
- Thử: happy path, nhập sai/biên, refresh giữa chừng, mạng chậm, màn hẹp, đọc console + network.
- Báo cáo `qa-report.md`: mỗi acceptance criteria → pass/fail + screenshot; mỗi bug có bước tái hiện.
- Bug ⇒ **chuyển thành Playwright spec đỏ** rồi mới sửa (pha 7), sau đó đẩy test xuống tầng unit/integration
  nếu được (Fowler test pyramid).
- Playwright healer chỉ dùng cho test hỏng vì UI đổi; đọc diff để chắc nó không sửa assertion cho xanh.

### Pha 7 — Debug & sửa

- Đầu vào: test đỏ / log CI (`gh run view <id> --log-failed`, `gh run download`) / server log / stack trace / trace Playwright.
- Codex `gpt-6.1-sol` high (chỉ đọc) phân tích nguyên nhân gốc + đề xuất sửa; `coder` sửa theo test đỏ.
- Fallback khi không có Codex: worker `debugger` (Sonnet xhigh).
- Tối đa 2–3 vòng rồi báo user, không lặp vô hạn.

### Pha 8 — Review code (Codex, tự động)

- 2 lượt `codex exec --sandbox read-only -m gpt-6.1-sol` song song:
  (a) đúng đắn + tiêu chuẩn mã + khả năng bảo trì + hiệu năng; (b) bảo mật.
  Nhánh rủi ro cao (dữ liệu, tiền, đồng thời) ⇒ thêm lượt.
- Captain kiểm từng finding vào code, tái hiện bằng test đỏ, rồi mới giao sửa. Sửa xong ⇒ dấu review cũ mất
  hiệu lực ⇒ review lại phần thay đổi.

### Pha 9 — Gộp

- Gộp từng làn theo thứ tự phụ thuộc (contract → backend → frontend → test → docs), test giữa các lần.
- Bản tích hợp cuối: test đủ bộ + QA lại các luồng chính.
- Hỏi user (tóm tắt diff + test + QA + review) ⇒ gật ⇒ rebase, squash, `merge --ff-only`, push.
- CI đỏ sau push ⇒ quay pha 7.

## 3. Đội hình

| Vai | Ai | Provider |
|---|---|---|
| Captain (phỏng vấn, plan, UI, chấm, gộp) | Opus 5.5 | Claude |
| Research prior art | `recon` Sonnet high + `grok` | Claude + xAI |
| Review plan | Codex gpt-6.1-sol high (+ Grok cho cỡ L) | OpenAI + xAI |
| Code | `coder` Sonnet xhigh / `coder-lite` Sonnet high | Claude (giữ — đã đo A/B 2026-09-29) |
| Kiểm cơ học | `test-runner` Haiku 4.5 | Claude |
| Test thực tế | `qa-tester` Sonnet high (MỚI) | Claude |
| Debug | Codex gpt-6.1-sol high; fallback `debugger` Sonnet xhigh (MỚI) | OpenAI |
| Review code + bảo mật + hiệu năng | Codex gpt-6.1-sol high ×2 | OpenAI |
| Review dự phòng | `code-reviewer` Opus 5.5 | Claude |

Không dùng `opencode` (bản Go v0.0.55 đã archive 2025-09-18, không đọc config hiện tại, chế độ `-p`
tự duyệt mọi quyền ghi file).

Chưa đề xuất Codex viết code: chưa đo; nếu muốn, A/B như lần đo Sonnet rồi mới quyết. Khi Codex viết thì Claude review.

## 4. Hook ép flow

| Hook | Điều kiện | Hành động |
|---|---|---|
| PreToolUse `Edit\|Write` | sửa file trong thư mục chính của git repo, chưa vào worktree | chặn; lối thoát: file `.claude/allow-direct-edit` trong repo |
| PreToolUse `Bash` | `git merge`/`git push` vào nhánh chính khi thiếu dấu review (hoặc thiếu dấu QA khi diff đụng UI) | chặn, nói rõ thiếu dấu nào |
| Stop | worktree có diff chưa review/QA | chặn một lần (kiểm `stop_hook_active`), nhắc pha còn thiếu |
| SubagentStop | worker thiếu receipt | bắt worker trả receipt; tự ghi một dòng `worker-log.md` |
| PreToolUse `Agent` | truyền `model` khác bậc leo Opus | nhắc (không chặn) |

Dấu = `.claude/gates/review-<patch-id>.json`, `.claude/gates/qa-<patch-id>.md` (gitignore).
`patch-id` = `git diff main...HEAD | git patch-id --stable` — sống qua rebase/squash, mất khi sửa nội dung.
QA được phép ghi `N/A: <lý do>` cho thay đổi không đụng UI; lý do hiện trong tóm tắt gửi user.

## 5. Đóng gói (giảm ngữ cảnh)

- `WORKERS.md` + `WORKTREE.md` rút còn: bảng đội hình, phân cỡ, cách viết brief, thang leo.
- Thủ tục chi tiết thành skill nạp khi cần: `flow-spec` (pha 1–3), `flow-qa` (pha 6), `flow-review` (pha 8 + lệnh Codex),
  `flow-merge` (pha 9).
- Agent mới: `qa-tester.md`, `debugger.md`. Sửa `test-runner.md` thêm phân tích lỗi.

## 6. Việc cần làm trên máy

1. `npm i -g @openai/codex@latest` — bản npm 0.157.1 không chạy `gpt-6.1-sol` (đã thử, lỗi 400);
   bản 0.159.2 của app desktop chạy được (đã thử, trả `OK`).
2. `grok login` (user tự làm) rồi `grok models` — hiện chưa đăng nhập.
3. Mỗi dự án web: `npx playwright install` (một lần).
4. Tuỳ chọn: MCP DeepWiki (`https://mcp.deepwiki.com/mcp`) + grep.app (`https://mcp.grep.app`) cho research.

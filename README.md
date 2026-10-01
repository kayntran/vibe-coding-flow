# vibe-coding-flow

Cấu hình Claude Code để **ra lệnh bằng lời, agent tự chạy**: ý tưởng → research → spec → plan → review plan →
thi công song song → kiểm → test thực tế → debug → review code → gộp. Không cần gõ slash command: captain tự phân cỡ,
skill tự bật theo câu user nói, hook ép các cổng. Thiết kế gốc: [plans/flow-v2.md](plans/flow-v2.md).

## Thành phần

| Path | Vai trò |
|---|---|
| `CLAUDE.md` | Thứ DUY NHẤT nạp vào mọi phiên (~3,6KB): ngôn ngữ, nguyên tắc, phân cỡ, bảng định tuyến "user nói gì → làm gì" |
| `skills/flow-*` | Quy trình, chỉ nạp khi cần: `flow-spec` (ý tưởng → plan), `flow-impact` (tính năng anh em + test đối chiếu), `flow-team` (worker, brief, song song), `flow-worktree`, `flow-qa` (kiểm, test thực tế, debug), `flow-review` (Codex), `flow-merge` |
| `agents/` | Worker: `researcher` (GitHub + agy), `recon`, `coder`, `coder-lite`, `test-runner`, `qa-tester` (Playwright), `debugger` (+ Codex), `code-reviewer` |
| `hooks/flow-gate.mjs` | Chặn: sửa thẳng thư mục chính repo, gộp thiếu dấu review/QA, commit/push có secret; bắt worker trả receipt |
| `hooks/session-start.mjs` | Mở phiên / sau khi nén ngữ cảnh: tự nạp sổ `progress.md` đang dở; nhắc báo cáo MCP sau 30 ngày |
| `hooks/lane-check.mjs` | Chạy song song: `plan` kiểm bảng làn trong PLAN.md (trùng file, file nóng, phụ thuộc, chia wave) · `audit` bắt worker sửa ngoài phạm vi (cả file chưa commit) · `conflicts` dò xung đột giữa các nhánh làn |
| `hooks/wt-env.mjs` | Cấp cửa sổ 20 port riêng cho mỗi worktree (`alloc`/`release`/`list`/`prune`), có khoá chống cấp trùng |
| `hooks/grok.mjs` | Gọi Grok CLI không nạp MCP/hook/skill của Claude Code và Cursor (nguyên nhân treo) |
| `hooks/review-ext.mjs` | Gọi Grok 4.7 / Gemini 3.8 Flash review chỉ-đọc, ra JSON đúng schema (tắt cấu hình Claude/Cursor mà Grok tự nạp) |
| `hooks/strix-scan.mjs` | Bọc Strix (pentest bằng AI): chỉ cho quét thư mục trên máy hoặc app ở localhost, tắt telemetry |
| `hooks/mcp-usage.mjs` | Ghi mỗi lần gọi MCP vào `~/.claude/logs/mcp-usage.jsonl`; `report` liệt kê MCP không dùng để tắt bớt |
| `workers/` | Brief + JSON schema cho review (chất lượng, bảo mật) — dùng chung cho Codex, Grok, Gemini |
| `WORKERS.md`, `WORKTREE.md` | Chỉ còn trỏ đường sang skill (dự án cũ còn nhắc tới) |

Model ngoài Claude: Codex `gpt-6.1-sol` (review nhạy cảm, ý kiến debug) · Grok `grok-4.7` high (review thường + lượt
thứ hai; gọi qua `hooks/review-ext.mjs`) · agy: `gemini-3.8-flash-high` (lượt review dự phòng/thứ ba),
`claude-opus-4-6-thinking` → `gemini-3.1-pro-high` cho research. Bài thử chọn model: `skills/flow-review/SKILL.md` §1.

## Cài trên máy mới

Cần: Claude Code, Node, git, `gh`; Codex CLI ≥ 0.159 (`npm i -g @openai/codex@latest`); Grok CLI mới
(`grok update`, `grok login`); agy (Antigravity CLI). Thiếu Grok/agy thì researcher vẫn tự tìm bằng GitHub/web.

```bash
cd ~/.claude
git init -b main
git remote add origin https://github.com/kayntran/vibe-coding-flow.git
git fetch origin
git show origin/main:install.mjs > /tmp/kit-install.mjs && node /tmp/kit-install.mjs backup   # sao lưu file trùng tên
git checkout -f -t origin/main                       # ghi đè các file cùng tên (đã sao lưu), không đụng file khác
node ~/.claude/install.mjs                           # ghép 9 hook vào settings.json của máy này
node --test ~/.claude/hooks/*.test.mjs ~/.claude/hooks/lib/*.test.mjs
```

Sau khi cài: so các file `*.before-kit-*` với bản kit, chép phần riêng của máy (nếu có) trở lại, rồi xoá bản sao lưu.
Cập nhật kit về sau: `git -C ~/.claude pull` — git gộp thay đổi, trùng dòng thì báo conflict chứ không ghi đè im lặng.
Luật riêng từng dự án nằm trong repo dự án (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/`), kit không bao giờ đụng tới.

Báo cáo MCP bất cứ lúc nào: `node ~/.claude/hooks/mcp-usage.mjs report` (mặc định 30 ngày gần nhất).

Repo muốn sửa thẳng trên nhánh chính (không worktree) ⇒ tạo `.claude/allow-direct-edit` trong repo đó.

## Hạn chế đã biết của hook

Hook chặn việc **quên** flow, không chặn việc cố tình lách. Các dạng lệnh sau lọt cổng gộp: `bash -c "git merge x"`,
heredoc nằm trong chuỗi có nháy, `git -C"<path>"` viết liền, tên nhánh có escape ngoài nháy (`f\eat`),
`cd <sai> || git merge x`. Ghi file bằng Bash (`echo > file`) không qua cổng Edit/Write. Quét secret không thấy phần
sắp `git add` trong cùng lệnh với `git commit`, không quét file untracked, và push bỏ qua commit merge (`--no-merges`).

`.gitignore` là allowlist: credentials, transcript (`projects/`), `settings.json`, `logs/` không bao giờ lên repo.
Repo này tự cho phép sửa thẳng (`.claude/allow-direct-edit`) vì cấu hình chỉ có hiệu lực tại `~/.claude`.

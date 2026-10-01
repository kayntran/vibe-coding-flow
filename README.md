# vibe-coding-flow

Cấu hình Claude Code để **ra lệnh bằng lời, agent tự chạy**: ý tưởng → research → spec → plan → review plan →
thi công song song → kiểm → test thực tế → debug → review code → gộp. Không cần gõ slash command: captain tự phân cỡ,
skill tự bật theo câu user nói, hook ép các cổng. Thiết kế gốc: [plans/flow-v2.md](plans/flow-v2.md).

## Thành phần

| Path | Vai trò |
|---|---|
| `CLAUDE.md` | Thứ DUY NHẤT nạp vào mọi phiên (~3,6KB): ngôn ngữ, nguyên tắc, phân cỡ, bảng định tuyến "user nói gì → làm gì" |
| `skills/flow-*` | Quy trình, chỉ nạp khi cần: `flow-spec` (ý tưởng → plan), `flow-team` (worker, brief, song song), `flow-worktree`, `flow-qa` (kiểm, test thực tế, debug), `flow-review` (Codex), `flow-merge` |
| `agents/` | Worker: `researcher` (GitHub + Grok 4.7 + agy), `recon`, `coder`, `coder-lite`, `test-runner`, `qa-tester` (Playwright), `debugger` (+ Codex), `code-reviewer` |
| `hooks/flow-gate.mjs` | Chặn: sửa thẳng thư mục chính repo, gộp thiếu dấu review/QA, commit/push có secret; bắt worker trả receipt |
| `hooks/session-start.mjs` | Mở phiên / sau khi nén ngữ cảnh: tự nạp sổ `progress.md` đang dở; nhắc báo cáo MCP sau 30 ngày |
| `hooks/mcp-usage.mjs` | Ghi mỗi lần gọi MCP vào `~/.claude/logs/mcp-usage.jsonl`; `report` liệt kê MCP không dùng để tắt bớt |
| `workers/` | Brief + JSON schema cho review Codex (chất lượng, bảo mật) |
| `WORKERS.md`, `WORKTREE.md` | Chỉ còn trỏ đường sang skill (dự án cũ còn nhắc tới) |

Model ngoài Claude: Codex `gpt-6.1-sol` (review, ý kiến debug) · Grok `grok-4.7` (research, review plan cỡ L) ·
agy `claude-opus-4-6-thinking` → `gemini-3.1-pro-high` khi hết lượt (CHỈ research, thêm góc nhìn).

## Cài trên máy mới

Cần: Claude Code, Node, git, `gh`; Codex CLI ≥ 0.159 (`npm i -g @openai/codex@latest`); Grok CLI mới
(`grok update`, `grok login`); agy (Antigravity CLI). Thiếu Grok/agy thì researcher vẫn tự tìm bằng GitHub/web.

```bash
cd ~/.claude
git init -b main
git remote add origin https://github.com/kayntran/vibe-coding-flow.git
git fetch origin && git checkout -f -t origin/main   # ghi đè các file cùng tên, không đụng file khác
node ~/.claude/install.mjs                           # ghép 7 hook vào settings.json của máy này
node --test ~/.claude/hooks/*.test.mjs
```

Báo cáo MCP bất cứ lúc nào: `node ~/.claude/hooks/mcp-usage.mjs report` (mặc định 30 ngày gần nhất).

Repo muốn sửa thẳng trên nhánh chính (không worktree) ⇒ tạo `.claude/allow-direct-edit` trong repo đó.

## Hạn chế đã biết của hook

Hook chặn việc **quên** flow, không chặn việc cố tình lách. Các dạng lệnh sau lọt cổng gộp: `bash -c "git merge x"`,
heredoc nằm trong chuỗi có nháy, `git -C"<path>"` viết liền, tên nhánh có escape ngoài nháy (`f\eat`),
`cd <sai> || git merge x`. Ghi file bằng Bash (`echo > file`) không qua cổng Edit/Write. Quét secret không thấy phần
sắp `git add` trong cùng lệnh với `git commit`, không quét file untracked, và push bỏ qua commit merge (`--no-merges`).

`.gitignore` là allowlist: credentials, transcript (`projects/`), `settings.json`, `logs/` không bao giờ lên repo.
Repo này tự cho phép sửa thẳng (`.claude/allow-direct-edit`) vì cấu hình chỉ có hiệu lực tại `~/.claude`.

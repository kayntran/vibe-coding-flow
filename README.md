# vibe-coding-flow

Cấu hình Claude Code cho flow captain + worker đa provider: ý tưởng → research → spec → plan → review plan →
thi công song song → kiểm → test thực tế → debug → review code → gộp. Thiết kế: [plans/flow-v2.md](plans/flow-v2.md).

## Thành phần

| Path | Vai trò |
|---|---|
| `CLAUDE.md`, `WORKERS.md`, `WORKTREE.md` | Luật nạp vào mọi phiên: phân cỡ, đội hình, brief, worktree |
| `agents/` | Worker: `researcher`, `recon`, `coder`, `coder-lite`, `test-runner`, `qa-tester`, `debugger`, `code-reviewer` |
| `skills/flow-*` | Thủ tục từng pha, nạp khi cần: `flow-spec`, `flow-qa`, `flow-review`, `flow-merge` |
| `hooks/flow-gate.mjs` | Ép flow: sửa file phải ở worktree, gộp phải có dấu review + QA, worker phải trả receipt |
| `workers/` | Brief + JSON schema cho review Codex |

## Cài trên máy mới

Cần: Claude Code, Node, git, `gh`; Codex CLI ≥ 0.159 (`npm i -g @openai/codex@latest`, model `gpt-6.1-sol`);
Grok CLI đã `grok login` (model `grok-4.7`) — thiếu Grok thì researcher tự tìm bằng nguồn khác.

```bash
cd ~/.claude
git init -b main
git remote add origin https://github.com/kayntran/vibe-coding-flow.git
git fetch origin && git checkout -f -t origin/main   # ghi đè các file cùng tên, không đụng file khác
node ~/.claude/install.mjs                           # ghép hook vào settings.json của máy này
node --test ~/.claude/hooks/flow-gate.test.mjs
```

## Hạn chế đã biết của hook

Hook chặn việc **quên** flow, không chặn việc cố tình lách. Các dạng lệnh sau lọt cổng gộp: `bash -c "git merge x"`,
heredoc nằm trong chuỗi có nháy, `git -C"<path>"` viết liền, tên nhánh có escape ngoài nháy (`f\eat`),
`cd <sai> || git merge x`. Ghi file bằng Bash (`echo > file`) không qua cổng Edit/Write.

`.gitignore` là allowlist: credentials, transcript (`projects/`), `settings.json` không bao giờ lên repo.
Repo này tự cho phép sửa thẳng (`.claude/allow-direct-edit`) vì cấu hình chỉ có hiệu lực tại `~/.claude`.

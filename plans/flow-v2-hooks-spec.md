# Spec: ~/.claude/hooks/flow-gate.mjs

Node ESM, không dependency, chạy trên Windows (git bash có sẵn `git`). Một script, chọn chế độ bằng argv[2].
Hook đọc JSON từ stdin (docs: https://code.claude.com/docs/en/hooks — đọc mục input/output của
PreToolUse, Stop, SubagentStop để lấy đúng tên field).

**An toàn trước hết:** mọi lỗi nội bộ (git lỗi, JSON hỏng, field thiếu) ⇒ CHO QUA (exit 0, không in gì) và
ghi một dòng vào `~/.claude/hooks/flow-gate.log`. Hook bug không bao giờ được chặn việc của user.

## Helper chung
- `repoInfo(dir)`: dir = thư mục tồn tại gần nhất của path. `git -C dir rev-parse --show-toplevel --git-dir --git-common-dir`
  + `--abbrev-ref HEAD`. Không phải repo ⇒ null. `linked = resolve(gitDir) !== resolve(commonDir)`.
- `mainBranch`: `main` nếu `refs/heads/main` tồn tại, không thì `master`.
- `gatesDir = <commonDir tuyệt đối>/flow-gates/` (dùng chung mọi worktree, không bị git theo dõi).
- `patchId(dir, base, head)`: `git diff base...head` | `git patch-id --stable` ⇒ token đầu; diff rỗng ⇒ null.
- `uiTouched(dir, base, head)`: `git diff --name-only base...head` có file khớp
  `/\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i`; repo có `.claude/flow.json` với `uiPattern`
  (chuỗi regex) thì dùng cái đó thay.

## Chế độ `edit` — PreToolUse, matcher `Edit|Write|NotebookEdit`
Path = `tool_input.file_path` hoặc `tool_input.notebook_path` (có thể là `C:\...` hoặc `C:/...`).
Cho qua nếu: không trong git repo · repo là linked worktree · `<toplevel>/.claude/allow-direct-edit` tồn tại.
Còn lại ⇒ deny:
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<lý do>"}}`
Lý do (tiếng Việt): đang sửa thẳng thư mục chính của `<toplevel>`; gọi EnterWorktree trước; muốn sửa thẳng thì
user tạo file `.claude/allow-direct-edit` trong repo.

## Chế độ `bash` — PreToolUse, matcher `Bash`
Bắt lệnh `git [-C <p>] merge ... <branch>` (không bắt `merge-base`, `merge-tree`, `merge --abort/--continue`),
kể cả khi nằm trong chuỗi `&&`/`;`. Repo = `-C <p>` hoặc `cwd` của input. Chỉ xét khi nhánh hiện tại là
mainBranch; branch đích = đối số không phải cờ cuối cùng. pid = patchId(repo, main, branch); null ⇒ cho qua.
Cần đủ:
- `gatesDir/review-<pid>.json`
- `gatesDir/qa-<pid>.md`; nếu uiTouched mà nội dung file bắt đầu bằng `N/A` ⇒ coi như thiếu.
Thiếu ⇒ deny, lý do liệt kê dấu thiếu + pid + lệnh đóng dấu (`node ~/.claude/hooks/flow-gate.mjs stamp ...`).
Lệnh khác ⇒ cho qua.

## Chế độ `stop` — Stop
`stop_hook_active` true ⇒ cho qua. Repo = `cwd`. Chỉ xét khi: linked worktree, nhánh ≠ main,
`git status --porcelain` rỗng (đã commit xong), pid(main, HEAD) không null, thiếu review hoặc qa
(cùng luật như trên), và chưa có `gatesDir/nudged-<pid>` (chỉ nhắc một lần mỗi trạng thái diff).
Khi chặn: tạo `nudged-<pid>` rồi in `{"decision":"block","reason":"<nhánh> đã commit xong nhưng thiếu: <review|qa>. Chạy skill flow-qa / flow-review trước khi báo user."}`.

## Chế độ `subagent-stop` — SubagentStop
`stop_hook_active` true ⇒ cho qua. Lấy loại agent và tin nhắn cuối từ input (đúng tên field theo docs; nếu
input không có tin nhắn cuối thì đọc dòng assistant cuối trong transcript path mà input đưa). Agent thuộc
`coder, coder-lite, recon, researcher, test-runner, qa-tester, debugger, code-reviewer` mà tin nhắn cuối không
khớp `/return=(done|done_with_concerns|needs_context|blocked)/` ⇒ `{"decision":"block","reason":"Thiếu receipt: kết thúc bằng đúng một dòng return=…; paths=…; checks=…; blocker=…; stop"}`.
Không xác định được loại agent ⇒ cho qua.

## CLI (không phải hook) — chạy trong worktree
- `stamp review <file.json>`: file phải parse được và có mảng `findings` ⇒ chép sang `gatesDir/review-<pid>.json`
  (pid = patchId(cwd, main, HEAD)). In pid.
- `stamp qa <file.md>`: file không rỗng ⇒ chép sang `gatesDir/qa-<pid>.md`. In pid; nếu uiTouched mà file
  bắt đầu `N/A` thì báo lỗi exit 1.
- `status`: in nhánh, pid, uiTouched, dấu review/qa có/không.

## Test — `~/.claude/hooks/flow-gate.test.mjs` (node:test)
Tạo repo tạm trong os.tmpdir (main + `git worktree add`), gọi script bằng spawnSync với JSON stdin. Phủ:
edit trong main bị chặn / trong worktree cho qua / có allow-direct-edit cho qua / ngoài repo cho qua;
merge thiếu dấu bị chặn / đủ dấu cho qua / qa N/A với file .tsx bị chặn / N/A với file .go cho qua /
`merge-base` cho qua; stop chặn một lần rồi cho qua lần hai / có thay đổi chưa commit thì cho qua /
stop_hook_active cho qua; subagent-stop thiếu receipt bị chặn / có receipt cho qua; JSON hỏng cho qua;
stamp đổi pid sau khi sửa thêm một dòng, giữ pid sau rebase không đổi nội dung.

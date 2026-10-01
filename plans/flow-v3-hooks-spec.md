# Spec hook flow v3 (2026-10-01)

Chung cho mọi hook: Node ESM, không dependency, Windows + git bash. Lỗi nội bộ ⇒ CHO QUA, không in gì, ghi một
dòng log (theo kiểu `flow-gate.log` hiện có). Không bao giờ in giá trị secret hay nội dung env/header ra output/log.
Docs input/output hook: https://code.claude.com/docs/en/hooks

## Làn A — quét secret trong `hooks/flow-gate.mjs` chế độ `bash`

Dùng lại tokenizer/parser hiện có (comment, heredoc, `cd … &&`, `-C <p>`).
- `git [-C p] commit …` (bỏ qua `--dry-run`): quét dòng THÊM (`+`) của `git diff --cached -U0`; có cờ `-a`/`--all`/
  `-am` thì cộng thêm `git diff -U0` (tracked chưa stage).
- `git [-C p] push …`: quét dòng thêm của `git diff -U0 <base>..HEAD`, base = `@{u}` nếu có, không thì
  `origin/<nhánh chính>` nếu có, không thì cây rỗng (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, tức toàn bộ HEAD).
- Mẫu chắc chắn (tên mẫu ↔ regex): private-key `-----BEGIN [A-Z ]*PRIVATE KEY-----` · aws `AKIA[0-9A-Z]{16}` ·
  github `gh[pousr]_[A-Za-z0-9]{36,}` và `github_pat_[A-Za-z0-9_]{60,}` · anthropic `sk-ant-[A-Za-z0-9_-]{20,}` ·
  openai `sk-(proj-)?[A-Za-z0-9_-]{32,}` · xai `xai-[A-Za-z0-9]{40,}` · google `AIza[0-9A-Za-z_-]{35}` ·
  slack `xox[baprs]-[A-Za-z0-9-]{10,}` · jwt `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` ·
  url-credential `[a-z][a-z0-9+.-]*://[^/\s:@]+:[^@\s/]{8,}@`.
- File nhạy cảm bị thêm/sửa trong phạm vi quét: `.env`, `.env.*` (trừ `.example`/`.sample`/`.template`),
  `*.pem`, `id_rsa*`, `id_ed25519*`, `.dev.vars`, `credentials.json`.
- Dòng chứa `flow-gate: allow-secret` ⇒ bỏ qua dòng đó. Bỏ qua file nhị phân; quét tối đa 5 MB diff.
- Phát hiện ⇒ deny (khuôn PreToolUse hiện có), lý do liệt kê `file:dòng — tên mẫu`, giá trị che hết
  (chỉ 4 ký tự đầu + `…`). Gợi ý: gỡ secret, dùng biến môi trường; báo nhầm thì thêm comment allow.
- Test (thêm vào `hooks/flow-gate.test.mjs`): commit có ghp_ bị chặn và lý do không chứa token đầy đủ · commit sạch
  cho qua · `-am` quét cả unstaged · push quét commit chưa push, không quét commit đã có trên upstream · repo không
  upstream quét toàn bộ · `.env` bị chặn, `.env.example` cho qua · dòng allow cho qua · url-credential bị chặn ·
  lỗi git ⇒ cho qua. Toàn bộ test cũ vẫn xanh.

## Làn B — `hooks/mcp-usage.mjs` + `hooks/session-start.mjs`

### mcp-usage.mjs
- `log` (PostToolUse, matcher `mcp__.*`): `tool_name` = `mcp__<server>__<tool>` ⇒ server = phần giữa `mcp__` đầu và
  `__` kế tiếp. Ghi nối một dòng JSONL `{ts, server, tool, cwd}` vào `~/.claude/logs/mcp-usage.jsonl` (env
  `MCP_USAGE_LOG` ghi đè; tự tạo thư mục). Không in gì, không chặn. Phải nhanh (một appendFileSync).
- `report [--days N]` (CLI, mặc định 30): đọc log trong N ngày gần nhất ⇒ mỗi server: số lần gọi, số ngày có dùng,
  lần cuối, các project (basename cwd). Danh sách MCP đã cấu hình — CHỈ đọc tên key, không đọc/in giá trị:
  `~/.claude.json` → `mcpServers` (scope user) và `projects[<path>].mcpServers` (scope local, ghi kèm path);
  `.mcp.json` ở gốc các project xuất hiện trong log. Đầu ra Markdown: bảng đang dùng (xếp theo số lần gọi) · danh
  sách đã cấu hình mà 0 lần gọi kèm lệnh gợi ý tắt (`claude mcp remove <tên> -s user|local`, CHỈ in, không chạy) ·
  ghi chú: connector claude.ai chỉ hiện khi có dùng, tắt ở cài đặt connector của claude.ai. In ra stdout và ghi
  `~/.claude/logs/mcp-report-<yyyy-mm-dd>.md`; cập nhật `~/.claude/logs/mcp-usage.state.json` `{lastReport}`.
- Test: tách tên server (kể cả `mcp__plugin_x_y__tool`, `mcp__1a59c906-…__batch`) · log ghi đúng dòng · input hỏng
  không crash · report đếm đúng, liệt kê server cấu hình 0 lần gọi, không in giá trị env/headers/token trong
  `~/.claude.json` giả (dùng HOME/USERPROFILE tạm).

### session-start.mjs (SessionStart, mọi nguồn: startup|resume|clear|compact)
Ghép `additionalContext` từ hai phần, rỗng thì không in gì:
1. **Sổ tiến độ:** cwd trong git repo ⇒ tìm `<toplevel>/docs/specs/*/progress.md`; bỏ file có dòng
   `Trạng thái: xong` (không phân biệt hoa thường); lấy tối đa 2 file sửa gần nhất, mỗi file cắt 2.000 ký tự. Tiền tố:
   `Việc đang dở trong repo này — đọc rồi làm tiếp từ "Bước tiếp theo", không hỏi lại user những gì đã chốt:`.
2. **Nhắc báo cáo MCP:** mốc = max(ts dòng đầu của mcp-usage.jsonl, lastReport trong state). Từ mốc ≥ 30 ngày ⇒
   thêm: `Đã đủ 30 ngày log MCP: chạy node ~/.claude/hooks/mcp-usage.mjs report, đưa user danh sách MCP không dùng để
   quyết tắt (không tự tắt).` Không có log ⇒ bỏ qua.
Output: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. Chạy < 300 ms.
- Test: có progress đang dở ⇒ có context · `Trạng thái: xong` ⇒ không · ngoài git repo ⇒ không in · log 31 ngày ⇒ có
  nhắc, 5 ngày ⇒ không, đã report 3 ngày trước ⇒ không · lỗi ⇒ không in, exit 0.

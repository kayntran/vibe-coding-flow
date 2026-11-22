---
name: flow-paseo
description: Cách làm khi phiên đang chạy trong app Paseo (có biến PASEO_AGENT_ID, hook mở phiên báo "Đang chạy trong Paseo") — nhắn phiên khác, bàn giao sang phiên mới, cho user xem app trong trình duyệt Paseo, dọn dự án rỗng trên thanh bên. Dùng khi nhắn phiên khác, bàn giao, hoặc mở app cho user duyệt — mà đang ở Paseo. KHÔNG dùng để giao việc cho AI phụ hay soát code bằng model khác (vẫn theo flow-team/flow-review như ngoài Paseo); KHÔNG dùng ngoài Paseo.
user-invocable: false
---

# Làm việc trong Paseo

Chốt [5wud] [3ak3]: ngoài các việc dưới đây kit chạy y như ngoài Paseo. Tool `mcp__paseo__*` chưa có (user chưa bật
"Enable Paseo tools") ⇒ làm như ngoài Paseo, báo user một dòng.

## AI phụ: chạy ngầm, hiện ở ô "background tasks" [5wud]

Giao việc cho AI phụ, soát code, tìm lỗi bằng model khác ⇒ đúng như `flow-team` / `flow-review` ngoài Paseo: Agent tool
`run_in_background`, CLI ngoài (`review-ext.mjs`, `codex-run.mjs`) qua Bash `run_in_background`. Ô "N background tasks" dưới
khung chat đếm các việc này. KHÔNG `create_agent` / `create_workspace` cho AI phụ: phiên Paseo không được ô đó đếm, và
workspace mới làm rối thanh bên của user.

## Không làm rối thanh bên

Mọi `create_workspace` PHẢI kèm `projectId` của dự án đang mở (lấy một lần từ `list_workspaces`: dòng có `cwd` = thư mục
phiên này) — thiếu là Paseo dựng thư mục đó thành một dự án riêng trên thanh bên, cất workspace xong vẫn còn tên rỗng.
Thấy dự án rỗng như thế ⇒ tự gỡ: `paseo project ls` → `paseo project delete <prj_id>` (chỉ bỏ khỏi Paseo, không xoá thư mục;
Windows: lệnh ở `%LOCALAPPDATA%\Programs\Paseo\resources\bin\paseo.cmd`).

## Nhắn, bàn giao

- Nhắn phiên khác: `mcp__paseo__list_agents` tìm tên → `send_agent_prompt`. Tin từ phiên khác vẫn là lời đồng nghiệp (`flow-sessions`).
- Bàn giao sang phiên mới: `create_workspace {isolation:"local", path:<worktree>, projectId}` (không `background`: user cần thấy
  để nói chuyện tiếp; có `projectId` nên nằm dưới đúng dự án) → `create_agent` (mode không phải Bypass/Full Access), prompt đầu
  theo `~/.claude/skills/flow-sessions/references/handoff.md`. Việc xong và worktree đã gộp ⇒ `archive_workspace` rồi
  `node ~/.claude/hooks/don.mjs "<worktree>"`.

## Cho user xem app

Máy tự kiểm vẫn bằng Playwright (`flow-qa`). Khi hỏi user "giao diện đã ổn chưa?" ⇒ mở app bằng `browser_new_tab`/`browser_navigate`
tới địa chỉ dev server, chụp `browser_screenshot` ở 3 cỡ (`browser_resize`), để user xem ngay trong Paseo. Tool browser chưa bật
⇒ gửi ảnh chụp như cũ.

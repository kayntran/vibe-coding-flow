---
name: flow-paseo
description: Cách làm khi phiên đang chạy trong app Paseo (có biến PASEO_AGENT_ID, hook mở phiên báo "Đang chạy trong Paseo") — AI phụ chạy thành phiên Paseo, nhắn/chờ/bàn giao bằng tool Paseo, thư mục làm việc hiện trên thanh bên, cho user xem app trong trình duyệt Paseo. Dùng khi sắp giao việc cho AI phụ, soát code bằng model khác, nhắn phiên khác, bàn giao, hoặc mở app cho user duyệt — mà đang ở Paseo. KHÔNG dùng ngoài Paseo (giữ Agent tool, review-ext, codex-run như cũ).
user-invocable: false
---

# Làm việc trong Paseo

Chốt [r7eq] [3ak3]: trong Paseo dùng đồ của Paseo; ngoài Paseo kit chạy như cũ. Mỗi việc một bên chịu trách nhiệm: kit tạo
thư mục làm việc, chọn vai, lọc khoá, chấm kết quả; Paseo chạy phiên, hiện ra, báo khi xong. Tool `mcp__paseo__*` chưa có
(user chưa bật "Enable Paseo tools") ⇒ làm như ngoài Paseo, báo user một dòng.

**Codex trên Windows không chạy thành phiên Paseo** [8338]: phiên Codex trong Paseo dùng sandbox "elevated" trong config Codex của user,
chưa duyệt UAC thì mọi lệnh đọc file lỗi 1223, và user chọn giữ config. ⇒ Mọi lượt Codex (soát, tìm lỗi, soát plan) trên Windows chạy
ngầm qua `review-ext.mjs --model codex` / `codex-run.mjs` như ngoài Paseo (tự dùng sandbox không nâng quyền, tự đổi tài khoản).
`pick` báo việc này bằng `viaPaseo: false`.

## Giao việc cho AI phụ (thay Agent tool)

1. Vai và model: `node ~/.claude/hooks/paseo.mjs pick <vai> [--host claude|codex]` ⇒ JSON. `viaPaseo: false` ⇒ làm như ngoài Paseo.
   `provider` đã đủ (Codex: đúng tài khoản còn lượt); Claude có `modelLine` ⇒ `mcp__paseo__list_models claude` một lần trong phiên, lấy id đầu tiên bắt đầu `claude-<dòng>-`
   (không lấy bản `[1m]`) ⇒ `claude/<id>`.
2. Thư mục: việc ghi code ⇒ kit tạo worktree như cũ (`git worktree add` + `wt-env.mjs alloc`), rồi
   `mcp__paseo__create_workspace {isolation:"local", path:<worktree>, background:true}` để nó hiện trên thanh bên. Việc chỉ đọc
   ⇒ dùng workspace hiện tại (bỏ `workspaceId`).
3. `mcp__paseo__create_agent {title, provider, workspaceId?, settings:{modeId, thinkingOptionId}, initialPrompt}`.
   `initialPrompt` = thân `agentFile` (bỏ frontmatter) + brief như skill `flow-team` (lane, scope, PORT_BASE, receipt). Không dùng
   mode Bypass/Full Access.
4. Giao xong kết thúc lượt, không poll: Paseo báo khi phiên xong, lỗi hoặc xin quyền. Xin quyền ⇒ xét như lệnh của chính mình
   (luật hook kit), hợp lệ thì `respond_to_permission` allow, không thì deny kèm lý do. Đọc kết quả bằng `get_agent_activity`.
   Phiên Codex báo lỗi hết lượt ("usage limit") ⇒ `node ~/.claude/hooks/paseo.mjs het-luot <provider> "<chữ lỗi>"` (ghi sổ tới giờ
   mở lại, in provider kế), báo user đúng dòng nó in, rồi `create_agent` lại với provider đó, cùng prompt. Hết cả ⇒ model dự phòng.
5. Xong việc: `archive_agent`; workspace của worktree đã gộp ⇒ `archive_workspace` rồi `node ~/.claude/hooks/don.mjs "<worktree>"`.

Song song: nhiều `create_agent` trong MỘT message, giới hạn làn như `flow-team`.

## Soát code bằng model khác (thay review-ext gọi CLI)

Chỉ khi `pick` ra `viaPaseo: true` (macOS/Linux); Windows xem đầu skill. Các bước (`review-ext.mjs --prepare` → phiên Codex →
`--collect`), cả tìm lỗi bằng Codex ⇒ `references/soat-code-model-khac.md`.

## Nhắn, bàn giao

- Nhắn phiên khác: `mcp__paseo__list_agents` tìm tên → `send_agent_prompt`. Tin từ phiên khác vẫn là lời đồng nghiệp (`flow-sessions`).
- Bàn giao sang phiên mới: `create_workspace` (path = worktree) → `create_agent`, prompt đầu theo
  `~/.claude/skills/flow-sessions/references/handoff.md`.

## Cho user xem app

Máy tự kiểm vẫn bằng Playwright (`flow-qa`). Khi hỏi user "giao diện đã ổn chưa?" ⇒ mở app bằng `browser_new_tab`/`browser_navigate`
tới địa chỉ dev server, chụp `browser_screenshot` ở 3 cỡ (`browser_resize`), để user xem ngay trong Paseo. Tool browser chưa bật
⇒ gửi ảnh chụp như cũ.

## Đọc khi cần

- `references/soat-code-model-khac.md` — đọc khi cần soát code hoặc tìm lỗi bằng phiên Codex/model khác và `pick` ra `viaPaseo: true`

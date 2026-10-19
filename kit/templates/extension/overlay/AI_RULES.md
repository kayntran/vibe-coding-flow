# AI_RULES — extension {{APP_NAME}}

Luật cho AI sửa extension này. Người dùng không viết code: giữ giao diện ít chữ, mỗi màn một việc chính (CLAUDE.md của người dùng).

## Nền tảng — đã ghim, KHÔNG đổi, KHÔNG thêm framework khác
- WXT {{V_WXT}} + React + TypeScript, Manifest V3 (Chrome). Mã nằm trong `src/` (`srcDir`).
- Kiểm thử: Playwright nạp extension đã build vào Chromium thật + axe (`{{PM_RUN}} test:e2e` build rồi chạy). Gói quản lý: {{PM}}.
- Thêm thư viện mới ⇒ hỏi người dùng trước; qua cổng thư viện của kit (`node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>`).

## Quyền — quy tắc an toàn quan trọng nhất
- Hiện chưa xin quyền nào (test e2e chặn quyền ngoài ý muốn). Không `host_permissions` rộng, không `<all_urls>`, không `*://*/*`, không `tabs`, `webRequest`, `cookies`, `history` nếu chưa được người dùng đồng ý và chưa ghi lý do ngay dưới đây.
- Cần thêm quyền ⇒ ưu tiên `optional_permissions` / `optional_host_permissions` (xin lúc dùng, không xin lúc cài), liệt kê đúng tên miền cần.
- KHÔNG thêm content script chạy trên mọi trang. Cần chạy trên một trang ⇒ ghi đúng tên miền, hoặc chèn bằng `activeTab` + `scripting` khi người dùng bấm.
- CSP của trang extension đã đặt trong `wxt.config.ts` (`script-src 'self'`): không tải mã từ web ngoài, không `eval`.
- Quyền đã được duyệt thêm (ghi ở đây, kèm lý do): (chưa có)

## Cấu trúc (docs/arch.json là luật máy đọc)
- `src/entrypoints/*` (popup, background, content) là các môi trường chạy riêng, chỉ nói chuyện qua message; logic đặt trong `src/features/<tên>/{ui,model,api}`, dùng chung ở `src/shared`. Tính năng không import tính năng khác.
- Màn popup `src/features/home` (S-01) chỉ là chỗ giữ chỗ, không có dữ liệu mẫu: làm màn thật thì thay nó, không dựng thêm bên cạnh.
- Gọi `browser.*` chỉ trong `api` của tính năng. Thêm tính năng ⇒ thêm module vào `docs/arch.json` + một dòng Codemap trong `docs/ARCHITECTURE.md`, rồi `node ~/.claude/hooks/arch.mjs sync`.

## Giao diện
- Mỗi màn đúng MỘT nút chính (`data-primary`); nhãn 1–3 chữ, động từ ("Lưu", "Thêm từ"); không "OK/Có/Không/Xác nhận". Icon luôn kèm nhãn chữ (trừ nhà · in · tìm kiếm · đóng (X)).
- Việc không quay lại được (xoá, tiền, quyền): nút nêu rõ; việc hoàn tác được: nút Hoàn tác, không hộp xác nhận.
- Mỗi trạng thái màn trong SPEC có mã `S-nn`: gắn `data-s="S-nn"` vào phần tử gốc của trạng thái và ghi mã trong tên test e2e (`e2e/`).
- Kiểm: `node ~/.claude/hooks/ui-check.mjs` (đọc `.claude/ui.json`, mở popup ở http://localhost:{{PORT}}/src/entrypoints/popup/index.html).

## Bí mật
- Mọi thứ trong extension đọc được (người dùng mở file ra xem là thấy): KHÔNG nhét khoá bí mật vào mã. Cần khoá ⇒ gọi qua máy chủ của người dùng. Người dùng tự dán khoá, AI không nhập hộ.

## Lệnh
- Xem thử popup: `{{PM_DEV}}` rồi mở http://localhost:{{PORT}}/src/entrypoints/popup/index.html · Thử thật: `{{PM_RUN}} build`, mở `chrome://extensions` → bật Chế độ nhà phát triển → Tải tiện ích đã giải nén → chọn thư mục `dist`.
- Test: `{{PM_RUN}} test:e2e` · Kiểm tổng: `node ~/.claude/hooks/flow-check.mjs --dir .`
- Cổng chạy thử đọc từ biến `PORT` (mặc định {{PORT}}): chạy nhiều bản song song thì mỗi bản một `PORT`. Bản build nằm ở `dist/` (bản chạy thử ở `dist/.-dev`).
- Máy kiểm đã cấu hình sẵn (`eslint.config.js`, `knip.jsonc`, `.size-limit.json`, `osv-scanner.toml`): sửa code cho đạt, đừng nới cấu hình để lách; cần nới thì hỏi người dùng.

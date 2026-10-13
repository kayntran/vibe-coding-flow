# AI_RULES — app máy tính {{APP_NAME}}

Luật cho AI sửa app này. Người dùng không viết code: giữ giao diện ít chữ, mỗi màn một việc chính (CLAUDE.md của người dùng).

## Nền tảng — đã ghim, KHÔNG đổi, KHÔNG thêm framework khác
- Wails v2 (bản ổn định; v3 còn beta nên KHÔNG dùng). Phần lõi viết bằng Go, giao diện React + TypeScript + Vite (mẫu `react-ts` của Wails).
- Giao diện dùng CSS thường đặt cạnh tính năng (`ui/*.css`); mẫu Wails không cài sẵn Tailwind/shadcn nên KHÔNG thêm.
- Kiểm thử: Go `go test ./internal/...`; giao diện Playwright + axe (`cd frontend && {{PM_RUN}} test:e2e`). Gói quản lý của frontend: {{PM}}.
- Thêm thư viện (Go hoặc npm) ⇒ hỏi người dùng trước; qua cổng thư viện của kit (`node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>` / `go:<module>`).

## Go ↔ giao diện — quy tắc an toàn quan trọng nhất
- Mọi hàm viết hoa đầu trên struct được đưa vào `Bind` (ở `main.go`) đều gọi được từ JavaScript, kể cả mã bị chèn vào giao diện.
- Struct đưa ra giao diện PHẢI đặt tên kết thúc bằng `App`, `Service` hoặc `Bindings` (hiện là `App` trong `app.go`): luật `ai-wails-binding-exec-write` của kit dựa vào đuôi tên để thấy chúng. Struct không đuôi đó ⇒ luật không thấy ⇒ không được đưa vào `Bind`.
- Hàm bind chỉ gọi lớp `transport` của miền (`internal/<miền>/transport`) và nhận tham số hẹp (mã, số). KHÔNG nhận đường dẫn file hay lệnh từ giao diện; KHÔNG `os.WriteFile`/`exec.Command` ngay trong hàm bind.
- Việc đụng file/lệnh đặt trong hàm viết thường hoặc package nội bộ, tự quyết đường dẫn; kiểm mọi đầu vào từ giao diện ở Go (id, độ dài, khoảng giá trị).

## Cấu trúc (docs/arch.json là luật máy đọc)
- Go: mỗi miền một thư mục `internal/<miền>/{domain,service,store,transport}`. domain không import lớp khác; chỉ store chạm database; chỉ transport biết dạng dữ liệu đưa ra giao diện. App mới tạo CHƯA có miền nào (`internal/` chưa tồn tại): thêm miền đầu tiên = tạo thư mục + thêm module vào `docs/arch.json` + `node ~/.claude/hooks/arch.mjs gen` (sinh `.go-arch-lint.yml`).
- Màn đầu `frontend/src/features/home` (S-01) chỉ là chỗ giữ chỗ, không có dữ liệu mẫu: làm màn thật thì thay nó, không dựng thêm bên cạnh.
- Frontend: `frontend/src/features/<tên>/{ui,model,api}`; tính năng không import tính năng khác; dùng chung ở `frontend/src/shared`. Gọi Go chỉ trong `api` (`window.go.main.App.<Hàm>`), ngoài Wails (trình duyệt) dùng dữ liệu mẫu.
- Thêm miền/tính năng ⇒ thêm module vào `docs/arch.json` + một dòng Codemap trong `docs/ARCHITECTURE.md`, rồi `node ~/.claude/hooks/arch.mjs sync`.

## Giao diện
- Mỗi màn đúng MỘT nút chính (`data-primary`); nhãn 1–3 chữ, động từ ("Lưu", "Thêm từ"); không "OK/Có/Không/Xác nhận". Icon luôn kèm nhãn chữ (trừ nhà · in · tìm kiếm).
- Việc không quay lại được (xoá, tiền, quyền): nút nêu rõ ("Xoá từ"); việc hoàn tác được: nút Hoàn tác, không hộp xác nhận.
- Mỗi trạng thái màn trong SPEC có mã `S-nn`: gắn `data-s="S-nn"` vào phần tử gốc của trạng thái và ghi mã trong tên test e2e (`frontend/e2e`).
- Kiểm: `node ~/.claude/hooks/ui-check.mjs --dir frontend` (đọc `frontend/.claude/ui.json`; Playwright cài trong `frontend`).

## Bí mật
- Khoá bí mật chỉ ở biến môi trường của máy / file `.env` không đưa lên git; KHÔNG nằm trong mã giao diện (mọi thứ trong giao diện đọc được). Người dùng tự dán khoá, AI không nhập hộ.
- Không tải mã từ web ngoài vào giao diện (`<script src="https://…">`); đóng gói mọi thứ cùng app.

## Lệnh
- Chạy thử: `wails dev` (cửa sổ app; cũng mở được ở http://localhost:34115) · Chỉ giao diện: `cd frontend && {{PM_DEV}}` · Test Go: `go test ./internal/...` · Đóng gói: `wails build` (chỉ khi người dùng bảo).
- Cổng của giao diện (khi chạy riêng) đọc từ biến `PORT` (mặc định {{PORT}}): chạy nhiều bản song song thì mỗi bản một `PORT`.
- Máy kiểm của giao diện đã cấu hình sẵn (`frontend/eslint.config.js`, `frontend/knip.jsonc`, `frontend/.size-limit.json`): sửa code cho đạt, đừng nới cấu hình để lách; cần nới thì hỏi người dùng.
- Kiểm tổng: `node ~/.claude/hooks/flow-check.mjs --dir .`

# Công thức phát hành: Cloudflare Pages

Pages KHÔNG có lệnh quay lại và `release cf` không dùng cho nền này. App mới nên chọn Workers (có bản 0%, thử nhanh,
quay lại một lệnh) — chỉ dùng Pages khi app đã ở đó. Preflight vẫn phải chạy trước: `release.mjs preflight …` (SKILL bước 2).

## Phát hành (chưa chạy thật với Pages)
Thứ tự: bản xem trước → thử nhanh → đạt mới lên production. KHÔNG `deploy` thẳng lên nhánh production trước khi thử:
bản đó lên thật ngay, người dùng thấy bản chưa qua thử.
1. Build bản production (`pnpm build`), rồi đưa lên bản XEM TRƯỚC: `pnpm exec wrangler pages deploy dist --branch flow-preview`
   (đổi `dist` nếu thư mục build khác; thêm `--project-name <tên>` nếu dự án chưa khai trong cấu hình).
   `--branch` phải KHÁC nhánh production của dự án Pages (xem Dashboard → dự án → Settings → Build → Production branch,
   thường là `main`). Không có `--branch` thì wrangler lấy tên nhánh git đang đứng — đứng ở nhánh production là lên thật.
2. (`playwright.config` phải đọc `BASE_URL` — xem cloudflare-workers.md mục "Trước lần đầu".) Mở địa chỉ xem trước lệnh vừa in ra (dạng `https://<mã>.<dự án>.pages.dev`), chạy bài thử nhanh vào đó:
   `BASE_URL=<địa chỉ xem trước> pnpm exec playwright test --grep @smoke --retries=2` (PowerShell:
   `$env:BASE_URL='<địa chỉ xem trước>'; pnpm exec playwright test --grep @smoke --retries=2`). Ở tab Deployments, bản vừa
   đưa lên phải mang nhãn **Preview** — nhãn Production là đã lên thật, dừng và làm mục "Quay lại bản trước".
   Bản xem trước dùng biến môi trường/binding của môi trường Preview (đặt riêng ở Dashboard): trượt vì thiếu biến thì
   bổ sung biến ở Preview rồi thử lại, không kết luận là lỗi code.
3. Trượt ⇒ dừng, production chưa đổi. Đạt ⇒ đưa lên production: `pnpm exec wrangler pages deploy dist --branch <nhánh production>`
   (cùng thư mục build, không build lại). Chạy `@smoke` lần nữa vào địa chỉ thật để chắc bản production lên đúng;
   trượt ⇒ làm ngay mục "Quay lại bản trước" bên dưới rồi báo user.
4. Ghi mốc nhắc xem lỗi (`checkAt` sau 1 và 7 ngày) vào `.claude/release.json` bằng Edit, kèm `platform: "cloudflare-pages"`.
`--branch` là cờ của `wrangler pages deploy` (theo tài liệu Cloudflare); chưa kiểm bằng `wrangler pages deploy --help`
vì máy dựng công thức này chưa có wrangler (chưa chạy thật).

## Quay lại bản trước (chưa chạy thật)
Làm bằng tay, từng bước, nói user bấm:
1. Cloudflare Dashboard → Workers & Pages → chọn dự án → tab **Deployments**.
2. Tìm bản production đã chạy tốt → menu `…` → **Rollback to this deployment** → xác nhận.
3. Mở địa chỉ thật, chạy lại `@smoke` để chắc bản cũ lên.
Chỉ bản production build thành công mới là đích. Có token Pages Write thì quay lại được bằng API
`POST /accounts/{id}/pages/projects/{tên}/deployments/{mã}/rollback` — nhưng chọn bấm tay cho người mới.
Sau đó ghi `rollbackTested: true` vào `.claude/release.json` (preflight cần mục này).

## Xem lỗi
Pages Functions xem ở Dashboard → dự án → **Functions** → Logs (real-time); không có lệnh `release logs` cho nền này.

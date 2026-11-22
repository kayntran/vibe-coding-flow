# AI_RULES — webapp có trang công khai {{APP_NAME}}

Luật cho AI sửa app này. Người dùng không viết code: giữ giao diện ít chữ, mỗi màn một việc chính (CLAUDE.md của người dùng).
App này có trang công khai (Google và Zalo/Facebook đọc được) + khu sau đăng nhập, cùng MỘT Worker Cloudflare.

## Nền tảng — đã ghim, KHÔNG đổi, KHÔNG thêm framework khác
- React Router **chế độ framework** (v8) chạy trên Cloudflare Workers, dựng trang ở máy chủ (`ssr: true`), TypeScript, Tailwind CSS v4, shadcn/ui (nền Base UI), icon lucide-react.
- Mã app nằm trong `src/` (`appDirectory: "src"`); Worker ở `workers/app.ts`; cấu hình Worker `wrangler.jsonc`. Đường dẫn import dùng `~/` (= `src/`).
- Kiểm thử: Playwright + axe (`{{PM_RUN}} test:e2e`). Gói quản lý: {{PM}}.
- Thêm thư viện mới ⇒ hỏi người dùng trước; thư viện đi qua cổng thư viện của kit (`node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>`).
- Không đổi `ssr: true` thành `false`, không thêm Astro/Next/framework khác, không nâng React Router xuống dưới bản đã ghim (có lỗ hổng đã vá từ 8.5.1).

## Viết theo React Router v8 — AI hay viết nhầm kiểu cũ
| Đúng (v8) | Sai (v7/Remix cũ) |
|---|---|
| `import { … } from "react-router"` | `react-router-dom`, `@remix-run/*` |
| `meta({ loaderData, matches })` | `meta({ data })` |
| trả dữ liệu thẳng (`return { a }`) hoặc `data(…, { status })` | `json(…)` |
| `@cloudflare/vite-plugin` (đã cấu hình) | `cloudflareDevProxy`, `getLoadContext` kiểu cũ |
| đọc biến/bí mật: `import { env } from "cloudflare:workers"` trong loader/action | `process.env`, `import.meta.env` cho bí mật |
- Sau khi thêm/đổi route chạy `{{PM_EXEC}} react-router typegen` (sinh kiểu `./+types/<route>`) rồi `{{PM_RUN}} typecheck`.

## Dùng gì cho việc gì
| Việc | Dùng | Không |
|---|---|---|
| Nút, ô nhập, hộp thoại | `src/components/ui/*` (shadcn). Thêm: `{{PM_DLX}} shadcn@{{V_SHADCN}} add <tên>` | tự viết lại, thêm thư viện giao diện khác |
| Icon | `lucide-react`, luôn kèm nhãn chữ (trừ nhà · in · tìm kiếm · đóng (X)) | icon trần |
| Kiểu dáng | class Tailwind | CSS tự viết, style inline |
| Gọi dữ liệu / dịch vụ ngoài | `src/features/<tên>/api` (chạy ở máy chủ, gọi từ `loader`/`action`) | gọi từ `ui` |
| Tiền, ngày | hàm định dạng chung trong `src/shared` (tạo khi cần) | định dạng rải rác |

## Cấu trúc (docs/arch.json là luật máy đọc)
- Mỗi tính năng một thư mục `src/features/<tên>/{ui,model,api}`; tính năng KHÔNG import tính năng khác; dùng chung đặt ở `src/shared`.
- `src/routes/*` chỉ ráp tính năng (file route mỏng: `meta`, `loader`, rồi vẽ màn của `features/*`); nó được import `features/*` và `shared`.
- Màn đầu `src/features/home` (S-01) chỉ là chỗ giữ chỗ, không có dữ liệu mẫu: làm màn thật thì thay nó, không dựng thêm bên cạnh.
- Thêm tính năng ⇒ thêm module vào `docs/arch.json` + một dòng Codemap trong `docs/ARCHITECTURE.md`, rồi `node ~/.claude/hooks/arch.mjs sync`.
- Lớn lên: khu quản trị (`src/features/admin*`, đường dẫn `/admin`) tách ra Worker riêng bằng cách chuyển thư mục, không viết lại; trang công khai nhiều thì cho CDN giữ bản sao (khu `/admin` luôn `private, no-store`).

## Trang công khai (SEO, xem trước link Zalo/Facebook)
- MỌI route công khai khai `meta` bằng `seoMeta({ siteUrl: siteUrlOf(matches), path, title, description, image? })` (`src/shared/seo/seo-meta.ts`). KHÔNG viết `<title>` hay thẻ `og:*` tay: `meta` của route con thay hẳn của route cha, quên khai là mất ảnh chia sẻ.
- Ảnh chia sẻ riêng từng trang: địa chỉ công khai, không cần đăng nhập. Ảnh mặc định `public/og-default.png` (1200x630) là ảnh tạm: thay bằng ảnh thương hiệu thật. Tên/mô tả mặc định ở `src/shared/seo/site.ts`.
- Địa chỉ gốc lấy từ `SITE_URL` (`wrangler.jsonc`, mục `vars`), KHÔNG lấy từ tiêu đề Host. Địa chỉ mẫu `*.example.com` PHẢI đổi thành tên miền thật trước khi phát hành.
- `sitemap.xml` tự sinh từ route (không viết tay). Trang có tham số (`san-pham/:slug`) vào sitemap khi module route khai `export const handle = { sitemap: async () => [{ path, lastmod }] }`; route không muốn lên Google: `handle = { noindex: true }`. Quá 50.000 địa chỉ thì tự chia file.
- Trang không có thật (hoặc sản phẩm đã xoá): `throw data(null, { status: 404 })` trong `loader` — mã 404 THẬT, không hiện "không tìm thấy" kèm mã 200.
- Dữ liệu có cấu trúc (giá, bài viết): `jsonLd(...)` trong `meta` (`src/shared/seo/json-ld.ts`).
- Mỗi route công khai mới ⇒ thêm đường dẫn vào `PAGES` của `e2e/seo.spec.ts` và một ca thử `a11y` cho trang đó. Máy kiểm `seo-public` chạy các test này (tắt JavaScript, giả bot Facebook) vào BẢN BUILD.
- Khu sau đăng nhập đặt dưới `/admin` (Worker tự gắn `X-Robots-Tag: noindex` + `Cache-Control: private, no-store`). Kiểm quyền ở máy chủ (loader/action), không chỉ ẩn nút.
- Trang dựng ở máy chủ trên gói miễn phí Cloudflare bị giới hạn 10 ms CPU mỗi lượt; app thật nên dùng gói trả phí (ghi mốc đổi gói trong STACK.md).

## Giao diện
- Mỗi màn đúng MỘT nút chính (`data-primary` hoặc nút shadcn mặc định); nhãn 1–3 chữ, động từ ("Lưu", "Thêm từ"); không "OK/Có/Không/Xác nhận".
- Việc không quay lại được (xoá, tiền, quyền): nút nêu rõ ("Xoá từ"); việc hoàn tác được: nút Hoàn tác, không hộp xác nhận.
- Mỗi trạng thái màn trong SPEC có mã `S-nn`: gắn `data-s="S-nn"` vào phần tử gốc của trạng thái và ghi mã trong tên test e2e.
- Kiểm: `node ~/.claude/hooks/ui-check.mjs` (đọc `.claude/ui.json`).

## Bí mật và header
- Khoá bí mật chỉ ở `.dev.vars` (máy này, không lên git) / `wrangler secret put` (bản thật); không đặt vào `wrangler.jsonc`, `vars`, hay mã chạy ở trình duyệt. Khoá đi qua kho khoá của kit (`khoa.mjs luu` rồi `lay`); không viết giá trị khoá vào code hay câu trả lời.
- Header bảo mật đặt trong CODE WORKER (`src/shared/security/headers.ts`, gọi từ `workers/app.ts`) cho MỌI phản hồi: CSP có nonce cho script nội tuyến, nosniff, chống nhúng, Referrer-Policy. `public/_headers` chỉ áp cho file tĩnh (JS, CSS, ảnh) — sửa ở đâu thì nhớ cả hai nơi khớp nhau.
- Thêm tên miền dịch vụ ngoài (Analytics, Pixel, chat) vào `script-src`/`connect-src` ở `headers.ts` (hỏi người dùng trước); KHÔNG nới thành `'unsafe-inline'`, KHÔNG thêm `'unsafe-eval'`.
- Script nội tuyến của trang tự mang nonce (React Router nhận qua `entry.server.tsx`); đừng thêm thẻ `<script>` nội tuyến tay, đừng bỏ `nonce` khỏi `entry.server.tsx`. Lỗi CSP chỉ lộ ở bản build (dev bỏ CSP): kiểm bằng `{{PM_RUN}} test:e2e`.
- Dữ liệu từ người dùng: kiểm ở máy chủ, truy vấn tham số hoá; không ghép chuỗi vào SQL.
- Ghi nhật ký chỉ qua `safeLog` (`src/shared/safe-log.ts`: chỉ trường trong danh sách cho phép được ghi, phần còn lại bị che). KHÔNG `console.log` thẳng mật khẩu, token, khoá, email hay chữ người dùng nhập. Máy kiểm `log-secrets` quét log của bài thử.

## Lệnh
- Chạy thử: `{{PM_DEV}}` (http://localhost:{{PORT}}; chạy thử không có CSP) · Xem bản build: `{{PM_RUN}} preview` · Test: `{{PM_RUN}} test:e2e` · Kiểm tổng: `node ~/.claude/hooks/flow-check.mjs --dir .`
- Cổng đọc từ biến `PORT` (mặc định {{PORT}}): chạy nhiều bản song song thì mỗi bản một `PORT`.
- Bài thử nhanh sau phát hành: test gắn `{ tag: '@smoke' }` CHỈ ĐỌC (mở màn, nhìn; không bấm/nhập/ghi dữ liệu). Chạy vào bản đã đưa lên: `BASE_URL=<địa chỉ>` (và `SMOKE_EXTRA_HTTP_HEADERS='{"tên":"giá trị"}'` nếu cần header thêm) rồi `{{PM_EXEC}} playwright test --grep @smoke`. Bài `@smoke` phải mở một trang dựng ở máy chủ (trang file tĩnh không đi qua Worker nên không có header). Màn thật thay màn đầu ⇒ giữ ít nhất một test `@smoke` cho màn đó.
- Máy kiểm đã cấu hình sẵn (`eslint.config.js`, `knip.jsonc`, `.size-limit.json`, `osv-scanner.toml`, `.jscpd.json`): sửa code cho đạt, đừng nới cấu hình để lách; cần nới thì hỏi người dùng.
- Phát hành lần đầu (máy không tự làm được): dán một link trang vào Zalo và Facebook xem tên + ảnh; Facebook có công cụ Sharing Debugger để xoá bản nhớ cũ.

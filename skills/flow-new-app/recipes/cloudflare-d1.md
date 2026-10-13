# Công thức: Cloudflare Workers + D1 + Better Auth

Hợp khi: user muốn gọn một nhà Cloudflare, chạy thử trên máy không cần cài thêm. Nguồn: research đợt 3 §1c (docs
Cloudflare/Better Auth 2026-10). D1 Free: 5 triệu dòng đọc/ngày, 100k dòng ghi/ngày, 5 GB — hết hạn mức thì truy vấn lỗi.

- **Đăng nhập:** Better Auth (MIT) chạy trong Worker, lưu phiên vào D1. Cookie `HttpOnly; Secure; SameSite=Lax`.
- **Chặn quyền:** D1 là SQLite, KHÔNG có RLS ⇒ chặn ở code Worker. MỌI route đọc/ghi dữ liệu người dùng đi qua MỘT hàm
  `requireUser(req)` rồi truy vấn luôn kèm `WHERE owner_id = ?` (gói trong lớp `store` theo `docs/arch.json`, route không
  tự viết SQL). Đây là chỗ AI hay quên nhất ⇒ mỗi route có test hai phiên.
- **Kiểm dữ liệu vào:** schema zod ở Worker cho mọi body/query; bảng có `NOT NULL`, `CHECK`.
- **Truy vấn:** `env.DB.prepare(sql).bind(...)` — cấm ghép chuỗi (luật `ai-sql-string-concat`).
- **Giới hạn tần suất:** đăng nhập/đăng ký: rate limit của Better Auth (bật sẵn); thêm binding `[[ratelimits]]` (wrangler
  ≥ 4.36, period 10/60 giây) cho route tốn kém — gói/hành vi local chưa xác minh, kiểm khi dùng.
- **Header:** asset tĩnh dùng `public/_headers`; response do Worker sinh KHÔNG nhận `_headers` ⇒ đặt header trong code
  (một middleware chung).
- **Khoá:** `wrangler secret put`; local trong `.dev.vars` (git-ignore). Không biến bí mật nào vào bundle giao diện.
- **Nhật ký (log):** Workers Logs KHÔNG che dữ liệu nhạy cảm ⇒ che ở code. Worker ghi log CHỈ qua `safeLog` — chép `src/shared/safe-log.ts`
  của mẫu web (cùng hàm: danh sách trường cho phép, phần còn lại bị che); cấm `console.log` thẳng body, header `Authorization`/`Cookie`,
  email, token. Bật lưu lịch sử trong cấu hình wrangler: `"observability": { "enabled": true }` (wrangler ≥ 3.78.6; `head_sampling_rate`
  để giảm lượng khi gần trần). Free: 200.000 sự kiện/ngày, giữ 3 ngày (Paid 7 ngày) ⇒ hỏi lỗi cũ hơn thế thì nói thật là log đã hết.
  Đọc lịch sử qua Telemetry Query API (token chỉ-đọc); `wrangler tail` chỉ để xem trực tiếp, không lưu. Ghi nguồn log vào
  `.claude/release.json`: `"logs": { "source": "workers-observability", "retentionDays": 3 }`. Bài thử: `wrangler dev` tự ghi
  `.wrangler/logs/*.log`; máy kiểm `log-secrets` của `flow check` quét các file này và `test-results/` ⇒ thấy thứ giống bí mật là đỏ.
- **DB thử:** `wrangler dev` (Miniflare, không Docker) + `wrangler d1 migrations apply --local`; mỗi worktree có thư mục
  `.wrangler/state` riêng ⇒ dữ liệu tách sẵn; cổng từ `wt-env.mjs alloc`.
- **Bài thử nhanh sau phát hành (`@smoke`):** `playwright.config.ts` của mẫu web đọc `BASE_URL` (địa chỉ bản vừa tải lên; có thì
  không bật server trên máy) và `SMOKE_EXTRA_HTTP_HEADERS` (JSON, thành `extraHTTPHeaders` — header chọn bản Worker chưa mở cho khách,
  để thử trước khi chuyển lưu lượng). Mỗi màn/luồng chính có ít nhất một test gắn `{ tag: '@smoke' }` CHỈ ĐỌC (mở màn, nhìn; không
  tạo/sửa/xoá dữ liệu); route API chỉ gọi GET hoặc tài khoản thử. Chạy: `BASE_URL=<địa chỉ> pnpm exec playwright test --grep @smoke`.
- **Mã bản trên phản hồi (để `release cf` chắc bài thử chạm đúng bản mới):** `wrangler.jsonc` thêm binding
  `"version_metadata": { "binding": "CF_VERSION_METADATA" }`; middleware chung (cùng chỗ đặt header bảo mật) đặt header
  `x-flow-version` = `env.CF_VERSION_METADATA.id` trên mọi phản hồi của Worker (mẫu Hono):
  `app.use('*', async (c, next) => { await next(); c.res.headers.set('x-flow-version', c.env.CF_VERSION_METADATA.id) })`.
  Trang tĩnh phục vụ thẳng từ `assets` không qua Worker nên không có header ⇒ đặt `"assets": { "run_worker_first": true }`.
  Thiếu header ⇒ `release cf` dừng, không mở bản mới (chi tiết: `skills/flow-production/recipes/cloudflare-workers.md`).
- **Test P-nn:** test API hai phiên chạy vào `wrangler dev` (hoặc `@cloudflare/vitest-pool-workers`): đăng ký A, B → A
  tạo → B đọc/sửa/xoá phải 403/404 → chưa đăng nhập phải 401. Tắt chặn quyền để chứng minh đỏ: tạm bỏ điều kiện
  `owner_id` của đúng route trong worktree (không commit) → test phải ĐỎ → khôi phục. Ghi `P-nn: đỏ khi tắt: có — <file>`.

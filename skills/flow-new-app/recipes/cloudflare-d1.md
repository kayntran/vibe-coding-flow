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
- **DB thử:** `wrangler dev` (Miniflare, không Docker) + `wrangler d1 migrations apply --local`; mỗi worktree có thư mục
  `.wrangler/state` riêng ⇒ dữ liệu tách sẵn; cổng từ `wt-env.mjs alloc`.
- **Test P-nn:** test API hai phiên chạy vào `wrangler dev` (hoặc `@cloudflare/vitest-pool-workers`): đăng ký A, B → A
  tạo → B đọc/sửa/xoá phải 403/404 → chưa đăng nhập phải 401. Tắt chặn quyền để chứng minh đỏ: tạm bỏ điều kiện
  `owner_id` của đúng route trong worktree (không commit) → test phải ĐỎ → khôi phục. Ghi `P-nn: đỏ khi tắt: có — <file>`.

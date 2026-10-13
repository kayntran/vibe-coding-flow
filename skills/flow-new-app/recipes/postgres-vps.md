# Công thức: Postgres trên VPS (hoặc dịch vụ Postgres user đã có)

Hợp khi: user đã có máy chủ/dịch vụ database riêng. App = giao diện tĩnh + API server (Node/Go) cạnh Postgres.

- **Đăng nhập:** dùng thư viện đã kiểm (Better Auth cho Node; Go: thư viện phiên/OAuth phổ biến, ghi lý do chọn trong
  PLAN) — không tự viết băm mật khẩu/phiên. Cookie `HttpOnly; Secure; SameSite=Lax`.
- **Chặn quyền:** ở API server, một hàm `requireUser` + lớp `store` luôn lọc theo chủ sở hữu; có thể bật thêm RLS của
  Postgres (`set local app.user_id`) làm lớp thứ hai. API không bao giờ nối DB bằng tài khoản superuser.
- **Kiểm dữ liệu vào:** schema ở server (zod / struct validate Go) + ràng buộc `NOT NULL`, `CHECK`, khoá ngoại.
- **Truy vấn:** tham số hoá (`$1`, query builder) — cấm ghép chuỗi.
- **Giới hạn tần suất:** ở reverse proxy (nginx `limit_req`, Caddy rate_limit) cho đăng nhập + route tốn kém.
- **Header:** cấu hình nginx/Caddy NẰM TRONG repo (`deploy/nginx.conf` hoặc `Caddyfile`) với CSP, nosniff,
  Referrer-Policy, `frame-ancestors`/X-Frame-Options — máy kiểm `web-headers` đọc file này.
- **Khoá:** biến môi trường trên máy chủ (systemd `EnvironmentFile`, secret của nền tảng); `.env` git-ignore.
- **DB thử:** mỗi làn một database riêng trên Postgres thử (tên từ `FLOW_DB_NAME` của `wt-env.mjs alloc`) hoặc container
  nếu máy có Docker; không bao giờ trỏ test vào database thật.
- **Test P-nn:** test API hai phiên (A tạo → B đọc/sửa/xoá phải 403/404). Tắt chặn quyền để chứng minh đỏ: tạm bỏ lọc
  chủ sở hữu của đúng truy vấn trong worktree → test phải ĐỎ → khôi phục. Ghi `P-nn: đỏ khi tắt: có — <file test>`.
- **Đường quay lại:** migration xoá/đổi dữ liệu ⇒ `pg_dump` trước + user gật bằng câu đời thường.

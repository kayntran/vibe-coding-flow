# Công thức: Postgres trên VPS (hoặc dịch vụ Postgres user đã có)

Hợp khi: user đã có máy chủ/dịch vụ database riêng. App = giao diện tĩnh + API server (Node/Go) cạnh Postgres.

- **Đăng nhập:** dùng thư viện đã kiểm (Better Auth cho Node; Go: thư viện phiên/OAuth phổ biến, ghi lý do chọn trong
  PLAN) — không tự viết băm mật khẩu/phiên. Cookie `HttpOnly; Secure; SameSite=Lax`.
- **Chặn quyền:** ở API server, một hàm `requireUser` + lớp `store` luôn lọc theo chủ sở hữu; có thể bật thêm RLS của
  Postgres (`set local app.user_id`) làm lớp thứ hai. API không bao giờ nối DB bằng tài khoản superuser.
- **Kiểm dữ liệu vào:** schema ở server (zod / struct validate Go) + ràng buộc `NOT NULL`, `CHECK`, khoá ngoại.
- **Truy vấn:** tham số hoá (`$1`, query builder) — cấm ghép chuỗi.
- **Giới hạn tần suất:** nginx `limit_req` (module có sẵn trong nginx) cho đăng nhập + route tốn kém. KHÔNG dựa vào Caddy `rate_limit`:
  Caddy bản chuẩn không có, đó là module ngoài (caddy-ratelimit) phải tự dựng lại Caddy bằng `xcaddy` và tự theo dõi bản vá. Dùng Caddy
  ⇒ đặt giới hạn trong code API bằng thư viện của framework (`@fastify/rate-limit`, `express-rate-limit`; Go: `golang.org/x/time/rate`),
  thư viện mới đi qua cổng thư viện của kit.
- **Header:** cấu hình nginx/Caddy NẰM TRONG repo (`deploy/nginx.conf` hoặc `Caddyfile`) với CSP, nosniff,
  Referrer-Policy, `frame-ancestors`/X-Frame-Options — máy kiểm `web-headers` đọc file này.
- **Khoá:** biến môi trường trên máy chủ (systemd `EnvironmentFile`, secret của nền tảng); `.env` git-ignore.
- **Nhật ký (log):** API server ghi log CHỈ qua `safeLog` tương đương — Node: chép `src/shared/safe-log.ts` của mẫu web (một dòng JSON ra
  stdout, danh sách trường cho phép, phần còn lại bị che); Go: `log/slog` với handler/`ReplaceAttr` chỉ giữ các khoá trong danh sách cho
  phép. Cấm ghi body, header `Authorization`/`Cookie`, chuỗi kết nối database, email, token. Log đi qua systemd: lịch sử đọc bằng
  `journalctl -u <dịch vụ> --since <khoảng>` (chạy bằng container: `docker logs --since`). journald mặc định không giữ theo ngày ⇒ đặt
  `MaxRetentionSec=30day` trong `/etc/systemd/journald.conf`. Ghi nguồn log vào `.claude/release.json`:
  `"logs": { "source": "vps-journald", "retentionDays": 30 }` (đúng số ngày đã đặt). Bài thử chạy server thì ghi stdout ra file
  (`node server.js > e2e/server.log 2>&1`) để máy kiểm `log-secrets` của `flow check` quét được.
- **DB thử:** mỗi làn một database riêng trên Postgres thử (tên từ `FLOW_DB_NAME` của `wt-env.mjs alloc`) hoặc container
  nếu máy có Docker; không bao giờ trỏ test vào database thật.
- **Test P-nn:** test API hai phiên (A tạo → B đọc/sửa/xoá phải 403/404). Tắt chặn quyền để chứng minh đỏ: tạm bỏ lọc
  chủ sở hữu của đúng truy vấn trong worktree → test phải ĐỎ → khôi phục. Ghi `P-nn: đỏ khi tắt: có — <file test>`.
- **Đường quay lại:** migration xoá/đổi dữ liệu ⇒ `pg_dump` trước + user gật bằng câu đời thường.

# Công thức: Supabase (Auth + Postgres RLS) + webapp tĩnh

Hợp khi: app có tài khoản, dữ liệu riêng từng người, user muốn trang xem dữ liệu sẵn. Nguồn: research đợt 3 §1
(docs Supabase 2026-10). Free: 2 project đang chạy, tạm dừng sau 1 tuần không dùng, 50k người dùng/tháng.

- **Đăng nhập:** Supabase Auth (email/OTP hoặc OAuth). Client chỉ cầm khoá công khai (`anon`/publishable). Khoá
  `service_role`/`sb_secret_` KHÔNG BAO GIỜ vào code trình duyệt hay biến `VITE_*` (máy kiểm `secret-build` chặn).
- **Chặn quyền:** ở DB. Mọi bảng `public` bật RLS; policy theo `auth.uid()`; ghi dùng `with check`. Không có policy
  `using (true)` trừ bảng công khai đã ghi lý do. Không có code server ⇒ không có chỗ khác để quên.
- **Kiểm dữ liệu vào:** ràng buộc trong migration (`not null`, `check (length(...) <= …)`, `check (amount >= 0)`, khoá
  ngoại); logic nhiều bước ⇒ hàm Postgres `security invoker`. Kiểm ở giao diện chỉ để báo lỗi sớm, không thay ràng buộc.
- **Truy vấn:** qua supabase-js (tham số hoá sẵn); SQL thô trong hàm Postgres dùng tham số, không ghép chuỗi.
- **Giới hạn tần suất:** Supabase Auth có sẵn (đăng nhập/đăng ký 30 lần/5 phút/IP; email mặc định 2/giờ ⇒ project thử
  tắt xác nhận email hoặc dùng SMTP riêng).
- **Header:** `public/_headers` của mẫu; `connect-src` thêm `https://<ref>.supabase.co wss://<ref>.supabase.co`.
- **DB thử:** máy KHÔNG có Docker (thường gặp trên Windows) ⇒ project Supabase thứ hai làm "test" (dev dùng luôn
  project này); mỗi làn tạo user thử email `<làn>-a@test.invalid`, `<làn>-b@test.invalid` và dọn sau test; migration đổi
  schema chạy MỘT làn một lúc. Có Docker ⇒ `supabase start` với `[experimental] stack = true`, mỗi worktree dữ liệu riêng.
  Không bao giờ chạy test vào project thật đang có khách.
- **Test P-nn:** không Docker ⇒ test API hai phiên (Vitest/Playwright + supabase-js): tạo 2 user qua Admin API bằng khoá
  `service_role` CHỈ trong `.env.test` của máy test (git-ignore) → A ghi → B đọc/sửa/xoá phải rỗng hoặc lỗi → `anon`
  thấy rỗng. Có Docker ⇒ thêm pgTAP `supabase/tests/database/*.sql` (`set local role authenticated; set local
  request.jwt.claim.sub = …`) + test toàn DB: không bảng `public` nào tắt RLS.
  Tắt chặn quyền để chứng minh test đỏ: migration tạm `alter table <bảng> disable row level security` (hoặc bỏ policy
  của đúng mã) trên DB thử → test của mã phải ĐỎ → bật lại. Ghi `P-nn: đỏ khi tắt: có — <file test>`.
- **Đường quay lại:** migration xoá/đổi dữ liệu ⇒ sao lưu trước (`supabase db dump`) + user gật bằng câu đời thường.

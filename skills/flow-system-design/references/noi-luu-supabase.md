# Công thức: Supabase (Auth + Postgres RLS) + webapp tĩnh

Hợp khi: app có tài khoản, dữ liệu riêng từng người, user muốn trang xem dữ liệu sẵn.

**Cảnh báo phải nói với user khi gợi ý gói miễn phí:** gói này tự **tạm dừng** khi lâu không có ai dùng (app báo lỗi tới khi bấm mở
lại) và **không có sao lưu**. Hạn mức cụ thể tra trang giá lúc chọn. App có dữ liệu thật ⇒ bật sao lưu từ ngày đầu theo `flow-backup`
(gói trả phí, hoặc tự xuất định kỳ), không đợi tới lúc phát hành.

- **Đăng nhập:** Supabase Auth (email/OTP hoặc OAuth). Client chỉ cầm khoá công khai (`anon`/publishable). Khoá
  `service_role`/`sb_secret_` KHÔNG BAO GIỜ vào code trình duyệt hay biến `VITE_*` (máy kiểm `secret-build` chặn).
- **Chặn quyền:** ở DB. Mọi bảng `public` bật RLS; policy theo `auth.uid()`; ghi dùng `with check`. Không có policy
  `using (true)` trừ bảng công khai đã ghi lý do. Không có code server ⇒ không có chỗ khác để quên.
- **Kiểm dữ liệu vào:** ràng buộc trong migration (`not null`, `check (length(...) <= …)`, `check (amount >= 0)`, khoá
  ngoại); logic nhiều bước ⇒ hàm Postgres `security invoker`. Kiểm ở giao diện chỉ để báo lỗi sớm, không thay ràng buộc.
- **Truy vấn:** qua supabase-js (tham số hoá sẵn); SQL thô trong hàm Postgres dùng tham số, không ghép chuỗi.
- **Giới hạn tần suất:** Supabase Auth có sẵn giới hạn đăng nhập/đăng ký theo IP; email mặc định gửi rất ít mỗi giờ ⇒ project thử
  tắt xác nhận email hoặc dùng SMTP riêng (số cụ thể: trang Auth rate limits của Supabase).
- **Header:** `public/_headers` của mẫu; `connect-src` thêm `https://<ref>.supabase.co wss://<ref>.supabase.co`.
- **Nhật ký (log):** giao diện ghi log CHỈ qua `safeLog` (`src/shared/safe-log.ts` của mẫu web). Code chạy phía Supabase (Edge Function, hàm
  Postgres) cũng ghi qua hàm tương đương — cùng danh sách trường cho phép, cấm `console.log(req.body)` hay `raise notice` dữ liệu
  người dùng, khoá, token. Lỗi của app nằm ở Supabase: gói miễn phí giữ log rất ngắn (bảng điều khiển → Logs; CLI không có `supabase logs`; log drain
  chỉ gói trả phí) ⇒ hỏi lỗi cũ hơn hạn giữ thì nói thật là log đã hết. Ghi nguồn log vào `.claude/release.json`:
  `"logs": { "source": "supabase", "retentionDays": 1 }` (số ngày gói miễn phí lúc viết; tra lại trang giá, đổi gói thì sửa). Web tĩnh phát hành bằng Cloudflare Workers (assets) ⇒ bật thêm
  `"observability": { "enabled": true }` trong cấu hình wrangler để xem log truy cập ở Workers Logs; nguồn chính vẫn là
  supabase. Máy kiểm `log-secrets` của `flow check` quét log bài thử (`test-results/`, `playwright-report/`, `*.log`).
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

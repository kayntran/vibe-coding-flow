# Công thức: Cloudflare Workers + Hyperdrive + Postgres (Supabase Pro hoặc Neon) + Drizzle — gói Chắc

Hợp khi: có thu tiền, nhiều công ty dùng chung một app, hoặc kỳ vọng hàng chục nghìn người dùng; dữ liệu là tài sản chính (đặt lịch,
quản lý khách…). Công cụ nhỏ, dữ liệu theo từng người ⇒ công thức D1 nhẹ hơn. Đã có `docs/BUSINESS.md` và `docs/STACK.md` ⇒ đọc trước:
gói nền, số công ty, ngân sách đã chốt ở đó, không hỏi lại. Nói với user bằng lời đời thường: dữ liệu công ty này không lộ sang công ty
kia vì chính database từ chối, kể cả khi AI quên một dòng lọc; phí nền cố định hàng tháng (tra trang giá lúc chọn, ghi ngày tra vào
STACK.md); đặt database ở vùng gần khách (Singapore hay dùng; chưa tra độ trễ, đo thử trước khi chốt). Chạy thật đã kiểm: phần SQL, vai và
RLS của bộ mẫu `kit/recipes/postgres-rls/`; phần code Worker/Drizzle bên dưới là mẫu minh hoạ (tra tài liệu Hyperdrive, Drizzle, PostgreSQL ngày 2026-11-22).

- **Cách nối:** Worker → Hyperdrive (bộ gom kết nối và bộ nhớ đệm của Cloudflare) → Postgres. Dùng chuỗi kết nối **trực tiếp** của nhà cung
  cấp (Supabase: Direct connection; Neon: bỏ chọn connection pooling) vì Hyperdrive tự gom kết nối. Driver `pg` (Cloudflare khuyên dùng,
  tối thiểu 8.16.3) hoặc `postgres` (tối thiểu 3.4.5, KHÔNG đặt `prepare: false`). `wrangler.jsonc`: `compatibility_flags: ["nodejs_compat"]`,
  `compatibility_date` = ngày làm, binding `hyperdrive`. Tạo client MỖI request trong handler (không để ở phạm vi toàn cục; Hyperdrive giữ hồ kết nối nên tạo mới rẻ).
- **Drizzle chỉ trong lớp `store`:** ghim `drizzle-orm` 0.45.x và `drizzle-kit` bản ổn định (bản 1.0 còn beta, không dùng; npm `latest` 0.45.4
  ngày tra), thêm qua cổng thư viện của kit. Schema bằng `pg-core`. Route/handler KHÔNG import Drizzle, không tự viết SQL; chỉ gọi hàm của
  `store` theo `docs/arch.json`. Đổi nhà cung cấp hay đổi DB sau này chỉ sửa lớp `store` và file schema. RLS và vai viết bằng migration SQL
  tay (`drizzle-kit generate --custom`), không phụ thuộc cú pháp RLS riêng của từng bản Drizzle.
- **Một cửa duy nhất vào DB — `store/db.ts` có đúng một hàm `withScope(env, scope, fn)`:** `scope` = `{ tenantId, userId }` lấy từ PHIÊN đã xác
  thực, không bao giờ từ body, query hay header. Hàm mở một giao dịch ngắn và đặt hai biến bằng `set_config(…, true)` (hiệu lực tới hết
  giao dịch, nhận tham số nên không ghép chuỗi; `SET`/`set_config(…, false)` cấm):
  ```ts
  const client = new Client({ connectionString: env.HYPERDRIVE_NOCACHE.connectionString }); await client.connect()
  const db = drizzle({ client })
  return db.transaction(async (tx) => {
    // thiếu userId (thao tác cấp công ty) ⇒ chuỗi rỗng: policy so với chuỗi rỗng ⇒ không khớp dòng nào (chặn), không lỗi bind
    await tx.execute(sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.user_id', ${scope.userId ?? ''}, true)`)
    return fn(tx)
  }) // minh hoạ: ghim đúng API theo bản Drizzle đã chốt
  ```
  Lý do: Hyperdrive gom kết nối theo giao dịch và RESET khi trả kết nối: giá trị đặt ngoài giao dịch không theo được sang câu sau (mất tenant
  ⇒ rỗng), và nếu sau này đổi sang bộ gom khác không RESET thì giá trị cũ còn lại cho khách kế tiếp. Đặt trong giao dịch thì đúng ở cả hai
  trường hợp. Một lần gọi `store` = một giao dịch ngắn (giữ giao dịch qua nhiều bước chờ làm cạn hồ kết nối).
- **Chặn quyền (nhiều công ty) ở DB, từ ngày đầu:** mọi bảng dữ liệu khách có `tenant_id uuid not null default app.tenant_id()`, `enable` **và**
  `force row level security`, một policy `using` + `with check` cùng so `tenant_id` với `(select app.tenant_id())`. Chưa đặt tenant ⇒ hàm
  trả NULL ⇒ không thấy dòng nào (đóng cửa mặc định). Dữ liệu riêng từng người (ghi chú, tin nhắn) thêm `user_id = (select app.user_id())`.
  Index chính bắt đầu bằng `tenant_id`; khoá ngoại giữa bảng khách dùng khoá kép `(tenant_id, id)` (kiểm khoá ngoại bỏ qua RLS, id của
  công ty khác có thể lộ qua thông báo lỗi). View khách: `with (security_invoker = true)`. Hàm `security definer` cấm (chạy bằng quyền chủ nên
  bỏ qua RLS) trừ khi ghi lý do và có bài kiểm. Bảng không thuộc công ty nào (danh mục, cấu hình) ghi lý do và chỉ cấp quyền đọc.
- **Vai (role) của ứng dụng:** Worker kết nối bằng `app_rw`: `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, không sở hữu bảng, chỉ
  `SELECT/INSERT/UPDATE/DELETE` từng bảng (không `TRUNCATE`, `REFERENCES`: RLS không chặn hai lệnh này). Superuser và vai có BYPASSRLS bỏ
  qua RLS hoàn toàn ⇒ không bao giờ đưa chúng vào cấu hình Hyperdrive. Migration chạy bằng vai chủ bảng từ máy hoặc CI, không từ Worker.
  Mật khẩu vai đặt ngoài file migration. Supabase: bảng của app nằm ở schema mà Data API không phát ra (hoặc tắt Data API); kiểm trong bảng điều khiển.
- **Bộ nhớ đệm của Hyperdrive:** mặc định cache câu đọc theo nội dung câu truy vấn, không biết biến đã `set_config`, và không xoá khi có
  ghi (suy luận từ tài liệu: có thể trả dữ liệu công ty khác, chưa thử trên bản thật) ⇒ mọi truy vấn trong `withScope` đi qua một cấu hình
  Hyperdrive TẮT cache (`wrangler hyperdrive create … --caching-disabled`, binding `HYPERDRIVE_NOCACHE`). Cấu hình có cache chỉ cho dữ liệu công khai chịu được cũ.
- **Đăng nhập:** Better Auth trong Worker (Drizzle adapter), cấu hình Hyperdrive tắt cache. Bảng của nó (user, session…) không thuộc
  `tenant_id`: cho vai riêng `app_auth` chỉ có quyền trên các bảng đó, `app_rw` không đọc được phiên; plugin `organization` lo "ai thuộc công
  ty nào, vai gì". Chưa có mẫu chạy trong kit cho phần này ⇒ rủi ro cao hơn, ghi vào STACK.md và kiểm bằng test API hai phiên.
- **Kiểm dữ liệu vào:** schema zod ở Worker cho mọi body/query; bảng có `not null`, `check`, khoá ngoại. **Truy vấn:** Drizzle (tham số hoá);
  `sql` template chỉ nhận `${…}` làm tham số, cấm ghép chuỗi (luật `ai-sql-string-concat`).
- **Giới hạn tần suất, header, khoá, nhật ký:** như công thức Workers + D1 (binding `ratelimits`, header trong middleware chung, `wrangler secret
  put`, log chỉ qua `safeLog`, nguồn log `workers-observability` trong `.claude/release.json`). Thêm: log cấm câu SQL kèm tham số và chuỗi
  kết nối; `tenant_id`/`user_id` chỉ ghi dạng mã, không kèm email. Chuỗi kết nối DB chỉ nằm ở cấu hình Hyperdrive, không ở `.dev.vars` của bản thật.
- **DB thử mỗi làn:** một Postgres Docker riêng mỗi làn: tên container `flow-pg-<FLOW_DB_NAME>`, port trong cửa sổ `PORT_BASE`, cả hai lấy từ
  `node ~/.claude/hooks/wt-env.mjs alloc <worktree>`. `wrangler dev` đọc `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<TÊN_BINDING>` (hoặc
  `localConnectionString`) và nối thẳng, **không qua Hyperdrive** ⇒ lỗi do cache hay gom kết nối chỉ lộ trên bản thật ⇒ cần bài `@smoke` hai
  khách sau phát hành. Không có Docker ⇒ Neon: mỗi làn một nhánh dữ liệu; Supabase: một project thử, migration đổi schema chạy một làn một
  lúc. Không bao giờ trỏ test vào DB thật.
- **Test P-nn (chạy lại được):** chép `kit/recipes/postgres-rls/` vào app: `schema.sql` thành migration (đổi tên bảng theo app), `rls.test.mjs`
  vào `tests/` (sửa danh sách bảng và probe theo bảng thật). Bài kiểm: khách A không đọc, sửa, xoá, chèn dữ liệu của B; chưa đặt tenant ⇒
  rỗng; hết giao dịch là mất tenant; `app_rw` không BYPASSRLS và không tự tắt được RLS; mọi bảng đã bật và ép RLS. Chạy
  `FLOW_PG_TEST=1 node --test tests/rls.test.mjs` (biến nối Docker ghi ở đầu file). Lần "tắt chặn quyền" nằm sẵn trong bộ mẫu: tắt RLS
  (rồi cho `app_rw` quyền BYPASSRLS) trên DB thử thì bài kiểm PHẢI đỏ, rồi bật lại; in "tắt RLS: bắt được truy cập chéo". Ghi
  `P-nn: đỏ khi tắt: có — <file>`. Thêm test API hai phiên (hai khách đăng nhập thật gọi cùng route) và `@smoke` hai khách trên bản thật (bắt lỗi cache).
- **Sao lưu (`flow-backup`):** gói trả phí của Supabase có sao lưu hằng ngày, khôi phục theo mốc từng phút là phần mua thêm; Neon giữ lịch
  sử khôi phục theo gói (gói miễn phí rất ngắn) ⇒ app có dữ liệu thật bật từ ngày đầu, hoặc `pg_dump` định kỳ. Thử khôi phục vào DB thử mỗi
  quý. Migration xoá/đổi dữ liệu ⇒ sao lưu trước và user gật bằng câu đời thường; không chạy `migration down` trên DB có dữ liệu.
- **Mốc nâng cấp (đo được, nhắc user khi chạm):** CPU DB > 70% liên tục 1 tuần ⇒ bản đọc phụ cho báo cáo (qua một cấu hình Hyperdrive riêng)
  hoặc nâng máy; lỗi `Failed to acquire a connection from the pool` ⇒ rút ngắn giao dịch, nâng giới hạn kết nối trong Hyperdrive (không
  vượt trần của DB, cộng cả các cấu hình); đĩa > 70% ⇒ nâng đĩa; 95% truy vấn chính vượt 300 ms ⇒ xem index trước khi thêm máy; gói
  Hyperdrive miễn phí có trần truy vấn mỗi ngày (tra trang giá) ⇒ lên gói trả phí trước khi có khách thật; một công ty đòi dữ liệu nằm riêng ⇒
  DB riêng cho công ty đó (RLS giữ nguyên).
- **Đường quay lại:** Postgres chuẩn nguồn mở ⇒ `pg_dump` sang nhà khác (Supabase, Neon, VPS); vai và policy nằm trong migration nên đi theo.
  Bỏ Hyperdrive chỉ đổi chuỗi kết nối (mất gom kết nối và cache). Đổi từ D1 sang gói này: viết lại file schema theo `pg-core`, chuyển dữ liệu, giữ lớp `store`.

# Công thức phát hành: Cloudflare Workers

Hợp khi app chạy trên Workers (có thể kèm D1/KV/R2, tài nguyên tĩnh). Cần: `wrangler` và Playwright trong dự án
(`pnpm add -D wrangler @playwright/test --allow-build=workerd`), đã `pnpm exec wrangler login` (hoặc đặt
`CLOUDFLARE_API_TOKEN`). Lệnh viết theo pnpm (mẫu của kit); app dùng npm/yarn ⇒ đổi tương ứng. Mã thoát: xem SKILL.

## Trước lần đầu
- `package.json` có script `build` (dựng bản chạy thật) — lệnh phát hành tự chạy nó trước khi tải lên.
- `wrangler.jsonc` có `"name"` của Worker và bật nhật ký để đọc lỗi cũ về sau (AC-48e):
  `"observability": { "enabled": true }` (gói miễn phí giữ log 3 ngày, 200.000 sự kiện/ngày).
- Có bài thử nhanh gắn `@smoke` (chỉ ĐỌC, hoặc dùng tài khoản thử riêng — không ghi dữ liệu thật).
  `playwright.config` phải đọc `BASE_URL` → `use.baseURL` và `SMOKE_EXTRA_HTTP_HEADERS` (JSON) → `use.extraHTTPHeaders`.
  Thiếu hai chỗ này thì bài thử không nhắm được vào bản mới.
- **Mã bản trên mọi phản hồi** (để lệnh phát hành chắc bài thử chạm đúng bản mới, không chạm nhầm bản cũ): `wrangler.jsonc` thêm
  binding `"version_metadata": { "binding": "CF_VERSION_METADATA" }`, và Worker đặt header `x-flow-version` = `env.CF_VERSION_METADATA.id`
  trên phản hồi (mẫu Hono; framework khác bọc tương tự ở chỗ trả phản hồi):
  ```ts
  app.use('*', async (c, next) => { await next(); c.res.headers.set('x-flow-version', c.env.CF_VERSION_METADATA.id) })
  ```
  Worker thuần trả trang tĩnh qua `env.ASSETS.fetch(req)`: header của phản hồi đó không sửa được ⇒ chép ra trước rồi mới đặt:
  `const a = await env.ASSETS.fetch(req); const res = new Response(a.body, a); res.headers.set('x-flow-version', env.CF_VERSION_METADATA.id)`.
  Trang tĩnh được phục vụ thẳng từ `assets` không đi qua Worker nên KHÔNG có header: đặt `"assets": { "run_worker_first": true }`
  (dạng mảng như `["/api/*"]` thì `/` vẫn không qua Worker; hoặc `--url` trỏ vào đường do Worker xử lý). Đã chạy thật 2026-10-13
  (`run_worker_first: true`, `/` và `/api/*` đều có header). Thiếu header ⇒ `release cf` dừng, chưa mở bản mới cho ai.

## Phát hành
`node ~/.claude/hooks/release.mjs cf --url https://<địa-chỉ-thật> [--worker <tên>] [--zap-exit N] [--has-data] [--first-release]`

Lệnh tự làm theo thứ tự (dừng ngay nếu một bước trượt, người dùng chưa thấy gì):
1. **Build** — có script `build` thì chạy bằng trình quản lý gói của app (pnpm/yarn/npm) và in một dòng "Đã build bằng …"; build lỗi ⇒ dừng, chưa tải gì.
2. Kiểm trước phát hành (preflight) **trên bản vừa build** — gồm quét khoá bí mật trong chính bản sắp tải lên (không quét bản
   build cũ); chặn ⇒ chưa tải gì. Dự án chưa build lần nào không còn bị chặn vì thiếu bản build.
3. `wrangler versions upload` đúng bản đã quét — bản mới tải lên nhưng **chưa nằm trong deployment** nên chưa ai thấy.
4. **Gắn 0%:** đọc bản đang chạy 100% (`wrangler deployments status --json`) rồi
   `wrangler versions deploy <cũ>@100% <mới>@0% -y`. Bước này BẮT BUỘC: header ở bước 5 chỉ có tác dụng với bản đã nằm trong
   deployment, nếu bỏ thì bài thử chạy nhầm vào bản cũ và luôn "đạt".
5. **Xác nhận bản:** GET địa chỉ thật kèm header `Cloudflare-Workers-Version-Overrides: <worker>="<mã bản mới>"`, đọc `x-flow-version`
   trong phản hồi, dò lại tối đa 10 lần cách 2 giây tới khi đúng bằng mã bản mới (Cloudflare có thể chưa áp dụng ngay).
   Không khớp sau hết lượt (header chưa áp dụng, `--worker`/`--url` nhầm), hoặc không có header `x-flow-version` (chưa thêm binding) ⇒
   gỡ bản mới (cũ@100%), exit 1, KHÔNG mở. Không xác nhận được thì không mở.
6. Chạy `@smoke` vào địa chỉ thật, cùng header đó, để chỉ trúng bản mới.
7. Đạt mới mở: đọc lại deployment, chỉ khi vẫn đúng {cũ@100%, mới@0%} của lượt này mới chạy `wrangler versions deploy <mới>@100% -y`
   (có lượt phát hành khác vừa đổi app ⇒ dừng, không đụng, báo kiểm `wrangler deployments status`). Trượt ⇒ cũng đọc lại như vậy rồi
   tự gỡ bản mới (`versions deploy <cũ>@100% -y`), báo kèm lý do trượt (dòng Expected/Received của Playwright); bản cũ vẫn là bản
   người dùng đang dùng. Lệnh đổi lưu lượng báo lỗi/hết giờ ⇒ đọc lại deployment rồi mới kết luận (bản mới đã 100% thì báo đúng và
   vẫn ghi mốc; không đọc được thì nói "chưa rõ" kèm lệnh kiểm — đừng chạy lại khi chưa biết app đang chạy bản nào).
Mất mạng giữa chừng ⇒ bản mới đứng ở 0% (hoặc chưa vào deployment), chạy lại lệnh được. Xong: lưu `--url` đã thử làm `target`
(lượt sau bỏ `--url` vẫn thử đúng site này; `--url` khác `target` đã lưu thì có dòng "Cảnh báo"), ghi mốc nhắc xem lỗi sau 1 và 7 ngày
tính từ lúc mở 100%, và đếm số lần phát hành.

**Lần đầu (Worker chưa có trên Cloudflare):** `versions upload` bị Cloudflare từ chối ("…Worker that does not yet exist.
Please run the `deploy` command first"). Lệnh dừng (exit 3) và bảo thêm `--first-release`; có cờ này thì lệnh chạy
`wrangler deploy` để tạo Worker (chưa có người dùng nên không cần mở dần), kiểm `x-flow-version` của địa chỉ thật == "Current
Version ID" (thiếu header chỉ cảnh báo; header là bản khác ⇒ dừng vì `--url` nhầm app), rồi `@smoke` vào địa chỉ thật (không cần header override).
Trượt ⇒ báo thật: app đang chạy bản lỗi nhưng chưa ai dùng; sửa rồi chạy lại cùng lệnh (lúc đó Worker đã có nên đi đường
0% như thường). Cờ này không có tác dụng khi Worker đã tồn tại.

**Thử quay lại:** sau lần thứ 2 lệnh nhắc "nên thử quay lại một lần" (xem mục Quay lại); từ lần thứ 3 preflight chặn nếu chưa thử.

## Đổi biến bí mật
KHÔNG dùng `wrangler secret put` (nó phát hành ngay, lọt qua bài thử). Dùng `pnpm exec wrangler versions secret put <TÊN>` rồi
phát hành bằng lệnh trên (chưa chạy thật với tài khoản thật).

## Quay lại
`node ~/.claude/hooks/release.mjs rollback [--version-id <mã>] --url https://<địa-chỉ-thật>`
Về bản liền trước (hoặc bản chỉ định), rồi chạy `@smoke` lại; đạt thì ghi "đã thử quay lại" (preflight cần mục này từ lần
phát hành thứ 3). Làm đúng một lần sau khi đã có hai bản: nói user "sẽ thấy bản cũ vài giây", chạy lệnh trên, rồi phát hành
lại bản mới bằng lệnh `release cf`.
Nói user: dữ liệu D1/KV/R2 **không quay theo**. Wrangler từ chối quay khi giữa hai bản có đổi Durable Object hoặc bản
cũ trỏ tới tài nguyên đã xoá ⇒ nói rõ, hướng khác là phát hành tiến một bản sửa. Chỉ giữ 100 bản gần nhất.

## Xem lỗi
`node ~/.claude/hooks/release.mjs logs --since 24h`. Cần token **chỉ-đọc** quyền đọc Workers Observability trong biến
`CF_LOGS_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (không dán token vào chat/log). Xem lỗi trực tiếp: `pnpm exec wrangler tail
--format json --status error`.

# Gói nền và 20 mảng công nghệ

Dùng ở bước 2–4 của `flow-stack`. Đây là tư liệu để AI viết câu hỏi theo đúng app, không phải kịch bản.

## Mục lục
- Mẫu câu năm ý
- Gói nền
- Thứ tự hỏi và phụ thuộc
- Điều kiện bỏ câu
- Mảng 1 Loại app · 1b Khung cho webapp
- Mảng 2 Máy chủ · 3 Nhiều công ty · 4 Cơ sở dữ liệu · 5 Migration và thư viện truy vấn
- Mảng 6 Đăng nhập · 7 Lưu file · 8 Nơi chạy
- Mảng 9 Email · 10 SMS · 11 Thu tiền
- Mảng 12 Việc nền · 13 Tìm kiếm · 14 Cache · 15 Gọi AI
- Mảng 16 Lỗi và log · 17 Đo người dùng · 18 Tên miền · 19 Sao lưu · 20 Đa ngôn ngữ

## Mẫu câu năm ý

Mỗi câu hỏi user phải đủ năm ý, nói đời thường, kèm phí:
1. **Chọn gì** (đáp án khuyên dùng đứng đầu, một hai phương án khác).
2. **Vì sao** (tác động lên người dùng, tiền, công sức: "không ai phải canh lúc nửa đêm", "DB tự chặn khi AI quên").
3. **Chịu tới đâu** (số người hoặc lượt dùng thường gặp; chỗ có trần cứng thì nói).
4. **Lớn hơn thì đổi gì** (mốc đo được, đổi lớn hay nhỏ).
5. **Trói nhà cung cấp và lối thoát** (đau nhẹ, vừa, nặng; cách mang dữ liệu đi).

Phí ước tính **tra lúc hỏi** (kho `kho.mjs tim` trước, hết hạn thì `researcher` tra trang giá chính thức), nói kèm "theo bảng giá ngày …" và ghi `gia_tra_ngay`. File này không ghi giá; số giới hạn của gói dịch vụ cũng tra lại lúc hỏi. Lựa chọn mà kit chưa có cách làm sẵn ⇒ nói thẳng "rủi ro cao hơn vì kit chưa có mẫu".

Ký hiệu cột Kit: **mẫu** = có mẫu và công thức · **luật** = có luật an toàn, chưa có mẫu · **chưa có** = chưa có gì, rủi ro cao hơn.

## Gói nền

Câu đầu của buổi, **chỉ cho app có máy chủ** (hộp hỏi: Nhẹ · Chắc · Máy chủ riêng + "Chưa biết" ⇒ lấy gói AI gợi ý). Gói là bộ mặc định cho cả 20 mảng; user gật gói rồi chỉ chỉnh chỗ cần. AI đã gợi ý sẵn theo câu trả lời business. App máy tính chạy offline và extension không tài khoản không có máy chủ ⇒ `goi: tai-may` (dữ liệu nằm tại máy, SQLite; phát hành bản cài), bỏ câu gói và các mảng 2, 3, 4, 6, 8 theo bảng "Điều kiện bỏ câu".

| | **Nhẹ** (mặc định kit) | **Chắc** | **Máy chủ riêng** |
|---|---|---|---|
| Hợp với | Công cụ nhỏ, thử ý tưởng, dùng riêng hoặc vài trăm người; dữ liệu theo từng người; chưa thu tiền hoặc thu ít | Có thu tiền, nhiều công ty dùng chung, kỳ vọng hàng chục nghìn người trở lên, dữ liệu là tài sản chính (đặt lịch, quản lý khách) | Việc nặng hoặc chạy lâu (xử lý video, AI chạy riêng, hàng giờ CPU), hoặc user đã có máy chủ |
| Máy chủ | Cloudflare Workers + Hono (TypeScript) | Như Nhẹ | Go hoặc Node trên Fly.io/VPS |
| Cơ sở dữ liệu | Cloudflare D1 | Postgres (Supabase gói trả phí) qua Hyperdrive | Postgres cạnh máy chủ |
| Đăng nhập | Better Auth | Better Auth (hoặc Supabase Auth nếu theo mô hình Supabase không máy chủ) | Better Auth |
| Phí nền mỗi tháng | Rẻ nhất, gần 0 khi thử | Cao hơn Nhẹ một khoản cố định cho DB trả phí | Tiền máy hoặc VPS, cao nhất |
| Chịu tới đâu | Hàng nghìn tới vài chục nghìn người hoạt động mỗi ngày; mỗi DB có trần dung lượng cứng và xử lý từng câu một | Hàng trăm nghìn người; nâng cấu hình máy từng bậc | Theo cấu hình máy; cần có người trực |
| Lớn hơn thì đổi gì | Sang Postgres (đổi vừa; nhẹ nếu đã dùng lớp `store`) | Bản đọc phụ, cache, hàng đợi; chia dịch vụ chỉ khi nhiều đội | Thuê người vận hành |
| Kit làm tốt không | **mẫu** (mẫu + công thức D1) | Công thức `noi-luu-postgres-workers.md` của `flow-system-design` (Workers + Hyperdrive + Postgres + Drizzle + chặn quyền ở DB + bài kiểm); công thức Supabase không máy chủ có sẵn | Công thức VPS có, vận hành nặng hơn |

Luật gợi ý gói (user ưu tiên mở rộng lâu dài [p125]): **Chắc** khi (có thu tiền **hoặc** nhiều công ty **hoặc** kỳ vọng > 10.000 người/ngày **hoặc** cờ `nhay`, `nganh`, `tre-em`, vì cần DB khoá quyền) **và** trần chi mỗi tháng (B-CP1) đủ cho Chắc theo phí tra lúc hỏi. Dữ liệu nhạy cảm mà trần thấp hơn ⇒ vẫn khuyên Chắc, nói rõ vượt trần bao nhiêu mỗi tháng. Trần thấp hơn (không nhạy cảm) ⇒ đưa cả hai gói và khuyên theo **đáp án thật của B-UT1**: "Chạy chắc và riêng tư" ⇒ Chắc, nói rõ vượt trần bao nhiêu mỗi tháng; "Ra nhanh và rẻ" ⇒ Nhẹ, mọi truy vấn qua lớp `store` và ghi mốc đo được để chuyển sang Postgres (vd dung lượng DB chạm 80% trần, hoặc đổi cấu trúc dữ liệu cho nhiều công ty); "Dễ dùng và gọn" hoặc Chưa biết ⇒ theo quy mô và trần chi. Một người dùng, không đăng nhập, không tiền ⇒ Nhẹ. Việc chạy lâu hoặc cần ngôn ngữ khác TypeScript ⇒ hỏi thêm rồi mới tới Máy chủ riêng. Ngưỡng 10.000 lấy từ bảng hạng quy mô của kit, là kinh nghiệm không phải số đo. Lý do một câu cho gói Chắc: D1 có trần dung lượng không nâng được và không khoá quyền ở DB, còn Postgres có cả hai.

Cảnh báo bắt buộc nếu user chọn DB gói miễn phí của Supabase: tạm dừng khi lâu không dùng và **không có sao lưu**.

## Thứ tự hỏi và phụ thuộc

```
Business (số người, tiền, Việt Nam hay quốc tế, offline, ngân sách, trang công khai)
  → gói nền → 1 Loại app → 1b Khung web → 2 Máy chủ ─┬→ 8 Nơi chạy (gộp một thẻ với 2)
  → 3 Nhiều công ty ─────────────────────────────────┤
  → 4 DB (theo 3, tiền, quy mô, 8) → 5 Migration (theo 2, 4)
  → 6 Đăng nhập (theo 3, 4, thị trường)
  → 7 Lưu file · 9 Email · 10 SMS (theo 6) · 11 Thu tiền (theo 6, thị trường)
  → 12 Việc nền (theo 9, 10, 11, 15) · 13 Tìm kiếm (theo 4) · 14 Cache (chỉ khi đã đo)
  → 15 AI · 16 Lỗi · 17 Đo người dùng · 18 Tên miền · 19 Sao lưu (theo 4) · 20 Đa ngôn ngữ (sớm, trước khi viết màn)
```

Dồn thời gian vào nhóm **khó đổi**: loại app, DB, tách dữ liệu nhiều công ty, đăng nhập, tên miền. Nhóm **dễ đổi** (email, SMS, AI, lưu file, lỗi, đo, thu tiền) chỉ cần đáp án khuyên dùng và một dòng "đổi sau có dễ không", vì mỗi dịch vụ ngoài chỉ chạm qua MỘT hàm bọc.

## Điều kiện bỏ câu

- Công cụ nhỏ dùng riêng (một người, không đăng nhập, không tiền): bỏ 3, 6, 9, 10, 11, 12, 13, 14, 15 (nếu không gọi AI), 17, 20 (giữ nếu sẽ chia sẻ ngoài nước). Còn 1, 2 (hoặc không cần máy chủ), 4, 8, 19; 16 chỉ khi chạy trên máy chủ (công cụ chạy trên máy mình thì bỏ, như "Bỏ câu khi" của mảng 16); 18 chỉ khi có trang công khai (như "Bỏ câu khi" của mảng 18).
- App máy tính chạy offline (`goi: tai-may`, bỏ câu gói): mảng 4 là SQLite tại máy; bỏ 2, 3, 6, 8 (chỉ còn "phát hành bản cài ở đâu"), 9, 10, 11 (trừ khoá bản quyền), 12, 14.
- Extension không tài khoản (`goi: tai-may`, bỏ câu gói): bỏ 2, 3, 4, 6, 8, 11.
- App đang có code: mảng nào đã dùng thì ghi "Đang dùng", không hỏi; chỉ hỏi mảng chưa chốt.

## Mảng 1. Loại app

Hỏi: người dùng mở app ở đâu (trình duyệt, cài lên máy tính, nút trong trình duyệt, điện thoại)? Có cần dùng khi mất mạng không?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Web** | Mở bằng trình duyệt, không cài; hầu hết app có tài khoản, thu tiền, chia sẻ nhóm | Không trần cứng; lớn hơn: tách trang công khai khỏi phần đăng nhập (xem 1b) | Không trói | mẫu |
| **App máy tính** (Wails: lõi Go + giao diện React) | Windows/Mac; dữ liệu nằm tại máy; dùng được khi offline; một người một máy | Một máy; muốn nhiều máy/nhóm phải thêm đồng bộ (đổi lớn nhưng kit dặn chừa chỗ: ID tạo tại máy, `updated_at`, đánh dấu xoá). Bản đã cài không tự cập nhật: chọn kiểu tải ngầm hoặc báo + nút Tải | Không trói nhà cung cấp. Phí ký số và notarize tra lúc hỏi | mẫu |
| **Extension trình duyệt** (Chrome) | Nút/popup làm việc trên trang web đang xem | Trong khuôn khổ Chrome, không tải mã từ xa; bản cũ nằm lại trên máy nên máy chủ phải chịu được bản cũ; thu tiền phải qua web riêng | Trói cửa hàng Chrome (duyệt, chính sách). Phí đăng cửa hàng tra lúc hỏi | mẫu |
| **App điện thoại** | Cài từ cửa hàng; cần thông báo đẩy ổn định, camera, chạy nền | Ba đường leo dần, đau tăng theo bậc: web cài vào màn hình (PWA) → bọc webapp có sẵn (Capacitor) → app gốc (Expo/React Native) | Trói cửa hàng Apple/Google; tài khoản Google cá nhân mới còn phải qua bước thử nghiệm theo quy định. Phí tra lúc hỏi | **chưa có**: rủi ro cao hơn |

Khuyên: **web trước** (giao diện co giãn được trên điện thoại, thêm PWA nếu cần) dù đích cuối là app điện thoại. Vì kit làm tốt web, một máy chủ và DB dùng chung được cho mọi loại app sau, app gốc đầu tiên không phải đập đi. Chỉ làm app gốc khi có đòi hỏi thật.
Mốc: khách đòi thông báo đẩy tin cậy, camera hoặc chạy nền ⇒ cân nhắc bọc webapp (Capacitor).
Bỏ câu khi: loại app đã rõ từ lời kể (B-PV13 chỉ là mặc định theo lời kể, chưa hỏi ở buổi business).

## Mảng 1b. Khung cho webapp (chỉ khi là web)

Hỏi: khách có tìm thấy bạn qua Google không? Có gửi link từng sản phẩm/bài lên Zalo/Facebook và muốn hiện đúng ảnh, tên không? Có khu chỉ người đã đăng nhập không? Chỉ vài trang cố định hay nhiều trang sinh từ danh sách? Sau 1–2 năm khoảng bao nhiêu trang công khai (chục, trăm, nghìn, chục nghìn)?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **`web-public`** (React Router chế độ framework trên Cloudflare Workers) | Cần Google tìm thấy hoặc link chia sẻ hiện đúng ảnh/tên từng trang; trang sản phẩm/bài lấy từ DB; có khu đăng nhập cùng app | Trang dựng sẵn ở máy chủ nên Google và Zalo/Facebook đọc được ngay. Không dựng sẵn cả trăm nghìn trang lúc build: dựng khi có người xem rồi cho mạng phân phối (CDN) giữ. Lớn hơn: CDN giữ trang công khai → tách khu quản trị ra Worker riêng (chuyển thư mục, không viết lại giao diện) | Không trói riêng: React + Cloudflare, mã dời được | Mẫu loại app mới `web-public`. Khung còn mới ⇒ ghim bản đã vá, quét lỗ hổng mỗi lần kiểm. Gói miễn phí giới hạn CPU mỗi lượt, trang dựng ở máy chủ có thể không đủ ⇒ tính gói trả phí |
| **`web`** (webapp một trang, mẫu hiện có) | Không cần Google, không chia sẻ link, chỉ người đăng nhập dùng (công cụ nội bộ, bảng điều khiển) | Tệp tĩnh, rẻ nhất; Google và Zalo/Facebook chỉ thấy trang gần trống. Khi cần Google ⇒ chuyển sang `web-public` | Không trói | mẫu |
| Khung khác (Astro, Next.js, TanStack Start) | Chỉ khi user đòi và đã nghe đánh đổi | — | — | **chưa có**: máy kiểm của kit chưa phủ, rủi ro cao hơn; không đề xuất |

Khuyên: hỏi "Google" hoặc "chia sẻ link" trả lời Có ⇒ `web-public`; cả hai Không ⇒ `web`. **"Chưa biết" ⇒ `web-public`** nếu B-KN2 có Google, Facebook hoặc Zalo, hoặc khách là người ngoài (B-TQ2); hồ sơ dùng riêng hoặc nội bộ ⇒ `web`. Vì dùng lại giao diện và máy kiểm của kit, lớn lên chỉ chuyển chỗ.
Mốc: số trang công khai lên tới hàng chục nghìn ⇒ CDN giữ bản sao và sitemap chia nhiều file; khu quản trị cần tên miền khác hoặc đội riêng ⇒ Worker riêng; gói miễn phí báo hết CPU ⇒ gói trả phí.
Bỏ câu khi: app máy tính, extension. Ghi loại chọn vào `loai_app` để `flow-new-app` dùng, không hỏi lại.

## Mảng 2. Phía máy chủ và ngôn ngữ

Hỏi: app có cần nơi chạy việc riêng trên mạng (kiểm tra quyền, nhận thanh toán, gọi AI) không? Có việc nào chạy lâu hơn vài chục giây không? (User không phải chọn ngôn ngữ.)

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **TypeScript trên Cloudflare Workers + Hono** | Mã chạy theo từng lượt gọi, nền tảng tự co giãn, không thuê máy | Gói miễn phí có trần lượt và CPU mỗi lượt, gói trả phí rộng hơn nhiều (số tra lúc hỏi). Lớn hơn: việc nặng đẩy sang hàng đợi hoặc container | Hono chạy được cả Node/Bun nên mã nghiệp vụ dời được; chỗ dính Cloudflare chỉ là binding nằm trong lớp `store`/adapter ⇒ thoát = đổi adapter | mẫu |
| **Go** | Lõi app máy tính; dịch vụ tính toán nặng | Không chạy tự nhiên trên Workers; cần nơi chạy container hoặc máy (Fly.io, VPS) | Không trói; phải có người vá lỗi, sao lưu | mẫu cho desktop; máy chủ Go cho web **chưa có** |
| **Node (TypeScript) trên máy chủ thường** (Fly.io, VPS) | Cần thư viện Node không chạy được trên Workers, hoặc việc chạy lâu | Theo cấu hình máy; "máy treo lúc 2 giờ sáng" thuộc về user | Không trói | luật (công thức VPS có), vận hành nặng hơn |

Khuyên: TypeScript trên Workers + Hono cho web và extension; Go chỉ trong lõi app máy tính. Vì một ngôn ngữ từ giao diện tới máy chủ, kit đã dựng và kiểm thử sẵn, không máy nào để người không code phải trông.
Mốc: có việc chạy lâu hoặc thư viện không chạy trên Workers ⇒ thêm một dịch vụ Node/Go riêng cho đúng việc đó, không đổi cả app. Có đăng nhập mật khẩu hoặc trang dựng ở máy chủ ⇒ tính gói trả phí của Workers.
Bỏ câu khi: app máy tính thuần offline, extension không tài khoản.

## Mảng 3. Nhiều công ty dùng chung một app

Hỏi: mỗi khách của bạn là một cá nhân hay cả một công ty có nhiều nhân viên? Dữ liệu công ty này lộ sang công ty kia thì hậu quả thế nào? Có công ty nào đòi dữ liệu nằm riêng không?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Một DB Postgres, mọi bảng có cột mã công ty (`tenant_id`) + khoá ở DB (RLS)** | Công ty ở chung bảng, DB tự từ chối dòng không thuộc mình dù code sót | Tới hàng trăm nghìn công ty nhỏ cho một DB; lớn hơn: bản đọc phụ. Thêm cột `tenant_id` **sau khi đã có dữ liệu** thì phải gán lại mọi hàng, dễ sót ⇒ chừa cột từ đầu | Postgres chuẩn, thoát dễ | luật + công thức Postgres |
| **D1 + `tenant_id` + chặn ở code** | Như trên nhưng D1 không có RLS: mọi truy vấn tự nhớ `WHERE tenant_id=?` (AI hay quên nhất) | Trần dung lượng cả DB; mỗi DB xử lý từng câu một | Thoát qua Postgres | mẫu |
| **Mỗi công ty một DB D1 riêng** | Cách ly mạnh nhất, xoá/xuất dữ liệu một công ty dễ | Báo cáo gộp và đổi cấu trúc dữ liệu phải chạy qua từng DB ⇒ đau khi nhiều công ty | Dính D1 | luật (chỉ nhắc), **chưa có** mẫu |
| **Better Auth plugin `organization`** | Chỉ lo thành viên, vai trò, mời bằng email; **không** tự tách dữ liệu hàng | Chạy cùng DB đã chọn | Mã nguồn mở | dùng kèm một trong ba phương án trên |

Khuyên: có "công ty/nhóm" ⇒ **một DB Postgres + `tenant_id` + RLS** (gói Chắc) kèm plugin `organization`. Vì người viết code là AI, hàng rào cuối cùng phải nằm ở DB chứ không ở trí nhớ của AI. Chỉ đi D1-mỗi-công-ty khi khách đòi dữ liệu nằm riêng hoặc xuất/xoá theo công ty là nhu cầu lõi.
Mốc: một công ty đòi dữ liệu nằm riêng ⇒ xét tách DB cho công ty đó.
Bỏ câu khi: mỗi người chỉ thấy dữ liệu của chính mình, không có khái niệm công ty/nhóm. Câu MR2 "về sau có thể nhiều công ty" vẫn phải chừa cột `tenant_id`.

## Mảng 4. Cơ sở dữ liệu

Hỏi: dữ liệu này mất thì hậu quả thế nào? Nhiều người cùng ghi một lúc không? Hai năm nữa khoảng bao nhiêu người? Ngân sách mỗi tháng cho nền móng?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Cloudflare D1** (SQLite) | Cùng nhà với Workers; dữ liệu theo từng người/nhóm; công cụ nhỏ | Mỗi DB có trần dung lượng không nâng được và xử lý từng câu một (quá tải trả lỗi "overloaded"); gói miễn phí chặn truy vấn khi chạm trần ngày. Không RLS. Lớn hơn: chia theo công ty hoặc chuyển Postgres (đổi vừa) | Dính Cloudflare; dữ liệu là SQLite chuẩn, xuất được (`flow-backup`); thoát phải viết lại schema theo Postgres | mẫu |
| **Postgres qua Supabase** | Postgres kèm đăng nhập, lưu file, bảng điều khiển; RLS khoá quyền ngay tại DB | Gói trả phí có sao lưu hằng ngày và không bị tạm dừng; gói miễn phí tạm dừng khi lâu không dùng và không sao lưu. Lớn hơn: nâng cấu hình, bản đọc phụ | Postgres chuẩn, `pg_dump` mang sang nhà khác; phần dính nhất là chính sách RLS theo `auth.uid()` và Supabase Auth (đau vừa) | mẫu (công thức Supabase, không máy chủ) + công thức Workers + Hyperdrive |
| **Postgres qua Neon** | Mỗi nhánh dữ liệu tạo tức thì, hợp mỗi làn một DB thử | Tính theo dùng; tự tắt khi không dùng. Không kèm đăng nhập/file ⇒ ghép Better Auth + R2 | Postgres chuẩn | **chưa có** công thức riêng: rủi ro cao hơn |
| **Postgres tự quản (VPS)** | User đã có máy | Tuỳ máy; tự vá, sao lưu, giám sát | Không trói | luật; vận hành nặng nhất |

Workers nói chuyện với Postgres qua **Hyperdrive** (bộ gom kết nối của Cloudflare), hoặc qua HTTP bằng thư viện của Supabase.
Khuyên: gói Nhẹ giữ D1; gói Chắc **Postgres gói trả phí của Supabase**. Vì DB chặn quyền dùm khi AI quên, có sao lưu tự động, một bảng điều khiển cho DB + đăng nhập + file, Postgres chuẩn nên không bị nhốt, phí cố định dễ lường. Neon khi cần nhánh thử cho từng làn. Chọn vùng đặt DB gần Việt Nam (Singapore hay dùng; chưa xác nhận nhà nào có vùng đặt ở Việt Nam, độ trễ chưa đo).
Mốc: D1 gần trần dung lượng hoặc báo "overloaded" ⇒ chuyển Postgres. Postgres: CPU DB > 70% liên tục 1 tuần ⇒ bản đọc phụ; đọc nóng đã đo ⇒ cache; báo cáo nặng làm chậm app ⇒ kho phân tích riêng; bảng cỡ trăm triệu hàng ⇒ chia nhỏ.
Bỏ câu khi: app máy tính offline (SQLite tại máy).

## Mảng 5. Đổi cấu trúc dữ liệu và thư viện truy vấn

Hỏi (chỉ mức hành vi): khi cần thêm một ô dữ liệu mới, chấp nhận app dừng vài phút hay muốn không bao giờ dừng? Trước mỗi lần đổi, muốn app tự sao lưu rồi mới đổi chứ? Phần còn lại AI tự chốt.

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Drizzle** (ghim bản ổn định 0.45.x, trong lớp `store`) | Kiểu dữ liệu chặt, hợp AI viết; có bản cho cả D1 và Postgres nhưng hai bộ schema riêng | Bản 1.0 còn ở mức thử ⇒ ghim bản ổn định, theo dõi bước lên 1.0. Đổi D1 → Postgres vẫn viết lại file schema nhưng truy vấn trong `store` sửa ít | Mã nguồn mở; thoát = viết SQL thô trong `store` | **chưa có** (thêm thư viện phải qua cổng thư viện của kit) |
| **SQL thô + file migration** | Không thêm thư viện; cấm ghép chuỗi | AI dễ sai tên cột; đổi D1 → Postgres phải rà từng câu | Không trói | mẫu |
| **Công cụ migration của nền tảng** | D1: `wrangler d1 migrations apply`; Supabase: `supabase db push` (không dùng `migration down`: xoá sạch dữ liệu rồi áp lại) | Chỉ tiến; lùi bằng migration sửa tiến hoặc khôi phục sao lưu | — | mẫu (mở rộng rồi mới thu hẹp, thử trên DB thử, lưu mốc khôi phục trước) |

Khuyên: giữ quy trình migration của kit và thêm Drizzle trong lớp `store`. Vì AI ít viết sai tên cột và khi phải đổi DB thì chỉ sửa một lớp. Gói Nhẹ giữ SQL thô vẫn chấp nhận được.
Mốc: Drizzle ra bản 1.0 ổn định ⇒ xem lại bản ghim.
Bỏ câu khi: không có DB.

## Mảng 6. Đăng nhập

Hỏi: khách quen đăng nhập bằng cách nào (Google, Zalo, số điện thoại, email)? Có cần xác thực hai lớp, chia vai trò, mời đồng nghiệp?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Better Auth** | Chạy ngay trong máy chủ của bạn, dữ liệu tài khoản ở DB của bạn; có sẵn plugin vai trò/công ty, mã email, hai lớp, nối nhà đăng nhập OAuth bất kỳ | Không trần người dùng riêng, theo DB và Workers. Lớn hơn: thêm hai lớp, vai trò | Mã nguồn mở, bạn giữ bảng người dùng; đổi nhà đăng nhập về sau đau (nơi lưu mật khẩu băm) nhưng dữ liệu trong tay bạn | mẫu |
| **Supabase Auth** | Đi kèm Supabase, gắn thẳng RLS | Có hạn mức người dùng hoạt động theo gói (tra lúc hỏi); SMS qua nhà gửi, có thể thay bằng nhà Việt Nam | Dính Supabase (RLS theo `auth.uid()`); thoát = chuyển người dùng sang bảng của bạn | mẫu trong công thức Supabase |
| **Clerk** | Dịch vụ đăng nhập trả sẵn, giao diện đẹp | Tính theo số người dùng giữ lại; phí tổ chức nhiều công ty riêng | Dữ liệu người dùng nằm ở Clerk, thoát đau | **chưa có**: rủi ro cao hơn |
| **Đăng nhập Google** | Qua OAuth, miễn phí, hầu như ai cũng có tài khoản | Chạy trên cả ba nền ở trên | — | luật OAuth. Webapp cần Google ⇒ khuyên `web-public` ở mảng 1b |
| **Đăng nhập Zalo** | Khách chủ yếu dùng Zalo | Phải đăng ký ứng dụng và xác thực tên miền; khả năng lấy số điện thoại chưa xác minh | Dính Zalo; nối qua nhà đăng nhập OAuth của Better Auth | **chưa có** mẫu |
| **Số điện thoại + mã OTP** | Nghiệp vụ buộc phải có số đã xác minh (giao hàng, đặt lịch, ngân hàng) | Mỗi mã là một khoản tiền và là chỗ kẻ xấu bơm tin nhắn ⇒ xem mảng 10 | — | luật OTP, chưa có mẫu Việt Nam |

Khuyên: **Better Auth** với **Google + email mã/liên kết**. Vì tài khoản là thứ khó đổi nhất sau DB, giữ trong DB của mình thì không ai khoá được mình, không tính phí theo người dùng. Zalo chỉ khi khách chủ yếu dùng Zalo và chấp nhận kit chưa có mẫu; số điện thoại + SMS chỉ khi nghiệp vụ buộc. Mô hình Supabase không máy chủ thì lấy Supabase Auth.
Mốc: người dùng hoạt động chạm hạn mức của gói dịch vụ đăng nhập đang dùng ⇒ nâng gói hoặc chuyển.
Bỏ câu khi: không có tài khoản người dùng.

## Mảng 7. Lưu file

Hỏi: người dùng có tải ảnh/tệp lên không, cỡ lớn nhất và tổng cộng khoảng bao nhiêu? Ai được xem: chỉ chủ, cả nhóm, hay công khai?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Cloudflare R2** | Web chạy trên Workers | Không trần thực tế; tải về không tính phí băng thông ra | Giao diện S3 chuẩn nên đổi nơi bằng copy dữ liệu; thoát dễ | mẫu |
| **Supabase Storage** | Đã theo mô hình Supabase | Gói có sẵn dung lượng và băng thông, vượt thì tính thêm (tra lúc hỏi) | Dính Supabase nhưng dễ chuyển | mẫu trong công thức Supabase |
| **Amazon S3** | Đã có tài khoản AWS | Tra lúc hỏi | Chuẩn của ngành | **chưa có** |

Khuyên: R2 cho web trên Workers; Supabase Storage nếu đã theo Supabase. Vì rẻ, không phí băng thông ra, giao diện S3 nên đổi được. Tệp tải qua đường link có chữ ký, hạn ngắn; không ép tệp đi qua máy chủ app.
Mốc: tổng dung lượng vượt phần miễn phí ⇒ trả phí (nhỏ); cần quét mã độc hoặc ảnh lớn ⇒ xét xử lý ảnh riêng.
Bỏ câu khi: app không có tệp người dùng.

## Mảng 8. Nơi chạy

Hỏi: khách chủ yếu ở Việt Nam hay nước ngoài? Chịu được trang chậm vài giây lần mở đầu không? Có sẵn máy chủ hoặc tài khoản đám mây nào chưa?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Cloudflare** (Workers + trang tĩnh) | Mọi thứ một nhà, không máy để trông, có mạng phân phối toàn cầu | Xem mảng 2 | Dính binding Cloudflare, mã Hono dời được | mẫu (có công thức phát hành, bài thử nhanh, quay lại bản trước) |
| **Vercel** | Gắn chặt với Next.js | Gói miễn phí có trần dùng và dành cho dùng cá nhân (kiểm điều khoản lúc hỏi); gói trả phí tính theo người triển khai | Dính tính năng riêng của Vercel | **chưa có** công thức phát hành |
| **Fly.io** | Máy ảo nhỏ nhiều vùng, hợp Go/Node chạy liên tục | Không còn gói miễn phí cho tổ chức mới (kiểm lúc hỏi) | Chạy container chuẩn, dời được | **chưa có** |
| **VPS** | User đã có máy | Tự vá, tự sao lưu, tự canh nhật ký | Không trói | luật; vận hành nặng nhất cho người không code |

Khuyên: **Cloudflare** cho gói Nhẹ và Chắc; Fly/VPS chỉ ở gói Máy chủ riêng. Vì không máy nào phải canh lúc nửa đêm, kit có sẵn quy trình phát hành và quay lại bản trước.
Mốc: CPU mỗi lượt chạm trần gói đang dùng ⇒ gói trả phí; cần việc nặng ⇒ mảng 2.
Bỏ câu khi: app máy tính/extension không có phần máy chủ (chỉ còn "phát hành bản cài ở đâu", GitHub Releases).

## Mảng 9. Gửi email

Hỏi: app có gửi email cho người dùng (xác nhận đăng ký, quên mật khẩu, hoá đơn, thông báo) không? Ngày đông nhất khoảng bao nhiêu thư?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Resend** | API gọn, dễ gắn vào Workers | Gói miễn phí có trần số thư; chạm trần thì thư (kể cả mã đăng nhập) có thể không đi được — tra hành vi hiện hành lúc chọn, đặt báo động trước khi chạm trần hoặc bật trả phí vượt mức | Thư gửi từ tên miền của bạn (SPF/DKIM/DMARC) nên đổi nhà là đổi DNS + một hàm bọc, không đau | luật (một hàm bọc, hàng đợi, chống trùng) |
| **Cloudflare Email Service** | Gửi từ Workers | Còn beta, chưa nêu giá ổn định (kiểm lúc hỏi) | Dính Cloudflare | **chưa có** |
| **Amazon SES / Postmark** | SES rẻ khối lượng lớn nhưng tự dựng nhiều; Postmark gọn nhưng đắt hơn | Tra lúc hỏi | — | **chưa có** |

Khuyên: Resend gói trả phí thấp nhất khi ra mắt công khai; gói miễn phí chỉ để thử. Vì ít cài đặt, thư vào hộp thư thật thay vì spam nếu cài SPF/DKIM/DMARC, đổi nhà chỉ đổi một hàm.
Mốc: thư/ngày chạm trần gói ⇒ nâng gói; tỉ lệ thư vào spam tăng ⇒ kiểm DNS và nội dung.
Bỏ câu khi: app không có tài khoản và không gửi thông báo.

## Mảng 10. SMS và mã OTP ở Việt Nam

Hỏi: có thật sự cần SMS, hay email/Zalo/Google là đủ? Mỗi tin là một khoản tiền; ngân sách SMS mỗi tháng?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Không dùng SMS** (OTP qua email, Google) | Mặc định an toàn nhất, không có khoản tiền để kẻ xấu bơm | Không trần | — | mẫu |
| **SMS qua nhà gửi Việt Nam** | Tin có tên thương hiệu đến thẳng số Việt Nam | Mỗi mã là một khoản chi ⇒ giới hạn theo số + IP + tổng mỗi ngày. Quy định tin quảng cáo và tên thương hiệu đổi nhiều (tra ngày, hỏi nhà gửi) | Một hàm bọc ⇒ đổi nhà dễ | luật OTP, **chưa có** mẫu |
| **Zalo ZNS** (tin nhắn mẫu qua Zalo) | Cần Zalo Official Account đã xác minh | Giá và tên gói đổi (tra lúc hỏi) | Dính Zalo | **chưa có** |
| **Supabase Auth phone + nhà gửi quốc tế** | Đi sẵn trong Supabase | Tới Việt Nam thường đắt hơn nhà nội địa; có móc gửi SMS để thay bằng nhà Việt Nam | — | luật |

Khuyên: **mặc định không dùng SMS khi user chưa nói gì về tin nhắn**. Chỉ khi nghiệp vụ buộc phải có số đã xác minh thì dùng nhà Việt Nam qua một hàm bọc, kèm hạn mức theo ngày và cảnh báo khi vượt. Vì SMS là khoản tiền hay bị lợi dụng nhất ("bơm tin nhắn") và kéo theo thủ tục tên thương hiệu. **Mặc định thua điều user đã nói:** B-PV9 `[Bạn nói]` có nhắc hoặc thông báo qua tin nhắn ⇒ hỏi kênh (Zalo, SMS, email) theo cách khách đang dùng (B-VD2, B-KH6) rồi khuyên kênh rẻ nhất khớp; kit chưa có mẫu không phải lý do bỏ: nói thẳng "rủi ro cao hơn", làm thành việc đầu tiên kèm trần chi (B-CP1) và bài kiểm.
Mốc: chi SMS tháng chạm 80% trần ngân sách ⇒ ngắt và báo chủ.
Bỏ câu khi: đăng nhập không dùng số điện thoại, không thông báo qua SMS.

## Mảng 11. Thu tiền

Hỏi: khách chủ yếu trả bằng gì (chuyển khoản/QR, thẻ, ví, thẻ quốc tế)? Thu một lần hay gói hàng tháng? Đã có hộ kinh doanh/công ty chưa? Bán sang nước ngoài không?

**Khách Việt Nam**

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **SePay** | Chỉ cần "thấy tiền về rồi mở quyền": đọc biến động số dư ngân hàng của bạn, báo về webhook ký chữ ký; tiền khách chuyển thẳng vào tài khoản bạn | Số ngân hàng kết nối và hạn mức giao dịch theo gói (tra lúc hỏi). Bản chất là đối soát nên đổi nhà dễ. **Chỉ báo tiền vào**: hoàn cọc/hoàn tiền là việc của chủ (chuyển lại hoặc lệnh qua ngân hàng), skill SePay có tài liệu hoàn tiền (`references/refunds.md` trong skill) để đọc khi làm tính năng này | Đổi cổng = đổi một hàm bọc + đối soát | **skill chính hãng** (kit đã đăng ký) |
| **payOS** | Cổng mã VietQR, tiền về thẳng ngân hàng của bạn | Chuyển khoản một lần, **không tự trừ định kỳ** ⇒ gói tháng nghĩa là mỗi kỳ khách quét lại mã. Phí và điều kiện tra lúc hỏi | Đổi cổng = đổi một hàm bọc | **kit chưa có skill**: gợi ý được, ghi rõ "rủi ro cao hơn" |
| **VNPay / MoMo** | Khách quen trả thẻ nội địa hoặc ví | Hộ kinh doanh có thể cần giấy phép kinh doanh; phí tra lúc hỏi | Dính từng cổng | **chưa có** |

**Khách nước ngoài**

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Bên bán hộ lo thuế** (Polar; Dodo, Paddle cần user xác nhận giấy tờ và điều kiện) | Bán cho khách nước ngoài: bên đó đứng ra bán, tự lo thuế bán hàng/VAT rồi trả tiền cho bạn | Tra lúc hỏi: nước được chi trả về Việt Nam, phí mỗi giao dịch, phí chi trả. Bạn vẫn tự chịu thuế thu nhập ở Việt Nam | Đổi nhà bán hộ + đối soát | skill **`payment-integration`** (nguồn đã duyệt, cài mức dự án) |
| **Stripe** | Cổng thẻ quốc tế phổ biến | Tra lại danh sách nước được hỗ trợ lúc hỏi: nếu chỉ có thực thể Việt Nam thì thường không phù hợp | — | `payment-integration` nếu thực thể đủ điều kiện |

Không gợi ý: **Lemon Squeezy** (đã đóng đăng ký mới ngày 16/11/2026, ngừng xử lý thanh toán ngày 31/03/2027); mọi dịch vụ tra ra đã đóng hoặc ngừng nhận đăng ký.

Khuyên: khách Việt ⇒ **SePay** nếu chỉ cần thấy tiền về, hoặc payOS nếu user muốn cổng có trang thanh toán (nói rõ kit chưa có skill); khách quốc tế ⇒ bên bán hộ đã xác nhận trả tiền về Việt Nam. Bán định kỳ cho khách Việt: nói thẳng mỗi kỳ phải thanh toán lại. Thu cọc rồi có thể phải hoàn (B-TG9): chuyển khoản không tự hoàn, nên nói rõ ai hoàn và bằng cách nào; với SePay xem tài liệu hoàn tiền của skill. Dù chọn cổng nào, luật an toàn của kit giữ nguyên (`ban-mau-tien.md` của `flow-system-design`): cổng là nguồn sự thật, kiểm chữ ký webhook, chống trừ tiền hai lần, số tiền tính ở máy chủ, đối soát định kỳ, có bài kiểm.
Nhắc hỏi kế toán: hoá đơn điện tử, thuế thu nhập trên tiền nhận từ nước ngoài, điều kiện hộ kinh doanh/công ty để mở cổng nội địa (văn bản gốc chưa đối chiếu; tra ngày).
Mốc: số giao dịch/tháng chạm hạn mức gói của nhà cung cấp ⇒ nâng gói; đối soát lệch ⇒ dừng mở quyền tự động, báo chủ.
Bỏ câu khi: không thu tiền (B-TG1 miễn phí hẳn).

## Mảng 12. Việc chạy nền, hàng đợi, hẹn giờ

Hỏi: có việc nào người dùng không nên ngồi đợi (gửi nhiều thư, xuất báo cáo, gọi AI lâu) hoặc phải chạy theo lịch (đối soát thanh toán mỗi đêm, nhắc hạn)?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Cloudflare Queues + Cron** | Hàng đợi tự thử lại; lịch chạy định kỳ | Gói miễn phí có trần thao tác mỗi ngày, gói trả phí rộng hơn (tra lúc hỏi). Lớn hơn: thêm Workflows cho chuỗi nhiều bước | Dính Cloudflare; hàm bọc ⇒ đổi hàng đợi chỉ đổi adapter | mẫu |
| **Cloudflare Workflows** | Chuỗi nhiều bước bền, có thể ngủ vài ngày | Trạng thái chính thức và giá cần kiểm lại lúc hỏi | Dính Cloudflare | **chưa có** |
| **Inngest / Trigger.dev** | Có máy chủ Node chạy liên tục | Thêm một nhà | Tách khỏi Cloudflare | **chưa có** |

Khuyên: Queues + Cron; thêm Workflows khi gặp chuỗi nhiều ngày; Inngest/Trigger.dev chỉ ở gói Máy chủ riêng.
Mốc: lượt hàng đợi chạm hạn mức gói ⇒ trả phí; có chuỗi nhiều ngày ⇒ Workflows.
Bỏ câu khi: mọi việc xong trong vài trăm mili-giây ngay trong lượt gọi và không có lịch.

## Mảng 13. Tìm kiếm

Hỏi: người dùng có gõ vào ô tìm không? Gõ sai dấu tiếng Việt, gõ thiếu chữ vẫn phải ra kết quả không? Có bao nhiêu mục có thể tìm (nghìn, trăm nghìn, triệu)?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Tìm ngay trong DB** | Dùng chính DB, không thêm hệ thống | D1: tìm toàn văn (FTS5), **bẫy tiếng Việt**: phải đặt `remove_diacritics=2` mới bỏ dấu đúng, tìm một phần của từ cần bộ tách trigram. Postgres: phần mở rộng `unaccent` và `pg_trgm` | Không trói | **chưa có** mẫu |
| **Meilisearch / Typesense** | Tìm kiếm là tính năng lõi, gõ sai vẫn ra, gợi ý khi gõ | Hợp từ hàng trăm nghìn mục. Kiểm giấy phép trước khi tự chạy (có bản copyleft) | Thêm một hệ thống phải trông | **chưa có** |

Khuyên: **tìm trong DB** cho tới khi tìm kiếm là lý do khách dùng app; khi lên máy tìm kiếm riêng thì thuê dịch vụ quản lý, không tự chạy.
Mốc: tìm kiếm thành tính năng chính hoặc quá trăm nghìn mục ⇒ dịch vụ tìm kiếm.
Bỏ câu khi: không có ô tìm kiếm văn bản.

## Mảng 14. Cache

Chỉ hỏi khi đã có số đo (tỉ lệ trúng cache, CPU DB). Hỏi: có trang nào hàng nghìn người cùng xem một nội dung hầu như không đổi không?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Cache của mạng phân phối (CDN)** | Trang/tệp công khai được lưu gần người xem | Không trần thực tế | — | có sẵn với Cloudflare |
| **Workers KV** | Kho khoá-giá trị đọc nhanh, ghi chậm đổi | Gói miễn phí giới hạn ghi mỗi ngày rất thấp (tra lúc hỏi) | Dính Cloudflare | luật (`cache.md` của `flow-system-design`) |

Khuyên: **không cache lúc đầu**; CDN cho trang công khai; KV khi đo thấy đọc nóng; mọi khoá cache chứa mã công ty; phản hồi sau đăng nhập luôn `private, no-store`.
Mốc: đọc nóng đã đo hoặc CPU DB > 70% liên tục ⇒ cache.
Bỏ câu khi: hạng prototype/MVP, chưa đo.

## Mảng 15. Gọi AI

Hỏi: tính năng AI nào, mỗi người dùng gọi bao nhiêu lần, ai trả tiền (bạn hay người dùng)? Dữ liệu gửi cho AI có nhạy cảm không? Có thẻ quốc tế để nạp tiền cho nhà cung cấp không?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Gọi thẳng một hãng** (qua hàm bọc `callModel`) | Một model, ít lớp trung gian | Theo hạn mức hãng; có model dự phòng thì hàm bọc tự đổi | Hàm bọc ⇒ đổi hãng chỉ sửa một file | mẫu |
| **Cloudflare AI Gateway** | Cache câu trả lời, giới hạn tần suất, bảng số liệu | Theo Cloudflare | Dính nhẹ, đặt sau hàm bọc | mẫu |
| **OpenRouter** | Thử nhiều model, tự chuyển khi lỗi | Có phí nền tảng khi nạp tiền (tra lúc hỏi) | Thêm một bên trung gian; thoát dễ nhờ hàm bọc | **chưa có** |

Khuyên: hàm bọc của kit + gọi thẳng một hãng, AI Gateway đặt phía sau. Vì hãng đổi giá, đổi model liên tục ⇒ nơi đổi duy nhất phải là hàm bọc; AI là khoản tiền đội nhanh nhất nên trần chi theo người dùng là bắt buộc. Nhắc: nạp tiền hãng nước ngoài cần thẻ quốc tế (người dùng cuối không phải lo).
Mốc: chi AI chạm 80% trần tháng ⇒ ngắt tính năng và báo chủ; cần dự phòng model ⇒ AI Gateway hoặc OpenRouter.
Bỏ câu khi: không có tính năng AI.

## Mảng 16. Theo dõi lỗi và nhật ký

Hỏi: app hỏng lúc nửa đêm thì ai cần biết và biết bằng cách nào (email, tin nhắn)? Muốn xem lại lỗi từ bao lâu trước? (Không ai trực ⇒ cảnh báo chủ động quan trọng hơn kho log.)

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Workers Logs** | Có sẵn của Cloudflare | Gói miễn phí giữ vài ngày; cách tính giá đổi từ 2026-12-01 ⇒ tra lại số lúc hỏi | Dính Cloudflare | mẫu |
| **Sentry** | Gom lỗi kèm vị trí trong mã, gửi cảnh báo | Gói miễn phí giới hạn số lỗi và số người | Thêm một nhà; che dữ liệu nhạy cảm trước khi gửi | **chưa có** |
| **PostHog (mục lỗi)** | Gom cả lỗi lẫn số liệu ở một nơi | Gói miễn phí có hạn mức lỗi | Thêm một nhà | **chưa có** |

Khuyên: Workers Logs + Sentry gói miễn phí, cảnh báo qua email; PostHog đã dùng cho mảng 17 thì dùng luôn mục lỗi của nó. Vì không ai trực ⇒ cần bị báo, không cần tự ngồi đọc. Log chỉ đi qua `safeLog` của kit (không ghi mật khẩu, token, email thô).
Mốc: số lỗi tháng chạm hạn mức gói miễn phí ⇒ gom lỗi trùng hoặc nâng gói.
Bỏ câu khi: công cụ dùng riêng chạy trên máy mình.

## Mảng 17. Đo người dùng

Hỏi: muốn biết điều gì: bao nhiêu người ghé, họ bấm gì, bao nhiêu người trả tiền? Chấp nhận ghi hành vi chi tiết (có hộp xin phép) không?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **PostHog Cloud** | Đếm lượt, bấm gì, phễu đăng ký → trả tiền, cờ tính năng | Gói miễn phí rộng; vượt thì tính theo sự kiện | Mã nguồn mở, thoát qua xuất dữ liệu | **chưa có** |
| **Google Analytics** | Quen thuộc, nối Search Console cho trang công khai | Tra lúc hỏi | Dữ liệu ở Google | **chưa có** |

Khuyên: PostHog Cloud gói miễn phí cho sự kiện của sản phẩm; trang công khai cần SEO thêm Google Search Console. Chỉ ghi sự kiện, không ghi nội dung người dùng nhập; xin phép nếu ghi lại phiên (B-TD6, B-PL6).
Mốc: sự kiện/tháng chạm hạn mức gói miễn phí ⇒ giảm sự kiện hoặc trả phí.
Bỏ câu khi: công cụ dùng riêng, chưa có người ngoài dùng.

## Mảng 18. Tên miền

Hỏi: muốn địa chỉ gì (.com, .vn)? Tên miền đứng tên bạn hay tên công ty?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **.com ở Cloudflare Registrar** | Mua theo giá gốc, DNS gắn sẵn với Workers | Không trần | Chuyển sang nhà khác được; xem giá trang chính thức lúc mua | luật |
| **.vn** (nhà đăng ký Việt Nam) | Tăng độ tin cậy với khách Việt | Cần hồ sơ theo quy định (tra lúc hỏi) | Chuyển nhà có quy trình riêng | **chưa có** |

Khuyên: đăng ký **đứng tên chính chủ** (người hoặc công ty thật chủ app), không đứng tên người làm hộ hay đơn vị thiết kế; DNS ở Cloudflare. Vì tên miền là thứ duy nhất không làm lại được nếu mất (khách đã nhớ địa chỉ, email, SEO).
Mốc: trước khi gắn đăng nhập Google và email gửi đi phải có tên miền.
Bỏ câu khi: app máy tính/extension không có trang.

## Mảng 19. Sao lưu

Hỏi: nếu mất toàn bộ dữ liệu hôm nay, chấp nhận mất tối đa bao lâu của dữ liệu (1 giờ, 1 ngày)? Đã từng thử khôi phục chưa?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **D1 Time Travel** | Khôi phục về một phút bất kỳ trong thời hạn giữ | Luôn bật; khôi phục ghi đè tại chỗ, chưa nhân bản ra bản riêng; giữ lâu hơn thì xuất sang R2 | Dính D1 | mẫu |
| **Sao lưu của Supabase** | Postgres Supabase | Gói miễn phí không có; gói trả phí sao lưu hằng ngày, khôi phục theo phút tính thêm | `pg_dump` xuất được | mẫu (`flow-backup`) |
| **Neon** | Lịch sử khôi phục tức thì | Thời gian giữ theo gói | — | **chưa có** |
| **Bản xuất riêng định kỳ ra nơi khác** | Một bản độc lập với nhà cung cấp chính | Chống cả trường hợp tài khoản bị khoá | Không trói | luật |

Khuyên: gói trả phí của DB (đã có sao lưu) **cộng một bản xuất định kỳ sang nơi độc lập**, và **thử khôi phục thật** trước khi ra mắt rồi mỗi quý. Vì sao lưu chưa từng thử khôi phục thì chưa tính là sao lưu.
Mốc: dữ liệu quan trọng mà chưa thử khôi phục ⇒ thử ngay trước khi ra mắt.
Bỏ câu khi: không có dữ liệu người dùng (app máy tính thì thay bằng nút "Xuất dữ liệu").

## Mảng 20. Đa ngôn ngữ

Hỏi: khách dùng tiếng Việt, tiếng Anh hay cả hai? Sau này thêm ngôn ngữ nào không? Tiền hiển thị bằng đồng hay có cả đô la?

| Phương án | Hợp khi | Chịu tới đâu · lớn hơn thì đổi gì | Trói và lối thoát | Kit |
|---|---|---|---|---|
| **Gom mọi chữ vào file ngôn ngữ ngay từ đầu** (kể cả khi mới một ngôn ngữ) | Chữ trên màn không rải trong mã | Thêm ngôn ngữ = thêm một file dịch; không gom từ đầu thì sau phải sửa từng màn | Không trói | luật |
| **Thư viện i18next** | App giao diện React | Thư viện dịch phổ biến nhất cho React | Chữ nằm trong file riêng nên thoát dễ | **chưa có** |
| **Lingui / Paraglide** | Cách khác | — | — | **chưa có** |

Cần chốt cùng lúc (khó sửa sau): tiền lưu **số nguyên theo đơn vị nhỏ nhất kèm mã tiền tệ**; giờ lưu **UTC**, hiển thị theo `Asia/Ho_Chi_Minh`; chuỗi UTF-8; tìm kiếm bỏ dấu (mảng 13).
Khuyên: gom chữ vào file ngôn ngữ từ đầu, dùng i18next nếu giao diện React; ngày/tiền dùng `Intl` có sẵn. Trang công khai nhiều ngôn ngữ cần thêm địa chỉ theo ngôn ngữ và thẻ `hreflang` (chưa nằm trong mẫu `web-public`, ghi vào SPEC).
Mốc: thêm ngôn ngữ thứ hai ⇒ thêm một file dịch.
Bỏ câu khi: công cụ dùng riêng, một ngôn ngữ, không bao giờ chia sẻ.

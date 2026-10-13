---
name: flow-production
description: Đưa app lên mạng cho người dùng thật và chăm sóc sau đó — hỏi nơi chạy, quét bảo mật, kiểm trước phát hành, phát hành, thử nhanh, quay lại bản trước, xem lỗi, sao lưu, đổi khoá bị lộ. Dùng khi user nói kiểu "phát hành", "đưa lên mạng", "deploy", "quay lại bản trước", "app có lỗi không", "sao lưu", "khoá bị lộ/đổi khoá". KHÔNG dùng cho chạy thử trước khi gộp (dùng flow-qa) hay đo tải (dùng flow-scale).
---

# Flow — phát hành và chăm sóc app đã lên mạng

Mọi lệnh dưới đây chạy từ thư mục dự án (hoặc thêm `--dir`). Mã thoát chung: 0 đạt · 1 chặn · 2 cảnh báo (zap) ·
3 thiếu công cụ/điều kiện · 4 cần user gật. Trạng thái nằm ở `.claude/release.json` (do `release`/`backup` ghi).

## 0. Nói bằng lời và hỏi nơi chạy (AC-21) — trước mọi việc khác
App chỉ dùng trên máy ⇒ KHÔNG đề nghị lên mạng, dừng ở đây. Muốn lên mạng ⇒ kể bằng lời đời thường, ngắn: **ai mở
được · dữ liệu nằm ở đâu · tốn gì mỗi tháng · cần tài khoản nào**. Rồi HỎI (AskUserQuestion) nơi chạy RIÊNG cho từng app,
kèm đề xuất tốt nhất cho app đó và lý do một câu (hợp nền dữ liệu đang dùng, miễn phí, ít việc nhất). Không mặc định.
Chốt xong ghi vào sổ chốt.

## 1. Quét bảo mật (AC-22, 22a)
Chỉ quét bản chạy ở máy với dữ liệu mẫu; **không quét chủ động địa chỉ thật** (hai công cụ tự từ chối).
- **ZAP, MỖI lần phát hành:** bật app local rồi `node ~/.claude/hooks/zap-scan.mjs -t http://localhost:<cổng>`.
  Giữ lại mã thoát để đưa vào bước 2. 1 = lỗi cao (chặn, kể lỗi bằng lời) · 2 = lỗi vừa (cảnh báo) · 3 = thiếu Java/ZAP
  (đưa đúng lệnh cài ZAP in ra; không cài được ⇒ chặn, không bỏ qua). Báo nhầm: chỉ miễn qua `docs/security-ignore.json`
  (`rule`, `reason`, `until` YYYY-MM-DD; hết hạn ⇒ chặn lại).
- **Strix (quét bằng AI), chỉ khi app nhạy cảm** (tiền, sức khoẻ, dữ liệu cá nhân thật) **hoặc user bảo:** nói trước chi
  phí và thời gian, user gật mới chạy:
  `node ~/.claude/hooks/strix-scan.mjs -t http://localhost:<cổng> --max-budget <USD> --scan-mode quick|standard|deep`.
  Thiếu `--max-budget` ⇒ bị từ chối. Máy không có Docker (exit 3) ⇒ bỏ qua Strix và nói rõ: "chưa quét sâu được, rủi ro là
  lỗi phân quyền/nghiệp vụ có thể còn sót"; ghi câu đó vào báo cáo phát hành.

## 2. Kiểm trước phát hành (AC-22b) — LUÔN chạy
`node ~/.claude/hooks/release.mjs preflight --zap-exit <mã zap> [--has-data] [--first-release]`
(`cf` và `vps --run` tự chạy lại bước này, nhưng gọi trước để kể user danh sách thiếu bằng lời. `cf` build TRƯỚC rồi mới kiểm,
nên quét khoá chạy trên đúng bản sắp tải lên; chạy `preflight` riêng thì quét thư mục build đang có sẵn — dự án chưa build lần nào
sẽ báo "chưa build", cứ chạy `release cf` thẳng là nó tự build.)
- **Exit 1** ⇒ đọc từng mục, kể bằng lời kèm việc làm tiếp (thiếu dấu review/QA → chạy skill tương ứng; khoá trong bản
  build → `recipes/key-rotation.md`; chưa thử quay lại (chỉ từ lần phát hành thứ 3) → bước 5; chưa chọn sao lưu → bước 6). Không lách.
- **Dòng "Cảnh báo" không chặn** vẫn phải kể user. Riêng cảnh báo repo cho sửa thẳng nhánh chính (`.claude/allow-direct-edit`):
  nói rõ "không có dấu review/QA/test nào để kiểm" và hỏi user đã tự kiểm chưa trước khi phát hành.
- **Exit 4** ⇒ hỏi user rồi chạy lại. **Exit 3** ⇒ đưa lệnh cài/xử lý in ra.
- App có dữ liệu thật thêm `--has-data`. `--first-release` chỉ để cho phép tạo Worker lần đầu: Cloudflare Workers chưa có
  Worker thì `release cf` dừng (exit 3) và bảo thêm cờ này; Worker đã có thì không cần (xem công thức).

## 3. Phát hành theo nền
Mở đúng công thức, làm theo; không chép lại nội dung ở đây:
| Nền | Công thức |
|---|---|
| Cloudflare Workers | `recipes/cloudflare-workers.md` |
| Cloudflare Pages | `recipes/cloudflare-pages.md` |
| Supabase (database) | `recipes/supabase.md` |
| VPS | `recipes/vps.md` |
| Tiện ích trình duyệt | `recipes/extension.md` |
| App desktop | `recipes/desktop-update.md` |

`release cf` cần Worker của app trả header `x-flow-version` (công thức Workers/D1 nói cách thêm); thiếu thì lệnh dừng, chưa mở bản mới.
Phát hành xong (`release cf` tự build nếu `package.json` có script `build`): bài thử nhanh (`@smoke`) đã chạy trong lệnh; `release` tự ghi mốc nhắc xem lỗi (1 và 7 ngày) vào
`.claude/release.json` — nền không do `release` phát hành thì tự ghi `checkAt` bằng Edit. Điền `docs/RUNBOOK.md`
từ `templates/RUNBOOK.md` (trang chăm sóc, viết đời thường) và nói user nơi đọc nó.

## 4. Xem lỗi (AC-48e)
User hỏi "app có lỗi không" hoặc tới mốc nhắc ⇒ `node ~/.claude/hooks/release.mjs logs --since 24h` (hoặc `7d`),
kể lại bằng lời: lỗi gì, bao nhiêu lần, từ khi nào, ở luồng nào. Log miễn phí giữ ngắn (Workers 3 ngày, Supabase 1 ngày):
lệnh sẽ nói khoảng nào không còn log — nhắc lại cho user, đừng kết luận "không lỗi". Exit 3 (thiếu token đọc log) ⇒
đưa user đúng việc cần làm; token chỉ-đọc, không dán ra chat.

## 5. Quay lại bản trước (AC-48a, 48b, 48c)
- Workers: `node ~/.claude/hooks/release.mjs rollback [--version-id <mã>] [--url https://…]` — thử nhanh lại sau khi quay.
- VPS: `node ~/.claude/hooks/release.mjs vps --rollback --run` (thiếu `--run` chỉ in lệnh).
- Pages, Supabase, tiện ích, desktop: không có lệnh ⇒ hướng dẫn từng bước trong công thức của nền đó.
Luôn nói rõ: **dữ liệu (D1, KV, R2, database) không quay theo**, chỉ phần mềm.
Luật thử quay lại: sau lần phát hành đầu chỉ có MỘT bản nên chưa thử được, preflight chưa đòi. `release` đếm số lần phát hành
trong `.claude/release.json`; **sau lần thứ 2** mà chưa thử, lệnh in nhắc "nên thử quay lại một lần" — làm đúng lúc đó: nói user
"người dùng sẽ thấy bản cũ vài giây", chạy lệnh quay lại ở trên, rồi phát hành lại bản mới. Tới **lần thứ 3** mà vẫn chưa thử
quay lại thì preflight chặn (exit 1). Không dùng `--first-release` để lách mục này.

## 6. Sao lưu (AC-23, 23a, 23b) — không tự ý
App có dữ liệu thật ⇒ HỎI user có bật sao lưu không, kèm đề xuất cách + chỗ cất (khác chỗ đặt dữ liệu chính, ngoài git).
Chỉ sau khi user nói **có** cho đúng app đó mới thêm `--dong-y`; thiếu `--dong-y` lệnh trả exit 4 kèm câu để hỏi.
```
node ~/.claude/hooks/backup.mjs chon on <thư-mục-app> --method d1|pg [--db …] [--dest …] [--every <giờ>] --dong-y
node ~/.claude/hooks/backup.mjs chay <thư-mục-app> --dong-y
node ~/.claude/hooks/backup.mjs khoi-phuc-thu <thư-mục-app> --dong-y   # đạt thì tự ghi docs/BACKUP.md
node ~/.claude/hooks/backup.mjs lich <thư-mục-app> --dong-y
node ~/.claude/hooks/backup.mjs trang-thai <thư-mục-app>               # chỉ đọc
```
User nói không ⇒ `chon off … --dong-y` để ghi lại lựa chọn (preflight không đòi nữa).
**Supabase gói miễn phí có dữ liệu thật:** chỉ khuyên nâng Pro (nói phí); user đồng ý ghi lựa chọn đó bằng
`chon on <app> --supabase-free --dong-y`. Không tự sao lưu. Trang `docs/BACKUP.md` do `backup.mjs` sinh; mẫu để biết
nó trông thế nào: `templates/BACKUP.md`.

## 7. Định tuyến câu nói của user
| User nói | Làm |
|---|---|
| "phát hành", "đưa lên mạng", "deploy" | bước 0 → 1 → 2 → 3 |
| "quay lại bản trước", "bản mới bị lỗi" | bước 5 (rồi bước 4 nếu cần biết lỗi gì) |
| "app có lỗi không", "xem lỗi" | bước 4 |
| "sao lưu", "backup", "khôi phục thử" | bước 6 |
| "khoá bị lộ", "đổi khoá", "lỡ đưa mật khẩu lên git" | `recipes/key-rotation.md` |
| "cập nhật app desktop cho người dùng" | `recipes/desktop-update.md` |

## Báo user
Khuôn: **đã làm gì · người dùng app sẽ thấy gì · còn gì cần bạn làm**. Không dán log, mã lỗi thô, khoá, đường dẫn dài.
Chưa chạy thật trên dịch vụ nào thì nói "chưa thử với dịch vụ thật" thay vì khẳng định.

---
name: flow-publish
description: Làm một bước phát hành hoặc xem lỗi bản thật — chọn nơi chạy, quét bảo mật, kiểm trước phát hành, đưa bản lên, thử nhanh trên địa chỉ thật. Dùng khi chỉ cần riêng các bước đó, "app có lỗi không", "xem lỗi bản thật"; cả quy trình lên mạng thì flow-release gọi skill này. KHÔNG dùng cho quay lại bản trước (flow-rollback), sao lưu (flow-backup), khoá lộ (flow-key-leak), chạy thử trước gộp (flow-qa).
---

# Phát hành

Mọi lệnh chạy từ thư mục dự án (hoặc thêm `--dir`). Mã thoát: 0 đạt · 1 chặn · 2 cảnh báo (zap) · 3 thiếu công cụ/điều
kiện · 4 cần user gật. Trạng thái nằm ở `.claude/release.json`.

**Chưa có bằng chứng sống thì chưa xong:** tải lên thành công chưa phải phát hành xong. Xong là đã thử nhanh đạt trên địa
chỉ thật và biết đang chạy đúng bản nào. Chưa thử được thì nói rõ "chưa xác nhận".

## 0. Nơi chạy và câu hỏi trước khi làm

App chỉ dùng trên máy ⇒ không đề nghị lên mạng, dừng ở đây.

- **Đã có nơi chạy** (sổ chốt, `.claude/release.json`, file cấu hình như `wrangler.jsonc`) ⇒ giữ nguyên, không đề nghị đổi
  trừ khi user bảo. Các nguồn mâu thuẫn nhau ⇒ hỏi một câu, không tự đoán tài khoản hay môi trường.
- **Lần đầu:** kể bằng lời đời thường: **ai mở được · dữ liệu nằm ở đâu · tốn gì mỗi tháng · cần tài khoản nào**. Rồi hỏi nơi
  chạy riêng cho app này, kèm đề xuất và lý do một câu (hợp nền dữ liệu đang dùng, miễn phí, ít việc nhất). Giá và giới
  hạn phải tra nguồn chính thức lúc hỏi, không nói theo trí nhớ. Chốt xong ghi sổ chốt.
- **Luôn hỏi user một câu trước khi đưa bản lên**, kể cả ngay sau khi gộp. Người dùng hỏi về một nền nào đó không có nghĩa
  là đã bảo phát hành.

## 1. Quét bảo mật

Chỉ quét bản chạy ở máy với dữ liệu mẫu; **không quét chủ động địa chỉ thật** (hai công cụ tự từ chối).

- **ZAP, mỗi lần phát hành:** bật app local rồi `node ~/.claude/hooks/zap-scan.mjs -t http://localhost:<cổng>`. Giữ mã thoát
  cho bước 2. 1 = lỗi cao (chặn, kể lỗi bằng lời) · 2 = lỗi vừa (cảnh báo) · 3 = thiếu Java/ZAP (đưa đúng lệnh cài in ra;
  không cài được ⇒ chặn). Báo nhầm: chỉ miễn theo `references/quet-bao-mat.md`.
- **Strix (quét bằng AI), chỉ khi app nhạy cảm** (tiền, sức khoẻ, dữ liệu cá nhân thật) **hoặc user bảo:** đọc
  `references/quet-bao-mat.md`; nói trước chi phí và thời gian, user gật mới chạy.

## 2. Kiểm trước phát hành — luôn chạy

`node ~/.claude/hooks/release.mjs preflight --zap-exit <mã zap> [--has-data] [--first-release]`

`cf` và `vps --run` tự chạy lại bước này (chi tiết khi chạy riêng `preflight`: `references/preflight-cf.md`).

- **Exit 1 — chặn, gật cũng không qua:** khoá trong bản build → skill `flow-key-leak` · lỗi bảo mật mức cao → sửa. Kể từng mục bằng lời kèm việc làm tiếp.
- **Exit 4 — thiếu test, soát code, QA, chưa tập quay lại (từ lần thứ 3), sao lưu chưa chọn hoặc chưa đạt:** kể bằng lời thiếu gì và
  người dùng thật có thể gặp gì, đề xuất làm bù nếu kịp (`flow-review`, `flow-qa`, `flow-rollback`, `flow-backup`). User gật trong chat ⇒ chạy lại lệnh với `--dong-y`. Chưa gật thì không thêm cờ này.
- **Dòng "Cảnh báo"** vẫn phải kể user. Repo cho sửa thẳng nhánh chính (`.claude/allow-direct-edit`): nói rõ không có dấu kiểm
  nào để xem và hỏi user đã tự kiểm chưa.
- **Exit 3** ⇒ đưa lệnh xử lý in ra.
- App có dữ liệu thật thêm `--has-data`. `--first-release` chỉ để cho phép tạo Worker lần đầu; không dùng để lách mục nào.
- App đụng tiền, sức khoẻ, trẻ em: nói rõ rủi ro còn lại và khuyên thuê kiểm thử; user quyết.

## 3. Phát hành theo nền

Mở đúng công thức của nền (danh sách ở "Đọc khi cần"), làm theo; không chép lại ở đây.

`release cf` cần Worker trả header `x-flow-version` (công thức Workers nói cách thêm); thiếu thì lệnh dừng, chưa mở bản mới.

Xong: bài thử nhanh (`@smoke`) đã chạy trong lệnh; `release` tự ghi mốc nhắc xem lỗi (1 và 7 ngày) vào `.claude/release.json`,
nền không do `release` phát hành thì tự ghi `checkAt`. Điền `docs/RUNBOOK.md` từ `assets/RUNBOOK.md`, ghi cách quay lại
và bản đang chạy (tên cấu hình, không có giá trị khoá), rồi nói user nơi đọc.

**Thử nhanh trượt:** chỉ báo bằng lời: lỗi gì, người dùng đang thấy gì, bản nào đang chạy. Không tự quay lại. User bảo quay
⇒ skill `flow-rollback`. Riêng `release cf` tự gỡ bản mới khi bài thử trượt lúc chưa mở cho người dùng; đó không phải quay lại.

## 4. Xem lỗi

User hỏi "app có lỗi không" hoặc tới mốc nhắc ⇒ đọc `references/xem-loi.md` rồi làm theo.

## Đọc khi cần

- `references/cloudflare-workers.md` — khi nền là Cloudflare Workers
- `references/cloudflare-pages.md` — khi nền là Cloudflare Pages
- `references/supabase.md` — khi nền là Supabase
- `references/vps.md` — khi nền là VPS
- `references/extension.md` — khi là tiện ích trình duyệt
- `references/desktop-update.md` — khi là app desktop
- `assets/RUNBOOK.md` — khi điền `docs/RUNBOOK.md`
- `references/quet-bao-mat.md` — khi ZAP báo nhầm cần miễn, hoặc cần quét Strix (bước 1)
- `references/preflight-cf.md` — khi `preflight` riêng báo "chưa build"
- `references/xem-loi.md` — khi xem lỗi bản thật (bước 4)

## Báo user

Khuôn: **đã làm gì · người dùng app sẽ thấy gì · còn gì cần bạn làm**. Không dán log, mã lỗi thô, khoá, đường dẫn dài.
Chưa chạy thật trên dịch vụ nào thì nói "chưa thử với dịch vụ thật". Không trình bày thay đổi như đã phát hành khi chưa có bằng chứng ở bước 3.

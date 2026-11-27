# Chọn lượt soát và dự phòng

Dùng ở bước 2 của `flow-review`: định nghĩa "nhạy cảm", bảng lượt theo rủi ro, lý do chọn model, cách xử lý khi không còn AI ngoài.

**Nhạy cảm** = diff đụng đăng nhập/phân quyền, tiền/license/thanh toán, dữ liệu (migration, xoá, transaction), đồng thời,
xử lý secret, API công khai/webhook, hoặc > ~400 dòng; dự án có `.claude/flow.json` `"sensitive": [glob…]` thì dùng thêm.
Captain quyết từ `git diff --stat main...HEAD`, nói một dòng lý do. Diff đụng database ⇒ lượt bảo mật dùng
`review-brief-security.md` (có checklist DB).

| Diff | Lượt (chạy song song) |
|---|---|
| Đã ở nhánh chính (phát hành khi chưa soát) | Soát khoảng từ lần phát hành trước tới bản hiện tại, không dùng `main...HEAD` |
| Thường | 1 lượt chất lượng: **Grok high** (brief đã gồm bảo mật cơ bản). Không gọi Codex |
| Nhạy cảm | **Codex Sol `high`** lượt bảo mật (cùng commit đã qua `flow-security` thì dùng lại) + **Grok** lượt chất lượng |
| Tiền / auth / dữ liệu có rủi ro mất mát | như Nhạy cảm + **agy** (`--model flash`, vai `sensitive-reviewer`) lượt chất lượng thứ hai |

Tên `--model` của wrapper chỉ là nhãn lượt: `opus` = vai `plan-reviewer` và `flash` = vai `sensitive-reviewer`, cả hai trên agy và cùng hạng **mạnh** (chọn theo hạng,
không còn là Opus/Flash thật). Hai vai ưu tiên hai dòng khác nhau để lượt dự phòng không gọi lại đúng model vừa hết lượt; xem model đang dùng: `models.mjs list`.

**Bài thử 2026-10-01** (10 lỗi cài sẵn, 2 vòng, đều mức high; số đo cũ, trước khi kit chọn theo hạng): Codex 8–9/10, Grok 4.7 9/8, Gemini 3.8 Flash 8/8 (nhanh nhất),
không model nào báo nhầm; Gemini 3.1 Pro 7–8 kèm báo nhầm. Dòng Gemini 4 chưa có bài thử riêng ⇒ lượt agy coi là lượt phụ, kết quả vẫn phải kiểm vào code.

**Không còn AI ngoài nào chạy được:** dùng Agent `code-reviewer`, không đứng chờ có lượt. Khi báo user phải nói rõ: "Lần này
chỉ có AI soát nội bộ, cùng hãng với AI viết code nên độ độc lập thấp hơn." Ghi `"reviewers"` thật vào JSON cuối. Agent này
trả về dạng chữ theo khuôn của `review-brief.md`; captain chép sang `findings` khi đóng dấu.

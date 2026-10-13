---
name: flow-maintain
description: Khám sức khoẻ định kỳ cho app đã làm hoặc đã phát hành — tìm code trùng lặp và code thừa, kiến trúc lệch, thư viện cũ hoặc có lỗ hổng, link hỏng trong tài liệu, nợ kỹ thuật; ghi docs/HEALTH.md và đề xuất việc nên làm. Dùng khi user nói "khám sức khoẻ", "kiểm tra sức khoẻ app", "app còn khoẻ không", "dọn nợ kỹ thuật", "thư viện cũ chưa", hoặc khi phiên mở ra có dòng nhắc "Hơn 30 ngày chưa khám sức khoẻ". KHÔNG dùng để tìm lỗi chức năng (flow-qa), soát một thay đổi trước khi gộp (flow-review) hay đo tải (flow-scale).
---

# Flow — khám sức khoẻ app

Giống đi khám định kỳ: máy tự soát cả dự án, ghi kết quả thành một trang, rồi gợi ý việc nên làm. **Chỉ đọc và báo:
không sửa code, không cập nhật thư viện, không chạy gì tốn tiền** (không quét sâu Strix, không đo tải k6 trên mây).
Việc sửa là bước sau, user gật từng việc.

## 1. Báo trước một câu
"Mình khám sức khoẻ app khoảng vài phút, không tốn tiền và không sửa gì: soát code trùng và code thừa, thư viện cũ
hoặc có lỗ hổng bảo mật, link hỏng trong tài liệu, chỗ hay sửa mà phức tạp."

Phiên mở ra có dòng nhắc "Hơn 30 ngày chưa khám" ⇒ nói đúng một câu đó kèm hỏi "khám luôn bây giờ nhé?" (không
chặn việc user đang nhờ). User chưa muốn ⇒ để đó, phiên sau nhắc lại.

## 2. Chạy
```
node ~/.claude/hooks/health.mjs <thư mục app>
```
- Lệnh ghi `docs/HEALTH.md` và mốc khám vào `.claude/release.json` của app, nên chạy trong worktree (bản sao riêng của
  dự án để sửa mà không đụng bản đang chạy — skill `flow-worktree`) rồi gộp như mọi thay đổi khác.
- Chỉ muốn xem, chưa ghi file ⇒ thêm `--no-write`.
- Mã thoát 0 = không có mục đỏ · 1 = có mục đỏ · 3 = gõ sai hoặc không thấy thư mục.
- Máy kiểm chạy vài phút; đừng bấm dừng giữa chừng. Mất mạng ⇒ phần thư viện cũ và link hỏng ghi "chưa kiểm được".

## 3. Kể lại kết quả (theo màn hình và việc, không đọc tên công cụ)
Khuôn: **khám được gì · app đang thế nào · bạn cần quyết gì**. Dịch ba màu:
- **Đỏ — nên làm ngay**: thư viện có lỗ hổng bảo mật đã biết (người lạ có thể lợi dụng), hoặc code đi lệch cách chia
  module đã chốt trong `docs/arch.json`.
- **Vàng — nên làm khi rảnh**: code trùng/thừa, file quá dài, bản build nặng, thư viện đã có bản mới, link hỏng, file
  hay sửa mà phức tạp (dễ sinh lỗi), test đang bị tắt, chỗ tắt kiểm kiểu, tài liệu nhắc file không còn.
- **Xanh — ổn**: chỉ nói số lượng.
- **Chưa kiểm được**: máy thiếu một công cụ nên phần đó chưa soát — không phải lỗi của app.

"So với lần trước: tốt lên / tệ đi / không đổi" luôn nói, kèm mục nào đổi (HEALTH.md có sẵn).

Ví dụ: "Khám xong: 1 việc nên làm ngay, 3 việc nên làm khi rảnh, 5 phần ổn. Việc gấp: có 2 thư viện chứa lỗ hổng
bảo mật đã biết, bản vá có sẵn. So với tháng trước: tệ đi 1 mục. Mình nâng 2 thư viện này trước nhé?"

## 4. Công cụ chưa cài
Mỗi dòng "chưa kiểm được: <công cụ> (<lệnh cài>)" ⇒ gom lại, hỏi MỘT câu: "Cài thêm <tên> để soát <phần nào>
không?" (vd lychee soát link hỏng · scc đo chỗ phức tạp · npm-check-updates tìm thư viện cũ). Gật ⇒ chạy đúng lệnh
trong dòng đó rồi khám lại; không gật ⇒ để nguyên, không coi là đỏ. Không tự cài ngầm.

## 5. Đề xuất việc nên làm
Lấy mục "Việc nên làm" trong HEALTH.md (đỏ trước), hỏi user chọn bằng lời ("Sửa lỗ hổng thư viện trước chứ?").
Mỗi việc đã chọn chạy theo luồng thường (đặt cỡ S/M/L, worktree, kiểm, review) — không sửa gộp một loạt không hỏi.
- **Thư viện có lỗ hổng/cũ:** không tự cập nhật. Nói tên, bản hiện tại → bản mới, loại "bản lớn" (đổi lớn, dễ vỡ) ⇒
  thử từng cái một, máy kiểm xanh mới sang cái kế.
- **Link hỏng / tài liệu nhắc file mất:** sửa hoặc bỏ dòng đó; không xoá cả tài liệu.
- **Kiến trúc lệch, code trùng, file dài:** sửa code cho đúng luật; không nới luật hay sửa tay `docs/arch.json` để
  hết đỏ (nới luật phải hỏi user).
- **Test bị tắt, TODO/FIXME:** bật lại hoặc xoá có lý do; không xoá test chỉ để hết cảnh báo.

## 6. Khám lại và mốc 30 ngày
Sửa xong ⇒ chạy lại lệnh ở bước 2, báo "tốt lên N mục". Mỗi lần chạy ghi `health.lastAt` trong `.claude/release.json`
(qua `hooks/lib/release-state.mjs` — không ghi tay); 30 ngày sau không khám, phiên mở ra sẽ nhắc đúng một dòng.
Mốc khám chưa ghi được vì `release.json` hỏng ⇒ lệnh nói rõ, không ghi đè; sửa hoặc xoá file đó rồi khám lại.

## Không làm
- Không chạy quét tốn tiền hoặc quét sâu (Strix cần user gật riêng, k6 chỉ trong `flow-scale`).
- Không cập nhật thư viện, không sửa code, không xoá file trong lúc khám.
- Không đoán kết quả khi lệnh lỗi: kể lại đúng dòng báo lỗi và hỏi user.
- Không dán cả HEALTH.md vào chat; chỉ nêu số và 3–5 việc đầu, trang đầy đủ ở `docs/HEALTH.md`.

# Tham khảo app thật (bắt buộc) [9a78] [8yu7]

1. **Hỏi nguồn, không tự bỏ qua:** sổ chốt chưa ghi user có tài khoản tham khảo nào ⇒ hỏi một lần (AskUserQuestion): Mobbin, Pinterest,
   Dribbble, Behance, khác, hoặc không có. Ghi sổ chốt phạm vi `chung` để lần sau không hỏi lại. Máy chưa thấy Mobbin không có nghĩa
   user không có.
2. **Có Mobbin:** chưa có tool `mcp__mobbin__*` ⇒ cài bộ skill chính hãng cho Claude: `claude plugin marketplace add mobbin/skills`
   rồi `claude plugin install mobbin@mobbin` (Codex: `codex plugin marketplace add mobbin/skills` rồi `codex plugin add mobbin@mobbin`); chưa đăng nhập
   ⇒ đưa user đúng lệnh `claude mcp login mobbin`. Cần mở phiên mới mới có tool. Có tool ⇒ làm theo skill `mobbin:search` (chọn tìm
   màn, luồng hay một phần màn; tìm theo việc cần làm, không theo tên hãng).
3. **Pinterest, Dribbble, Behance…:** điều khoản các trang này cấm máy tự lấy ⇒ nhờ user dán 3-5 link hoặc ảnh họ thích; AI chỉ đọc
   thứ user đưa.
4. **Lấy 2-4 app làm mẫu chính cho mỗi màn chính** (đếm theo app, không theo ảnh). Mỗi điều rút ra ghi mức chắc: 2 app trở lên =
   **tiền lệ**, 1 app = **ví dụ**, không có = **ý kiến**. Không viết "hầu hết app" mà không nêu tên app. Chỉ học cấu trúc (bố cục,
   thứ tự bước, cách xử lý màn trống/lỗi); không chép màu, chữ, logo, nội dung, dữ liệu mẫu. Tên app và link chỉ ghi trong `UX.md`,
   không vào code; ảnh để thư mục tạm, không commit.
5. **Cho user xem trước khi dựng demo:** ảnh các app cạnh nhau trong chat, dưới mỗi ảnh một câu "app này làm thế nào, hợp hay không
   hợp khách của bạn", hỏi user thích cách nào. Kết quả đi vào mục "Tham khảo" của `UX.md`.
6. Không lấy được nguồn nào (Mobbin lỗi, user không có tài khoản và không dán link) ⇒ báo user một dòng rồi làm tiếp, ghi "chưa
   tham khảo app thật" trong `UX.md`. Không tự điền tham khảo từ trí nhớ.

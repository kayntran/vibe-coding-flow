---
paths:
  - "**/*.{tsx,jsx,vue,svelte,astro,html,css,scss}"
  - "**/{components,pages,views,screens,ui}/**"
---

# Phong cách UI — tối giản, ít chữ nhất mà người mới vẫn tự dùng được

AI hay thêm chữ giải thích khắp nơi ⇒ app rối. Mặc định ngược lại:
- **Mỗi màn hình một việc chính.** Nút chính nổi bật nhất; thứ phụ lùi xuống hoặc vào menu.
- **Bố cục kể luồng thay cho chữ:** thứ tự trên màn hình = thứ tự người dùng làm. Bố cục tự nói được thì không thêm chữ.
- **Icon luôn kèm nhãn 1 chữ** trừ nhà · in · tìm kiếm · đóng (X); thanh công cụ dày được ẩn nhãn nhưng hiện khi rê chuột.
- **Nhãn 1–3 chữ, dạng động từ** ("Lưu", "Thêm từ"; không OK/Có/Không/Xác nhận). Không đoạn giải thích, không placeholder dài, không tooltip cho thứ hiển nhiên.
- **Bắt buộc có chữ rõ** ở việc không quay lại được: xoá, tiền, quyền, dữ liệu mất hẳn — nêu tên đối tượng, nút theo kết quả ("Xoá đơn"). Việc hoàn tác được ⇒ nút Hoàn tác, không hộp xác nhận.
- **Chỗ duy nhất được giải thích là màn hình trống** (chưa có dữ liệu): một câu + một nút làm bước đầu tiên.
- **Phản hồi bằng trạng thái**, không bằng thông báo chữ: nút đổi trạng thái, mục mới hiện ra, chỗ vừa lưu sáng lên.
- **Lỗi một dòng, ngay cạnh chỗ sai:** sai gì + làm gì tiếp.
- **Mọi chỉnh sửa giao diện đi qua token** (`flow-ui-design/references/tokens.md`): user bảo đổi màu, cỡ, khoảng cách ⇒ sửa
  token ở tầng phù hợp để mọi chỗ cùng loại đổi theo, không sửa riêng một chỗ. Chỉ một chỗ cần khác ⇒ thêm token thành phần hoặc
  biến thể, không gõ số rời. Không chắc user muốn đổi một chỗ hay mọi chỗ ⇒ hỏi.
- Trước khi thêm chữ nào: "bỏ đi thì người mới có kẹt không?" Không kẹt ⇒ không thêm. Thêm UI mới ⇒ đề xuất cái bỏ
  được trước, cái thêm sau. Dự án có design system riêng ⇒ theo nó, nguyên tắc này chỉ quyết chuyện lượng chữ.

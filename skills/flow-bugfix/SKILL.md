---
name: flow-bugfix
description: Chạy trọn việc sửa một lỗi người dùng gặp, từ tìm nguyên nhân tới lúc hỏi gộp. Dùng khi user báo app lỗi, crash, bấm không ăn, hoặc khách phản ánh và muốn xử lý xong luôn. KHÔNG dùng khi user chỉ muốn sửa test hoặc CI đỏ (flow-fix), chỉ muốn hiểu lỗi (flow-explain), hay chỉ chạy thử (flow-qa).
---

# Luồng sửa lỗi

File này chỉ ghi thứ tự. Cách làm từng bước nằm ở skill lẻ. User tả lỗi bằng lời hoặc ảnh thì hỏi "có phải chỗ này?" kèm ảnh trước khi sửa.

| Bước | Skill | Khi nào | Qua bước khi | Hỏng thì |
|---|---|---|---|---|
| 1 | `flow-fix` | Luôn | Đã chứng minh nguyên nhân, lỗi hết, có bằng chứng | Sửa 3 lần không xong thì dừng, đưa 2-3 hướng |
| 2 | `flow-qa` | Lỗi hành vi | Luồng hỏng và luồng chính đều chạy đúng | Quay lại bước 1, quá 2 lần thì báo user |
| 3 | `flow-ui-design` | Sửa đụng giao diện | Hết lỗi nặng; sửa rất nhỏ thì gửi ảnh trước/sau | Tự sửa lỗi nặng rõ ràng |
| 4 | `flow-security` | Lỗi đụng tiền, quyền, đăng nhập, dữ liệu | Không còn lỗi cao chưa quyết | Báo và hỏi "Sửa" |
| 5 | `flow-review` | Trừ lỗi rất nhỏ như sai chữ | Hết lỗi nặng, hoặc user chọn vẫn gộp | AI ngoài hết lượt thì soát nội bộ và báo |
| 6 | `flow-merge` | User gật | Đã gộp và dọn | Theo skill |

**Đang có lỗi trên bản thật:** hỏi trước "quay lại bản trước trong lúc sửa không?" (`flow-rollback`). Không tự quay. Nói rõ dữ liệu không quay theo. Gộp xong hỏi có phát hành bản sửa không (`flow-release`).

---
name: flow-release
description: Chạy trọn việc đưa một bản lên mạng từ lúc kiểm trước phát hành tới khi có bằng chứng bản thật chạy. Dùng khi user nói "phát hành", "deploy", "đưa lên mạng", "đưa bản này cho khách dùng". KHÔNG dùng khi chỉ chạy lại bước tải lên hoặc xem lỗi bản thật (flow-publish), quay bản cũ (flow-rollback), hay chạy thử trên máy (flow-qa).
---

# Luồng phát hành

File này chỉ ghi thứ tự. Cách làm từng bước nằm ở skill lẻ. **Luôn hỏi user trước khi đưa bản mới lên, không tự phát hành sau khi gộp.**

| Bước | Skill | Khi nào | Qua bước khi | Hỏng thì |
|---|---|---|---|---|
| 1 | `flow-merge` | Còn thay đổi chưa gộp, user gật | Bản phát hành nằm trên nhánh chính | Theo skill |
| 2 | `flow-security` | Đụng tiền, quyền, dữ liệu, hoặc lần đầu phát hành | Hết lỗi cao đã xác minh | Báo và hỏi "Sửa"; chưa sửa thì dừng phát hành |
| 3 | `flow-backup` | Có dữ liệu thật, chưa từng chọn | User đã chọn bật hay không | Không tự bật |
| 4 | `flow-publish` | Luôn | Bài thử nhanh trên địa chỉ thật đạt | Thiếu test, soát, QA: cảnh báo, user gật mới chạy. Khoá trong bản build: dừng, sang `flow-key-leak` |
| 5 | `flow-rollback` | Chỉ khi user bảo | Bản cũ chạy lại, đã nói dữ liệu không quay theo | Thử nhanh trượt thì chỉ báo user, không tự quay |

**Xong khi:** có bằng chứng bản thật đang chạy đúng phiên bản. Chưa có bằng chứng thì nói rõ là chưa xong.

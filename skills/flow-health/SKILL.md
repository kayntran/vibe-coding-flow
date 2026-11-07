---
name: flow-health
description: Khám tổng thể một app đang dùng rồi đề xuất việc nên làm, gồm code, thư viện, bảo mật, lỗi bản thật và sao lưu. Dùng khi user nói "khám tổng thể", "chăm sóc app", "app còn ổn không" hoặc tới kỳ khám. KHÔNG dùng khi chỉ dọn nợ kỹ thuật hay kiểm thư viện (flow-maintain), đo tải (flow-scale), hay sửa một lỗi cụ thể (flow-bugfix).
---

# Luồng khám định kỳ

File này chỉ ghi thứ tự. Khám chỉ đọc và báo, không tự sửa. Bước nào không chạy được thì ghi rõ và làm tiếp.

| Bước | Skill | Khi nào | Được gì |
|---|---|---|---|
| 1 | `flow-status` | Luôn | Việc dở, nhánh và bản sao cũ |
| 2 | `flow-maintain` | Luôn | Code trùng và thừa, kiến trúc lệch, thư viện cũ, `docs/HEALTH.md` |
| 3 | `flow-security`, đọc điểm nhạy cảm cả app | App có đăng nhập hoặc dữ liệu | Rủi ro còn lại |
| 4 | `flow-publish`, phần xem lỗi | App đã lên mạng | Lỗi trên bản thật, khoảng nào không còn log |
| 5 | `flow-backup`, phần trạng thái | Có dữ liệu thật | Lần sao lưu và lần khôi phục thử gần nhất |
| 6 | `flow-scale` | Chỉ khi user lo tải hoặc app chậm | Điểm nghẽn, đo trên bản thử riêng |

**Kết thúc:** gom thành một danh sách ngắn xếp theo tác động lên người dùng, rồi hỏi user muốn làm mục nào. Mỗi mục được chọn đi theo `flow-bugfix` hoặc `flow-feature`.

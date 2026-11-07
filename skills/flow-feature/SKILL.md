---
name: flow-feature
description: Chạy trọn một tính năng từ ý tưởng tới lúc hỏi gộp, theo đúng thứ tự các skill lẻ. Dùng khi user muốn app có thêm chức năng, làm tính năng hoặc module từ đầu tới cuối (cỡ M/L). KHÔNG dùng cho sửa nhỏ một câu, sửa lỗi (flow-bugfix), app chưa có thư mục (flow-new-app), hay khi user chỉ cần một bước như viết SPEC (gọi thẳng skill lẻ).
---

# Luồng làm tính năng

File này chỉ ghi thứ tự. Cách làm từng bước nằm ở skill lẻ. Làm tuần tự, không báo giữa chừng ngoài các lần hỏi dưới đây.

| Bước | Skill | Khi nào | Qua bước khi | Hỏng thì |
|---|---|---|---|---|
| 1 | `flow-spec` | Luôn; app mới, màn mới, đổi luồng thì gọi `flow-ux` trước khi viết phần màn hình | User duyệt SPEC, không còn `[CẦN LÀM RÕ]`; luồng đã duyệt thì không hỏi lại | Hỏi tiếp, không đoán |
| 2 | `flow-impact` | Đụng thứ dùng chung | Mỗi tính năng anh em có quyết định | Hỏi user làm luôn hay để sau |
| 3 | `flow-ui-demo` | Có màn mới hoặc làm lại giao diện | User chọn bản, đã gỡ bản thừa | Sửa theo lời tới khi user gật |
| 4 | `flow-plan` | Luôn | User gật bản tóm tắt plan | Sửa plan, không code trước |
| 5 | `flow-build` | Luôn | Mọi ô trong PLAN đã tick, kiểm hẹp xanh | Sửa 2 lần không qua thì dừng, kể user |
| 6 | `flow-qa` | Luôn | Hết lỗi, hoặc user chấp nhận phần còn lại | `flow-fix` rồi quay lại bước này |
| 7 | `flow-ui-design` | Đụng giao diện | Hết lỗi nặng, user xem và gật | Tự sửa lỗi nặng rõ ràng, lỗi về gu chỉ báo |
| 8 | `flow-security` | Đụng tiền, quyền, đăng nhập, dữ liệu | Không còn lỗi cao chưa quyết | Báo và hỏi "Sửa" |
| 9 | `flow-review` | Luôn | Hết lỗi nặng, hoặc user chọn vẫn gộp | Sửa rồi soát lại; AI ngoài hết lượt thì soát nội bộ và báo |
| 10 | `flow-merge` | User gật | Đã gộp và dọn | Theo skill |

**Trước khi sửa file:** `flow-worktree`. Thêm module mới: `flow-architecture` trước khi lập plan.

**Sau khi nén ngữ cảnh:** đọc sổ tiến độ, xác định bước đang dở. Sổ ghi `Đang chờ user gật` thì tóm tắt lại điều cần gật rồi hỏi lại, không coi là đã gật.

**Bỏ bước:** chỉ khi cột "Khi nào" không khớp, hoặc user bảo. Bỏ theo lời user thì ghi "chưa kiểm" và nhắc lại lúc gộp.

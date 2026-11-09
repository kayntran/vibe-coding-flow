---
name: flow-feature
description: Chạy trọn một tính năng từ ý tưởng tới lúc hỏi gộp, theo đúng thứ tự các skill lẻ. Dùng khi user muốn app có thêm chức năng, làm tính năng hoặc module từ đầu tới cuối (cỡ M/L). KHÔNG dùng cho sửa nhỏ một câu, sửa lỗi (flow-bugfix), app chưa có thư mục (flow-new-app), hay khi user chỉ cần một bước như viết SPEC (gọi thẳng skill lẻ).
---

# Luồng làm tính năng

File này chỉ ghi thứ tự. Cách làm từng bước nằm ở skill lẻ. **Giao trọn là mặc định** [vyt1]: user duyệt SPEC xong thì tự đi tới lúc
hỏi gộp, không báo giữa chừng, không chờ gật plan. Chỉ dừng hỏi khi: chọn bản giao diện · việc không đảo ngược mà SPEC chưa nêu · đổi điều
đã chốt trong "Thế nào là đạt" · tiêu tiền hoặc gửi gì ra ngoài chưa được duyệt · lỗi vẫn không rõ sau `flow-fix` · khoá/đăng nhập hết hạn
giữa chừng. Dừng thì báo: đã xong gì · kẹt gì · khuyên chọn gì; user trả lời xong làm tiếp.

| Bước | Skill | Khi nào | Qua bước khi | Hỏng thì |
|---|---|---|---|---|
| 1 | `flow-spec` | Luôn; app mới, màn mới, đổi luồng thì gọi `flow-ux` trước khi viết phần màn hình | User duyệt SPEC, không còn `[CẦN LÀM RÕ]`; luồng đã duyệt thì không hỏi lại | Hỏi tiếp, không đoán |
| 2 | `flow-system-design` | Luôn [89i7] | Có DESIGN.md: hạng quy mô, con số, bản mẫu đã áp, đánh đổi | Thiếu con số thì ghi giả định, không đứng chờ |
| 3 | `flow-impact` | Đụng thứ dùng chung | Mỗi tính năng anh em có quyết định | Hỏi user làm luôn hay để sau (gom vào lần hỏi SPEC nếu kịp) |
| 4 | Gom chuẩn bị [qh5c] | Luôn | Đủ mọi thứ cần trước khi code (dưới đây) hoặc user đã bỏ qua mục nào | Thiếu thứ chỉ user làm được ⇒ hỏi MỘT lần, gom hết |
| 5 | `flow-plan` | Luôn | `plan-check` sạch, đã soát plan; báo user một câu rồi làm tiếp, không chờ gật [vyt1] | Sửa plan, không code trước |
| 6 | `flow-ui-demo` song song `flow-build` | Có màn mới hoặc làm lại giao diện | User chọn bản, đã gỡ bản thừa | Sửa theo lời tới khi user gật |
| 7 | `flow-build` | Luôn | Mọi ô trong PLAN đã tick, kiểm hẹp xanh, mọi mốc đã soát [lcly] | Sửa 2 lần không qua thì dừng, kể user |
| 8 | `flow-qa` | Luôn | Hết lỗi, hoặc user chấp nhận phần còn lại | `flow-fix` rồi quay lại bước này |
| 9 | `flow-ui-design` | Đụng giao diện | Hết lỗi nặng, user xem và gật | Tự sửa lỗi nặng rõ ràng, lỗi về gu chỉ báo |
| 10 | `flow-security` | Đụng tiền, quyền, đăng nhập, dữ liệu | Không còn lỗi cao chưa quyết | Báo và hỏi "Sửa" |
| 11 | `flow-review` | Luôn — soát cuối, phiên mới [lcly] | Hết lỗi nặng, hoặc user chọn vẫn gộp | Sửa rồi soát lại; AI ngoài hết lượt thì soát nội bộ và báo |
| 12 | `flow-merge` | User gật | Đã gộp và dọn | Theo skill |

**Gom chuẩn bị (bước 4)** [qh5c]: soát một lượt mọi thứ việc này cần mà chưa có — công cụ đã cài và đăng nhập (`cli-check.mjs`), khoá
trong kho khoá (`khoa.mjs`, chỉ kiểm có/không, không đọc giá trị), skill/MCP thư viện (`skills-check.mjs`), quyền repo, dịch vụ ngoài,
dữ liệu thử. Liệt kê CHỈ thứ thiếu thật, mỗi dòng: là gì · vì sao cần · user làm gì (đúng lệnh đăng nhập, hoặc "dán khoá vào kho khoá") ·
AI kiểm lại bằng gì. Lựa chọn đổi lại được thì tự đặt mặc định, không hỏi. User bỏ qua mục nào ⇒ ghi vào `progress.md` kèm hậu quả.

**Tự dọn** [064z]: mọi thứ chính mình mở (máy chủ chạy thử, tiến trình nền, phiên AI phụ, worktree làn) ghi vào `progress.md` mục
`## Đang mở` lúc mở; xong việc (hoặc khi dừng chờ user lâu) tắt/dọn hết, worktree theo `flow-worktree`, rồi xoá mục đó.

**Không đứng chờ duyệt giao diện** [xwuk]: dựng demo, hỏi user chọn bản, rồi trong lúc chờ làm luôn các task không đụng giao diện (dữ liệu,
xử lý phía sau, test) trong worktree riêng theo `flow-build`. Chúng chỉ dựa vào luồng màn đã duyệt nên bản nào được chọn cũng không phải
làm lại. Task giao diện (ghi `(chờ demo)` trong PLAN) chỉ làm sau khi user chọn bản. Không có màn mới thì bỏ bước 6, làm thẳng bước 7.

**Trước khi sửa file:** `flow-worktree`. Thêm module mới: `flow-architecture` trước khi lập plan (sau `flow-system-design`).

**Sau khi nén ngữ cảnh:** đọc sổ tiến độ, xác định bước đang dở. Sổ ghi `Đang chờ user gật` thì tóm tắt lại điều cần gật rồi hỏi lại, không coi là đã gật.

**Bỏ bước:** chỉ khi cột "Khi nào" không khớp, hoặc user bảo. Bỏ theo lời user thì ghi "chưa kiểm" và nhắc lại lúc gộp.

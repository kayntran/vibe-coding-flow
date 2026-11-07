---
name: flow-build
description: Thi công một việc đã rõ phạm vi — làm theo PLAN hoặc yêu cầu cỡ S trong worktree, kiểm hẹp rồi rộng, tự sửa hồi quy mình gây, tick ô PLAN. Dùng khi plan đã xong, "làm theo plan", "làm tiếp task 3". KHÔNG dùng khi chưa rõ phải làm gì (flow-spec), chưa có plan cho việc cỡ M/L (flow-plan), sửa lỗi chưa rõ nguyên nhân (flow-fix), hay user giao cả tính năng từ đầu tới cuối (flow-feature).
---

# Thi công

Đầu ra của skill này: code trong worktree đã qua kiểm của từng task, ô PLAN đã tick, sẵn sàng sang `flow-qa`.
Không gộp, không push, không phát hành ở đây.

## 1. Chốt đầu việc

Trước dòng sửa đầu tiên, có đủ 4 điều sau. SPEC/PLAN đã ghi thì dùng lại, không hỏi lại:

| Điều | Trả lời được câu |
|---|---|
| Kết quả | Xong thì người dùng làm được gì |
| Ràng buộc | Không được đổi gì (hợp đồng, dữ liệu, giao diện đã duyệt) |
| Không làm | Thứ gần đó nhưng ngoài phạm vi |
| Tiêu chí xong | Lệnh hoặc hành động nào chứng minh, kết quả mong đợi |

Thiếu điều làm đổi kết quả ⇒ hỏi một lần, gom câu. Thiếu điều kỹ thuật ⇒ tự quyết, ghi vào nhật ký plan.
Cỡ M/L mà chưa có PLAN ⇒ sang `flow-plan`. Đọc code và test quanh chỗ sửa trước khi viết; dùng lại mẫu sẵn có.

Chưa ở worktree ⇒ `flow-worktree`. Việc đụng thứ dùng chung ⇒ `flow-impact` trước.
Màn mới hoặc làm lại giao diện ⇒ làm theo bản đã chọn ở `flow-ui-demo`, chưa có bản được chọn thì chưa code thật.

## 2. Chia việc

Một mình làm được thì không chia. Chạy song song ⇒ theo `flow-team`, và:
- Bảng `## Làn` phải qua `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>`.
- Mỗi làn một nhóm file riêng. Hai làn cần cùng file ⇒ gộp làn hoặc chạy nối tiếp.
- File nóng (lockfile, migration, cấu hình gốc, i18n chung, registry) chỉ một chủ.
- Làn xong ⇒ `lane-check audit` rồi mới gộp vào nhánh tích hợp.

## 3. Vòng làm mỗi task

1. Đọc task và tiêu chí của nó.
2. Sửa ít nhất đủ đạt tiêu chí. Không dọn dẹp, không thêm tính năng ngoài plan.
3. **Kiểm hẹp:** chỉ chạy test của phần vừa sửa. Đọc kết quả rồi mới kết luận.
4. Đạt ⇒ đổi `- [ ]` thành `- [x]` trong PLAN. Chưa đạt thì chưa tick, không tick trước để sửa sau.
5. Commit cùng PLAN đã tick.

PLAN cũ không có ô tick ⇒ ghi vào mục `## Kết quả`, không bắt viết lại plan.

Xong hết task ⇒ **kiểm rộng:** `node ~/.claude/hooks/flow-check.mjs --dir <worktree>` và test của những chỗ gọi tới phần vừa sửa.
Bộ đủ để dành cho `flow-qa`. Kết quả cũ chỉ dùng lại được khi code, dữ liệu vào và môi trường không đổi.

## 4. Khi kiểm hỏng

| Tình huống | Làm |
|---|---|
| Hỏng do thay đổi của mình | Tự sửa, không hỏi |
| Cùng một bước sửa 2 lần vẫn không qua | Dừng task, dùng `flow-fix` tìm nguyên nhân |
| Hỏng sẵn, không do việc này | Không sửa kèm, ghi `## Phát hiện bất ngờ` kèm bằng chứng, báo lúc xong |
| Muốn nới test, tắt kiểm cho xanh | Không làm |

## 5. Khi nào được ngắt lời user

**Việc lớn: im lặng tới khi xong** [rofm]. Không gửi báo cáo tiến độ giữa chừng; tiến độ ghi vào `progress.md` để phiên sau làm tiếp được.

Chỉ dừng hỏi khi: đổi điều người dùng thấy · thêm hoặc bỏ tính năng · xoá hoặc đổi dữ liệu · thêm thứ tốn tiền · quyền, bảo mật ·
đổi kiến trúc lớn hoặc mục tiêu đã chốt · không sửa được sau khi đã qua `flow-fix`.

Còn lại tự quyết và ghi `## Thay đổi plan`: đổi thứ tự, chia nhỏ task, tên file, thư viện trong danh sách cho phép, thêm bước kiểm.
Làm ra sai ý ⇒ quay về plan sửa cho cụ thể rồi làm lại phần đó, không vá chồng.

User bảo bỏ test ⇒ làm theo, ghi `Chưa kiểm: <phần nào>` vào `progress.md`, nhắc lại lúc gộp.

## 6. Kết thúc

- Mọi tiêu chí trong plan có bằng chứng, hoặc ghi rõ phần chưa kiểm.
- Tiêu chí có task phủ và ô tick khớp với code đã commit. Plan hoàn tất nằm cùng commit với code [m2is].
- Cập nhật `Bước tiếp theo` trong `progress.md`.
- Sang `flow-qa`. Báo user theo khuôn: làm được gì · người dùng sẽ thấy gì khác · còn gì cần bạn làm.

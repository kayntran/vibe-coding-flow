---
name: flow-key-leak
description: Xử lý khoá bí mật bị lộ theo đúng thứ tự để app không chết — tìm chỗ lộ, tạo khoá mới, chuyển app, phát hành, nhờ user thu hồi khoá cũ, xem ai đã dùng. Dùng khi user nói "khoá bị lộ", "đổi khoá", "lỡ đưa mật khẩu lên git", hoặc máy kiểm báo khoá trong bản build. KHÔNG dùng cho quét bảo mật chung (flow-security).
---

# Khoá bị lộ

Bước theo dịch vụ nằm ở `key-rotation.md`; đọc khi làm.

## Luật

- **Không để khoá hiện ra chat, log, commit, file `.md`.** Chỉ nêu tên khoá và vị trí. Không đọc `.env*`, `.dev.vars`.
- **Không thử khoá** xem còn dùng được không. Khoá đã lộ coi như đã bị dùng.
- **Thứ tự: thêm khoá mới → chuyển app → phát hành → thu hồi khoá cũ.** Thu hồi trước = app chết. Khoá đang bị lạm dụng (phí tăng, dữ liệu lạ): kể điều đó, hỏi user có thu hồi ngay và chấp nhận app tạm dừng không.
- **Không viết lại lịch sử git.** Xoá khỏi lịch sử không làm khoá hết hiệu lực; chỉ thu hồi mới có tác dụng. User muốn dọn lịch sử
  thì kể mất gì và chờ user gật, vì việc này không hoàn tác được.

## Ai làm gì

- **AI tạo khoá mới** khi dịch vụ có lệnh hoặc công cụ làm được, rồi đặt vào nơi chạy, không in giá trị. Không làm được ⇒ chỉ đúng
  chỗ bấm, user dán thẳng vào bảng điều khiển hoặc vào lệnh `… secret put` tự hỏi giá trị.
- **User thu hồi khoá cũ** ở trang của dịch vụ, sau khi bản mới đã chạy đạt. AI chỉ đúng chỗ bấm.

## Xong khi nào

1. App chạy khoá mới, thử nhanh đạt (skill `flow-publish`).
2. User báo đã thu hồi khoá cũ.
3. Đã **xem ai đã dùng khoá**: log hoặc trang dùng/hoá đơn của dịch vụ từ lúc lộ tới lúc thu hồi; kể có truy cập lạ không. Không xem được thì nói "chưa xác nhận được".
4. `flow-check` hết đỏ; sổ chốt có dòng "đã đổi khoá <tên>, ngày".

**Báo user:** đã làm gì · người dùng app có bị đăng xuất hay gián đoạn không · còn gì cần bạn làm.

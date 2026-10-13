# Công thức: đổi khoá bí mật bị lộ (AC-30b)

Dùng khi khoá lộ trong git, bản build hoặc log (preflight báo "khoá trong bản build", máy kiểm bí mật đỏ, hoặc user nói).

## Luật cứng
- **Không để khoá hiện ra chat, log, commit, file `.md`.** Không đọc giá trị khoá lên màn hình; user dán khoá mới thẳng
  vào bảng điều khiển hoặc vào `.dev.vars`/`.env` (git-ignore) hoặc lệnh `… secret put` tự hỏi giá trị. Không đọc `.env*`, `.dev.vars`.
- **Thứ tự bắt buộc: thêm khoá mới → chuyển app sang khoá mới → phát hành → thu hồi khoá cũ.** Thu hồi trước khi app
  chạy khoá mới = app chết. Khoá đã lộ coi như đã bị dùng: sau khi thu hồi, xem log dịch vụ có truy cập lạ không.
- Đã lộ trong git: xoá khỏi lịch sử không đủ — vẫn phải thu hồi. Chỉ viết lại lịch sử khi user đồng ý (việc phá huỷ).

## Các bước (nói user bằng lời, từng bước một)
1. **Tìm chỗ lộ:** khoá nào, ở đâu (file/commit/bản build/log); chỉ nêu TÊN khoá và vị trí, không nêu giá trị.
2. **Tạo khoá mới** ở dịch vụ (bảng dưới). Chưa đụng khoá cũ.
3. **Thay vào app:** đặt khoá mới vào nơi chạy; gỡ khoá cũ khỏi code/bản build (khoá phía server không được vào bundle trình duyệt).
4. **Phát hành bản dùng khoá mới** (SKILL bước 2–3). Đổi khoá Workers bằng `pnpm exec wrangler versions secret put <TÊN>` rồi
   `release cf` để bài thử nhanh vẫn chạy (không dùng `wrangler secret put` — phát hành ngay, lọt qua bài thử).
5. **Thử nhanh đạt** rồi mới **thu hồi khoá cũ** ở dịch vụ.
6. **Dọn:** ghi vào sổ chốt "đã đổi khoá <tên>, ngày"; chạy lại `flow-check` để máy kiểm hết đỏ.

## Theo dịch vụ (đường đi trên bảng điều khiển; chưa chạy thật)
| Dịch vụ | Tạo khoá mới | Thu hồi khoá cũ |
|---|---|---|
| Supabase | Project Settings → API Keys → tạo secret key mới (hoặc "Roll" JWT secret — làm đổi mọi khoá, đăng xuất mọi người dùng, cân nhắc) | xoá/vô hiệu khoá cũ cùng trang; mật khẩu database: Settings → Database → Reset password (cập nhật `DATABASE_URL` trước khi app dùng) |
| Cloudflare | My Profile → API Tokens → Create token (quyền tối thiểu) | cùng trang → token cũ → Roll/Delete |
| Better Auth | tạo chuỗi bí mật mới (`BETTER_AUTH_SECRET`, chuỗi ngẫu nhiên dài) đặt vào nơi chạy | bỏ chuỗi cũ; **mọi phiên đăng nhập đang có bị đăng xuất** — báo user trước |
| GitHub | Settings → Developer settings → tạo token mới (hoặc deploy key) | token cũ → Delete; xem Security log có dùng lạ không |
| Khoá AI / dịch vụ khác | trang quản lý khoá của dịch vụ → tạo khoá mới | xoá khoá cũ cùng trang; xem trang dùng/hoá đơn có bất thường không |

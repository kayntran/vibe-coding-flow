---
name: flow-security
description: Kiểm bảo mật phần code vừa sửa hoặc điểm nhạy cảm của app — khoá lọt, thư viện có lỗ hổng, ai xem được dữ liệu của ai, chống giả mạo, nhật ký, giới hạn tốc độ. Dùng khi user nói "kiểm bảo mật", "có lỗ hổng không", "người khác xem được dữ liệu không", hoặc diff đụng đăng nhập, quyền, tiền. KHÔNG dùng cho khoá đã lộ (flow-key-leak), quét cả app trước khi phát hành (flow-publish), soát chất lượng chung (flow-review).
---

# Flow — kiểm bảo mật

Trả lời một câu: **phần vừa đổi có mở ra đường nào để người không có quyền lấy, sửa hay phá dữ liệu không?**

**Đây không phải pentest.** Kiểm này đọc code và chạy công cụ trên máy, không tấn công thật, không chứng minh app an toàn. Báo
cáo luôn nói rõ giới hạn đó. App đụng tiền, sức khoẻ hoặc trẻ em ⇒ nói rõ rủi ro còn lại và khuyên thuê kiểm thử; user quyết,
không chặn chờ chuyên gia.

## Luật an toàn

- **Che khoá:** báo cáo chỉ ghi `<ĐÃ CHE: tên loại khoá>` và tên biến môi trường. Không in giá trị, số ký tự hay ký tự cuối;
  chuỗi kết nối che cả phần `user:mật-khẩu@`.
- **Không thử khoá:** thấy khoá thì không gọi thử xem còn sống không. Dùng nó là đăng nhập bằng danh tính người khác.
- **Không tự viết lại lịch sử git.** Gỡ khoá khỏi code không làm khoá hết hiệu lực; khoá có thể thật ⇒ skill `flow-key-leak`.
- **Không quét chủ động địa chỉ thật.** Quét bản chạy thật cần sự đồng ý riêng, và thuộc bước phát hành.
- Gửi model ngoài chỉ qua `review-ext.mjs` (gửi sạch), không gửi dữ liệu thật hay khoá.

## 1. Khoanh phạm vi

Mặc định là phần vừa sửa: `git diff main...HEAD`. Gọi từ `flow-health`, hoặc user hỏi về app đang chạy ⇒ đọc các điểm nhạy cảm hiện có: đăng nhập, phân quyền, API ghi dữ liệu, tải file, thanh toán. User muốn "cả app" hoặc sắp lên mạng ⇒ phần quét cả app (ZAP, Strix) nằm ở
skill `flow-publish`; ở đây chỉ đọc thêm các điểm nhạy cảm, và nói rõ phạm vi đã đọc.

Trước khi xét lỗi, ghi 3 dòng: **thứ cần bảo vệ** (dữ liệu, tiền, tài khoản) · **ai chạm được** (khách chưa đăng nhập, người dùng,
quản trị, dịch vụ khác) · **ranh giới tin cậy** (dữ liệu từ đâu vào, chỗ nào được tin). Tên hàm nghe nguy hiểm chưa phải lỗi:
phải có đường đi tới được từ bên ngoài.

## 2. Máy kiểm trước

```bash
git diff main...HEAD | node ~/.claude/hooks/secret-scan.mjs --diff -
node ~/.claude/hooks/flow-check.mjs --dir <WT>
node ~/.claude/hooks/deps-check.mjs --repo <WT> --base main --head HEAD
```
Thêm: `.env` có bị git theo dõi không (`git ls-files .env .env.local .env.production`), thư viện vừa thêm có lỗ hổng không.
Công cụ không chạy được ⇒ ghi "chưa kiểm được" vào báo cáo, không coi là sạch.

## 3. Đọc theo 6 câu hỏi

Chỉ hỏi phần code vừa đổi chạm tới; không có thì ghi "không áp dụng". Máy kiểm thường bắt thiếu ở cột "Hay sót".

| Mối đe doạ | Hỏi | Hay sót |
|---|---|---|
| Giả mạo | Phiên, token, webhook có được xác minh ở server không? | Webhook không kiểm chữ ký; link đặt lại mật khẩu dùng nhiều lần |
| Sửa trộm | Dữ liệu vào có kiểm ở server/DB không, hay chỉ ở giao diện? | Giá tiền, vai trò lấy từ phía trình duyệt |
| Chối bỏ | Việc quan trọng (tiền, xoá, đổi quyền) có **nhật ký** ai làm, lúc nào không? | Không có nhật ký nào; nhật ký ghi cả khoá hay dữ liệu riêng |
| Lộ thông tin | Lỗi, log, API có trả thừa dữ liệu không? | Thông báo lỗi lộ cấu trúc; API trả cả cột không cần |
| Làm sập | Có **giới hạn tốc độ** và trần kích thước ở chỗ tốn kém không? | Đăng nhập thử mật khẩu vô hạn; API gọi AI tốn tiền không giới hạn; tải file không trần |
| Vượt quyền | Đổi mã trong đường dẫn có xem được đồ người khác không? | Chỉ ẩn nút mà server không chặn; RLS thiếu `with check` |

Thêm các lỗi quen: ghép chuỗi vào SQL/lệnh hệ thống/đường dẫn file, HTML không thoát, số ngẫu nhiên yếu cho token, gọi URL do
người dùng nhập (SSRF), CORS/cookie lỏng.

SPEC có mã quyền `P-nn` ⇒ chỉ đọc xem mã nào đổi. Bằng chứng "đỏ khi tắt chặn quyền" thuộc skill `flow-qa`, không làm lại.

## 4. Lấy ý kiến model khác khi nhạy cảm

Theo bậc của `flow-review`, dùng `review-brief-security.md`. **Cùng commit đã có lượt bảo mật của `flow-review` ⇒ dùng lại, không
gọi lần hai; `flow-review` cũng dùng lại lượt của skill này theo cùng cách.** AI ngoài đều hết lượt ⇒ Agent `code-reviewer` và nói rõ chỉ có soát nội bộ.

## 5. Kiểm rồi mới xếp mức

Mỗi lỗi phải có: vị trí `path:line`, kịch bản tấn công cụ thể, tác động, điều kiện đi kèm. Không dựng được đường đi ⇒ ghi vào
mục "đã xét, không phải lỗi" kèm chứng cứ. Trùng gốc ⇒ gộp một.

| Mức | Nghĩa |
|---|---|
| Cao | Dùng được ngay hoặc khá dễ: mất dữ liệu, lộ dữ liệu người khác, mất tiền, chiếm tài khoản |
| Vừa | Cần điều kiện khó hoặc tác động hẹp |
| Thấp | Lớp phòng thủ thêm, chưa thấy cách khai thác |

## 6. Báo và xử lý

Mặc định chỉ báo, không tự sửa. Báo cáo một trang trong chat, nói theo góc người dùng:
- **Lỗi Cao và chắc chắn:** kể "ai làm được gì, mất gì", sửa tốn gì, rồi hỏi (AskUserQuestion): "Sửa" hoặc "Để sau". Chọn "Sửa" ⇒ Agent
  `coder` viết test đỏ tái hiện trước, sửa, chạy lại phần kiểm đó. Chọn "Để sau" ⇒ giữ nguyên mức, nhắc lại lúc gộp; chưa sửa thì `flow-release` dừng, không phát hành.
- **Lỗi Vừa, Thấp:** liệt kê, không hỏi từng cái; user bảo sửa thì sửa.
- **Khoá thật trong code:** chuyển skill `flow-key-leak` ngay.

Khuôn: **đã kiểm phần nào · lỗi theo mức · đã xét và bác · chưa kiểm được gì · đây không phải pentest**.
Lưu báo cáo ở `docs/specs/<tính năng>/notes/security.md` khi có thư mục tính năng; không ghi giá trị khoá vào đó.

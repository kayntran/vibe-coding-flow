# Thiết kế: <tên tính năng / app>

<!-- Mục có (M) là bắt buộc cả cỡ M; cỡ L và app mới viết đủ mọi mục. Mỗi con số ghi nguồn trong ngoặc:
     (SPEC) · (user nói) · (đo ngày …) · (tra <trang> ngày …) · (giả định). -->

**Hạng quy mô (M):** prototype | MVP | đang tăng | quy mô lớn — vì sao xếp hạng này, một dòng.

## 1. Tóm tắt (M)
3–5 dòng đời thường: làm gì, chạy trên gì, tốn khoảng bao nhiêu mỗi tháng, rủi ro lớn nhất.

## 2. Bối cảnh, mục tiêu, không làm (M)
- Mục tiêu: trỏ `AC-nn` trong SPEC.
- Không làm: những thứ dễ tưởng là có nhưng lần này không có.

## 3. Yêu cầu phi chức năng (M)
| Mục | Con số | Nguồn |
|---|---|---|
| Người dùng hoạt động/ngày (năm đầu) | | |
| Độ trễ (95% request dưới) | | |
| Thời gian chạy (uptime) | | |
| Mất dữ liệu tối đa chấp nhận (RPO) / thời gian khôi phục (RTO) | | |
| Ngân sách hạ tầng/tháng | | |
| Người vận hành | | |

**Giả định:** liệt kê, mỗi dòng một giả định cần user xác nhận hoặc đo lại.

## 4. Ước lượng (M)
Request/giây trung bình và cao điểm · tỉ lệ đọc/ghi · dung lượng 1 năm · băng thông · **chi phí tháng theo từng khoản**
(hạ tầng, AI, SMS/email, lưu file). Ghi phép tính, không chỉ ghi kết quả.

## 5. Bản mẫu tính năng đã áp (M)
| Loại | Làm ngay (→ AC/task) | Chừa chỗ (móc ở đâu) | Chưa làm (ngưỡng cần) |
|---|---|---|---|

## 6. Kiến trúc tổng (M)
```mermaid
flowchart LR
  user[Người dùng] --> app[App]
```
Luồng chính bằng chữ, đánh số, khớp từng hộp trong sơ đồ.

## 7. Chi tiết thành phần
Mỗi thành phần: làm gì · vì sao cần (yêu cầu/con số nào) · **nó chết thì sao** · thay thế đã loại.

## 8. Dữ liệu (M)
Bảng chính, khoá, index cho truy vấn chính, ai đọc/ghi gì (quyền ở lớp dữ liệu), giữ bao lâu, xoá thế nào, migration.

## 9. API
Endpoint/hàm chính · định dạng lỗi · phân trang · khoá chống gửi trùng cho việc tốn tiền · giới hạn tần suất.

## 10. Khi có sự cố (M)
| Thành phần | Hỏng kiểu gì | Người dùng thấy gì | Hệ thống làm gì (timeout, thử lại, chạy giảm chức năng) |
|---|---|---|---|

## 11. Bảo mật
Đăng nhập, phân quyền, tách dữ liệu giữa khách hàng, khoá bí mật để đâu, chống lạm dụng, mối đe doạ chính.

## 12. Giám sát
Log có cấu trúc · số đo chính · cảnh báo nào báo ai · xem lỗi bản thật ở đâu.

## 13. Triển khai
Môi trường · phát hành dần hay một lần · cách quay lại bản trước · cờ bật/tắt tính năng nếu cần.

## 14. Chi phí
Bảng khoản phí/tháng ở hạng hiện tại và ở 10× người dùng; khoản nào đội nhanh nhất.

## 15. Đánh đổi (M)
| Quyết định | Chọn | Đã loại | Vì sao | Xem lại khi |
|---|---|---|---|---|
Quyết định khó đảo ngược ⇒ ADR riêng theo mẫu ADR của skill, lưu `docs/adr/`, trỏ tới đây.

## 16. Lộ trình theo ngưỡng (M)
| Khi (ngưỡng đo được) | Làm |
|---|---|

## 17. Rủi ro và câu hỏi mở (M)

## Soát
Một dòng: ai soát (tự soát / model nào), mục nhận, mục bác kèm lý do.

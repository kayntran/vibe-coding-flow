# Danh sách soát giao diện

Dòng ⚙ do `ui-check` kiểm được khi dự án có `.claude/ui.json`; còn lại soát bằng mắt trên ảnh thật.

## Bố cục, cả 3 cỡ

- Không cuộn ngang; không chữ, nút, bảng tràn hay bị cắt.
- Không phần tử che nhau; thanh cố định không che việc chính, kể cả khi bàn phím điện thoại mở.
- Hộp thoại, danh sách thả xuống vừa màn và đóng được.
- Chuỗi dài nhất (tên người, địa chỉ tiếng Việt, số tiền lớn) vẫn gọn.

## Dùng được

- Vùng chạm tối thiểu 44×44 trên điện thoại, cách nhau đủ để không bấm nhầm.
- Tương phản: chữ thường 4.5:1, chữ lớn và thành phần 3:1.
- Dùng được bằng bàn phím: thứ tự Tab đúng, thấy focus, Esc đóng hộp thoại.
- Không dựa vào mỗi màu hay mỗi hover để truyền ý.
- Font hiển thị đủ dấu tiếng Việt, không vỡ dòng giữa từ.

## Luật tối giản

1. ⚙ Mỗi màn đúng một nút chính.
2. ⚙ Nhãn nút 1-3 chữ, động từ; không OK, Yes, Submit, Có, Không, Xác nhận.
3. ⚙ Nút chỉ có icon chỉ cho nhà, in, tìm kiếm, đóng (X); còn lại có nhãn hiện ra.
4. Hộp xác nhận chỉ cho xoá hoặc ghi đè không hoàn tác, tiền, quyền; nêu tên đối tượng, nút theo kết quả, focus không rơi vào nút
   phá huỷ.
5. Việc hoàn tác được thì dùng nút Hoàn tác, không hộp xác nhận.
6. ⚙ Không hộp thoại lúc mở app, không banner chỉ để thông báo.
7. Lỗi một dòng cạnh ô sai, giữ giá trị đã nhập, không mã lỗi trần.
8. Màn trống: một câu và một nút bước đầu, khác trạng thái đang tải.
9. Mọi tính năng tới được trong tối đa 2 lần bấm từ màn chính.
10. Đang lưu: nút đổi trạng thái; mục mới sáng lên. Thông báo nhỏ chỉ khi có Hoàn tác.

## Trạng thái

Có dữ liệu, trống, đang tải, lỗi, không có quyền nếu có. Tải lại trang, quay lại, mở link sâu: không mất bộ lọc hay nội dung đang
nhập. Nhập rỗng, sai, rất dài.

## Dọn

Không còn bản demo thừa, thanh chuyển demo, chữ giả, dữ liệu mẫu trong bản thật. Console không có lỗi đỏ.

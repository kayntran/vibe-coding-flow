# Dò trường hợp hiếm

## Các chiều

Đánh dấu chiều nào liên quan tới tính năng; bỏ chiều nào thì ghi giả định ứng với nó. Giả định có thể sai trong đời tính năng
thì chính nó là một trường hợp phải xét.

| Chiều | Hỏi gì |
|---|---|
| Người dùng | Khách, người mới, người bị khoá, chủ, nhân viên làm gì khác nhau |
| Dữ liệu vào | Rỗng, rất dài, tiếng Việt có dấu, ký tự lạ, nội dung độc |
| Thời điểm | Bấm hai lần, hai người cùng sửa, chờ lâu, mất mạng giữa chừng |
| Số lượng | 0 mục, 1 mục, rất nhiều mục, chuyển trang ở biên |
| Dở dang | Lần đầu dùng, bỏ giữa chừng, tải lại trang, quay lại sau lỗi |
| Thiết bị | Điện thoại yếu, màn hẹp, chỉ dùng bàn phím, múi giờ khác |
| Hỏng dây chuyền | Dịch vụ ngoài chết, ghi được một nửa, hết chỗ |
| Quyền | Phiên hết hạn, sai vai, link chia sẻ, xem dữ liệu người khác |
| Toàn vẹn | Trùng, mồ côi, dữ liệu cũ gặp code mới |
| Tiền, luật | Giá 0 hoặc âm, hoàn tiền một phần, xoá dữ liệu theo yêu cầu |

## Cách dừng

Lặp từng vòng, mỗi vòng chọn chiều chưa xét hoặc ghép hai chiều. Dừng khi **hai vòng liên tiếp không có trường hợp mới**, hoặc
quá 5 vòng. Khi báo, nói rõ đây là dò có giới hạn, không phải đã hết mọi trường hợp.

Không chấm điểm, không đếm cho đủ số. Trường hợp vô nghĩa với tính năng thì bỏ.

## Kết quả

Giữ lại thì thành tiêu chí `KHI … THÌ HỆ THỐNG PHẢI …` hoặc dòng "Không làm". Có thể giao `researcher` gom thêm trường hợp
người khác từng gặp với bài tương tự.

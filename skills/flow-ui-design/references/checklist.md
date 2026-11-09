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
- Nút là `<button>`, link là `<a>`, không `div` bấm được; ô nhập có nhãn; nút chỉ icon có tên đọc được. Không `outline: none` mà
  không có viền focus thay thế.

## Nhập liệu và con số

- Ô nhập đúng loại: số điện thoại, tiền, mã ⇒ bàn phím số (`type`/`inputmode`); email, mật khẩu, địa chỉ có `autocomplete`. Không
  chặn dán.
- Đăng nhập: cho dán mật khẩu, có nút hiện/ẩn mật khẩu, trình quản lý mật khẩu điền được (`autocomplete="current-password"`,
  `"new-password"`).
- Tiền, số, ngày theo kiểu Việt qua `Intl` (`1.000.000 ₫`, `08/11/2026`), không ghép chuỗi tay.
- Số trong bảng, tiền, giờ đếm: thẳng cột (`tabular-nums`). Ảnh có kích thước sẵn để màn không nhảy khi tải. Không khoá phóng to;
  nút sát mép không bị tai thỏ hay thanh điều hướng che (vùng an toàn).

## Token

- ⚙ Màu, cỡ chữ, khoảng cách, bo góc, bóng lấy từ token; không gõ số rời (`#1a2b3c`, `text-[13px]`, `style={{ color: … }}`) — máy
  `ui-token` của `flow-check` nhắc.
- Màn chỉ dùng token tầng vai trò hoặc thành phần, không dùng thẳng giá trị gốc (tầng 1 của bộ token 3 tầng).
- Thành phần bấm được thấy rõ đủ 6 trạng thái: mặc định, hover, nhấn, focus (Tab), tắt, đang chọn.
- Chế độ tối (nếu app có) và chế độ dày đặc (nếu có): soát lại tương phản, vòng focus, vùng bấm.

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

## Giữ danh sách này gọn

Mỗi dòng ở đây phải bắt được lỗi thật. Dòng nào qua 3 lần soát liền (3 tính năng khác nhau) không bắt được lỗi nào thì đề xuất bỏ
khi gộp; dòng ⚙ do máy kiểm thì giữ. Lỗi giao diện mới gặp mà danh sách chưa có thì thêm một dòng.

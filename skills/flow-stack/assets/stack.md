# Mẫu STACK.md

`docs/STACK.md` trong app. Chưa có thư mục app: lưu nháp ở `<thư mục cha>/.flow-nhap/<tên-app>/STACK.md` (thư mục cha = giá trị `--dir` của `flow-new-app`; chưa chốt thì thư mục làm việc hiện tại của phiên, nói user một dòng), chuyển vào `docs/` ngay sau khi `flow-new-app` tạo xong; app đã có thì ghi thẳng `docs/`. Chỉ `flow-stack` ghi; skill khác chỉ đọc.

Chép khối dưới, thay mọi `<…>`, bỏ chú thích sau `#`. Tiêu đề `## 0. Tóm tắt` giữ nguyên chữ (hook tìm theo tiêu đề đó). Chỉ viết mảng áp dụng cho app.

## Mẫu

```
---
ten_app: <tên>
phien_ban: 0.1.0               # nháp 0.x; user gật lần đầu ⇒ 1.0.0
trang_thai: nhap               # nhap | da-duyet
goi: <nhe|chac|may-chu-rieng|tai-may>   # tai-may: app máy tính offline hoặc extension không tài khoản, không có máy chủ nên không hỏi gói
loai_app: <web|web-public|desktop|extension>   # flow-new-app lấy từ đây, không hỏi lại
gia_tra_ngay: <YYYY-MM-DD>     # ngày tra giá gần nhất; quá 30 ngày ⇒ tra lại trước khi quyết chuyện tiền
duyet: <YYYY-MM-DD>            # ngày user gật; nháp thì để trống
sua_cuoi: <YYYY-MM-DD>
vong_da_xong: <n>/<tổng ước>   # chỉ khi nháp: hỏi tiếp từ đây
---
# STACK — <tên app>

## 0. Tóm tắt
<≤ 10 dòng và ≤ 1.000 ký tự, đời thường, mỗi dòng một ý: gói nền · loại app và khung · nơi chạy · cơ sở dữ liệu · đăng nhập · thu tiền · dịch vụ ngoài đã chọn · phí tháng ước tính (giá ngày …) · mốc nâng cấp gần nhất · điều AI KHÔNG tự đổi>

## Luật của app về công nghệ
- Không đổi hay thêm khung, cơ sở dữ liệu, dịch vụ ngoài khi user chưa bảo; cần thứ mới ⇒ hỏi một câu kèm 5 ý và phí.
- Chỉ nhắc khi app chạm mốc nâng cấp dưới đây, không tự làm.
- Mảng không áp dụng: <số mảng + lý do ngắn, vd "3, 6, 9: dùng riêng, không tài khoản">

### <tên mảng, vd Cơ sở dữ liệu>
- Chọn: <phương án>
- Vì sao: <một câu, tác động lên người dùng hoặc tiền>
- Chịu tới: <số người hoặc lượt, nói rõ chỗ có trần cứng>
- Phí: <ước tính mỗi tháng> (giá ngày <YYYY-MM-DD>)
- Mốc nâng cấp: <số đo được ⇒ làm gì>
- Lối thoát: <đau nhẹ/vừa/nặng, cách mang dữ liệu đi>
- Kit: <mẫu | luật | chưa có ⇒ rủi ro cao hơn>
- Ai chọn: <Bạn chọn | Mặc định gói | Đang dùng>

## Nhật ký đổi
| Ngày | Mảng | Từ ⇒ thành | Vì sao | Tài liệu phải xem lại |
|---|---|---|---|---|
```

## Ví dụ hai mảng điền (app đặt lịch tiệm tóc, thu cọc, khách Việt, trần chi dưới 500 nghìn, UT1 = ra nhanh và rẻ)

```
### Cơ sở dữ liệu
- Chọn: D1 của Cloudflare, mọi truy vấn qua lớp `store`
- Vì sao: nằm trong trần chi tháng; bạn chọn "ra nhanh và rẻ" là quan trọng nhất. Phương án Chắc (Postgres trả phí) vượt trần khoảng <số> mỗi tháng
- Chịu tới: hàng nghìn khách mỗi ngày; DB có trần dung lượng cứng
- Phí: <ước tính> (giá ngày 2026-11-22)
- Mốc nâng cấp: dung lượng DB chạm 80% trần, hoặc mở chi nhánh thứ hai (nhiều công ty) ⇒ chuyển sang Postgres qua lớp `store`, không làm lại giao diện
- Lối thoát: vừa, SQLite xuất được nhưng phải viết lại schema theo Postgres
- Kit: mẫu (D1); công thức Postgres đã có cho ngày chuyển
- Ai chọn: Bạn chọn

### Thu tiền
- Chọn: SePay (khách chuyển khoản QR, tiền về thẳng tài khoản của tiệm)
- Vì sao: chỉ cần thấy tiền về rồi giữ lịch; không cần cổng thẻ
- Chịu tới: theo hạn mức gói của nhà cung cấp
- Phí: <ước tính> (giá ngày 2026-11-22)
- Mốc nâng cấp: số giao dịch/tháng chạm hạn mức gói ⇒ nâng gói
- Lối thoát: nhẹ, đổi nhà = đổi một hàm bọc + đối soát. Hoàn cọc làm theo tài liệu hoàn tiền của skill SePay
- Kit: skill chính hãng SePay, cài mức dự án ở bước chuẩn bị của việc đầu tiên sau khi hỏi user; luật an toàn của `ban-mau-tien.md` vẫn giữ
- Ai chọn: Bạn chọn
```

## Quy tắc điền

- Mỗi mảng đủ các dòng trên; "Chọn" đúng một phương án. Giá luôn kèm ngày tra; không ghi giá không có ngày.
- Mục 0 ≤ 10 dòng, ≤ 1.000 ký tự: hook chỉ nạp mục này vào mỗi phiên.
- "Đang dùng" cho thứ đọc được từ code của app có sẵn; không đoán, không đổi thứ đó khi chưa được bảo.
- Số phiên bản: MAJOR khi đổi gói, cơ sở dữ liệu hoặc khung · MINOR khi thêm mảng · PATCH khi sửa chữ. Mỗi lần đổi ghi một dòng ở Nhật ký đổi.
- Quyết định lớn (gói, loại app và khung, cơ sở dữ liệu, đăng nhập, thu tiền) có thêm một dòng sổ chốt trỏ mảng. Lệch nhau ⇒ sổ chốt thắng, sửa file.
- Mục "Công nghệ đã chốt" trong `AI_RULES.md` của app ghi sau khi app được tạo, không ghi trong lúc còn nháp.

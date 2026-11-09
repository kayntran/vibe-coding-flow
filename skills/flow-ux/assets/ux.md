# Mẫu UX.md và bảng tình huống dùng

## Bảng tình huống dùng

Mỗi nhóm người dùng khác cách dùng là một dòng, thường 1-3 dòng. Ví dụ điền:

| Trường | Ví dụ |
|---|---|
| Ai | Shipper giao đơn |
| Lúc nào, bao lâu một lần | Giữa hai điểm giao, 30 lần một ngày |
| Ở đâu, máy gì | Ngoài đường, điện thoại, nắng |
| Đang thế nào | Vội, một tay, mạng chập chờn |
| Muốn xong việc gì | Đánh dấu đã giao trong dưới 5 giây |
| Trước và sau đó làm gì | Trước: xem địa chỉ. Sau: đi điểm tiếp |
| Mức chắc | **Bạn nói**, **Dữ liệu cho thấy**, hoặc **AI đoán** |

## Mẫu `docs/specs/<YYYY-MM-DD>-<slug>/UX.md`

```
# Luồng: <tính năng>
## Tình huống dùng
<bảng tình huống dùng ở trên>
## Luồng việc chính
Màn A → Màn B → Xong (N lần bấm)
Nhánh: lần đầu → … · lỗi → … · bỏ giữa chừng → …
## Các màn
| Màn | Việc chính | Người dùng so sánh bằng gì (phải nổi nhất) | Vì tình huống nào |
## Tham khảo
| Màn | App (link Mobbin/link user dán) | Học gì | Mức chắc (tiền lệ / ví dụ / ý kiến) |
## Giả định cần kiểm
- <giả định> → kiểm bằng: <bài người mới / hỏi khách / số liệu>
```

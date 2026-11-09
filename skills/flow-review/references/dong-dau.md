# Trường của JSON đóng dấu review

Dùng ở bước 5 của `flow-review`.

**JSON cuối** gộp từ các file lượt soát: `findings` = tất cả, kèm trạng thái sửa/bác/chấp nhận, mã AC liên quan, `commit` đã review,
`reviewers`.

**Chỉ sửa MINOR** (không gọi lại model): thêm vào JSON cũ `"delta_reviewed_by": "captain", "delta": "<commit đã review>..HEAD"`.

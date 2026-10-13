<!-- Mẫu điền tay cho nơi sao lưu không qua backup.mjs (vd Supabase Pro tự sao lưu, hoặc user tự làm). Khi dùng
     `backup.mjs khoi-phuc-thu`, kit tự ghi docs/BACKUP.md cùng các mục này (dòng đầu bắt đầu bằng "<!-- flow-backup:auto")
     và sẽ ghi đè file đó khi chạy lại — đừng sửa tay file tự sinh. Điền xong xoá các dòng chú thích này. -->
# Sao lưu dữ liệu

## Cách làm
- <Cách sao lưu, một câu: vd "xuất database D1 bằng wrangler d1 export" / "pg_dump schema public" / "Supabase Pro sao lưu hằng ngày">.
- <Chỉ khi D1: có thêm Time Travel, quay về bất kỳ phút nào trong 7 ngày gần nhất.>

## Chỗ cất
- <Thư mục/dịch vụ>/<ngày>/ — nằm ngoài thư mục dự án, KHÔNG đưa lên git (có dữ liệu người dùng).

## Lịch
- <Cách chạy tự động (Task Scheduler / launchd / cron / dịch vụ), mỗi bao nhiêu giờ; ghi rõ "chỉ chạy khi máy bật" nếu là máy cá nhân>.

## Lần thử khôi phục gần nhất
- Ngày: <YYYY-MM-DD HH:MM>
- Bản dùng để thử: <tên file> (<kích thước>, mã kiểm tra <12 ký tự đầu của SHA256>…)
- Kết quả: <đạt/không đạt> — <số bảng> bảng, <số dòng> dòng khớp bản gốc, <truy vấn mẫu trả đúng>.

## Khi cần khôi phục thật
- <Các bước, đời thường. Luôn: hỏi người dùng trước, vì sẽ ghi vào dữ liệu thật.>

## Chưa sao lưu
- <Phần chưa được sao lưu, vd file đính kèm (Storage/R2). Không có thì bỏ mục này.>

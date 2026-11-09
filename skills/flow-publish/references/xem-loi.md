# Xem lỗi bản thật

`node ~/.claude/hooks/release.mjs logs --since 24h` (hoặc `7d`), kể lại: lỗi gì,
bao nhiêu lần, từ khi nào, ở luồng nào. Log miễn phí giữ ngắn (Workers 3 ngày, Supabase 1 ngày): lệnh sẽ nói khoảng nào
không còn log; nhắc lại, đừng kết luận "không lỗi". Exit 3 (thiếu token đọc log) ⇒ đưa đúng việc cần làm; token chỉ-đọc,
không dán ra chat.

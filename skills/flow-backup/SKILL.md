---
name: flow-backup
description: Chọn, bật, chạy, đặt lịch và thử khôi phục sao lưu dữ liệu app. Dùng khi user nói "sao lưu", "backup", "khôi phục thử", hoặc kiểm trước phát hành báo chưa chọn sao lưu. KHÔNG dùng cho quay lại phần mềm (flow-rollback); không tự bật khi user chưa đồng ý cho đúng app đó.
---

# Sao lưu

App có dữ liệu thật ⇒ hỏi user có bật sao lưu không, kèm đề xuất cách và chỗ cất (khác chỗ đặt dữ liệu chính, ngoài git). Chỉ sau khi
user nói **có** cho đúng app đó mới thêm `--dong-y`; thiếu cờ này lệnh trả exit 4 kèm câu để hỏi.

```
node ~/.claude/hooks/backup.mjs chon on <thư-mục-app> --method d1|pg [--db …] [--dest …] [--every <giờ>] --dong-y
node ~/.claude/hooks/backup.mjs chay <thư-mục-app> --dong-y
node ~/.claude/hooks/backup.mjs khoi-phuc-thu <thư-mục-app> --dong-y   # đạt thì tự ghi docs/BACKUP.md
node ~/.claude/hooks/backup.mjs lich <thư-mục-app> --dong-y
node ~/.claude/hooks/backup.mjs trang-thai <thư-mục-app>               # chỉ đọc
```

**Chưa thử khôi phục thì chưa gọi là có sao lưu:** bật xong phải chạy `khoi-phuc-thu` đạt rồi mới báo xong.

User nói không ⇒ `chon off … --dong-y` để ghi lại lựa chọn (kiểm trước phát hành không đòi nữa).

**Supabase gói miễn phí có dữ liệu thật:** chỉ khuyên nâng Pro (nói phí); user đồng ý thì ghi `chon on <app> --supabase-free --dong-y`.
Không tự sao lưu. Trang `docs/BACKUP.md` do `backup.mjs` sinh; mẫu ở `templates/BACKUP.md`.

Khôi phục vào dữ liệu thật là ghi đè: nêu tên dữ liệu và thời điểm bản sao, hỏi user trước.

**Báo user:** đã làm gì · sao lưu nằm ở đâu, bao lâu một lần · lần khôi phục thử gần nhất · còn gì cần bạn làm.

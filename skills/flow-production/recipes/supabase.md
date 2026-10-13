# Công thức phát hành: Supabase (database + đăng nhập)

Supabase **không có quay lại thật**. `supabase migration down` xoá sạch dữ liệu rồi áp lại — **cấm dùng**. Quay lại =
viết thêm một migration sửa tiến (forward-fix) hoặc khôi phục từ bản sao lưu.

## Luật migration (để lúc nào cũng sửa tiến được)
- Migration chỉ **thêm** (bảng, cột, chỉ mục). Cần bỏ cái cũ ⇒ làm ở bản sau, khi không còn code nào dùng nó
  ("mở rộng rồi mới thu hẹp").
- Migration xoá/đổi dữ liệu ⇒ cần sao lưu trước và user gật bằng câu đời thường (SKILL bước 6).
- Khoá `service_role`/`sb_secret_` không bao giờ vào code chạy ở trình duyệt.

## Phát hành
1. Preflight (SKILL bước 2; thêm `--has-data` nếu đã có dữ liệu thật).
2. Thử migration trên project thử riêng trước, không phải project thật đang có khách.
3. Áp lên project thật: `supabase db push` (chỉ áp migration còn chờ).
4. Thử nhanh luồng chính bằng Playwright `@smoke` vào địa chỉ app thật (chỉ đọc hoặc tài khoản thử); `supabase db advisors`
   cho cảnh báo bảo mật/hiệu năng. Ghi `.claude/release.json` bằng Edit: `platform: "supabase"`, `target`, `checkAt`, và
   `logs: { "source": "supabase", "retentionDays": 1 }`.

## Sai sau khi đã áp
Nói user: "dữ liệu không tự quay lại được". Rồi theo thứ tự: (1) viết migration mới sửa lỗi, thử ở project thử, áp lên;
(2) nặng quá thì khôi phục từ bản sao lưu — chỉ khi đã có (SKILL bước 6), và hỏi user trước vì sẽ ghi vào dữ liệu thật.
Quay lại phần mềm của app (không phải database) dùng công thức của nền chạy app.

## Xem lỗi
`node ~/.claude/hooks/release.mjs logs --since 24h --project-ref <mã>` với `SUPABASE_ACCESS_TOKEN` trong biến môi trường
(mã là chuỗi trong `<mã>.supabase.co`). Gói miễn phí chỉ giữ log **1 ngày**; lệnh sẽ nói khoảng không còn log.
Sức khoẻ database: `supabase inspect db cache-hit|locks|long-running-queries`.

## Gói miễn phí và sao lưu
Gói miễn phí không có sao lưu tự động. Có dữ liệu thật ⇒ chỉ khuyên nâng Pro (nói phí), không tự sao lưu (SKILL bước 6).

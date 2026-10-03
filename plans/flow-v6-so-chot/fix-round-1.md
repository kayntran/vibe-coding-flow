# Vòng sửa 1 — từ QA (2026-10-02)

Báo cáo gốc: qa-report-sochot.md (QA 1, 5/5 đạt, 3 MINOR) · qa-report-1scout.md (QA 2, 5 MAJOR, 3 MINOR) trong scratchpad/qa.
Mỗi mục: viết test đỏ trước, rồi sửa.

## Làn FA — hooks/lib/so-chot.mjs (+ test)
- FA1 (QA1 BUG-1) `xong` sau khi tính năng mở lại: nếu trước đó progress KHÔNG ở trạng thái xong thì ghi lại "Xong ngày" = hôm nay (giờ VN).
- FA2 (QA1 BUG-2) số đếm ở dòng đầu INDEX/ROADMAP phải tính từ nguồn; INDEX lệch sau merge=union luôn có cảnh báo trong phần nạp.
- FA3 (QA1 BUG-3) `oneLine` bỏ ký tự điều khiển hướng chữ (U+202A–U+202E, U+2066–U+2069, U+200E/F); `vi_sao`/`ap_dung`/`da_can_nhac` giới hạn 8 KB mỗi trường (cắt kèm "…(đã cắt)").
- FA4 (thiết kế, đã chốt) `close`/`xong` CHỈ cất `dang-dung`; điều `cho-xem` (⚠️) giữ nguyên tới khi người dùng xem.
- FA5 (QA2 B5) INDEX.md dễ đọc cho người không biết code: nhóm theo phạm vi (`## Luật chung`, `## <tính năng>` mới nhất trước), trong nhóm xếp theo thời gian; tóm tắt KHÔNG cắt giữa câu (nếu dài thì cắt ở ranh giới từ + "…"); đường dẫn file đặt làm link trên mã `[k3f9](chung/…md)` thay vì đuôi "→ path"; phần ⚠️ chờ xem lại tách thành nhóm riêng ở đầu.
- FA6 (QA2 B6) ROADMAP: lý do bằng lời người dùng ("chưa có sổ tiến độ — cần xem lại trạng thái"), không lý do máy; không ghi ROADMAP-luu-tru.md khi rỗng; ghi đè docs/ROADMAP.md CHỈ khi file đó do so-chot sinh (có dòng đánh dấu) hoặc chưa tồn tại — nếu là file viết tay thì từ chối và báo (làn FC lo dời file viết tay).

## Làn FC — hooks/lib/legacy-migrate.mjs (+ test)
- FC1 (QA2 B1, đã chốt) bỏ qua mọi nguồn bị git bỏ qua (`git check-ignore`); liệt kê trong bảng mục "không chuyển (git đang bỏ qua)"; không bao giờ `git add -f`.
- FC2 (QA2 B2) nhận diện cả dạng gạch `<slug>-(plan|decisions|progress|spec|research|notes|review|recon)(-\d+)?.md` như dạng chấm; quyết định không bao giờ rơi vào legacy chỉ vì tên.
- FC3 (QA2 B3) ứng viên cho dòng cần hỏi: xếp mọi tính năng theo độ giống (tiền tố từ dài nhất + từ chung), gồm cả tính năng có tiền tố dài hơn (vd `ai-agent-tool-gaps` ⇒ có `ai-agent-gaps`); đưa tối đa 4 ứng viên kèm lý do.
- FC4 (QA2 B4) tìm mọi chỗ trong file text đã theo dõi (gồm .claude/CLAUDE.md, docs/**, *.md) trỏ tới đường dẫn nguồn sẽ dời: liệt kê trong bảng; khi apply, thay đúng chuỗi đường dẫn cũ → mới trong commit 2; verify báo nếu còn chỗ trỏ đường cũ.
- FC5 (QA2 B5, đã chốt) mỗi `*.decisions.md` ⇒ MỘT quyết định ⚠️ phạm vi tính năng: tóm tắt "Quyết định cũ của <tính năng> (N ý)", thân liệt kê tối đa 5 ý đầu + link `notes/decisions.md` (bản gốc giữ nguyên byte); verify đối chiếu theo file (bản gốc còn nguyên, đúng 1 quyết định, đúng phạm vi).
- FC6 (QA2 B6) docs/ROADMAP.md viết tay có sẵn ⇒ bảng ghi dời sang `docs/legacy/ROADMAP-viet-tay.md` (git mv ở commit 1), rồi mới sinh ROADMAP mới.
- FC7 (QA2 B7) thiếu git identity ⇒ báo tiếng Việt một dòng kèm lệnh `git config user.name "…"`/`user.email`, trước khi đổi bất cứ gì.
- FC8 (QA2 B8) bảng plan liệt kê rõ các thay đổi phụ: tạo/sửa .gitattributes, đổi tên README của reports, file tạo mới.

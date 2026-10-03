# Research: sổ chốt (decision ledger) - prior art

Nguồn: tự tìm (gh + đọc doc/code). Grok: hết lượt. agy: không ra kết quả (workspace khoá lệnh), bỏ qua. Mọi dòng dưới đã mở URL kiểm.

| repo/tài liệu | license | pushed | stars | dùng lại được gì |
|---|---|---|---|---|
| [adr/madr](https://github.com/adr/madr) | NOASSERTION (MIT/CC0 trong repo, chưa xác minh) | 2026-08 | 2.5k | front matter `status/date/decision-makers`, `status: superseded by ADR-0123` |
| [npryce/adr-tools](https://github.com/npryce/adr-tools) `src/adr-new` | NOASSERTION | 2024-04 (cũ) | 5.7k | `-s N`: link hai chiều, gỡ "Accepted" khỏi bản cũ, số tăng dần |
| [thomvaill/log4brains](https://github.com/thomvaill/log4brains) | Apache-2.0 | 2024-12 (>12 tháng, hạ hạng) | 1.6k | cố ý KHÔNG đánh số để khỏi xung đột merge; ngày/thứ tự suy từ git log; bản ghi bất biến, chỉ đổi status |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) | MIT | 2026-10 | 71k | `changes/` (đang làm) → `changes/archive/YYYY-MM-DD-ten/` khi xong |
| [github/spec-kit](https://github.com/github/spec-kit) constitution-template | MIT | 2026-10 | 140k | chân trang Version / Ratified / Last amended |
| Claude Code auto memory ([docs](https://code.claude.com/docs/en/memory)) | tài liệu | - | - | cơ chế chuẩn của chính Claude Code (chi tiết dưới) |
| [Cline memory bank](https://docs.cline.bot/prompting/cline-memory-bank) | tài liệu | - | - | 6 file, đọc TẤT CẢ mỗi task; không có luật archive |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | Apache-2.0 | 2026-10 | 95k | 3 tầng: search (~50-100 token, chỉ ID) → timeline → chi tiết (~500-1000) |
| [vanzan01/cursor-memory-bank](https://github.com/vanzan01/cursor-memory-bank) | không license (chỉ học ý) | 2026-05 | 3k | chế độ + file nhớ theo pha |

## (2) Giữ context nhỏ
- **Claude Code auto memory**: `MEMORY.md` là chỉ mục "một dòng/mục", chỉ nạp **200 dòng hoặc 25KB**, phần dư bị cắt im lặng; chi tiết ở topic file, đọc khi cần. Ghi vượt ngưỡng ⇒ Claude Code báo lỗi bắt viết lại. Tự thêm `modified:` ISO vào front matter.
- **CLAUDE.md**: <200 dòng; `.claude/rules/*.md` có `paths:` chỉ nạp khi chạm file khớp; `@import` KHÔNG giảm context.
- **claude-mem**: lộ mục lục rẻ trước, chi tiết sau (progressive disclosure); giới hạn số observation lúc SessionStart.
- **Cline/Cursor memory bank**: nạp hết, không giới hạn ⇒ là phản ví dụ.
- Không tool nào tìm được có luật "xong feature ⇒ archive quyết định theo scope". Gần nhất: OpenSpec archive cả thư mục change.

## (3) Supersede/lịch sử
Thống nhất: bản cũ không xoá, đổi status + trỏ sang bản mới; bản mới ghi `supersedes`. adr-tools làm hai chiều; MADR chỉ ghi ở bản cũ (`superseded by X`). log4brains: bản ghi bất biến trừ status.

## (4) Roadmap tự cập nhật
Không thấy chuẩn nào có file ROADMAP.md do tool giữ. Quy ước thật là "thư mục = trạng thái" (OpenSpec `changes/` vs `archive/`) hoặc footer ngày (spec-kit). ROADMAP một dòng/feature là tự thiết kế, hợp lý.

## Nên mượn
- Chỉ mục một dòng + file chi tiết (MEMORY.md pattern ⇒ đúng ý INDEX.md).
- Ngân sách cứng theo **dòng/byte** thay vì chỉ "~2000 token": ví dụ 120 dòng hoặc 8KB; hook tự cắt, ghi "(còn N mục, xem ARCHIVE/INDEX)" để agent biết có phần bị cắt.
- `supersedes` ở bản mới + `superseded_by` ghi lại ở bản cũ khi chốt (hai chiều, hook/skill làm, không để người nhớ). Bản cũ đổi `da-thay`, ra khỏi phần nạp.
- Archive theo kiểu OpenSpec: `archive/YYYY-MM-DD-<feature>.md`; INDEX giữ 1 dòng "đã lưu N quyết định của <feature> → file".
- Trường `modified`/`last reviewed` để phát hiện quyết định cũ.
- Quyết định `chung` KHÔNG tự archive; chỉ archive scope-feature.

## Nên tránh
- Nạp toàn bộ log (Cline). Cắt im lặng không báo (MEMORY.md làm vậy, agent không biết mất gì).
- Mẫu MADR đầy đủ 9 mục: quá nặng cho người không code; giữ Why / How to apply / Alternatives.
- Phụ thuộc MCP/DB (claude-mem) cho việc chỉ cần file markdown.

## Mâu thuẫn với thiết kế
1. **Số `#N` tăng dần đụng nhau khi dùng worktree/nhánh song song** (hai nhánh cùng lấy #12 ⇒ conflict ở INDEX.md). log4brains bỏ số chính vì lý do này. Hướng: cấp số lúc gộp, hoặc id = ngày-giờ-slug (đã có HH:MM trong dòng), #N chỉ là nhãn hiển thị.
2. **INDEX.md một file cho mọi dòng ⇒ chính nó là điểm xung đột merge.** Cân nhắc một dòng/mục append-only, hoặc sinh INDEX từ front matter.
3. Thứ tự nạp "chờ xem → chung → feature → mới nhất" hợp lý, nhưng cần luật cắt khi chỉ riêng `chung` đã vượt ngân sách.
4. Auto memory của Claude Code đã có `type: project` lưu "quyết định": hai nơi cùng giữ quyết định ⇒ dặn rõ sổ chốt là nguồn duy nhất, nằm trong git (auto memory chỉ cục bộ máy, không share).

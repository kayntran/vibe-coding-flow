# Soát code bằng model khác (thay review-ext gọi CLI)

Chỉ khi `pick` ra `viaPaseo: true` (macOS/Linux); Windows xem đầu SKILL.md.

1. `node ~/.claude/hooks/review-ext.mjs --model codex --wt "<WT>" --brief <BRIEF> --note "<…>" --prepare "<thư mục mới>"` ⇒ JSON
   `{workspace, prompt, result}`: bản sao HEAD đã lọc khoá/dữ liệu riêng, không có .git. Exit 3 ⇒ không gửi, như cũ.
2. `create_workspace {isolation:"local", path:<workspace>}` → `create_agent` với `pick security-reviewer|code-reviewer` (Codex),
   prompt: "Đọc `<prompt>` và làm đúng như nó yêu cầu. Chỉ đọc code, không sửa file nào ngoài `<result>`. Ghi JSON review vào
   `<result>`."
3. Phiên xong ⇒ `node ~/.claude/hooks/review-ext.mjs --collect "<workspace>/<result>" --out "<S>/review-codex.json" --model codex`
   (bóc JSON, quét khoá; exit 3 ⇒ coi như lượt hỏng, sang model dự phòng). Rồi `archive_workspace` + `don.mjs` thư mục đó.
4. Grok/Gemini (Cursor, agy) vẫn qua `review-ext.mjs --model grok|flash` như cũ.

Tìm lỗi (`debugger` hỏi thêm Codex) cũng vậy: phiên Codex `pick debugger --host codex`, chỉ phân tích, không sửa.

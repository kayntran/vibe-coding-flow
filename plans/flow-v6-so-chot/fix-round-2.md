# Vòng sửa 2 — từ review (Codex high · Gemini 3.8 Flash · code-reviewer), 2026-10-02

JSON gốc: scratchpad/review-codex.json, review-flash.json, review-claude.json. Mỗi mục: test đỏ trước rồi sửa.

## hooks/lib/legacy-migrate.mjs (+ test)
- R1 MAJOR (Codex) Nhật ký `.claude/so-chot/.migrated.json` và bảng `.migrate-plan.json` là dữ liệu repo KHÔNG đáng tin: mọi đường dẫn nguồn/đích đọc từ đó phải là đường tương đối, nằm trong repo (realpath), không chứa `..`, không nằm dưới `.git/` (kể cả viết hoa/thường khác, `.git` là file), không là symlink/junction; sai ⇒ từ chối trước khi đổi gì. Test: dich '.git/hooks/pre-commit', '../x', 'C:/x', '.GIT/config'.
- R2 MAJOR (Codex) Mã commit đọc từ nhật ký (commit1, commit2, sha_sau…) chỉ nhận /^[0-9a-f]{7,40}$/ và phải tồn tại (`git cat-file -e <sha>^{commit}`); mọi lệnh git nhận ref/đường dẫn từ dữ liệu repo phải đặt sau `--end-of-options` hoặc `--`. Test: commit1 = "--output=<tệp ngoài repo>" ⇒ verify từ chối, không tạo tệp.
- R3 MAJOR (code-reviewer) apply kiểm TRƯỚC khi đổi gì: `git check-ignore` cho nhật ký, bảng, `.claude/so-chot/INDEX.md`, một đường mẫu `.claude/so-chot/<phạm vi>/x.md` cho mỗi phạm vi, docs/ROADMAP.md, docs/ROADMAP-luu-tru.md, docs/IDEAS.md, .gitattributes; có cái bị bỏ qua ⇒ dừng, báo tiếng Việt một dòng cách sửa (.gitignore thêm dòng `!` tương ứng). Test với .gitignore `.claude/*` + `!.claude/plans/`.
- R4 MINOR (code-reviewer :594) lần apply đầu (chưa có nhật ký) mà index git đã có file staged ⇒ từ chối, yêu cầu commit/bỏ stage trước; không để git mv rơi vào commit 2.

## hooks/lib/so-chot.mjs (+ test)
- R5 MINOR write() idempotent: không ghi cảnh báo 'index-mat' vào chính INDEX mới (như 'index-lech'); test ghi 2 lần liên tiếp không đổi file.
- R6 MINOR (Flash + code-reviewer) xong() giữ kiểu xuống dòng gốc (CRLF/LF) của progress.md; không đổi file khi nội dung không đổi.
- R7 MINOR trường "Nhánh / worktree" tách theo `,` `;` `·` và bóc backtick/ngoặc kép/khoảng trắng bao quanh từng token; excerpt/openProgress trim branch như nhau. Test dạng thật: "Nhánh / worktree: `feat/x` · `.claude/worktrees/x`".

## hooks/flow-dispatch.mjs (+ test)
- R8 MINOR Stop: tính HEAD và kiểm marker đã nhắc TRƯỚC, chỉ gọi pickProgress khi chưa có marker.

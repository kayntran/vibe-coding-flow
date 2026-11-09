# Gộp nhiều làn song song

1. Mỗi làn đã qua `lane-check audit` (không có file ngoài scope) — xem skill `flow-team`.
2. Dò xung đột cả bộ một lần: `node ~/.claude/hooks/lane-check.mjs conflicts --base <nhánh-tích-hợp> <làn1> <làn2> …` ⇒ in cặp xung đột +
   **thứ tự gộp gợi ý**. Hai làn xung đột ⇒ gộp nối tiếp, làn sau rebase lên nhánh tích hợp rồi test lại trước khi gộp; không gộp song song.
3. Gộp từng làn vào **nhánh tích hợp** của tính năng (không vào main) theo thứ tự đó, kết hợp thứ tự phụ thuộc (contract → backend →
   frontend → test → docs), chạy test giữa mỗi lần gộp.
4. Trên nhánh tích hợp: test đủ bộ + `flow-qa` các luồng chính + `flow-review` MỘT lần cho cả nhánh.
5. Rồi gộp nhánh tích hợp vào main theo mục "Một nhánh" của SKILL.md (gồm bước đóng sổ). Xong: dọn từng worktree làn theo `flow-worktree`
   (hoặc `node ~/.claude/hooks/wt-env.mjs prune`).

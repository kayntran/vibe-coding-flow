---
name: flow-merge
description: Gộp nhánh worktree (một nhánh hoặc nhiều làn song song) vào nhánh chính — rebase, squash, test đủ bộ, merge --ff-only, push, dọn worktree, đóng sổ tiến độ. Dùng khi user đã gật gộp, hoặc nói "gộp đi", "merge", "push lên", "xong rồi đẩy lên". KHÔNG tự gộp khi user chưa đồng ý rõ ràng trong chat.
---

# Flow — gộp

Chỉ chạy khi user đã gật trong chat. Nhánh chính tên `master`/khác ⇒ thay `main` tương ứng.

## Một nhánh
1. Trong worktree: `git rebase main` (conflict xử lý trên branch) → `git reset --soft main && git commit`
   (squash một commit, message theo quy ước dự án + dòng Co-Authored-By).
2. **Test ĐỦ BỘ ngay trong worktree sau rebase** (Agent `test-runner`). Gộp là fast-forward nên đây chính là
   test trên `main` sau gộp. Đỏ ⇒ sửa trên branch, không gộp.
   Rebase làm diff đổi nội dung (conflict, main có sửa chạm vùng mình) ⇒ dấu review/QA mất hiệu lực ⇒ hook
   chặn gộp ⇒ chạy lại `flow-review` (và `flow-qa` nếu đụng UI) cho phần đổi.
3. `ExitWorktree` `action: "keep"` → về thư mục chính, soi lại `git worktree list` + file các phiên khác đang đổi,
   rồi `git merge --ff-only <branch>`.
4. **Trước khi push:** `git log --oneline origin/main..main`. Ngoài commit của mình còn commit khác chưa push (của phiên
   khác/việc cũ) ⇒ liệt kê cho user, hỏi có push kèm không — push là đẩy tất cả. Rồi `git push origin main` (nếu có
   remote) → `git worktree remove <path> && git branch -d <branch>` → `node ~/.claude/hooks/wt-env.mjs release <path>`.
5. Có `progress.md` ⇒ đổi `Trạng thái: xong`, ghi commit gộp (hook sẽ thôi nạp sổ này).
6. `merge --ff-only` bị từ chối ⇒ không ép, không stash hộ, không đụng file dở của phiên khác. Main có commit mới ⇒
   `EnterWorktree` `path` quay lại, làm lại bước 1–5; trùng file dở ⇒ hỏi user.

## Nhiều làn song song
1. Mỗi làn đã qua `lane-check audit` (không có file ngoài scope) — xem skill `flow-team`.
2. Dò xung đột cả bộ một lần: `node ~/.claude/hooks/lane-check.mjs conflicts --base <nhánh-tích-hợp> <làn1> <làn2> …`
   ⇒ in cặp xung đột + **thứ tự gộp gợi ý**. Hai làn xung đột ⇒ gộp nối tiếp, làn sau rebase lên nhánh tích hợp
   rồi test lại trước khi gộp; không gộp song song.
3. Gộp từng làn vào **nhánh tích hợp** của tính năng (không vào main) theo thứ tự đó, kết hợp thứ tự phụ thuộc
   (contract → backend → frontend → test → docs), chạy test giữa mỗi lần gộp.
4. Trên nhánh tích hợp: test đủ bộ + `flow-qa` các luồng chính + `flow-review` MỘT lần cho cả nhánh.
5. Rồi gộp nhánh tích hợp vào main theo mục "Một nhánh". Xong: `node ~/.claude/hooks/wt-env.mjs release <đường worktree>` cho từng worktree đã xoá (hoặc `prune`).

## Sau push
CI đỏ ⇒ Agent `debugger` với run id (`gh run view <id> --log-failed`) ⇒ sửa trên nhánh mới theo flow.

## Không được
- Xoá worktree/branch không do phiên mình tạo (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.

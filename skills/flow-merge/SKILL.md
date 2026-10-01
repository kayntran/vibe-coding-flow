---
name: flow-merge
description: Pha 9 của flow — gộp nhánh worktree (hoặc nhiều làn song song) vào nhánh chính sau khi user đồng ý: rebase, squash, test đủ bộ, merge --ff-only, push, dọn worktree. Dùng khi user gật gộp.
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
   rồi `git merge --ff-only <branch>` → `git push origin main` (nếu có remote) →
   `git worktree remove <path> && git branch -d <branch>`.
4. `merge --ff-only` bị từ chối ⇒ không ép, không stash hộ, không đụng file dở của phiên khác. Main có commit mới ⇒
   `EnterWorktree` `path` quay lại, làm lại bước 1–3; trùng file dở ⇒ hỏi user.

## Nhiều làn song song
1. Thứ tự theo phụ thuộc: contract/type → backend/service → frontend → test → docs.
2. Gộp từng làn vào **nhánh tích hợp** của tính năng (không vào main), chạy test giữa mỗi lần gộp.
   Dò conflict trước: `git merge-tree --write-tree <nhánh-tích-hợp> <làn>`.
3. Trên nhánh tích hợp: test đủ bộ + `flow-qa` các luồng chính + `flow-review` MỘT lần cho cả nhánh.
4. Rồi gộp nhánh tích hợp vào main theo mục "Một nhánh".

## Sau push
CI đỏ ⇒ Agent `debugger` với run id (`gh run view <id> --log-failed`) ⇒ sửa trên nhánh mới theo flow.

## Không được
- Xoá worktree/branch không do phiên mình tạo (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.

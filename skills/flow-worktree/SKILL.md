---
name: flow-worktree
description: Tách worktree trước khi sửa file trong git repo và soi các phiên Claude khác để tránh conflict. Dùng ngay trước lần sửa file đầu tiên trong một git repo, khi hook báo "Đang sửa thẳng thư mục chính", hoặc trước khi gộp. KHÔNG dùng khi chỉ hỏi đáp/đọc code/lập plan, thư mục không phải git repo, đã ở trong .claude/worktrees/, hoặc repo có .claude/allow-direct-edit.
---

# Worktree

User hay mở nhiều phiên Claude song song trên cùng repo. Dự án có luật worktree riêng (vd `.claude/rules/worktree-flow.md`)
thì **luật dự án thắng**.

## Soi phiên khác — trước khi tách và lại trước khi gộp

Ở **thư mục chính**: `git worktree list`, rồi với mỗi worktree khác lấy file nó đang đổi =
`git diff --name-only main...<branch>` + `git -C <wt> status --porcelain`. Việc của mình sắp sửa một file trong đó ⇒
dừng, hỏi user bằng AskUserQuestion (đợi phiên kia gộp / làm tiếp chịu conflict / né file đó). Sửa file dùng chung thì
thêm vào cuối, không format lại phần người khác.

## Tách

- `EnterWorktree` với `name` kebab-case theo việc (`fix-login-redirect`).
- Worktree tạo từ commit hiện tại (`worktree.baseRef: head`). File sửa dở chưa commit ở thư mục chính không đi theo —
  cần chúng thì báo user một dòng trước.
- Worktree mới chưa có dependencies ⇒ cài lại một lần bằng package manager của dự án. Hai phiên không chạy dev server
  cùng cổng.
- Repo user muốn sửa thẳng ⇒ user tạo `.claude/allow-direct-edit` (hook sẽ cho qua).

## Gộp

Chỉ khi user gật, theo skill `flow-merge`.

## Không được

- Xoá worktree/branch không do phiên mình tạo (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.

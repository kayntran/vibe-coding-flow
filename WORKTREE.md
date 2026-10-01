# Worktree — mọi dự án

User hay mở nhiều phiên Claude song song trên cùng repo. Dự án có luật worktree riêng (vd
`.claude/rules/worktree-flow.md`) thì **luật dự án thắng**.

## Khi nào tách

- Phiên **sắp sửa file trong git repo** → `EnterWorktree` TRƯỚC lần sửa đầu tiên, `name` kebab-case theo việc.
  Hook chặn Edit/Write ở thư mục chính; repo nào user muốn sửa thẳng thì user tạo `.claude/allow-direct-edit`.
- Không tách khi: chỉ hỏi đáp / đọc code / lập plan · không phải git repo · đang ở `.claude/worktrees/` rồi.
- Worktree tạo từ commit hiện tại (`worktree.baseRef: head`). File sửa dở chưa commit ở thư mục chính không đi theo
  — cần chúng thì báo user một dòng trước.
- Worktree mới chưa có dependencies → cài lại một lần bằng package manager của dự án. Hai phiên không chạy dev
  server cùng cổng.

## Soi phiên khác — chống conflict từ đầu

Ở **thư mục chính**, trước `EnterWorktree` và lại trước khi gộp: `git worktree list`, rồi với mỗi worktree khác
lấy file nó đang đổi = `git diff --name-only main...<branch>` + `git -C <wt> status --porcelain`. Việc của mình
sắp sửa một file trong đó → dừng, hỏi user bằng AskUserQuestion (đợi phiên kia gộp / làm tiếp chịu conflict /
né file đó). Sửa file dùng chung thì thêm vào cuối, không format lại phần người khác.

## Gộp

Chỉ khi user gật, theo skill `flow-merge`.

## Không được

- Xoá worktree/branch không do phiên mình tạo (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.

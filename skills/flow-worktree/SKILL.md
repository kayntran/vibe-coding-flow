---
name: flow-worktree
description: Tạo, dùng lại và dọn worktree (bản sao riêng của dự án để sửa không đụng bản đang chạy), soi file các phiên khác đang sửa. Dùng khi sắp sửa file lần đầu trong git repo, trước khi gộp, hoặc khi user muốn dọn bản sao cũ. KHÔNG dùng khi chỉ hỏi đáp, đọc code, lập plan, ngoài git repo, đã ở trong worktree, hay repo có .claude/allow-direct-edit.
---

# Worktree

User hay mở nhiều phiên Claude song song trên cùng repo. Dự án có luật worktree riêng (vd `.claude/rules/worktree-flow.md`) thì
**luật dự án thắng**.

## 1. Xem có sẵn chưa

`git worktree list` ở thư mục chính. Đã có worktree đúng việc này (cùng tên việc, hoặc sổ tiến độ đang trỏ tới) ⇒ `EnterWorktree`
`path` vào làm tiếp, không tạo cái mới. `locked` hoặc đang có phiên khác dùng ⇒ không vào.

## 2. Soi phiên khác — trước khi tách và lại trước khi gộp

Ở **thư mục chính**, với mỗi worktree khác lấy file nó đang đổi = `git diff --name-only main...<branch>` + `git -C <wt> status --porcelain`.
Việc của mình sắp sửa một file trong đó ⇒ dừng, hỏi user bằng AskUserQuestion (đợi phiên kia gộp / làm tiếp chịu conflict / né file đó).
Sửa file dùng chung thì thêm vào cuối, không format lại phần người khác.

## 3. Tách

- `EnterWorktree` với `name` kebab-case theo việc (`fix-login-redirect`).
- Worktree tạo từ commit hiện tại (`worktree.baseRef: head`). File sửa dở chưa commit ở thư mục chính không đi theo — cần chúng thì
  báo user một dòng trước.
- Cần chạy app hoặc test mà chưa có thư viện ⇒ cài một lần theo file khoá của dự án, không làm đổi file khoá. Việc không cần thì không cài.
  Lệnh theo từng loại file khoá: `references/cai-thu-vien.md`. Dự án ghi lệnh riêng trong `CLAUDE.md` ⇒ dùng lệnh đó.
- Hai phiên không chạy dev server cùng cổng: lấy cổng bằng `node ~/.claude/hooks/wt-env.mjs alloc <worktree>`. Ghi lại lệnh và cổng của
  mọi tiến trình mình bật để còn dừng lúc dọn.
- Không có hook chặn sửa thẳng (chốt 8kxf, như AgentKit): tự giác tách worktree trước khi sửa. Repo có `.claude/allow-direct-edit` ⇒ sửa thẳng, bỏ bước này.

## 4. Gộp

Chỉ khi user gật, theo skill `flow-merge`.

## 5. Dọn

Chỉ tự dọn worktree **do phiên mình tạo và đã gộp**. Theo đúng thứ tự:

1. **Xem trước:** `git -C <wt> status --porcelain` (còn file dở?), `git log --oneline main..<branch>` (còn commit chưa gộp?), có repo lồng bên
   trong không. Có thứ gì chưa gộp ⇒ dừng, kể cho user, không dọn.
2. **Dừng tiến trình mình đã bật** trong worktree đó (dev server, watcher). Chỉ dừng cái mình ghi lại, không dừng theo tên chung. Windows
   giữ khoá file khi tiến trình còn chạy nên phải làm trước khi gỡ.
3. **Gỡ:** `node ~/.claude/hooks/don.mjs "<đường worktree>"` (tự từ chối nếu chưa gộp sạch, bị khoá, có repo lồng), rồi
   `git branch -d <branch>` và `node ~/.claude/hooks/wt-env.mjs release <đường worktree>`. Không gõ lệnh xoá đệ quy.

### Bản sao cũ bị quên

User muốn dọn, hoặc thấy nhiều worktree cũ: chỉ liệt kê, rồi hỏi. Mỗi dòng ghi bằng lời: tên việc · lần sửa cuối · đã gộp chưa · còn file dở không ·
có phiên nào đang dùng không (`locked`, tiến trình đang chạy).

Hỏi bằng AskUserQuestion, đưa rõ số lượng và tên, ví dụ "Dọn 4 bản đã gộp xong" hoặc "Giữ lại". Bản chưa gộp hoặc còn file dở không nằm trong
lựa chọn dọn chung: hỏi riêng từng bản, nói rõ sẽ mất gì. `prune` chỉ xoá ghi chép của thư mục đã mất, không thay được việc xem trước.

## Không được

- Xoá worktree/branch không do phiên mình tạo khi user chưa gật (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.

## Đọc khi cần

- `references/cai-thu-vien.md` — đọc khi worktree mới cần cài thư viện để chạy app hoặc test (bảng file khoá → lệnh)

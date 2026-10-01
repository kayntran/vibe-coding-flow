# Spec song song v4 (2026-10-01)

Nguồn: research-parallel (ccpm execute.md, spec-kit tasks-template, Superset `.superset/lib/setup/steps.sh:200-270`,
`git merge-tree` docs, arXiv 2607.04697). Node ESM, không dependency, Windows + git bash, chạy được từ mọi cwd.
Lỗi nội bộ ⇒ in lỗi rõ ràng ra stderr, exit 2 (đây là công cụ CLI, không phải hook — không fail-open).

## A. `hooks/lane-check.mjs`

Bảng làn trong PLAN.md (Markdown, đúng tiêu đề cột, thứ tự cột tuỳ ý, các cột khác bỏ qua):

```
| lane | worker | files | ops | depends_on | accept |
|---|---|---|---|---|---|
| A | coder | web/src/api/**, shared/types.ts | extend | - | pnpm -C web test |
| B | coder-lite | web/src/i18n/** | new | A | pnpm -C web test i18n |
```
- `files`: glob ngăn bởi dấu phẩy, cú pháp `**`/`*`/`?`, tương đối gốc repo. `depends_on`: tên làn ngăn bởi phẩy, `-` = không.
- `ops`: free text (replace/extend/rename/delete/new) — chỉ in lại để captain đối chiếu.

Lệnh:
1. `plan <PLAN.md> [--repo <dir>]` (repo mặc định = git toplevel của PLAN.md):
   - Mở rộng glob mỗi làn trên `git ls-files` (file đã có). Glob không khớp file nào (file sẽ tạo mới) ⇒ so tiền tố
     thư mục tĩnh (phần trước ký tự đại diện đầu tiên) giữa các làn.
   - LỖI: file (hoặc tiền tố) thuộc ≥2 làn ⇒ in `OVERLAP <file> lanes: A C`.
   - LỖI: file nóng thuộc ≥2 làn. File nóng = lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock*`,
     `go.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`), `**/migrations/**`, `supabase/migrations/**`, file cấu hình ở
     gốc repo (`package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `go.mod`, `wrangler.toml`), cộng `hot:` trong
     `.claude/flow.json` nếu có (mảng glob).
   - LỖI: `depends_on` trỏ làn không tồn tại, hoặc có vòng.
   - CẢNH BÁO: > 4 làn cùng một wave; làn không có `accept`.
   - In các **wave** (xếp tầng topo theo depends_on): `wave 1: A, C` …, kèm cột ops từng làn.
   - Exit 0 sạch (chỉ cảnh báo), 1 có lỗi.
2. `audit <PLAN.md> <lane> [--branch <b>] [--base main]`: `git diff --name-only <base>...<b>` (mặc định b = HEAD), in file
   nằm NGOÀI glob của làn ⇒ exit 1; không có ⇒ exit 0. Glob khớp theo đường dẫn (không cần file tồn tại).
3. `conflicts [--base <b>] <branch1> <branch2> [...]`: với từng cặp nhánh chạy
   `git merge-tree --write-tree --name-only --no-messages <x> <y>`; exit ≠ 0 ⇒ in `CONFLICT x y: <file…>`.
   In thứ tự gộp gợi ý: nhánh không xung đột trước. Exit 1 nếu có cặp xung đột.

Test `hooks/lane-check.test.mjs` (repo tạm): overlap glob · overlap tiền tố file mới · lockfile hai làn · depends_on vòng ·
waves đúng · audit báo file ngoài scope / sạch · conflicts phát hiện cặp sửa cùng dòng và cho qua cặp sạch · bảng thiếu
cột ⇒ lỗi rõ ràng.

## B. `hooks/wt-env.mjs` — cấp port cho mỗi worktree (theo mẫu Superset allocate_port_base)

- Registry `~/.claude/state/ports.json` `{ "<đường worktree tuyệt đối, chuẩn hoá>": <base> }`. Mỗi worktree một cửa sổ
  20 port. Base bắt đầu 4100, bước 20, tối đa 8980.
- Khoá: `mkdir ~/.claude/state/ports.lock` (thử lại 50 ms, tối đa 5 s; khoá cũ hơn 30 s coi là chết, xoá). Ghi file tạm
  rồi `rename` (nguyên tử). Env `FLOW_STATE_DIR` ghi đè thư mục state (cho test).
- `alloc [path]` (mặc định = git toplevel của cwd): đã có ⇒ in lại base cũ. Chưa có ⇒ chọn base nhỏ nhất chưa ai giữ mà
  port đầu cửa sổ đang rảnh (thử `net.createServer().listen(port, '127.0.0.1')`). In `PORT_BASE=<n>` (stdout, một dòng).
- `release [path]`, `list` (bảng path | base | còn tồn tại?), `prune` (xoá mục có path không còn tồn tại).
- Test `hooks/wt-env.test.mjs`: alloc idempotent · hai path khác base · release rồi alloc lại dùng base trống · 10 tiến trình
  alloc song song ra 10 base khác nhau (khoá đúng) · port đầu cửa sổ bị chiếm ⇒ bỏ qua base đó · prune.

# Cài thư viện trong worktree mới

Cần chạy app hoặc test mà chưa có thư viện ⇒ cài một lần theo file khoá của dự án, không làm đổi file khoá. Việc không cần thì không cài.

| File khoá | Lệnh |
|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |
| `yarn.lock` | `yarn install --immutable` (bản cũ: `--frozen-lockfile`) |
| `bun.lock` | `bun install --frozen-lockfile` |
| `uv.lock` | `uv sync --frozen` |
| `poetry.lock` | `poetry install --no-update` hoặc `poetry sync` |
| `go.sum` | `go mod download` |
| `Cargo.lock` | `cargo fetch --locked` |

Dự án ghi lệnh riêng trong `CLAUDE.md` ⇒ dùng lệnh đó. Lệnh báo file khoá lệch ⇒ báo một dòng, chỉ cập nhật khi việc đang làm có đổi thư viện.

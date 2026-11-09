# Máy kiểm kiến trúc

Chạy trong `flow check` khi có docs/arch.json.

arch-sync (tài liệu ↔ luật ↔ thư mục) · arch-size (trần cỡ file) · dependency-cruiser (web: vòng, vượt ranh giới) ·
go-arch-lint + depguard/funlen/gocyclo (Go) · oasdiff (có OpenAPI: đổi API gây vỡ client) · squawk (migration Postgres
nguy hiểm). Thiếu công cụ ⇒ `flow check` báo THIẾU + lệnh cài; hỏi user trước khi cài. Web/extension: cài
dependency-cruiser TRONG dự án cùng typescript (`pnpm add -D dependency-cruiser typescript`) — bản cài cả máy không đọc
được TypeScript của dự án; cần Node 22, 24 LTS hoặc ≥26. `gen` sinh `.dependency-cruiser.mjs` (ESM, không `require`):
ESLint của dự án đọc sạch, KHÔNG cần miễn luật hay `ignores` nào cho nó. Dự án còn `.dependency-cruiser.cjs` cũ do kit
sinh: chạy lại `arch.mjs gen` (tự thay bằng `.mjs`, xoá `.cjs`), rồi gỡ khối miễn đã thêm cho nó trong `eslint.config.*`
(vd `files: ['**/*.cjs']` tắt `@typescript-eslint/no-require-imports`, hoặc `ignores: ['.dependency-cruiser.cjs']`).

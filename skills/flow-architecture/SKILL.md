---
name: flow-architecture
description: Kiến trúc chuẩn từ đầu và ép bằng máy — bản đồ docs/ARCHITECTURE.md + luật máy đọc docs/arch.json, sinh cấu hình dependency-cruiser / go-arch-lint / golangci, chốt mốc cho dự án có sẵn. Dùng khi tạo dự án mới (ngay sau khi chọn stack), khi tính năng thêm module/miền mới, khi dự án có sẵn chưa có docs/arch.json lần đầu làm tính năng, hoặc user nói "kiến trúc", "cấu trúc thư mục", "file quá dài", "code rối", "tách module". KHÔNG dùng cho sửa nhỏ trong module có sẵn.
---

# Flow — kiến trúc

Mục tiêu: AI không tự đẻ cấu trúc mới mỗi lần; ranh giới module, trần cỡ file/hàm và hợp đồng API được MÁY kiểm, vi
phạm thì không gộp, lời báo là lời dặn sửa. Kit chỉ viết phần keo; máy kiểm thật là công cụ có sẵn.

## Mặc định
Modular monolith + hexagonal nhẹ — một khối, chia module chặt; lõi nghiệp vụ không biết DB/HTTP/giao diện.
- Web / extension: `src/features/<tính năng>/{ui,api,model}` + `src/shared`. Tính năng không import tính năng khác (đi
  qua `shared` hoặc sự kiện). Gọi dịch vụ ngoài (Supabase, Stripe…) chỉ trong `features/*/api` hoặc `shared/lib`.
- Go / Wails: `internal/<miền>/{domain,service,store,transport}`. `domain` không import ai; chỉ `transport` biết
  Wails/HTTP; mỗi bảng thuộc đúng một miền, miền khác đọc qua hàm của miền đó.
- Không "MVP tạm rồi tính" cho phần khó sửa sau: dữ liệu, hợp đồng, ranh giới module.

## Dự án mới (sau khi chọn stack, trước PLAN)
1. `node ~/.claude/hooks/arch.mjs init --stack web|go --dir <repo>` ⇒ chép `docs/arch.json` + `docs/ARCHITECTURE.md` mẫu.
2. Sửa hai file cho đúng dự án: module + `mayDependOn`, `forbidden` (mỗi luật có `reason` + `fix`), `limits`.
   ARCHITECTURE.md ≤ 80 dòng: bài toán · codemap (mỗi module một dòng làm gì / KHÔNG làm gì, chỉ gọi tên file, không
   dán link) · bất biến · ranh giới · cắt ngang (auth, log, lỗi, cấu hình) · "vỡ đầu tiên ở 10x".
3. `arch.mjs gen` ⇒ sinh cấu hình máy kiểm (không ghi đè `.golangci.yml` có sẵn — in khối cần ghép).
4. `node ~/.claude/hooks/flow-check.mjs --dir <repo>` phải xanh. Hai file docs + cấu hình sinh ra là task đầu của PLAN.

## Dự án có sẵn (lần đầu làm tính năng)
`arch.mjs init` suy module từ thư mục hiện có ⇒ soát lại cho đúng ⇒ `gen` ⇒ `arch.mjs baseline` chốt vi phạm cũ làm
mốc ⇒ `flow check` xanh. Từ đó chỉ chặn vi phạm MỚI; vi phạm cũ giảm dần qua khám định kỳ. Báo user một dòng: "đã
chốt mốc N chỗ chưa chuẩn có sẵn, chỉ chặn chỗ mới".

## Tính năng thêm module / đổi ranh giới
Sửa `docs/arch.json` + codemap trong ARCHITECTURE.md cùng lúc (`arch.mjs sync` kiểm hai bên khớp và khớp thư mục thật),
rồi `gen`. Thêm module mới là bình thường; NỚI luật thì không (dưới đây).

## Nới luật = hỏi user
Cổng gộp tự phân biệt: thêm module/luật cấm, hạ trần, file sinh lại bằng `gen` khớp `arch.json`, thêm luật ESLint mức
`error`, gỡ khối miễn ⇒ cho qua. Đổi `limits` lên, bỏ/nới `forbidden`, bỏ module, thêm `mayDependOn` ngược hướng, sửa tay
file sinh, sửa file mốc, thêm miễn/ignores/tắt luật ESLint, thêm comment tắt luật (`eslint-disable`, `@ts-ignore`,
`//nolint`…) ⇒ hook chặn gộp tới khi user gật [j21n]. Trước đó tự hỏi: sửa code cho
đúng luật có được không? Được ⇒ sửa code. Thật sự cần nới ⇒ hỏi user một câu đời thường ("cho phép file này dài 600
dòng vì đây là bảng dữ liệu sinh tự động?"), ghi sổ chốt.

## Máy kiểm (chạy trong `flow check` khi có docs/arch.json)
arch-sync (tài liệu ↔ luật ↔ thư mục) · arch-size (trần cỡ file) · dependency-cruiser (web: vòng, vượt ranh giới) ·
go-arch-lint + depguard/funlen/gocyclo (Go) · oasdiff (có OpenAPI: đổi API gây vỡ client) · squawk (migration Postgres
nguy hiểm). Thiếu công cụ ⇒ `flow check` báo THIẾU + lệnh cài; hỏi user trước khi cài. Web/extension: cài
dependency-cruiser TRONG dự án cùng typescript (`pnpm add -D dependency-cruiser typescript`) — bản cài cả máy không đọc
được TypeScript của dự án; cần Node 22, 24 LTS hoặc ≥26. `gen` sinh `.dependency-cruiser.mjs` (ESM, không `require`):
ESLint của dự án đọc sạch, KHÔNG cần miễn luật hay `ignores` nào cho nó. Dự án còn `.dependency-cruiser.cjs` cũ do kit
sinh: chạy lại `arch.mjs gen` (tự thay bằng `.mjs`, xoá `.cjs`), rồi gỡ khối miễn đã thêm cho nó trong `eslint.config.*`
(vd `files: ['**/*.cjs']` tắt `@typescript-eslint/no-require-imports`, hoặc `ignores: ['.dependency-cruiser.cjs']`).

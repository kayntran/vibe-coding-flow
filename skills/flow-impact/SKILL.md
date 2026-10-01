---
name: flow-impact
description: Bản đồ ảnh hưởng — khi thêm/sửa một thứ DÙNG CHUNG (provider, model AI, tài khoản/API key, gói license, cài đặt, tool của AI agent, ngôn ngữ, loại dữ liệu…), tìm mọi tính năng "anh em" cũng nên được cập nhật theo, hỏi user làm luôn hay để sau, và gắn test đối chiếu để máy bắt chỗ sót. Dùng khi user nói kiểu "thêm provider…", "thêm model…", "hỗ trợ thêm…", "thêm gói/quyền…", "thêm ngôn ngữ…", hoặc khi diff chạm một registry/danh sách dùng chung — kể cả việc cỡ S. KHÔNG dùng cho sửa nội bộ một tính năng không ai khác dùng.
---

# Bản đồ ảnh hưởng — không bỏ sót tính năng anh em

Lời dặn bằng chữ không giữ được lâu; **test giữ được**. Mục tiêu cuối của skill này là mỗi thứ dùng chung có một
bài test đối chiếu, để lần sau thêm thành viên mới mà quên một tính năng thì test đỏ — và dấu "test xanh" chặn gộp.

## 1. Gọi tên thứ dùng chung và nguồn gốc của nó
- Thứ dùng chung là gì (vd "provider dữ liệu SERP"), danh sách gốc/registry nằm ở đâu (`path:line`).
- Không có danh sách gốc (mỗi tính năng tự giữ danh sách riêng) ⇒ ghi rõ, đó là nợ cần xử lý ở bước 4.

## 2. Dò mọi nơi tiêu thụ
- MỘT lệnh `rg` nhiều `-e` theo tên các thành viên hiện có (vd `-e serper -e searlo -e dataforseo`) + tên registry,
  loại test/fixture/bindings sinh tự động. Nhiều hơn ~30KB cần đọc ⇒ giao `recon`.
- Máy có `codegraph` (MIT) ⇒ thêm `codegraph impact <symbol registry>` để bắt nơi gọi gián tiếp. KHÔNG dùng GitNexus
  cho dự án thương mại (license PolyForm Noncommercial).
- Dự án có `docs/feature-map.md` ⇒ đọc trước, rồi mới dò bổ sung.

## 3. Bảng ảnh hưởng ⇒ hỏi user ⇒ ghi vào SPEC

| Tính năng tiêu thụ | Tự thấy thành viên mới? (đọc registry / danh sách cứng) | Chỗ phải sửa (`path:line`) | Đề xuất |
|---|---|---|---|

Hỏi user bằng ngôn ngữ app, MỘT câu cho mỗi tính năng chưa tự thấy: *"Provider mới có nên dùng được trong AI Agent
luôn không?"* (đáp án khuyến nghị đứng đầu). Kết quả ghi vào SPEC: **làm luôn** / **để sau** (thành mục việc riêng) /
**không áp dụng** (kèm lý do — sẽ vào danh sách ngoại lệ của test).

## 4. Plan: để máy kiểm, không để trí nhớ kiểm
Thêm vào PLAN.md (thành task có `accept`):
1. **Test đối chiếu (bắt buộc)** — một test duyệt mọi thành viên registry × mọi tính năng tiêu thụ, assert có mục
   tương ứng; ngoại lệ cố ý nằm trong allowlist `notApplicable` có lý do. Test đỏ ngay khi thêm thành viên mà quên
   một tính năng. ~20–40 dòng mỗi cặp; đặt cạnh registry.
2. **Ép bằng kiểu khi rẻ** — TS: `PROVIDERS = [...] as const`, `type ProviderId = typeof PROVIDERS[number]`, bảng
   theo provider viết `{…} satisfies Record<ProviderId, X>`, switch có nhánh `default` gán `never`. Go: bật linter
   `exhaustive` (`-check switch,mapliteral`) trong golangci-lint cho kiểu enum provider.
3. **Gom về danh sách gốc** khi ≥2 tính năng đang giữ danh sách cứng riêng: tính năng tiêu thụ đọc từ registry thay
   vì tự liệt kê. Là làn riêng ở wave đầu (đụng nhiều file) — hoặc nếu quá lớn, ghi thành việc sau nhưng VẪN làm test
   đối chiếu ở mục 1 ngay.
4. Bảng giá/hằng số phải "giữ khớp" giữa hai nơi (vd Go và frontend) ⇒ test so hai bảng, hoặc sinh một bên từ bên kia.

## 5. `docs/feature-map.md` — mục lục, không phải nguồn sự thật
Mỗi thứ dùng chung một mục: registry ở đâu · tính năng nào tiêu thụ · **file test đối chiếu** · ngoại lệ. Nguồn sự
thật là test; file này chỉ giúp phiên sau tìm nhanh. Skill `flow-merge` cập nhật mục liên quan khi gộp.

## 6. Review
Brief review plan và review code hỏi thêm: "tính năng anh em nào dùng chung registry với thay đổi này mà chưa được
cập nhật, và test đối chiếu có phủ nó không?".

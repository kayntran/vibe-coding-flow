---
name: flow-review
description: Review code bằng Codex gpt-6.1-sol — ĐÚNG MỘT LẦN cho cả tính năng, trước khi hỏi user gộp; máy kiểm trước (lint/typecheck/test) rồi mới gọi AI; mức suy luận theo rủi ro; captain chỉ kiểm sâu lỗi nặng; đóng dấu review. Tự chạy khi nhánh đã xanh test và QA (hook chặn gộp nếu thiếu dấu). Cũng dùng khi user nói "review", "soát code", "kiểm bảo mật", "code này ổn chưa". KHÔNG dùng cho review plan (nằm trong flow-spec), KHÔNG chạy sau từng giai đoạn/làn.
---

# Flow — review code (tiết kiệm token, vẫn kỹ)

**Một lần cho cả tính năng:** chạy trên nhánh tính năng / nhánh tích hợp ngay trước khi hỏi gộp — không sau từng
giai đoạn, từng làn, từng commit. Plan chỉ có MỘT bước "review code", ở cuối.

## 0. Máy kiểm trước (bắt buộc, miễn phí)
Lint, typecheck, test đủ bộ (dấu test xanh), quét secret đã xanh rồi mới gọi Codex. Codex không tốn token cho thứ
công cụ đã bắt. Kiểm `command -v codex`.

## 1. Chọn mức theo rủi ro
**Nhạy cảm** = diff đụng đăng nhập/phân quyền, tiền/license/thanh toán, dữ liệu (migration, xoá, transaction), đồng
thời, xử lý secret, API công khai/webhook, hoặc > ~400 dòng; dự án có `.claude/flow.json` `"sensitive": [glob…]` thì
dùng thêm. Captain quyết từ `git diff --stat main...HEAD`, nói một dòng lý do.

| Diff | Lượt Codex | `model_reasoning_effort` |
|---|---|---|
| Thường | 1 lượt chất lượng (brief đã gồm mục bảo mật cơ bản) | `medium` |
| Nhạy cảm | lượt chất lượng + lượt bảo mật, song song | `high` |
| Tiền / auth / dữ liệu có rủi ro mất mát | thêm lượt chất lượng thứ hai (hai lượt hay ra lỗi khác nhau) | `high` |

Lệnh (Bash `run_in_background`, ghi thẳng ra file, KHÔNG pipe vào tail/head, luôn `< /dev/null`; `<S>` scratchpad,
`<WT>` gốc worktree, `<E>` effort, `<BRIEF>` = `review-brief.md` hoặc `review-brief-security.md`):

```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="<E>" -C "<WT>" \
  --output-schema ~/.claude/workers/review-schema.json -o "<S>/review-<tên>.json" \
  "$(cat ~/.claude/workers/<BRIEF>)

Phạm vi: git diff main...HEAD (bỏ qua file sinh tự động, lockfile). <1–2 câu nhánh làm gì>
Trả lời theo JSON schema đã cho (bỏ qua khuôn markdown ở trên)." < /dev/null
```
Brief giữ nguyên phần đầu (tĩnh ⇒ cache được), phần riêng của nhánh để cuối.
Không có `codex`, lỗi đăng nhập, hoặc >30 phút không ra file ⇒ Agent `code-reviewer`, báo user một dòng.

## 2. Captain xử lý finding — kiểm sâu chỉ lỗi nặng
- **BLOCKER/MAJOR:** mở code tại `path:line`, dựng lại kịch bản hỏng. Thật ⇒ Agent `coder` viết test đỏ tái hiện
  TRƯỚC rồi sửa. Không thật ⇒ một dòng lý do bác.
- **MINOR:** không kiểm từng cái. Gom hết vào MỘT brief cho `coder-lite` ("sửa nếu đúng, bỏ qua kèm lý do nếu sai").
- Codex hay thổi mức độ lên một bậc ⇒ hạ mức nếu kịch bản không đủ nặng.

## 3. Đóng dấu
Sửa xong ⇒ test lại (dấu test; QA lại nếu đụng UI) ⇒ diff đổi nên dấu cũ mất hiệu lực:
- Đã sửa BLOCKER/MAJOR ⇒ chạy lại MỘT lượt chất lượng `medium` trên diff mới, brief thêm "chỉ báo BLOCKER/MAJOR,
  kiểm các chỗ đã sửa: <danh sách>". Vẫn còn lỗi nặng thật sau lượt này ⇒ dừng, báo user.
- Chỉ sửa MINOR ⇒ không gọi lại Codex: captain đọc diff sửa (`git diff <commit đã review>..HEAD`), thêm vào JSON cũ
  trường `"delta_reviewed_by": "captain", "delta": "<commit đã review>..HEAD"` rồi đóng dấu.
Gộp các file JSON thành một (`findings` = tất cả, kèm trạng thái sửa/bác) rồi:
`node ~/.claude/hooks/flow-gate.mjs stamp review <S>/review-final.json`

## 4. Báo user
Tóm tắt: đã đổi gì · test (số thật) · QA (criteria pass/fail) · review (mức đã chạy + lý do; finding đã sửa / đã bác)
· hỏi gộp ⇒ skill `flow-merge`.

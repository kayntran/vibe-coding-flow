---
name: flow-review
description: Review code tự động bằng Codex gpt-6.1-sol — hai lượt song song (đúng đắn/tiêu chuẩn/hiệu năng + bảo mật), kiểm từng finding bằng test đỏ, sửa, đóng dấu review. Tự chạy khi nhánh đã xanh test và QA, trước khi hỏi user gộp (hook chặn gộp nếu thiếu dấu). Cũng dùng khi user nói "review", "soát code", "kiểm bảo mật", "code này ổn chưa". KHÔNG dùng cho review plan (nằm trong flow-spec).
---

# Flow — review code

Chạy trong worktree, nhánh đã commit. Kiểm `command -v codex` trước.

## 1. Hai lượt Codex song song
Bash `run_in_background`, ghi thẳng ra file, KHÔNG pipe vào tail/head, luôn `< /dev/null`.
`<S>` = scratchpad, `<WT>` = gốc worktree, `<MÔ TẢ>` = 1–2 câu nhánh làm gì.

```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="high" -C "<WT>" \
  --output-schema ~/.claude/workers/review-schema.json -o "<S>/review-quality.json" \
  "$(cat ~/.claude/workers/review-brief.md)

Phạm vi: git diff main...HEAD (bỏ qua file sinh tự động). <MÔ TẢ>
Trả lời theo JSON schema đã cho (bỏ qua khuôn markdown ở trên)." < /dev/null
```
```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="high" -C "<WT>" \
  --output-schema ~/.claude/workers/review-schema.json -o "<S>/review-security.json" \
  "$(cat ~/.claude/workers/review-brief-security.md)

Phạm vi: git diff main...HEAD (bỏ qua file sinh tự động). <MÔ TẢ>
Trả lời theo JSON schema đã cho (bỏ qua khuôn markdown ở trên)." < /dev/null
```
Nhánh rủi ro cao (dữ liệu, tiền, auth, đồng thời) ⇒ thêm lượt thứ ba bằng brief chất lượng — hai lượt trên
cùng diff hay tìm ra lỗi KHÁC nhau.

Không có `codex`, lỗi đăng nhập, hoặc >30 phút không ra file ⇒ Agent `code-reviewer` (cùng checklist), báo user một dòng.

## 2. Kiểm từng finding (bắt buộc)
Codex hay thổi mức độ lên một bậc, và sửa mù theo finding của nó có thể làm code tệ đi. Với mỗi finding:
- Mở code tại `path:line`, dựng lại kịch bản hỏng.
- Thật ⇒ Agent `coder` viết test đỏ tái hiện TRƯỚC, rồi sửa (nhiều finding độc lập ⇒ gom theo file, song song).
- Không thật ⇒ ghi một dòng lý do bác bỏ (sẽ đưa vào tóm tắt gửi user).

## 3. Đóng dấu
Sửa xong ⇒ test lại (pha 5; QA lại nếu sửa đụng UI) ⇒ diff đổi nên dấu cũ mất hiệu lực ⇒ chạy lại Codex
CHỈ lượt chất lượng trên diff mới (đủ hai lượt nếu sửa đụng vùng bảo mật). Không còn BLOCKER/MAJOR thật ⇒
gộp các file JSON thành một (`findings` = tất cả) rồi:
`node ~/.claude/hooks/flow-gate.mjs stamp review <S>/review-final.json`

## 4. Báo user
Tóm tắt: đã đổi gì · test (số thật) · QA (criteria pass/fail) · review (finding đã sửa / đã bác + lý do) ·
hỏi gộp ⇒ skill `flow-merge`.

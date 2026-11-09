# Soát plan cỡ L bằng model khác

Dùng ở mục "Soát plan bằng model khác" của `flow-plan`. Kiểm `node ~/.claude/hooks/cli-check.mjs <tên>` trước, chưa sẵn sàng thì sang bậc sau.

- Đang ở Claude: **Codex** (`pick codex plan-reviewer`) → **Opus qua agy** (`pick agy plan-reviewer`) → Agent `code-reviewer` với `model: "opus"`.
- Đang ở Codex: **Sol high** (`pick codex plan-reviewer`).

```bash
# codex-run.mjs = codex exec, tự đổi tài khoản Codex khi hết lượt và báo một dòng
node ~/.claude/hooks/codex-run.mjs exec --sandbox read-only -m "$(node ~/.claude/hooks/models.mjs pick codex plan-reviewer)" \
  -c model_reasoning_effort="high" -C "<gốc repo>" -o "<scratchpad>/plan-review.md" "<ĐỀ>" < /dev/null
# agy: cd vào thư mục trống, agy -p "<ĐỀ, kèm đường dẫn tuyệt đối SPEC/PLAN>" --model "$(node ~/.claude/hooks/models.mjs pick agy plan-reviewer)" --mode plan
```

`<ĐỀ>`: "Review plan: <SPEC.md> và <PLAN.md>. Kiểm chéo SPEC↔PLAN. Chỉ báo lỗi thiết kế KHÓ SỬA SAU khi đã code: sai kiến trúc/contract, yêu
cầu bị sót, tính năng anh em dùng chung registry/danh sách mà plan quên hoặc thiếu test đối chiếu, làn giao file, rủi ro bảo mật/dữ liệu. KHÔNG
báo câu chữ, đặt tên, chi tiết code. CẤM đề xuất thêm tính năng. Tối đa 7 mục: mức, vấn đề, bằng chứng path:line, hướng sửa." (Bash
`run_in_background`, ghi file, luôn `< /dev/null`.)

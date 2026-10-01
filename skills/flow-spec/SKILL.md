---
name: flow-spec
description: Pha 1–3 của flow — phỏng vấn ý tưởng, research prior art song song, viết SPEC, plan kỹ thuật + ADR + chia làn, review plan đa provider. Dùng khi bắt đầu một tính năng/ý tưởng cỡ M hoặc L (nhiều file, quyết định kiến trúc, schema, tính năng mới), trước khi sửa code.
---

# Flow — từ ý tưởng tới plan đã duyệt

Cỡ S (tả diff bằng một câu, 1–2 file) ⇒ KHÔNG dùng skill này; vào worktree làm luôn.

## Pha 1 — Phỏng vấn + research (song song)

1. Gửi trong MỘT message:
   - AskUserQuestion: ≤5 câu/vòng, mỗi câu có đáp án khuyến nghị đứng đầu. Hỏi mục tiêu, người dùng, phạm vi,
     ràng buộc, thế nào là "xong".
   - Cỡ M/L: Agent `researcher` chạy nền — brief: ý tưởng, stack, ràng buộc licence, đường ghi
     `docs/specs/<yyyy-mm-dd>-<chủ-đề>/research.md`.
2. Nhận research ⇒ kể user những gì đáng giá (repo dùng lại được, ý tưởng hay hơn) trước khi chốt spec.
3. Viết `docs/specs/<yyyy-mm-dd>-<chủ-đề>/SPEC.md`:
   - Mục tiêu (1–3 câu), người dùng, user story.
   - Acceptance criteria dạng `KHI <tình huống> THÌ HỆ THỐNG PHẢI <hành vi>` — mỗi dòng phải dịch thẳng thành test.
   - Ngoài phạm vi. Yêu cầu phi chức năng (hiệu năng, bảo mật, offline, i18n…) chỉ khi có thật.
   - Chỗ chưa rõ đánh `[CẦN LÀM RÕ]` — còn dấu này thì chưa sang pha 2.
4. **Cổng 1:** user duyệt SPEC.

## Pha 2 — Plan kỹ thuật (plan mode)

Viết `PLAN.md` cạnh SPEC.md, mọi path phải kiểm có thật trong code:
- **Kiến trúc**: module nào, trách nhiệm, contract (type/interface/API) giữa chúng; data model/migration.
- **Chọn thư viện** dựa research.md, ghi lý do.
- **ADR** cho quyết định khó đảo ngược (DB, giao thức, cấu trúc module, phụ thuộc lớn):
  `docs/adr/NNNN-<tên>.md` = Bối cảnh · Quyết định · Hệ quả · Trạng thái. ADR Accepted không sửa; đổi ý = ADR mới.
- **Dễ mở rộng/bảo trì** — tự kiểm: tách theo trách nhiệm không theo layer; không abstraction cho thứ dùng một
  lần; không phụ thuộc vòng; điểm mở rộng có thật trong roadmap chứ không đoán.
- **Wave + làn**:
  - Wave 0: contract/type dùng chung — một người làm, gộp trước.
  - Wave 1..n: làn song song, mỗi làn một bộ file KHÔNG giao nhau; ghi rõ worker (`coder`/`coder-lite`/captain-UI).
  - File nóng (lockfile, migration, root config, i18n chung, registry) thuộc đúng một làn hoặc captain gom cuối.
  - Mỗi task có test của nó; mỗi làn có lệnh `accept`.
- **Kế hoạch test**: unit/integration/e2e cần thêm + **QA charter** (từ acceptance criteria: vai, trạng thái đầu,
  dữ liệu, bằng chứng cần có) cho pha 6.

## Pha 3 — Review plan (song song, chỉ đọc)

Chạy nền trong MỘT message (Bash `run_in_background`, ghi file, luôn `< /dev/null`):

```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="high" -C "<gốc repo>" \
  -o "<scratchpad>/plan-review-codex.md" "Review plan: <đường SPEC.md> và <đường PLAN.md>. Kiểm chéo SPEC↔PLAN.
Chỉ báo: lỗi logic, yêu cầu bị sót, contract mâu thuẫn, làn giao file, rủi ro mở rộng/bảo trì/bảo mật/hiệu năng.
CẤM đề xuất thêm tính năng. Tối đa 10 mục, mỗi mục: mức, vấn đề, bằng chứng, hướng sửa." < /dev/null
```
Cỡ L, thêm Grok (provider thứ ba):
```bash
grok -p "<cùng nội dung>" -m grok-4.7 --agent design-doc-reviewer --permission-mode plan \
  --cwd "<gốc repo>" --output-format plain > "<scratchpad>/plan-review-grok.md" 2>&1 < /dev/null
```
Grok lỗi ⇒ bỏ qua, báo user một dòng. Codex lỗi ⇒ Agent `code-reviewer` review plan.

Hợp nhất: kiểm từng mục vào SPEC/PLAN/code; sửa plan; mục bác bỏ ghi một dòng lý do cuối PLAN.md.
**Cổng 2:** user duyệt plan (ExitPlanMode) ⇒ sang thi công theo WORKERS.md.

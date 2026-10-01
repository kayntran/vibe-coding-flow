---
name: flow-spec
description: Từ ý tưởng tới plan đã duyệt — phỏng vấn, research repo/thư viện có sẵn song song, viết SPEC, dò edge case, plan kỹ thuật + ADR + chia làn song song, review plan bằng model khác, mở sổ tiến độ. Dùng khi user nói kiểu "tôi có ý tưởng…", "làm tính năng…", "thêm chức năng…", "muốn app làm được…", "xây module…", hoặc việc đụng schema/nhiều module (cỡ M/L), trước khi sửa code. KHÔNG dùng cho sửa nhỏ tả được bằng một câu (cỡ S), sửa bug (dùng debugger), hay câu hỏi thuần.
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
4. **Bản đồ ảnh hưởng:** việc chạm thứ dùng chung (provider, model, gói, cài đặt, tool AI agent…) ⇒ chạy skill
   `flow-impact` — kết quả (làm luôn / để sau / không áp dụng) ghi vào SPEC, test đối chiếu thành task trong PLAN.
5. **Dò edge case (cỡ L):** quét theo từng chiều — dữ liệu biên/rỗng/khổng lồ, Unicode tiếng Việt, đồng thời/bấm
   hai lần, mất mạng/timeout, quyền & người dùng khác, trạng thái dở dang/refresh, thời gian & múi giờ, quy mô dữ liệu,
   bảo mật/input độc, khôi phục sau lỗi, tương thích bản cũ/dữ liệu cũ, truy cập bằng bàn phím/màn hẹp. Lặp tới khi hai
   vòng liên tiếp không thêm gì. Mỗi edge case giữ lại ⇒ một acceptance criteria hoặc một dòng "ngoài phạm vi".
   Có thể giao `researcher` gom thêm edge case người khác từng gặp với bài tương tự.
6. **Cổng 1:** user duyệt SPEC.

## Pha 2 — Plan kỹ thuật (plan mode)

Viết `PLAN.md` cạnh SPEC.md, mọi path phải kiểm có thật trong code:
- **Kiến trúc**: module nào, trách nhiệm, contract (type/interface/API) giữa chúng; data model/migration.
- **Chọn thư viện** dựa research.md, ghi lý do.
- **ADR** cho quyết định khó đảo ngược (DB, giao thức, cấu trúc module, phụ thuộc lớn):
  `docs/adr/NNNN-<tên>.md` = Bối cảnh · Quyết định · Hệ quả · Trạng thái. ADR Accepted không sửa; đổi ý = ADR mới.
- **Dễ mở rộng/bảo trì** — tự kiểm: tách theo trách nhiệm không theo layer; không abstraction cho thứ dùng một
  lần; không phụ thuộc vòng; điểm mở rộng có thật trong roadmap chứ không đoán.
- **Làn song song — bảng máy đọc được** (mục `## Làn` trong PLAN.md, đúng tên cột):

  ```
  | lane | worker | files | ops | depends_on | accept |
  |---|---|---|---|---|---|
  | A | coder | shared/types.ts | new | - | pnpm test types |
  | B | coder | web/src/api/** | extend | A | pnpm -C web test api |
  | C | coder-lite | web/src/i18n/** | extend | A | pnpm -C web test i18n |
  ```
  - `files`: glob ngăn bởi phẩy. `ops`: replace/extend/rename/delete/new. `depends_on`: làn phải xong trước (`-` = không).
  - Contract/type dùng chung là một làn riêng không phụ thuộc ai (wave 1); các làn dùng nó `depends_on` làn đó.
  - File nóng (lockfile, migration, config gốc, i18n chung, registry) thuộc đúng một làn hoặc captain gom cuối.
  - Mỗi task có test của nó; mỗi làn có `accept`.
  - Plan chỉ có **MỘT** bước "review code" (skill `flow-review`), ở cuối, sau khi các làn đã gộp vào nhánh
    tích hợp — không review sau từng giai đoạn/làn.
  - **Kiểm bằng máy, bắt buộc trước cổng 2:** `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>` — báo làn trùng file
    (`OVERLAP`), file nóng hai chủ (`HOT`), phụ thuộc sai/vòng, rồi in các **wave**. Exit 1 ⇒ sửa bảng tới khi sạch.
    Hai làn cùng đụng một symbol (vd A `replace` còn B `extend` cùng `PaymentService`) git không thấy được ⇒ captain
    soát cột `ops`, gộp hai làn làm một hoặc cho chạy nối tiếp.
  - Chạy song song có đáng không ⇒ theo mục "Khi nào KHÔNG song song" trong skill `flow-team`.
- **Kế hoạch test**: unit/integration/e2e cần thêm + **QA charter** (từ acceptance criteria: vai, trạng thái đầu,
  dữ liệu, bằng chứng cần có) cho pha 6.

## Pha 3 — Review plan

**Cỡ S/M: KHÔNG gọi Codex.** Captain tự soát 4 câu, ghi một dòng kết quả cuối PLAN.md: (1) mọi acceptance criteria của
SPEC có task phủ? (2) tính năng anh em (`flow-impact`) đã vào plan hoặc ghi "để sau"? (3) `lane-check plan` sạch?
(4) có quyết định khó đảo ngược nào thiếu ADR?

**Cỡ L: MỘT lượt Codex, mức `medium`, chỉ tìm lỗi thiết kế khó sửa về sau** (Bash `run_in_background`, ghi file,
luôn `< /dev/null`):

```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="medium" -C "<gốc repo>" \
  -o "<scratchpad>/plan-review-codex.md" "Review plan: <đường SPEC.md> và <đường PLAN.md>. Kiểm chéo SPEC↔PLAN.
Chỉ báo lỗi thiết kế KHÓ SỬA SAU khi đã code: sai kiến trúc/contract, yêu cầu bị sót, tính năng anh em dùng chung
registry/danh sách mà plan quên hoặc thiếu test đối chiếu, làn giao file, rủi ro bảo mật/dữ liệu.
KHÔNG báo câu chữ, đặt tên, chi tiết code. CẤM đề xuất thêm tính năng. Tối đa 7 mục: mức, vấn đề, bằng chứng, hướng sửa." < /dev/null
```
agy/Grok không dùng review. Codex lỗi ⇒ Agent `code-reviewer` review plan.

Hợp nhất (cỡ L): kiểm từng mục vào SPEC/PLAN/code; sửa plan; mục bác bỏ ghi một dòng lý do cuối PLAN.md.
**Cổng 2:** user duyệt plan (ExitPlanMode) ⇒ mở sổ tiến độ ⇒ thi công theo skill `flow-team`.

## Sổ tiến độ — `progress.md` cạnh SPEC.md

Hook SessionStart nạp lại sổ đang dở mỗi khi mở phiên mới hoặc nén ngữ cảnh, nên sổ phải đủ để người khác làm tiếp
mà không cần hội thoại cũ. Captain cập nhật mỗi lần đổi pha, xong một làn, hoặc có quyết định mới. Ngắn, ≤ 40 dòng:

```
# Tiến độ: <chủ đề>
Trạng thái: đang làm            ← đổi thành "xong" khi đã gộp; hook bỏ qua sổ đã xong
Bước tiếp theo: <một câu, đủ cụ thể để làm ngay>   ← để ở đầu: hook chỉ nạp 2.000 ký tự đầu
Pha: <số + tên>
Nhánh / worktree: <tên nhánh, đường worktree>
Đã chốt: <các quyết định user đã duyệt, mỗi dòng một ý — không hỏi lại>
Làn:
- [x] A <tên> — <worker> — gộp ở <commit>
- [ ] B <tên> — <worker> — <đang làm / chờ gì>
Finding còn mở: <id/tóm tắt hoặc "không">
```

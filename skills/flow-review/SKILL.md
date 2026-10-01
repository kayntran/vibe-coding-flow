---
name: flow-review
description: Review code bằng Grok 4.7 / Codex gpt-6.1-sol (+ Gemini 3.8 Flash) — ĐÚNG MỘT LẦN cho cả tính năng, trước khi hỏi user gộp; máy kiểm trước (lint/typecheck/test) rồi mới gọi AI; mức suy luận theo rủi ro; captain chỉ kiểm sâu lỗi nặng; đóng dấu review. Tự chạy khi nhánh đã xanh test và QA (hook chặn gộp nếu thiếu dấu). Cũng dùng khi user nói "review", "soát code", "kiểm bảo mật", "code này ổn chưa". KHÔNG dùng cho review plan (nằm trong flow-spec), KHÔNG chạy sau từng giai đoạn/làn.
---

# Flow — review code (tiết kiệm token, vẫn kỹ)

**Một lần cho cả tính năng:** chạy trên nhánh tính năng / nhánh tích hợp ngay trước khi hỏi gộp — không sau từng
giai đoạn, từng làn, từng commit. Plan chỉ có MỘT bước "review code", ở cuối.

## 0. Máy kiểm trước (bắt buộc, miễn phí)
Lint, typecheck, test đủ bộ (dấu test xanh), quét secret đã xanh rồi mới gọi model review — không tốn token cho thứ
công cụ đã bắt.

## 1. Chọn mức theo rủi ro
**Nhạy cảm** = diff đụng đăng nhập/phân quyền, tiền/license/thanh toán, dữ liệu (migration, xoá, transaction), đồng
thời, xử lý secret, API công khai/webhook, hoặc > ~400 dòng; dự án có `.claude/flow.json` `"sensitive": [glob…]` thì
dùng thêm. Captain quyết từ `git diff --stat main...HEAD`, nói một dòng lý do.

Chọn model theo bài thử 2026-10-01 (10 lỗi cài sẵn, 2 vòng, đều mức high): Codex 8–9/10, Grok 4.7 9/8, Gemini 3.8
Flash 8/8 (nhanh nhất), không model nào báo nhầm; Gemini 3.1 Pro 7–8 kèm báo nhầm ⇒ không dùng. Hai họ model khác nhau
bắt lỗi khác nhau ⇒ lượt thứ hai dùng họ khác thay vì chạy Codex lần nữa.

| Diff | Lượt (chạy song song) |
|---|---|
| Thường | 1 lượt chất lượng — **Grok 4.7 high** (brief đã gồm mục bảo mật cơ bản). Không gọi Codex |
| Nhạy cảm | **Codex `high`** lượt bảo mật + **Grok** lượt chất lượng |
| Tiền / auth / dữ liệu có rủi ro mất mát | như Nhạy cảm + **Gemini 3.8 Flash** lượt chất lượng thứ hai |

**Dự phòng:** lượt nào lỗi/hết giờ/không ra JSON ⇒ chạy lại lượt đó bằng model kế tiếp CHƯA dùng cho nhánh này theo
thứ tự Codex → Grok → Gemini Flash → Agent `code-reviewer`; báo user một dòng.
Grok CLI gói miễn phí có hạn mức: hết lượt ⇒ wrapper báo "HẾT LƯỢT" và exit 1 ⇒ sang Gemini Flash như trên.

Lệnh (Bash `run_in_background`; `<S>` scratchpad, `<WT>` gốc worktree, `<BRIEF>` = `review-brief.md` hoặc
`review-brief-security.md`):

**Grok / Gemini Flash** — wrapper lo hết: diff, prompt, tắt cấu hình Claude/Cursor mà Grok tự nạp (nguyên nhân treo),
chế độ chỉ đọc, bóc JSON. Exit 1 ⇒ dùng dự phòng.
```bash
node ~/.claude/hooks/review-ext.mjs --model grok|flash --wt "<WT>" --brief <BRIEF> \
  --out "<S>/review-<tên>.json" --note "<1–2 câu nhánh làm gì>" < /dev/null
```

**Codex** (ghi thẳng ra file, KHÔNG pipe vào tail/head, luôn `< /dev/null`; kiểm `command -v codex`):
```bash
codex exec --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort="high" -C "<WT>" \
  --output-schema ~/.claude/workers/review-schema.json -o "<S>/review-<tên>.json" \
  "$(cat ~/.claude/workers/<BRIEF>)

Phạm vi: git diff main...HEAD (bỏ qua file sinh tự động, lockfile). <1–2 câu nhánh làm gì>
Trả lời theo JSON schema đã cho (bỏ qua khuôn markdown ở trên)." < /dev/null
```
Brief giữ nguyên phần đầu (tĩnh ⇒ cache được), phần riêng của nhánh để cuối. Codex >30 phút không ra file ⇒ dự phòng.

## 2. Captain xử lý finding — kiểm sâu chỉ lỗi nặng
- **BLOCKER/MAJOR:** mở code tại `path:line`, dựng lại kịch bản hỏng. Thật ⇒ Agent `coder` viết test đỏ tái hiện
  TRƯỚC rồi sửa. Không thật ⇒ một dòng lý do bác.
- **MINOR:** không kiểm từng cái. Gom hết vào MỘT brief cho `coder-lite` ("sửa nếu đúng, bỏ qua kèm lý do nếu sai").
- Model hay thổi mức độ lên một bậc ⇒ hạ mức nếu kịch bản không đủ nặng. Nhiều lượt báo cùng chỗ ⇒ gộp làm một.

## 3. Đóng dấu
Sửa xong ⇒ test lại (dấu test; QA lại nếu đụng UI) ⇒ diff đổi nên dấu cũ mất hiệu lực:
- Đã sửa BLOCKER/MAJOR ⇒ chạy lại MỘT lượt Grok trên diff mới, `--note` thêm "chỉ báo BLOCKER/MAJOR, kiểm các
  chỗ đã sửa: <danh sách>". Vẫn còn lỗi nặng thật sau lượt này ⇒ dừng, báo user.
- Chỉ sửa MINOR ⇒ không gọi lại model: captain đọc diff sửa (`git diff <commit đã review>..HEAD`), thêm vào JSON cũ
  trường `"delta_reviewed_by": "captain", "delta": "<commit đã review>..HEAD"` rồi đóng dấu.
Gộp các file JSON thành một (`findings` = tất cả, kèm trạng thái sửa/bác) rồi:
`node ~/.claude/hooks/flow-gate.mjs stamp review <S>/review-final.json`

## 4. Báo user
Tóm tắt: đã đổi gì · test (số thật) · QA (criteria pass/fail) · review (model + tầng đã chạy + lý do; finding đã sửa / đã bác)
· hỏi gộp ⇒ skill `flow-merge`.

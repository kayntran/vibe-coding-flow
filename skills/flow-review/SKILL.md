---
name: flow-review
description: Review code bằng Grok (qua Cursor) / Codex Sol mới nhất (+ Gemini Flash mới nhất) — ĐÚNG MỘT LẦN cho cả tính năng, trước khi hỏi user gộp; máy kiểm trước (lint/typecheck/test) rồi mới gọi AI; mức suy luận theo rủi ro; captain chỉ kiểm sâu lỗi nặng; đóng dấu review. Tự chạy khi nhánh đã xanh test và QA (hook chặn gộp nếu thiếu dấu). Cũng dùng khi user nói "review", "soát code", "kiểm bảo mật", "code này ổn chưa". KHÔNG dùng cho review plan (nằm trong flow-spec), KHÔNG chạy sau từng giai đoạn/làn.
---

# Flow — review code (tiết kiệm token, vẫn kỹ)

**Một lần cho cả tính năng:** chạy trên nhánh tính năng / nhánh tích hợp ngay trước khi hỏi gộp — không sau từng
giai đoạn, từng làn, từng commit. Plan chỉ có MỘT bước "review code", ở cuối.

## 0. Máy kiểm trước (bắt buộc, miễn phí)
`node ~/.claude/hooks/flow-check.mjs --dir <WT>` (lint, typecheck, SAST, lỗ hổng thư viện, khoá trong bản build…) +
test đủ bộ (dấu test xanh) + `node ~/.claude/hooks/deps-check.mjs --repo <WT> --base main --head HEAD` (thư viện mới) đã
xanh rồi mới gọi model review — không tốn token cho thứ công cụ đã bắt. Diff đụng database ⇒ dùng
`review-brief-security.md` (có checklist DB) cho lượt bảo mật.

## 1. Chọn mức theo rủi ro
**Nhạy cảm** = diff đụng đăng nhập/phân quyền, tiền/license/thanh toán, dữ liệu (migration, xoá, transaction), đồng
thời, xử lý secret, API công khai/webhook, hoặc > ~400 dòng; dự án có `.claude/flow.json` `"sensitive": [glob…]` thì
dùng thêm. Captain quyết từ `git diff --stat main...HEAD`, nói một dòng lý do.

Chọn model theo bài thử 2026-10-01 (10 lỗi cài sẵn, 2 vòng, đều mức high): Codex 8–9/10, Grok 4.7 9/8, Gemini 3.8
Flash 8/8 (nhanh nhất), không model nào báo nhầm; Gemini 3.1 Pro 7–8 kèm báo nhầm ⇒ không dùng. Hai họ model khác nhau
bắt lỗi khác nhau ⇒ lượt thứ hai dùng họ khác thay vì chạy Codex lần nữa.

| Diff | Lượt (chạy song song) |
|---|---|
| Thường | 1 lượt chất lượng — **Grok high** (brief đã gồm mục bảo mật cơ bản). Không gọi Codex |
| Nhạy cảm | **Codex Sol `high`** lượt bảo mật + **Grok** lượt chất lượng |
| Tiền / auth / dữ liệu có rủi ro mất mát | như Nhạy cảm + **Gemini Flash** lượt chất lượng thứ hai |

**Dự phòng:** lượt nào lỗi/hết giờ/không ra JSON ⇒ chạy lại lượt đó bằng model kế tiếp CHƯA dùng cho nhánh này theo
thứ tự Codex → Grok → Gemini Flash → Agent `code-reviewer`; báo user một dòng.
Model luôn là bản mới nhất của dòng (`kit/roles.json` + `models.mjs`); hết lượt ⇒ wrapper báo "HẾT LƯỢT", exit 1 ⇒ dự phòng.

Lệnh (Bash `run_in_background`; `<S>` scratchpad, `<WT>` gốc worktree, `<BRIEF>` = `review-brief.md` hoặc
`review-brief-security.md`):

MỌI model đi qua MỘT wrapper (`--model grok|flash|codex|opus`): kiểm CLI sẵn sàng, chọn model mới nhất của dòng,
**gửi sạch** (bỏ file bí mật/dữ liệu riêng khỏi diff và workspace, quét khoá cả dòng đã xoá, reviewer đọc thư mục tạm
chứ không phải worktree thật, không nhận biến môi trường dạng khoá), bóc JSON đúng `review-schema.json`.
```bash
node ~/.claude/hooks/review-ext.mjs --model grok|flash|codex|opus --wt "<WT>" --brief <BRIEF>   --out "<S>/review-<tên>.json" --note "<1–2 câu nhánh làm gì>" < /dev/null
```
Exit 0 xong · 1 lỗi/CLI chưa sẵn sàng/hết giờ ⇒ dự phòng · **3 = có khoá/dữ liệu riêng, KHÔNG gửi** ⇒ dừng, gỡ khoá khỏi
code (và lịch sử nếu đã commit) rồi chạy lại; không lách bằng cách đổi model. Codex >30 phút không ra file ⇒ dự phòng.

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
Gộp các file JSON thành một (`findings` = tất cả, kèm trạng thái sửa/bác, mã AC liên quan, `commit` đã review) rồi:
`node ~/.claude/hooks/flow-gate.mjs stamp review <S>/review-final.json` + chép bản cuối vào
`docs/specs/<tính năng>/notes/review-final.json` (lưu cùng tính năng, ghi commit đã kiểm).

## 4. Báo user
Tóm tắt: đã đổi gì · test (số thật) · QA (criteria pass/fail) · review (model + tầng đã chạy + lý do; finding đã sửa / đã bác)
· hỏi gộp ⇒ skill `flow-merge`. Không tự nâng nhãn: tách rõ **đã biết** (đã chạy/đo) · **quan sát được** · **suy luận** ·
**cần bạn quyết** · **chưa biết**.

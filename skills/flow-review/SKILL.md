---
name: flow-review
description: Soát cuối chất lượng code của cả nhánh bằng model khác, một lần trước khi hỏi gộp — đối chiếu yêu cầu, kiểm từng lỗi rồi mới nhận, đóng dấu review. Dùng khi nhánh đã qua test và QA, hoặc user nói "review", "soát code", "code này ổn chưa". KHÔNG dùng cho riêng bảo mật hay lỗ hổng (flow-security), soát plan (flow-plan), soát giao diện (flow-ui-design), hay soát mốc trong lúc làm (flow-build).
---

# Flow — soát code

**Soát cuối, một lần cho cả tính năng** [lcly]: chạy trên nhánh tính năng hoặc nhánh tích hợp, ngay trước khi hỏi gộp, bằng lượt AI
mới không mang ngữ cảnh lúc làm. Việc M/L đã có soát theo mốc trong `flow-build`; lượt này nhìn thứ soát mốc không thấy: các phần ghép
có khớp không, có đúng yêu cầu đã duyệt không, bảo mật tổng thể. Lỗi đã nhận hoặc bác ở `## Soát mốc` của `progress.md` không báo lại.

Soát chỉ là báo và kiểm. Sửa thuộc bước 4, gộp thuộc skill `flow-merge`; bắt đầu soát không có nghĩa là được gộp.

## 0. Máy kiểm trước (miễn phí)

`node ~/.claude/hooks/flow-check.mjs --dir <WT>` (lint, typecheck, SAST, lỗ hổng thư viện, khoá trong bản build…) + test
đủ bộ + `node ~/.claude/hooks/deps-check.mjs --repo <WT> --base main --head HEAD` (thư viện mới). Xanh rồi mới gọi model,
để không tốn lượt cho thứ công cụ đã bắt. Không chạy được bước nào ⇒ ghi lại, báo ở bước 6, không đứng lại.

## 1. Đối chiếu yêu cầu trước

Lấy mục "Bạn duyệt" và tiêu chí nghiệm thu trong SPEC (không có SPEC ⇒ lấy yêu cầu trong hội thoại, ghi một dòng vào `--note`).
Với mỗi điều user duyệt: code đã làm chưa, làm khác đi ở đâu, có thêm thứ không ai xin không. Việc này do captain làm,
bằng `git diff main...HEAD`; lệch thì thành finding như mọi lỗi khác. Code đúng mà sai yêu cầu vẫn là sai.

Không đảo quyết định đã có trong sổ chốt chỉ vì một reviewer không thích nó. Muốn đổi ⇒ hỏi user.

## 2. Chọn lượt theo rủi ro

Captain quyết từ `git diff --stat main...HEAD` diff là thường hay **nhạy cảm**, nói một dòng lý do. Thường ⇒ 1 lượt chất lượng
**Grok high**, không gọi Codex. Nhạy cảm ⇒ thêm **Codex Sol `high`** lượt bảo mật (cùng commit đã qua `flow-security` thì dùng lại).
Lượt thứ hai dùng họ model khác, không chạy Codex hai lần. Model luôn là bản mới nhất của dòng (`kit/roles.json` + `models.mjs`).
Định nghĩa nhạy cảm, bảng lượt đủ: `references/chon-luot-soat.md`.

**Dự phòng:** lượt nào lỗi, hết giờ, hết lượt hoặc không ra JSON ⇒ chạy lại bằng model kế tiếp CHƯA dùng cho nhánh này:
Codex → Grok → Gemini Flash → Agent `code-reviewer`. Không còn AI ngoài nào chạy được ⇒ dùng `code-reviewer`, không đứng chờ, và
phải nói rõ với user là chỉ có AI soát nội bộ (câu báo: `references/chon-luot-soat.md`).

## 3. Gọi model: gửi sạch và hỏi trung lập

MỌI model ngoài đi qua MỘT wrapper `review-ext.mjs`. Chỉ gửi code, không gửi dữ liệu thật và khoá. Lệnh gọi, mã thoát, Paseo:
đọc `references/goi-ai-ngoai.md` ở bước này.

Mã thoát **3 = có khoá/dữ liệu riêng, KHÔNG gửi** ⇒ dừng, gỡ khoá khỏi code rồi chạy lại (đã commit ⇒ skill `flow-key-leak`);
không lách bằng cách đổi model.

**`--note` chỉ tả nhánh làm gì và yêu cầu là gì.** Không nói "mình nghĩ đã ổn", không nêu nghi ngờ hay kết luận của mình,
không kể phần đã bác của lượt trước, để reviewer không đồng tình theo. Lượt kiểm lại chỉ nêu chỗ đã sửa.

## 4. Kiểm từng lỗi trước khi nhận

Lời reviewer là gợi ý, không phải lệnh. Lỗi không có `path:line` và kịch bản hỏng cụ thể ⇒ loại.

**Tự bỏ qua, không báo user (giảm báo nhầm):**
- Style, đặt tên, format không gây lỗi; thứ máy kiểm đã bắt.
- Code cũ không nằm trong diff (ghi một dòng nếu nặng, tách việc riêng).
- Mối lo trừu tượng mà code hoặc test hiện có đã chứng minh ngược lại.
- Đề xuất tính năng mới, "phòng khi sau này cần", hoặc đề xuất viết đầy đủ cho code không ai gọi.
- Lỗi cùng gốc nhiều lượt cùng báo ⇒ gộp một.
- Đề xuất ngược quyết định trong sổ chốt ⇒ không tự làm, hỏi user nếu lý do nặng.

**Xử lý phần còn lại:**
- **BLOCKER/MAJOR:** mở code tại `path:line`, dựng lại kịch bản hỏng. Thật ⇒ Agent `coder` viết test đỏ tái hiện TRƯỚC rồi
  sửa. Không thật ⇒ một dòng lý do bác. Reviewer hay thổi mức một bậc ⇒ hạ mức nếu kịch bản không đủ nặng.
- **MINOR:** không kiểm từng cái. Gom vào MỘT brief cho `coder-lite` ("sửa nếu đúng, bỏ qua kèm lý do nếu sai").

## 5. Đóng dấu

Sửa xong ⇒ test lại (QA lại nếu đụng UI); diff đổi nên dấu cũ mất hiệu lực:
- Đã sửa BLOCKER/MAJOR ⇒ MỘT lượt Grok trên diff mới, `--note` thêm "chỉ báo BLOCKER/MAJOR, kiểm các chỗ đã sửa: <danh sách>".
- Chỉ sửa MINOR ⇒ không gọi lại model: captain đọc `git diff <commit đã review>..HEAD` và ghi delta vào JSON cũ
  (trường: `references/dong-dau.md`).

**Vẫn còn lỗi nặng thật sau lượt kiểm lại:** không vá thêm vòng nữa và không tự hạ mức. Kể bằng lời đời thường cho user: người
dùng sẽ gặp gì, khi nào, sửa thêm tốn gì. Hỏi bằng AskUserQuestion, hai lựa chọn "Sửa tiếp" hoặc "Vẫn gộp". Chọn "Vẫn gộp" ⇒
finding giữ nguyên mức, trạng thái `"user-chap-nhan"`, nhắc lại một dòng lúc gộp.

Gộp các file JSON thành một (trường: `references/dong-dau.md`) rồi: `node ~/.claude/hooks/flow-gate.mjs stamp review <S>/review-final.json`
+ chép bản cuối vào `docs/specs/<tính năng>/notes/review-final.json`.

## 6. Báo user

Tóm tắt theo `assets/bao-user.md`, rồi hỏi gộp ⇒ skill `flow-merge`. Không tự nâng nhãn, không nói "code đúng" ngoài phần đã đọc.

## Đọc khi cần

- `references/chon-luot-soat.md` — đọc khi chọn lượt soát (bước 2) hoặc không còn AI ngoài nào chạy được
- `references/goi-ai-ngoai.md` — đọc khi gọi `review-ext.mjs` (bước 3: lệnh, Paseo, Codex)
- `references/dong-dau.md` — đọc khi gộp JSON cuối hoặc ghi delta cho lượt MINOR (bước 5)
- `assets/bao-user.md` — đọc khi viết tóm tắt cuối (bước 6)

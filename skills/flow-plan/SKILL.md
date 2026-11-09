---
name: flow-plan
description: Lập plan kỹ thuật từ SPEC đã duyệt — kiến trúc, task có ô tick và lệnh kiểm, chia làn song song, soát bằng model khác, mở sổ tiến độ, tóm tắt rồi hỏi user. Dùng khi SPEC đã xong, "lập plan", "chia việc", "chia làn". Làm trọn tính năng thì dùng flow-feature. KHÔNG dùng khi yêu cầu còn mơ hồ (flow-spec), để thi công (flow-build), sửa nhỏ một câu.
---

# Lập plan kỹ thuật

## Ba câu trước khi lập plan

Trả lời trong đầu PLAN.md, mỗi câu một dòng:

1. Code có sẵn đã giải được phần nào? (đã kiểm bằng cách đọc, kèm `file:dòng`)
2. Bỏ gì mà vẫn đạt mọi tiêu chí của SPEC? Thấy phần nên cắt thì hỏi user, không tự cắt.
3. Chỗ nào khó đảo ngược, hoặc phát hỏng thì mất dữ liệu, tiền, quyền?

## Chuẩn bị

- **Skill/MCP của thư viện chính:** `node ~/.claude/hooks/skills-check.mjs --host claude|codex --dir <repo> --lib <a,b>`.
  `installed` + `ok` ⇒ đọc khi viết plan. `missing` ⇒ hỏi user một câu đời thường rồi chạy lệnh cài nó in (chỉ bản chính hãng trong
  `kit/official.json`; bản cộng đồng: đọc, soát, viết lại thành skill dự án). `needs-login` ⇒ báo đúng việc cần đăng nhập.
  `misconfigured` ⇒ báo một dòng. `unknown` ⇒ thử một lệnh đọc rẻ trước khi dựa vào. Cài xong cần mở lại phiên ⇒ ghi sổ tiến độ trước.
- **Thiết kế hệ thống:** việc M/L đọc `DESIGN.md` cạnh SPEC (skill `flow-system-design`; chưa có thì chạy skill đó trước). Mỗi mục
  "làm ngay" của bản mẫu thành task có Verify; mục "chừa chỗ" ghi trong phần kiến trúc của plan.
- **Kiến trúc:** dự án chưa có `docs/arch.json`, hoặc tính năng thêm module ⇒ `flow-architecture` trước; plan theo `docs/ARCHITECTURE.md`.

## Viết PLAN.md

Đặt cạnh SPEC.md. Mọi đường dẫn phải kiểm có thật; phát hiện về code không chỉ được `file:dòng` thì loại. Mẫu đầy đủ, kiến trúc 9 dòng,
bảng làn, plan sống: `references/plan-format.md`.

Mỗi task:

```
- [ ] T3 <việc> (phủ AC-02, S-05)
  Files: <đường dẫn có thật>
  Verify: `<lệnh>` → <kết quả mong đợi cụ thể>
```

- Không có "kiểm tra lại cho chắc": **Verify phải có lệnh chạy được và kết quả mong đợi**.
- Mọi tiêu chí của SPEC có task phủ; mỗi task có test của nó. Việc làm dần thì đánh dấu ô tick; plan hoàn tất nằm **cùng commit** với code.
- Việc chia thành nhiều làn: viết bảng làn rồi `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>`, exit 1 thì sửa tới khi sạch.
- Plan chỉ có **MỘT** bước review code (`flow-review`), ở cuối.
- Có màn mới hoặc làm lại giao diện: task phụ thuộc bản demo ghi `(chờ demo)` ở cuối dòng; các task còn lại không được phụ thuộc vào
  task đó, để làm song song trong lúc user chọn bản demo [xwuk].
- Có **kế hoạch test** và **QA charter** từ tiêu chí (vai, trạng thái đầu, dữ liệu, bằng chứng cần có).

## Soát plan bằng model khác

**Cỡ S/M:** tự soát 4 câu, ghi một dòng cuối PLAN.md:
(1) mọi tiêu chí có task phủ? (2) tính năng anh em (`flow-impact`) đã vào plan hoặc ghi "để sau"? (3) `lane-check plan` sạch? (4) quyết định
khó đảo ngược nào thiếu ADR?

**Cỡ L:** một lượt soát mức high, chỉ tìm lỗi thiết kế khó sửa về sau; gửi kèm DESIGN.md và danh sách soát thiết kế của `flow-system-design`
trong cùng lượt. Kiểm `node ~/.claude/hooks/cli-check.mjs <tên>` trước, chưa sẵn sàng
thì sang bậc sau. Bậc model, lệnh chạy và `<ĐỀ>`: `references/soat-plan-model-khac.md`.

Hợp nhất: kiểm từng mục vào SPEC, PLAN, code; sửa plan; ghi đúng/bác kèm lý do cuối PLAN.md.

## Kiểm plan khớp SPEC và code

`node ~/.claude/hooks/plan-check.mjs <PLAN.md>` phải sạch trước khi tóm tắt cho user. Lệnh kiểm mọi mã AC, S, P trong SPEC có task phủ, file có thật
(file sắp tạo ghi `(mới)`, sẽ xoá hay đổi tên ghi `(xoá)`, `(đổi tên)`), mỗi task có Verify. Exit 1 ⇒ tự sửa chi tiết kỹ thuật như đường dẫn hay task thiếu theo SPEC đã duyệt; đổi thứ người dùng
thấy hoặc bỏ yêu cầu thì hỏi user. Lệnh chỉ nhắc, không chặn, và không chạy lệnh trong Verify.

## Tóm tắt và LUÔN hỏi user

Không có thi công khi user chưa trả lời. Trong tin nhắn, bằng lời đời thường, không bắt mở file:

- Sẽ làm gì, theo thứ tự nào; người dùng thấy gì khác ở mỗi bước.
- Đã chọn gì thay user và vì sao (tác động: nhanh hơn, an toàn hơn, tốn phí hơn).
- Rủi ro lớn nhất, soát plan phát hiện gì và đã sửa thế nào.
- Phí phát sinh; phần chưa kiểm được.

Rồi hỏi bằng AskUserQuestion: "Làm theo plan này?", nút chính "Làm theo plan", kèm "Sửa plan". Không dán plan đầy đủ. Bản xem chép vào thư mục mở
phiên và mở sẵn. Quyết định mới ghi sổ chốt.

## Sổ tiến độ

User gật ⇒ mở `progress.md` cạnh SPEC.md, thi công theo `flow-build`. Mẫu ở `references/plan-format.md`.

Hook SessionStart nạp lại sổ đang dở khi mở phiên mới hoặc sau khi nén, nên sổ phải đủ để người khác làm tiếp. Cập nhật khi đổi pha, xong
một làn. **Đang chờ user gật thì ghi rõ trong sổ; sau khi nén phải hỏi lại, không coi là đã được gật.** Quyết định user duyệt ghi sổ chốt, không ghi
vào sổ này. Bước gộp (`flow-merge`) tự ghi `Trạng thái: xong`.

## Đọc khi cần

- `references/plan-format.md` — đọc khi viết PLAN.md (kiến trúc 9 dòng, bảng làn, plan sống) và khi mở `progress.md`
- `references/soat-plan-model-khac.md` — đọc khi plan cỡ L cần soát bằng model khác

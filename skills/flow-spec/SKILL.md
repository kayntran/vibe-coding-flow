---
name: flow-spec
description: Biến ý tưởng thành SPEC đã duyệt — hỏi cho rõ, tìm thứ có sẵn, chốt yêu cầu và phạm vi, dò trường hợp hiếm. Dùng khi user chỉ muốn làm rõ yêu cầu hoặc viết SPEC, "tôi có ý tưởng…", "chưa rõ lắm, hỏi tôi đi". Làm trọn tính năng từ đầu tới cuối thì dùng flow-feature. KHÔNG dùng cho sửa nhỏ một câu, sửa lỗi (flow-bugfix), lập plan kỹ thuật (flow-plan), thiết kế luồng màn (flow-ux).
---

# Từ ý tưởng tới SPEC đã duyệt

Việc nhỏ tả được bằng một câu thì không cần skill này. SPEC đã có và đã duyệt thì dùng lại, không hỏi lại từ đầu.

## Thư mục tính năng

Mọi tài liệu của một tính năng nằm trong `docs/specs/<YYYY-MM-DD>-<slug>/`: `SPEC.md`, `UX.md`, `PLAN.md`, `progress.md`,
`research.md`, `notes/`. Không rải ở chỗ khác.

## 1. Rà cái đã có

- Đọc `docs/IDEAS.md` (nếu có), tìm ý tưởng trùng. Chỉ coi là một khi khớp chắc chắn; mơ hồ thì hỏi. Làm ý tưởng nào thì ghi
  dòng trỏ về mã đó: `node ~/.claude/hooks/lib/so-chot.mjs y-tuong <projectRoot> '{"ma":"y-xxxxxx","lam":"<YYYY-MM-DD>-<slug>"}'`.
- Tra sổ chốt theo phạm vi việc (`mcp__so-chot__tim_chot`). Đã chốt thì không hỏi lại.

## 2. Hỏi cho rõ

Ý tưởng còn mơ hồ thì **hỏi không giới hạn số vòng, nhưng gom câu vào AskUserQuestion** (tối đa 4 câu một vòng; tool từ chối
câu thứ 5), không hỏi lẻ từng câu trong chat. Mỗi câu đứng độc lập, có đáp án khuyên dùng đứng đầu và lý do. Dừng khi đã trả
lời được hợp đồng dưới đây. Đoán được từ code, sổ chốt hay cách làm phổ biến thì không hỏi.

**Hợp đồng 4 trường** (ghi đầu SPEC, chỉ dòng ngắn):

| Trường | Trả lời |
|---|---|
| Kết quả | Xong thì người dùng làm được gì mà giờ chưa làm được |
| Ràng buộc | Tiền, thời gian, thứ phải giữ nguyên |
| Không làm | Việc dễ bị hiểu là có nhưng lần này không có |
| Thế nào là đạt | Tiêu chí kiểm được |

Luôn có một câu: **"Làm xong mà thấy gì thì bạn sẽ nói là sai ý?"** Câu này lôi ra kỳ vọng user chưa nói thành lời; câu trả lời
thành tiêu chí đạt.

Thấy cách rẻ hơn đạt cùng kết quả thì kể một lần, kèm đánh đổi. Chỉ cắt phạm vi khi user gật.

## 3. Tìm thứ có sẵn (song song với bước 2)

- Không viết lại bánh xe: có sẵn trong dự án → thư viện chuẩn → thư viện/repo licence thoáng → tự viết (ghi lý do).
- Tra kho trước: `node ~/.claude/hooks/kho.mjs tim <repo> "<từ khoá>"`. Thẻ còn hạn thì dùng lại ("dùng kết quả ngày …"); hết
  hạn thì chỉ tra phần cũ.
- Chỉ gọi Agent `researcher` khi cần [w99v]: bí cách làm, không chắc đã có ai làm, user đưa repo/link, sắp tự viết khả năng
  chung lớn. Brief: ý tưởng, stack, ràng buộc licence, đường ghi `docs/specs/<YYYY-MM-DD>-<slug>/research.md`; researcher ghi
  thẻ vào `docs/research/`.
- User đưa repo/link: đọc kỹ MỘT lần, ghi thẻ (`kho.mjs moi repo …`: làm gì, cấu trúc, lấy được gì, licence, commit đã đọc, chế
  độ `lay-dung` hoặc `chi-hoc` cho GPL/AGPL/cấm thương mại, chỉ lưu logic bằng lời). Lần sau đọc thẻ.
- Có kết quả đáng giá thì kể user trước khi chốt SPEC.

## 4. Luồng màn hình

Việc có app mới, màn mới hoặc đổi luồng ⇒ chạy skill `flow-ux` trước khi viết phần "Các màn hình". Không có màn hình (API,
script, tác vụ nền) ⇒ bỏ bước này, thay bằng **một tình huống mẫu bằng chữ**: ai làm gì, đưa vào gì, nhận lại gì.

## 5. Viết SPEC

`docs/specs/<YYYY-MM-DD>-<slug>/SPEC.md`: phần user duyệt đứng đầu, đời thường, kỹ thuật tách sau. Máy kiểm:
`node ~/.claude/hooks/spec-check.mjs spec <SPEC.md>` (định dạng ADR-0006).

```
## Bạn duyệt
### Ai dùng
### Các màn hình            ← mỗi màn: #### <tên màn> + bảng | mã | khi | thấy gì | làm được gì |; mã S-nn duy nhất toàn dự án, tiếp số sau mã lớn nhất trong docs/specs
                            ← đủ trạng thái có dữ liệu · trống · đang tải · lỗi ("Không tải dữ liệu" ⇒ chỉ cần có dữ liệu)
### Làm được gì
### Để sau
### Phí phát sinh
### Ai thấy/sửa được dữ liệu gì   ← - P-01: <ai> <thấy|sửa|xoá> <gì> · hoặc "Không áp dụng — <lý do>" (P-nn cũng duy nhất toàn dự án)
## Kỹ thuật
```

- Trong "Làm được gì" và phần kỹ thuật: tiêu chí dạng `KHI <tình huống> THÌ HỆ THỐNG PHẢI <hành vi>`, mỗi dòng dịch thẳng thành test.
- Yêu cầu phi chức năng (hiệu năng, offline, i18n…) chỉ khi có thật.
- Chỗ chưa rõ đánh `[CẦN LÀM RÕ]`; còn dấu này thì chưa xong.
- App có tài khoản/dữ liệu mà chưa chốt chỗ để ⇒ hỏi một câu "dữ liệu để đâu" [d8dk], không mặc định; gợi ý theo nhu cầu từ
  `~/.claude/skills/flow-new-app/recipes/` (Supabase, Cloudflare D1, Postgres trên VPS, dịch vụ user đã có).
- Mỗi `P-nn` sẽ thành test ở lớp chặn quyền thật (skill `flow-qa`).
- Chạm thứ dùng chung (provider, model, gói, cài đặt, tool AI agent…) ⇒ chạy `flow-impact`; kết quả ghi vào SPEC.

## 6. Dò trường hợp hiếm

Chỉ cho **việc lớn, và việc vừa đụng tiền, quyền, dữ liệu**. Việc khác bỏ qua. Cách làm: `references/edge-cases.md`. Mỗi trường
hợp giữ lại thành một tiêu chí hoặc một dòng "Không làm".

## 7. User duyệt

Tóm tắt ngắn trong chat, chép bản xem vào thư mục mở phiên và mở sẵn (khung xem file không mở được file trong worktree), rồi
hỏi bằng AskUserQuestion. Đây là cổng về PHẠM VI. Quyết định vừa duyệt ghi sổ chốt, không ghi vào progress.md.

Duyệt xong: đang chạy trong `flow-feature` thì quay về bảng của luồng. User chỉ nhờ viết SPEC thì dừng ở đây, nói bước tiếp là gì.

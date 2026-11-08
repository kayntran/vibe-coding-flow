---
name: flow-ux
description: Hiểu người dùng ở đúng lúc họ dùng app — ai, lúc nào, ở đâu, đang vội hay rảnh, muốn xong việc gì — rồi ra luồng các màn và việc chính mỗi màn. Dùng khi có app mới, màn mới, đổi luồng, hoặc hỏi "luồng nên thế nào", "màn nào trước". KHÔNG dùng cho sửa nhãn, màu, thêm một ô; dựng bản xem (flow-ui-demo); soát giao diện (flow-ui-design).
---

# Hiểu người dùng, ra luồng màn

Sai ở đây thì giao diện đẹp mấy vẫn khó dùng. Skill này **không vẽ giao diện**. Kết quả là một trang ngắn: tình huống dùng, luồng,
việc chính mỗi màn.

**AI không quan sát được người dùng thật.** Điều user chưa nói và dữ liệu chưa cho thấy chỉ là suy đoán, phải ghi là giả định.

## 1. Lấy thứ đã có

- Sổ chốt, SPEC, `docs/IDEAS.md`.
- App đang có: mở các màn hiện tại, đọc luồng thật. Có log hay số liệu sử dụng thì xem.
- App thật cùng loại giải luồng này thế nào: **bắt buộc** với app mới, màn mới, đổi luồng — làm mục 5b.

## 2. Hỏi user trước

Dùng AskUserQuestion, tối đa 4 câu một vòng, chỉ hỏi cái làm thay đổi luồng. User thường biết khách của mình hơn AI:

- Người dùng chính là ai, họ đang làm gì ngay trước khi mở app?
- Họ dùng ở đâu, trên máy gì, bao lâu một lần?
- Mở app ra, họ muốn xong việc gì nhất?
- Điều gì khiến họ bỏ cuộc hoặc quay lại cách cũ (sổ tay, Excel, Zalo)?

User không biết thì không gặng: ghi là giả định và đi tiếp.

## 3. Viết tình huống dùng

Mỗi nhóm người dùng khác cách dùng là một dòng, thường 1-3 dòng. Không viết chân dung nhân vật dài dòng.

| Trường | Ví dụ |
|---|---|
| Ai | Shipper giao đơn |
| Lúc nào, bao lâu một lần | Giữa hai điểm giao, 30 lần một ngày |
| Ở đâu, máy gì | Ngoài đường, điện thoại, nắng |
| Đang thế nào | Vội, một tay, mạng chập chờn |
| Muốn xong việc gì | Đánh dấu đã giao trong dưới 5 giây |
| Trước và sau đó làm gì | Trước: xem địa chỉ. Sau: đi điểm tiếp |
| Mức chắc | **Bạn nói**, **Dữ liệu cho thấy**, hoặc **AI đoán** |

## 4. Suy ra quyết định

Mỗi đặc điểm của tình huống phải đổi được một điều trong app, không đổi được gì thì bỏ.

| Tình huống | Hệ quả |
|---|---|
| Một tay, điện thoại | Việc chính ở vùng ngón cái, nút to |
| Vội, làm lặp lại | Bỏ bước, mở ra đúng việc đó, nhớ lựa chọn lần trước |
| Mạng yếu | Giữ dữ liệu đã nhập, lưu khi có mạng lại |
| Hiếm khi dùng | Rõ từng bước, không dựa vào việc đã nhớ |
| Lần đầu dùng | Màn trống có một câu và một nút bước đầu |
| Ngoài nắng, ồn | Tương phản cao, không chỉ dựa vào âm thanh |
| Rảnh, so sánh kỹ | Thêm thông tin trên một màn thay vì nhiều bước |

## 5. Vẽ luồng

- Bắt đầu từ việc chính, đi thẳng tới khi xong; đếm số lần bấm. Việc chính và mọi tính năng tới được trong tối đa 2 lần bấm từ
  màn chính, trừ khi có lý do ghi rõ.
- Mỗi màn một việc chính; thứ tự trên màn là thứ tự làm.
- Thêm nhánh: lần đầu (trống), lỗi, bỏ giữa chừng, quay lại sau. Nhánh nào cũng có lối đi tiếp.
- Việc không quay lại được (xoá, tiền, quyền) đánh dấu rõ. Việc hoàn tác được thì dùng Hoàn tác.

Tự đi thử trên giấy: đóng vai từng tình huống, đi hết luồng, ghi chỗ phải dừng nghĩ. Có chỗ kẹt thì sửa luồng.

## 5b. Tham khảo app thật (bắt buộc) [9a78] [8yu7]

1. **Hỏi nguồn, không tự bỏ qua:** sổ chốt chưa ghi user có tài khoản tham khảo nào ⇒ hỏi một lần (AskUserQuestion): Mobbin, Pinterest,
   Dribbble, Behance, khác, hoặc không có. Ghi sổ chốt phạm vi `chung` để lần sau không hỏi lại. Máy chưa thấy Mobbin không có nghĩa
   user không có.
2. **Có Mobbin:** chưa có tool `mcp__mobbin__*` ⇒ cài bộ skill chính hãng cho Claude: `claude plugin marketplace add mobbin/skills`
   rồi `claude plugin install mobbin@mobbin` (Codex: `codex plugin marketplace add mobbin/skills` rồi `codex plugin add mobbin@mobbin`); chưa đăng nhập
   ⇒ đưa user đúng lệnh `claude mcp login mobbin`. Cần mở phiên mới mới có tool. Có tool ⇒ làm theo skill `mobbin:search` (chọn tìm
   màn, luồng hay một phần màn; tìm theo việc cần làm, không theo tên hãng).
3. **Pinterest, Dribbble, Behance…:** điều khoản các trang này cấm máy tự lấy ⇒ nhờ user dán 3-5 link hoặc ảnh họ thích; AI chỉ đọc
   thứ user đưa.
4. **Lấy 2-4 app làm mẫu chính cho mỗi màn chính** (đếm theo app, không theo ảnh). Mỗi điều rút ra ghi mức chắc: 2 app trở lên =
   **tiền lệ**, 1 app = **ví dụ**, không có = **ý kiến**. Không viết "hầu hết app" mà không nêu tên app. Chỉ học cấu trúc (bố cục,
   thứ tự bước, cách xử lý màn trống/lỗi); không chép màu, chữ, logo, nội dung, dữ liệu mẫu. Tên app và link chỉ ghi trong `UX.md`,
   không vào code; ảnh để thư mục tạm, không commit.
5. **Cho user xem trước khi dựng demo:** ảnh các app cạnh nhau trong chat, dưới mỗi ảnh một câu "app này làm thế nào, hợp hay không
   hợp khách của bạn", hỏi user thích cách nào. Kết quả đi vào mục "Tham khảo" của `UX.md`.
6. Không lấy được nguồn nào (Mobbin lỗi, user không có tài khoản và không dán link) ⇒ báo user một dòng rồi làm tiếp, ghi "chưa
   tham khảo app thật" trong `UX.md`. Không tự điền tham khảo từ trí nhớ.

## 6. Ghi và hỏi user

Ghi `docs/specs/<YYYY-MM-DD>-<slug>/UX.md`:

```
# Luồng: <tính năng>
## Tình huống dùng
<bảng mục 3>
## Luồng việc chính
Màn A → Màn B → Xong (N lần bấm)
Nhánh: lần đầu → … · lỗi → … · bỏ giữa chừng → …
## Các màn
| Màn | Việc chính | Người dùng so sánh bằng gì (phải nổi nhất) | Vì tình huống nào |
## Tham khảo
| Màn | App (link Mobbin/link user dán) | Học gì | Mức chắc (tiền lệ / ví dụ / ý kiến) |
## Giả định cần kiểm
- <giả định> → kiểm bằng: <bài người mới / hỏi khách / số liệu>
```

Tóm tắt trong chat bằng lời, kể đúng hành trình của người dùng, rồi hỏi "luồng này đúng chưa?" bằng AskUserQuestion. Luồng đã duyệt
ghi sổ chốt.

## Sau đó

- Tình huống đi vào "Ai dùng", các màn đi vào "Các màn hình" của SPEC (`flow-spec`).
- Có màn mới: `flow-ui-demo` dựng theo luồng đã duyệt, không tự đổi luồng.
- Giả định cần kiểm đi vào mục tiêu của bài **người mới** trong `flow-qa`. Giả định sai thì quay lại đây.

## Không làm

- Không tự nhận đã "nghiên cứu người dùng" khi chỉ suy luận.
- Không thêm tính năng ngoài yêu cầu với danh nghĩa cải thiện trải nghiệm: có ý hay thì kể user.
- Không chạy cho thay đổi không đụng luồng.

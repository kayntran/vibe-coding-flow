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

Mỗi nhóm người dùng khác cách dùng là một dòng, thường 1-3 dòng. Không viết chân dung nhân vật dài dòng. Mỗi dòng gồm các
trường: Ai · Lúc nào, bao lâu một lần · Ở đâu, máy gì · Đang thế nào · Muốn xong việc gì · Trước và sau đó làm gì · Mức chắc
(**Bạn nói**, **Dữ liệu cho thấy**, hoặc **AI đoán**). Bảng ví dụ điền sẵn: `assets/ux.md`.

## 4. Suy ra quyết định

Mỗi đặc điểm của tình huống phải đổi được một điều trong app, không đổi được gì thì bỏ. Bảng tình huống → hệ quả thường gặp:
`references/he-qua-tinh-huong.md`.

## 5. Vẽ luồng

- Bắt đầu từ việc chính, đi thẳng tới khi xong; đếm số lần bấm. Việc chính và mọi tính năng tới được trong tối đa 2 lần bấm từ
  màn chính, trừ khi có lý do ghi rõ.
- Mỗi màn một việc chính; thứ tự trên màn là thứ tự làm.
- Thêm nhánh: lần đầu (trống), lỗi, bỏ giữa chừng, quay lại sau. Nhánh nào cũng có lối đi tiếp.
- Việc không quay lại được (xoá, tiền, quyền) đánh dấu rõ. Việc hoàn tác được thì dùng Hoàn tác.

Tự đi thử trên giấy: đóng vai từng tình huống, đi hết luồng, ghi chỗ phải dừng nghĩ. Có chỗ kẹt thì sửa luồng.

## 5b. Tham khảo app thật (bắt buộc) [9a78] [8yu7]

Cách làm đủ 6 bước (hỏi nguồn, Mobbin, link user dán, chọn 2-4 app và ghi mức chắc, cho user xem ảnh cạnh nhau, khi không lấy được
nguồn): `references/tham-khao-app-that.md`. Luật cứng: không tự bỏ qua mục này; không tự điền tham khảo từ trí nhớ; chỉ học cấu
trúc, không chép màu, chữ, logo, nội dung; cho user xem trước khi dựng demo.

## 6. Ghi và hỏi user

Ghi `docs/specs/<YYYY-MM-DD>-<slug>/UX.md` theo mẫu `assets/ux.md`.

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

## Đọc khi cần

- `assets/ux.md` — khi viết bảng tình huống dùng (bước 3) và ghi `UX.md` (bước 6)
- `references/he-qua-tinh-huong.md` — khi suy quyết định từ tình huống (bước 4)
- `references/tham-khao-app-that.md` — khi làm mục 5b (nguồn tham khảo, Mobbin, mức chắc, cho user xem)

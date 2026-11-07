---
name: flow-ui-demo
description: Dựng các bản giao diện xem thử ngay trong app chạy trên máy, có thanh chuyển để user chọn, rồi gỡ bản thừa. Dùng khi có màn mới hoặc làm lại giao diện, hoặc user nói "cho xem vài bản", "dựng mấy hướng cho tôi chọn". KHÔNG dùng cho sửa rất nhỏ (chỉ gửi ảnh trước/sau), thiết kế luồng (flow-ux), soát giao diện đã có (flow-ui-design).
---

# Dựng bản xem thử cho user chọn

Luồng đã duyệt (`UX.md`) và SPEC là đầu vào, nếu có. Thiếu luồng mà đây là màn mới thì chạy `flow-ux` trước.

## Số bản

| App | Số bản |
|---|---|
| Chưa có gu (app mới, chưa có token, sổ chốt chưa ghi gu) | 5 |
| Đã có gu | 3, giữ nguyên màu, chữ, thành phần; chỉ khác bố cục |

**Sửa giao diện rất nhỏ** (đổi nhãn, màu, một nút): không dựng demo, không dừng chờ. Làm luôn, gửi ảnh trước/sau khi báo.

## Cách dựng

Làm trong worktree, ngay trong app của dự án, dùng stack và thành phần thật. Không widget/artifact, không HTML rời, không dịch vụ
tạo giao diện ngoài. Chưa có app ⇒ dựng khung trước (`flow-new-app`).

- **Giữ cảnh:** mọi bản cùng dữ liệu mẫu tiếng Việt thực tế, cùng luồng, cùng việc chính, để user so sánh được. Không có số liệu
  giả làm đẹp, không chữ ngẫu nhiên.
- **Mỗi bản khác nhau ở một trục, ghi tên trục:** cách điều hướng, mật độ thông tin, vị trí việc chính, cách trình bày danh sách
  (bảng, thẻ, dòng), hoặc phong cách (chỉ khi chưa có gu). Năm bản phải thật khác nhau, không phải năm lần đổi màu.
- **Hướng rút ra từ tình huống dùng:** mỗi bản nói được một câu "hợp với ai, lúc nào", không chọn theo sở thích của AI.
- **Đủ trạng thái:** mỗi màn có đủ trạng thái trong bảng S-nn của SPEC, bấm thử được (trống, đang tải, lỗi). Gắn `data-s="S-nn"`
  vào phần tử gốc của từng trạng thái và giữ nguyên mã khi làm thật; máy (`spec-check codes`) đối chiếu SPEC, app, test.
- **Thanh chuyển:** thanh nhỏ nổi trên màn (Bản 1…5, phím ←/→), hiện tên trục của bản. Chỉ bật khi chạy dev (vd
  `import.meta.env.DEV`, cờ build dev); không bao giờ có trong bản phát hành.
- Chỉ làm giao diện và dữ liệu mẫu, chưa nối logic thật, để đổi bản không tốn công.

## Tự kiểm trước khi mở cho user

Lấy cổng riêng: `node ~/.claude/hooks/wt-env.mjs alloc <worktree>`. Mở từng bản ở **3 cỡ 390, 768, 1280**, xem ảnh chụp thật:

- Sửa lỗi rõ ràng: chữ tràn, nút bị che, cuộn ngang, chữ tiếng Việt lỗi dấu, trạng thái bấm không tới.
- Không chấm điểm, không tinh chỉnh gu ở bước này. Luật giao diện ở `flow-ui-design`.
- Chưa mở được ở cỡ nào thì nói rõ khi báo.

## Hỏi user

Chạy app, mở cho user xem. Trong chat nêu một dòng cho mỗi bản, rồi hỏi bằng AskUserQuestion: chọn bản nào, cần sửa gì. Mỗi lựa
chọn kèm phần đánh đổi. Được phép ghép ("bố cục bản 2, danh sách bản 4"). Sửa theo lời tới khi user gật.

Không mở được trên máy (máy ảo, app desktop): gửi ảnh chụp từng bản ở từng cỡ.

## Chọn xong

1. Ghi bản đã chọn và gu vào sổ chốt.
2. Gỡ các bản còn lại và thanh chuyển. Kiểm lại: tìm trong code không còn tên bản thừa, thanh chuyển không lọt vào bản build.
3. Giữ các `data-s`.
4. Đang chạy trong `flow-feature` thì quay về bảng của luồng; plan làm thật theo bản đã chọn. User chỉ nhờ dựng bản xem thì dừng ở đây.

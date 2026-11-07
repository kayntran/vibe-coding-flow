---
name: flow-ui-design
description: Làm và soát giao diện theo luật tối giản của kit — chọn token, bố cục, trạng thái; kiểm 3 cỡ màn hình, tràn chữ, nút bị che, tương phản rồi tự sửa lỗi nặng. Dùng khi làm giao diện thật hoặc user nói "soát giao diện", "nhìn rối", "bị tràn trên điện thoại". KHÔNG dùng cho thiết kế luồng (flow-ux), dựng bản để chọn (flow-ui-demo), kiểm chức năng (flow-qa).
---

# Làm và soát giao diện

Hai chế độ dùng chung một bộ luật: **Làm** khi đang viết giao diện, **Soát** khi đã có màn chạy được.

## Thứ tự ưu tiên

1. Lời user và gu đã ghi ở sổ chốt (`mcp__so-chot__tim_chot`).
2. Design system và token trong code. **Token trong code là nguồn thật** của màu, chữ, khoảng cách; sổ chốt chỉ ghi hướng gu.
3. Bản demo đã chọn và `UX.md`.
4. Phần "Phong cách UI" trong `~/.claude/CLAUDE.md`: mỗi màn một việc, ít chữ, nhãn 1-3 chữ dạng động từ, phản hồi bằng trạng thái,
   lỗi một dòng cạnh chỗ sai. Trùng với luật ở đây thì luật CLAUDE.md thắng.
5. Mặc định trong `references/defaults.md`, chỉ khi các nguồn trên không nói.

## Chế độ Làm

1. Đọc token và thành phần sẵn có, dùng lại trước khi tạo mới. Dự án có thư viện UI thì tra tài liệu chính hãng trước khi đoán API.
2. Giá trị màu, cỡ, khoảng cách lấy từ token. Thiếu thì thêm vào token, không gõ số rời.
3. Mỗi màn đủ trạng thái: có dữ liệu, trống, đang tải, lỗi; nút có hover, focus, đang xử lý, tắt. Giữ `data-s="S-nn"`.
4. Phản hồi sau khi bấm:
   - Bấm Lưu: nút đổi trạng thái hoặc chỗ vừa lưu sáng lên.
   - **Thông báo nhỏ chỉ dùng khi có Hoàn tác** (vừa xoá, vừa lưu trữ).
5. Không tự thêm thứ chưa ai xin: Ctrl+K, chuông thông báo, ảnh động trang trí. Thấy hợp thì gợi ý một dòng.
6. Xong chạy Soát trên chính phần vừa làm.

## Chế độ Soát

### Bước 1: máy kiểm

Dự án có `.claude/ui.json`: `node ~/.claude/hooks/ui-check.mjs --dir <repo>`. Dự án có sẵn lần đầu bật:
`node ~/.claude/hooks/ui-check.mjs --dir <repo> --baseline` một lần, để lỗi cũ chỉ nhắc, lỗi mới mới chặn.

### Bước 2: mở app xem thật

Cổng riêng: `node ~/.claude/hooks/wt-env.mjs alloc <worktree>`. **Luôn đủ 3 cỡ: 390, 768, 1280.** Mở màn trong phạm vi soát, chụp ảnh
từng cỡ và từng trạng thái, đi hết việc chính, đọc console. Danh sách kiểm: `references/checklist.md`. Không mở được cỡ nào thì
ghi "chưa kiểm", không suy ra từ code.

Soát app thật đang chạy: chỉ đọc, không gửi, không xoá, không đổi dữ liệu.

### Bước 3: ghi lỗi có bằng chứng

| Mức | Nghĩa | Ví dụ |
|---|---|---|
| **Chặn** | Không làm được việc hoặc rõ ràng hỏng | Nút bị che, chữ tràn mất nội dung, cuộn ngang, không chạm được, lỗi dấu tiếng Việt, thiếu trạng thái lỗi |
| **Nên sửa** | Vẫn làm được nhưng vướng hoặc phạm luật | Hai nút chính, nhãn không rõ, vùng chạm nhỏ, tương phản thấp, thiếu phản hồi |
| **Gu** | Đúng sai tuỳ mắt | Khoảng cách, màu, cách trình bày, mật độ |

Mỗi dòng: `màn, cỡ, trạng thái | thấy gì | ảnh | hướng sửa`. Tách điều đã thấy với điều suy ra.

### Bước 4: xử lý

- **Chặn:** tự sửa trong worktree, chụp lại đúng cỡ đó, rồi cho user xem ảnh trước/sau.
- **Nên sửa:** sửa khi rõ ràng, thuộc phần đang làm và không đổi điều user đã duyệt; còn lại liệt kê.
- **Gu:** chỉ báo, không tự đổi.
- Sửa 2 lần cùng lỗi không qua: dừng, kể bằng lời kèm ảnh.
- Không sửa kỳ vọng hay tắt máy kiểm cho khớp với lỗi.

Báo theo khuôn: đã sửa gì, người dùng thấy gì khác, còn gì cần user quyết, phần nào chưa kiểm. Có đụng giao diện thì hỏi "giao diện
đã ổn chưa?" theo luật trong `CLAUDE.md`; sửa rất nhỏ chỉ gửi ảnh trước/sau.

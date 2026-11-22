---
name: flow-business
description: Buổi hỏi business đầu dự án cho người không code — user kể ý tưởng, AI hỏi theo tầm cỡ app (dùng riêng, nội bộ, mở miễn phí, có thu tiền, ngành nhạy cảm), tra đối thủ và giá chạy ngầm, bắt chỗ mâu thuẫn, đọc lại cho user gật rồi lưu docs/BUSINESS.md; sau đó mọi skill khác không hỏi lại business. Dùng khi tạo app mới (flow-new-app gọi), làm tính năng ở app chưa có docs/BUSINESS.md, hoặc user nói "hỏi tôi về business", "đổi giá", "đổi khách". KHÔNG dùng cho hỏi yêu cầu một tính năng (flow-spec), chọn công nghệ (flow-stack), luồng màn (flow-ux), sửa chữ hay màu.
---

# Buổi hỏi business đầu dự án

Ra `docs/BUSINESS.md` (mẫu `assets/business.md`). **Chỉ skill này sửa nội dung**; skill khác chỉ đọc và thêm một dòng vào `## Nhật ký
đổi`. Bản đã duyệt thì **không ai hỏi lại business**. Hỏi bằng AskUserQuestion, tiếng Việt đời thường.

**`references/cau-hoi.md` (146 điều, 16 chương) là mục tiêu phủ, không phải kịch bản.** AI viết câu và đáp án theo đúng app (ngành,
khách, tên gọi), bỏ điều đã rõ, hỏi thêm câu đào sâu khi câu trả lời mở ra chuyện mới, kể cả câu ngoài danh sách.

## Luật hỏi
- ≤ 4 câu một vòng, cùng chương hoặc cùng cờ, **mỗi câu một ý** (ý phụ thành câu đào sâu); câu phụ thuộc đáp án để vòng sau.
- **Hộp hỏi nhận 2–4 đáp án** (ô tự gõ có sẵn). Chọn một: tối đa 3 đáp án thật, ô thứ 4 là "Chưa biết"; nhiều hơn thì gộp nhóm
  hoặc tách hai câu. Chọn nhiều: tối đa 4, không cần "Chưa biết" (bỏ trống = mặc định). UT1 không xếp hạng: hỏi điều quan trọng nhất, thứ hai chỉ khi cần.
- Cột "Kiểu": **QĐ** ⇒ đáp án khuyên dùng đứng đầu + lý do đời thường · **ST** (sự thật, hoàn cảnh user, cả VD1) ⇒ đáp án trung
  lập, không soạn chuyện để user gật · **TD** (tả tự do) ⇒ đáp án 1 là bản nháp AI, đáp án 2 "Sửa lại".
- **"Chưa biết" không gặng: lấy phương án AI suy riêng cho đúng app** (kèm lý do, ghi `(giả định)` kèm hạn và cách kiểm rẻ nhất);
  cột Mặc định chỉ khi không có căn cứ riêng. **Mặc định và suy luận đều thua điều user đã nói.**
- **Số vòng chỉ để báo user ước tính** (≈ (câu còn phải hỏi + 2) ÷ 4). Câu ⭐ không bao giờ cắt. Ba "Chưa biết" liên tiếp ⇒ đường nhanh:
  AI soạn đề xuất cho cả chương, gồm ⭐, user xác nhận từng điều.
- Không hỏi cái tra được (đối thủ, giá, luật): tra rồi cho user xác nhận. Không câu dẫn dắt, thuật ngữ, bịa số hay điều luật, lấy ý
  riêng của user làm giá. Bảng lỗi: `references/thich-ung.md`.

## Quy trình (9 bước)
1. **Mở.** Đọc sổ chốt, `docs/IDEAS.md`, lời kể, tài liệu user dán. App đã có code ⇒ đọc app trước (README, màn, dữ liệu), điền mục
   đã rõ ở mức "Dữ liệu cho thấy", chỉ hỏi phần thiếu. Có nháp dở ⇒ nhắc ba dòng, hỏi tiếp từ chỗ dừng.
   Nói một dòng: "Tôi hỏi business rồi công nghệ, khoảng N vòng, ≤ 4 câu mỗi vòng; bạn dừng được, lần sau hỏi tiếp đúng chỗ."
2. **Nghe kể.** User kể vài câu hoặc dán tài liệu; điền sẵn mục đã rõ ("Bạn nói"). **Rõ từ lời kể thì không hỏi** (lời kể có "miễn
   phí" hoặc "chuyển khoản tiền cọc" ⇒ bỏ TG1, TG7).
3. **Vòng 1 xác định tầm cỡ** (TQ1 TQ2 TQ9 TG1; TG1 bỏ khi lời kể đã rõ) ⇒ hồ sơ R · N · C · $ · S và cờ. Báo "app của bạn thuộc loại
   …, khoảng N vòng" (dùng riêng ~12 câu ≈ 4 vòng · nội bộ ~32 ≈ 9 · mở miễn phí ~69 ≈ 18 · có thu tiền ~85 ≈ 22). Chỉ hỏi câu hợp
   hồ sơ và cờ (chương đã bỏ thì cờ không mở lại, trừ cờ an toàn `nhay`, `tre-em`, `nganh`): `references/thich-ung.md`.
4. **Tra ngầm** (hồ sơ C, $, S). **Ngay sau vòng 1** giao `researcher` chạy nền tra app cùng loại, giá họ bán (thu dịch vụ thì mức cọc
   và chính sách nơi cùng ngành), luật liên quan; tra kho `kho.mjs tim` trước. Chưa xong tới vòng đối thủ ⇒ hỏi chương khác trước; xong
   thì user xác nhận.
5. **Lưu nháp mỗi vòng** (`trang_thai: nhap`, `vong_da_xong`): app đã có ⇒ `docs/BUSINESS.md`; chưa có ⇒
   `<thư mục cha>/.flow-nhap/<tên-app>/BUSINESS.md`, **thư mục cha = giá trị `--dir` của `flow-new-app`**; chưa chốt thì lấy thư mục
   làm việc hiện tại của phiên và nói user một dòng. Mỗi mục kèm mức chắc và ngày.
6. **Bắt mâu thuẫn.** Trước vòng chốt rà bảng cặp mâu thuẫn và mẫu chung "hai câu trả lời không cùng đúng được"; mỗi cặp một câu hỏi lại.
7. **Câu chốt business:** UT1 (điều quan trọng nhất), rồi UT8 chọn nhiều: **"Ngoài 4 việc kit luôn hỏi, bạn muốn AI hỏi thêm việc
   nào?"** (đổi giá hoặc khuyến mãi · chữ hiện cho khách · thêm tính năng ngoài phạm vi; bỏ trống = không thêm). **Bốn cổng của kit
   (tiêu tiền thật, xoá dữ liệu, gửi ra ngoài cho khách, đưa app lên mạng) luôn hỏi, cố định, không ai tắt được, không nằm trong đáp
   án UT8.** Bản ghi: "4 cổng luôn hỏi + việc chọn ở UT8; còn lại AI tự suy".
8. **Tự thử 10 quyết định** (`references/thich-ung.md`) trả lời được không cần hỏi lại? Chưa ⇒ thêm vòng bổ sung (sau UT8) hoặc giả định.
   Chỉ đóng buổi khi mọi điều hợp hồ sơ đã có trả lời hoặc giả định ghi rõ.
9. **Đọc lại, xin gật.** Đọc tóm tắt ≤ 15 dòng bằng lời đời thường, nói mục nào là giả định (gom theo chương); gật tóm tắt không phải
   gật từng giả định (việc sau chạm tới thì cập nhật, ghi nhật ký). Gật ⇒ `trang_thai: da-duyet`, `phien_ban: 1.0.0`, ngày duyệt; mỗi
   quyết định lớn (khách, cách thu tiền, nền tảng, UT1, UT8) một dòng sổ chốt (`mcp__so-chot__ghi_chot`) trỏ mã `B-xx`; rồi chạy
   `flow-stack`. Chưa gật ⇒ giữ `nhap`.

## Luật Việt Nam
Câu đụng luật (nhóm PL, TG8, TG11, TG12): hỏi sự việc ("có lưu CCCD không?"), không hỏi "bạn tuân thủ … chưa". Ghi "tra ngày …" vào
`phap_ly_tra_ngay` (hồ sơ R không có chương pháp lý: `—`); quá 90 ngày ⇒ `researcher` tra lại trước khi dựa vào. Không nói "đúng luật";
nhắc hỏi kế toán hoặc luật sư. Ngành nhạy cảm (PL12 có hoặc không chắc): **dừng phần app đưa ra đánh giá, khuyên hoặc quyết định
chuyên môn** (chẩn đoán, liều thuốc, đầu tư, pháp lý…); phần ghi, nhắc, gửi dữ liệu người dùng tự nhập vẫn làm; ghi Câu hỏi mở "cần
người có chuyên môn". PL3 "Chưa biết" mà có cờ `nganh`/`nhay` ⇒ giả định an toàn, bật cờ `tre-em`. Không gợi ý dịch vụ thu tiền đã đóng.

## Đổi ý
- User nói **ngược mục `[Bạn nói]`** (giá, khách, nền tảng…) ⇒ một dòng xác nhận rồi làm: "Điều này đổi B-TG1 (từ miễn phí sang thuê
  bao). Kéo theo: màn giá, cổng thu tiền, trang pháp lý, phí. Đổi nhé?"
- Trái mục `[AI đoán]` hoặc `[Mặc định]` (user nói khác, hoặc việc mới cần điều ngược bản) ⇒ **cập nhật, ghi nhật ký, không hỏi**.
- Cách sửa: **tại chỗ** (xoá câu cũ mâu thuẫn); mục user nói thành `[Bạn nói]`; tăng phiên bản (MAJOR đổi khách/cách thu tiền/nền
  tảng · MINOR thêm · PATCH chữ); ghi `## Nhật ký đổi`; **kể tài liệu bị ảnh hưởng** (SPEC, UX, DESIGN, STACK; không tự sửa, báo user
  hoặc ghi Câu hỏi mở); ghi sổ chốt thay cho cũ. MAJOR đụng công nghệ ⇒ chạy lại `flow-stack`. Một mục đổi từ lần thứ 2 ⇒ hỏi "Chưa
  chắc phải không? Thử rẻ trước nhé?".
- **Skill khác gặp lỗ hổng** (bản chưa nói, hoặc trái `[AI đoán]`/`[Mặc định]`) ⇒ **không hỏi user** [kis5]: tự suy theo mục dưới, chỉ
  thêm MỘT dòng vào Nhật ký đổi, không sửa chương; lần `flow-business` sau đọc rồi cập nhật.

## Ranh giới tự suy (mọi skill sau buổi hỏi)
Bản `da-duyet` ⇒ yêu cầu, luồng màn, thiết kế hệ thống, tạo app, giao diện, phát hành **không hỏi câu business**. Điều bản chưa nói:
BUSINESS.md/STACK.md ⇒ sổ chốt ⇒ suy theo hồ sơ + cờ + luật đánh đổi, ghi `(AI suy từ B-xx)` ⇒ mặc định phổ biến + giả định; cuối việc
kể user. Vẫn hỏi **lúc hành động thật**: bốn cổng cố định và việc chọn thêm ở UT8 (`references/thich-ung.md`).

## Đọc khi cần
- `references/cau-hoi.md` — soạn câu cho vòng (bước 3 đến 8): kiểu câu, mặc định, hỏi khi
- `references/thich-ung.md` — hồ sơ, thứ tự vòng, cờ, đường nhanh, mâu thuẫn, 10 quyết định thử, ranh giới tự quyết, lỗi hay gặp
- `assets/business.md` — khi lưu nháp (bước 5) và bản chốt (bước 9)

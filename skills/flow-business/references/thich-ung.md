# Thích ứng: hồ sơ, thứ tự vòng, cờ, mâu thuẫn, quyết định thử

Dùng khi chạy buổi hỏi. Mã `XXn` là mã trong danh sách điều cần biết (ghi vào bản là `B-XXn`).

## Mục lục
- Năm hồ sơ và ước tính số vòng
- Chương bỏ theo hồ sơ
- Thứ tự vòng
- Cờ mở câu
- Câu mở và câu đóng chương
- Đường nhanh
- Cặp mâu thuẫn
- 10 quyết định thử
- Ranh giới tự quyết
- Lỗi hay gặp

## Năm hồ sơ và ước tính số vòng

**Hồ sơ là danh sách nền**: các dòng mang `R`, `N`, `C`, `$` ở cột "Hỏi khi" của danh sách (hồ sơ sau gồm hồ sơ trước). **Cờ mở thêm câu ngoài hồ sơ** (các dòng mang `cờ x`), **nhưng chỉ câu thuộc chương hồ sơ còn hỏi**: chương hồ sơ đã bỏ hẳn thì cờ không mở lại (bảng "Chương bỏ theo hồ sơ" bên dưới), câu lấy giả định (vd `may-tinh` không mở CP2 ở hồ sơ R, `gui-thu` hoặc `ai` không mở TG14 ở hồ sơ C, `tai-file` không mở PL16 ở hồ sơ R). **Ngoại lệ là cờ an toàn `nhay`, `tre-em`, `nganh`: luôn mở câu PL của chúng** (PL1 PL2 PL3 PL12). Dòng `mặc định` không hỏi. Hồ sơ chọn ở vòng 1 từ TQ2 (R, N hoặc C), rồi TG1 ≠ miễn phí hẳn thì nâng lên $ (từ N trở lên), TQ9 = có hoặc "Chưa biết" thì thêm cờ `nganh` (hồ sơ S). **Câu rõ từ lời kể thì không hỏi**, kể cả TG1 và TG7 khi lời kể đã nói thu tiền hay miễn phí, chuyển khoản hay không; điền "Bạn nói" từ lời kể.

| Hồ sơ | Khi nào | Câu hỏi | Ước tính |
|---|---|---|---|
| **R** Dùng riêng | TQ2 = mình hoặc gia đình | 12 câu: TQ1 TQ2 TQ9 VD2 VD7 PV1 PV3 PV8 PV9 PV10 UT1 UT8 | ≈ 4 vòng, chừa thêm 1 vòng cho câu mâu thuẫn và đào sâu |
| **N** Nội bộ | TQ2 = nhóm hoặc công ty | R + KH3 KH6 KH8 TG1 CP1 TD5 PV2 PV4 PV5 VH2 VH5 VH6 PL1 PL2 PL4 PL16 TH4 TH7 RR3 UT5 (32 câu) | ≈ 9 vòng |
| **C** Mở miễn phí | TQ2 = người ngoài, TG1 = miễn phí hẳn | N + KH1 KH4 KH7 KH10 VD1 VD3 VD5 VD9 GT1 GT2 GT3 GT4 DT1 DT3 KN1 KN2 KN6 TD1 TD2 TD4 VH1 VH7 VH8 PL3 PL6 PL17 TH1 TH2 TH3 TH5 RR1 RR2 MR1 MR2 UT2 UT3 UT4 (69 câu) | ≈ 18 vòng |
| **$** Có thu tiền | TG1 ≠ miễn phí hẳn (nâng từ N hoặc C) | C + TQ3 KH2 DT2 TG3 TG7 TG8 TG9 TG11 TG13 CP3 CP4 TD3 PL9 PL11 TH8 RR5 (85 câu) | ≈ 22 vòng |
| **S** Ngành nhạy cảm | TQ9 = có hoặc "Chưa biết" (cờ `nganh`) | Hồ sơ nền + PL12, và PL1 PL2 PL3 nếu nền chưa có (luôn mở dù nền đã bỏ chương PL). PL12 = Không ⇒ vẫn như nền. PL12 = có ngành cần giấy phép ⇒ **dừng phần app đưa ra đánh giá, khuyên hoặc quyết định chuyên môn** (chẩn đoán, liều thuốc, đầu tư, pháp lý…); phần ghi, nhắc, gửi dữ liệu do người dùng tự nhập vẫn làm; ghi Câu hỏi mở "cần người có chuyên môn" | như nền, vòng 2 đứng đầu bởi các câu này |

**Số vòng chỉ để báo user ước tính** (≈ (số câu + 2) ÷ 4, làm tròn lên; cộng 2 vì PV9 hỏi thành hai câu và UT1 có thể cần câu thứ hai), không phải trần. Số câu trong bảng là điều cần biết, không phải số câu phải hỏi: điều đã rõ thì điền sẵn (mức "Bạn nói" hoặc "Dữ liệu cho thấy"). **Câu ⭐ không bao giờ cắt.** Câu không ⭐ mà vượt ước tính ⇒ đi **đường nhanh**; điều kiện phụ ghi ở cột "Hỏi khi". Phiên mới thì ước tính lại theo phần còn lại.

## Chương bỏ theo hồ sơ

Chương **không còn câu nào** trong hồ sơ (bài đo `business-session.json` đối chiếu bảng này), trừ câu cổng TG1: hỏi ở vòng 1 với hồ sơ N, C để biết có lên hồ sơ $ không (bỏ khi lời kể đã rõ). Chương đã bỏ hẳn thì cờ không mở lại câu của chương đó, trừ cờ an toàn `nhay`, `tre-em`, `nganh` mở câu PL của chúng. S dùng dòng của hồ sơ nền.

| Hồ sơ | Chương bỏ hẳn |
|---|---|
| R | KH GT DT TG CP KN TD VH PL TH RR MR |
| N | GT DT TG KN MR |
| C | TG |
| $ | (không bỏ chương nào) |

## Thứ tự vòng

Thứ tự ưu tiên, không phải khuôn cứng: bỏ câu hồ sơ không có hoặc đã rõ, xếp phần còn lại theo thứ tự này rồi cắt thành vòng ≤ 4 câu. Mỗi câu của hồ sơ có đúng một chỗ ở bảng. Câu cờ mở ra đứng ngay sau câu bật cờ. Chương nhạy cảm (tiền, pháp lý) đứng sau để user đã tin, **trừ hồ sơ S: vòng 2 thành PL12 PL1 PL2 PL3, các câu vòng 2 thường lùi sang vòng 3, các vòng sau lùi một**. Câu phụ thuộc đáp án (vd hoàn tiền chỉ hỏi sau khi biết có thu tiền) dồn sang vòng sau.

| Vòng | Câu | Vì sao đứng đây |
|---|---|---|
| 1 | TQ1 TQ2 TQ9 TG1 | Bật hồ sơ (dùng riêng, nội bộ, mở, có thu tiền) và cờ ngành nhạy cảm; TG1 bỏ khi lời kể đã rõ hoặc hồ sơ R. Sau vòng này báo hồ sơ và số vòng ước tính, giao `researcher` chạy nền |
| 2 | KH1 KH2 KH4 TQ3 | Ai dùng, ai trả, ở đâu; TQ3 (ai đứng tên chủ app) chỉ hồ sơ $ |
| 3 | VD1 VD2 VD3 VD7 | Vấn đề đứng trước giải pháp |
| 4 | GT1 GT2 DT1 DT2 | Giá trị + đối thủ (AI đã tra, user xác nhận; chưa tra xong thì hỏi chương khác trước) |
| 5 | DT3 GT3 GT4 VD5 | |
| 6 | PV1 PV2 PV3 PV4 | Phạm vi sớm để câu sau biết cần hỏi gì |
| 7 | PV8 PV9 PV10 PV5 | **PV9 bật cờ tính năng** (tải file, nội dung người dùng, email/SMS, AI, thanh toán) |
| 8 | KH3 KH6 KH8 KH7 | Vai người dùng, máy dùng, đăng ký |
| 9 | TG3 TG7 TG8 TG9 | DT2 đã tra sẵn để chốt mức tiền |
| 10 | TG11 TG13 CP1 CP3 | |
| 11 | CP4 KN1 KN2 KN6 | |
| 12 | TD1 TD2 TD3 TD5 | |
| 13 | TD4 VD9 KH10 VH1 | |
| 14 | VH2 VH5 VH6 VH7 | |
| 15 | VH8 PL1 PL2 PL4 | Pháp lý gần cuối. Mốc luật tra ngày |
| 16 | PL3 PL6 PL9 PL11 | |
| 17 | PL16 PL17 TH1 TH2 | |
| 18 | TH3 TH4 TH5 TH7 | |
| 19 | TH8 RR1 RR2 RR3 | |
| 20 | RR5 MR1 MR2 UT2 | |
| 21 | UT3 UT4 UT5 UT1 | |
| 22 | UT8 | UT8 là câu cuối của danh sách; vòng bổ sung của bước "tự thử 10 quyết định" (nếu có) đứng sau UT8, trước vòng chốt |

**Researcher giao ngay sau vòng 1** (hồ sơ C, $, S). Tới vòng đối thủ và giá mà chưa tra xong ⇒ hỏi chương khác trước, quay lại sau; tra xong mới đưa DT1, DT2 cho user xác nhận.

## Cờ mở câu

Cờ ghi vào front matter `co` của bản. Cờ chỉ mở câu của chương hồ sơ còn hỏi; riêng cờ an toàn `nhay`, `tre-em`, `nganh` luôn mở câu PL của chúng.

| Cờ | Bật khi | Mở câu |
|---|---|---|
| tien | TG1 ≠ miễn phí hoặc PV9 có thanh toán | mọi câu mang `$` (TQ3 KH2 DT2 TG3 TG7 TG8 TG9 TG11 TG13 CP3 CP4 TD3 PL9 PL11 TH8 RR5) |
| thu-dich-vu | TG1 = thu tiền dịch vụ hoặc hàng của mình (cọc, đặt chỗ, bán hàng) | không mở câu mới; TG3 viết thành mức cọc/giá dịch vụ, DT2 tra mức cọc và chính sách các nơi cùng ngành; **không mở** câu theo khuôn bán phần mềm |
| ban-app | TG1 = thu tiền người dùng app (thuê bao, gói, trả theo lượt) | TG4 TG5 TG6 TG10 DT6 CP5 UT6 |
| dlcn | PL1 ≠ không lưu gì | PL5 PL7 PL18 |
| nhay | PL2 có | PL3 (luôn); RR3 mức cao, VH5 có nhật ký khi hồ sơ còn hỏi chương đó |
| tre-em | PL3 có, KH9 trẻ em, hoặc PL3 "Chưa biết" mà đang có cờ nhay hoặc nganh (giả định an toàn) | TD6 tắt theo dõi, PL3 (tuổi, đồng ý phụ huynh) |
| quoc-te | KH4 ≠ chỉ Việt Nam | TG12 PL8 MR4 UT7 |
| nhieu-vai | KH3 > 1 vai | VH5 VH6 MR2 |
| ugc | PV9 có nội dung người dùng | PL14 RR6 |
| ai | PV9 có AI | PV11 PL13 TG14 |
| gui-thu | PV9 có email/SMS | TG14 TH9 |
| tai-file | PV9 có tải file | PL16 (bản quyền nội dung), bản mẫu `ban-mau-noi-dung` |
| san | PL9 = sàn nhiều người bán | PL10 |
| nganh | TQ9 có hoặc "Chưa biết", hoặc PL12 có | PL12; kéo PL1 PL2 PL3 lên vòng 2; dừng phần chuyên môn (đánh giá, khuyên, quyết định), vẫn làm phần ghi, nhắc, gửi |
| may-tinh, extension | loại app | CP2 (ký số, store), PV8, RR4 (chính sách store) |

## Câu mở và câu đóng chương

| Chương | Câu mở (cổng) | Bỏ cả chương khi | Câu đóng |
|---|---|---|---|
| TG | TG1 | Miễn phí hẳn (user nói "có thể thu sau" thì giữ riêng TG13 để chừa chỗ, hồ sơ vẫn C) | "Còn điều gì về tiền chưa nói?" |
| CP | CP1 | Hồ sơ R (mặc định 0 đồng, app chạy trên máy) | CP4 |
| KN | KN1 | Hồ sơ R, N | "Ngoài các nơi đã nói, còn nơi nào tìm khách?" |
| TD | TD1 | Hồ sơ R, N (giữ TD5) | TD2 |
| PL | PL1 | "Không lưu gì của ai ngoài tôi" ⇒ bỏ PL2 đến PL11, PL18; vẫn giữ PL12 PL16 | PL17 |
| VH | VH2 | Hồ sơ R | VH8 |
| RR | RR1 | Hồ sơ R | RR2 |
| MR | MR1 | Hồ sơ R, N | MR2 |

Chương nhạy cảm (TG, PL, RR) kết bằng một câu mở: "Còn điều gì tôi chưa hỏi mà bạn nghĩ cần nói?". Câu trả lời mở ra chuyện mới ⇒ đào sâu ngay, dù không có trong danh sách.

## Đường nhanh

Bật khi (1) user "Chưa biết" **ba câu liên tiếp**, hoặc (2) câu **không ⭐** vượt số vòng ước tính (khi đó chỉ gom câu không ⭐). **Đếm "Chưa biết" theo câu, không theo vòng**; về 0 khi có một câu trả lời thật **và ngay sau khi đường nhanh bật**; câu của đường nhanh không tính vào bộ đếm.

Cách làm: chọn **chương của câu "Chưa biết" thứ ba** (chương còn nhiều câu không ⭐ nhất khi vượt ước tính); vòng trộn nhiều chương thì chỉ soạn chương đó, chương khác hỏi bình thường. AI soạn **đề xuất riêng cho đúng app** cho các điều còn lại của chương, **gồm cả câu ⭐**, từ lời kể, câu đã trả lời và dữ liệu đã tra. Rồi hỏi tối đa 4 câu xác nhận mỗi vòng, **mỗi câu một điều chính**: đáp án 1 "Tôi đề xuất: …" (kèm lý do) · đáp án 2 "Sửa lại" (gõ ô tự gõ) · "Chưa biết" = giữ đề xuất, ghi giả định. Điều ⭐ được gật ghi `[AI đề xuất, bạn gật]`; điều "Chưa biết" hoặc không ⭐ chưa gật ghi `[AI đoán]` (giả định). **Chương hết điều thì sang chương kế theo bảng thứ tự vòng** (bộ đếm đã về 0, đếm lại).

"Chưa biết" không bị gặng: lấy phương án AI suy riêng cho app (kèm lý do), đánh `(giả định)`, ghi vào Giả định kèm hạn và cách kiểm rẻ nhất (nhắn 5 khách, trang đăng ký chờ…); chỉ khi không có căn cứ riêng mới lấy cột Mặc định.

## Cặp mâu thuẫn

Rà trước vòng chốt; mỗi cặp hỏi lại **một** câu, nói thẳng chỗ vênh, đưa 2–3 hướng gỡ.

| Cặp | Chỗ vênh | Hướng gỡ thường gặp |
|---|---|---|
| TG1 miễn phí mãi + CP1 ngân sách 0 + PV9 dùng AI nhiều | AI tốn tiền theo lượt, không ai trả | Giới hạn lượt theo người · gói trả phí cho phần AI · bỏ AI bản đầu |
| KH5 khách lớn tuổi + toàn bộ qua chatbot | Khách khó tự dùng | Thêm đường gọi/nhắn người thật · bỏ chatbot ở bước chính |
| TD3 doanh thu mục tiêu lớn + TQ3 chưa có pháp nhân + TG1 thu tiền | Nhận tiền và hoá đơn cần người đứng tên | Lập hộ kinh doanh/công ty trước · giữ quy mô nhỏ ở bản đầu (hỏi kế toán) |
| PL2 lưu dữ liệu nhạy cảm + CP1 không ngân sách bảo mật + VH2 không ai trực | Dữ liệu nhạy cảm cần người canh | Lưu ít hơn · thuê người · hoãn tính năng đó |
| VH2 không ai biết kỹ thuật + phải tự chạy máy chủ | Không ai vá, sao lưu | Chỉ dịch vụ có người vận hành hộ |
| UT1 "ra nhanh và rẻ" + cờ nhay, nganh hoặc tre-em | Dữ liệu nhạy cảm cần khoá quyền ở DB (gói Chắc) | Giữ Chắc cho an toàn, nói rõ vượt trần bao nhiêu · giảm dữ liệu nhạy cảm lưu · hoãn tính năng đó |
| KH4 chỉ Việt Nam + TG7 chỉ thẻ quốc tế | Khách Việt hay trả chuyển khoản/ví | Thêm VietQR hoặc đổi nhóm khách |
| TQ2 = dùng riêng nhưng PV9 có thanh toán, nội dung người dùng hoặc lưu dữ liệu người khác | Không còn là dùng riêng | Đổi hồ sơ (N, C hoặc $) và hỏi thêm câu của hồ sơ đó |
| CP1 trần thấp + tính năng tốn tiền theo lượt trong PV1 (nhắc qua SMS nhiều lần, AI) | Chi phí thật vượt trần | Đổi kênh rẻ hơn · giảm số lần · nâng trần |
| Điều tính năng lõi cần (TQ1, PV1) + điều PV3 loại ra | Hai câu trả lời không cùng đúng | Nêu thẳng chỗ vênh, hỏi giữ điều nào |

Rà theo **mẫu chung** chứ không chỉ theo bảng: hai câu trả lời không cùng đúng được ⇒ hỏi lại một câu.

## 10 quyết định thử

Trước khi đóng buổi, lấy 10 quyết định dưới đây (bỏ cái không hợp app, thay bằng quyết định hay gặp của đúng app) và kiểm bản trả lời được **không cần hỏi lại**. Câu nào chưa trả lời được ⇒ hoặc thêm câu hỏi ở vòng bổ sung, hoặc ghi mặc định + giả định. Đây là cách phủ "mọi điều hợp hồ sơ đã có trả lời hoặc giả định ghi rõ".

| # | Quyết định thử | Bản phải có | AI tự suy nếu thiếu (ghi `AI suy từ …`) |
|---|---|---|---|
| 1 | Tin nhắc gửi lúc mấy giờ | KH6 KH7 TH8 KN6, cộng giờ hẹn hoặc hạn của việc cần nhắc | Nhắc theo giờ của việc: trước giờ hẹn một khoảng hợp lý, không nhắc đêm (22:00 đến 07:00); việc không có giờ thì buổi sáng giờ Việt Nam |
| 2 | Gói miễn phí giới hạn thế nào | TG4 TG5 CP1 TG14 | Giới hạn theo lượt tốn tiền nhất, báo khi tới 80% |
| 3 | Khách quên mật khẩu thì sao | KH8 KH5 PL1 | Liên kết qua email; không SMS khi ngân sách thấp |
| 4 | Khách xin xoá tài khoản | VH8 PL7 | Xoá sau 30 ngày, giữ hoá đơn |
| 5 | Câu báo lỗi, nút, thông báo viết giọng nào, xưng hô gì | TH3 TH4 TH5 | Theo giọng/xưng hô đã chọn; không dùng từ cấm |
| 6 | Mất mạng giữa chừng thì sao | PV8 KH6 | Không offline, báo "chưa lưu được", giữ lại việc đang làm |
| 7 | Ai thấy dữ liệu của ai, admin có xem được không | KH3 VH5 | Chỉ chủ dữ liệu; admin không xem nội dung riêng |
| 8 | Đổi giá, khuyến mãi, điều khoản sau khi đã chạy thật | UT8 TG3 | User chọn "đổi giá" ở UT8 ⇒ hỏi; không thì chuẩn bị bản sửa, chưa đưa lên mạng (cổng đưa lên mạng luôn hỏi) |
| 9 | Chi phí vượt trần thì ngừng gì | CP1 CP3 | Ngừng tính năng tốn tiền, báo chủ |
| 10 | Trễ hạn thì cắt gì, hoãn gì | UT1 PV3 PV4 | Cắt theo luật đánh đổi, không cắt thứ khó sửa sau; báo user |

## Ranh giới tự quyết

**Bốn việc kit luôn hỏi: tiêu tiền thật, xoá dữ liệu, gửi gì ra ngoài cho khách, đưa app lên mạng (gồm gộp bản). Cố định, không ai tắt được, không nằm trong đáp án UT8.** UT8 chỉ hỏi việc muốn AI hỏi **thêm** (chọn nhiều: đổi giá hoặc khuyến mãi · đổi chữ hiện cho khách · thêm tính năng ngoài phạm vi; việc khác gõ ô tự gõ); bỏ trống hoặc "Chưa biết" = không thêm, khuyên dùng. Bản ghi: "bốn cổng luôn hỏi + việc chọn ở UT8; còn lại AI tự suy". Dùng chung mọi skill đọc bản. Sau khi bản đã duyệt, AI **không hỏi câu business** [kis5]: chỉ dừng ở bốn cổng và việc đã chọn thêm ở UT8, ngay lúc hành động thật.

| Loại việc | AI tự suy? | Cách |
|---|---|---|
| Chữ giao diện, giọng, xưng hô, câu báo lỗi | Có | Theo TH |
| Chọn dịch vụ kỹ thuật theo ngân sách/quy mô, hạn mức, chống spam | Có | Theo CP, TD5, UT1; nói lý do bằng tác động lên người dùng và tiền |
| Hoãn hay cắt phạm vi khi trễ | Có, **báo user** | Theo UT1, PV3 |
| Thêm tính năng ngoài PV1 (AI tự nghĩ ra) | **Không làm** | Ghi `docs/IDEAS.md`, kể cuối việc; không hỏi (user đã chọn "thêm tính năng ngoài phạm vi" ở UT8 ⇒ hỏi) |
| Giá, gói, hoàn tiền, thuế/hoá đơn bản chưa nói | Có, ghi giả định | Suy từ chương TG + mức đã tra, ghi `(AI suy từ B-xx)`, kể cuối việc, nhắc "hỏi kế toán" với thuế; chưa gì lên mạng thật khi chưa qua cổng phát hành |
| Dữ liệu nhạy cảm, trẻ em, ngành có điều kiện mới xuất hiện | **Không tự làm phần chuyên môn** (đánh giá, khuyên, quyết định) | Vẫn làm phần ghi, nhắc, gửi dữ liệu do người dùng tự nhập; ghi Câu hỏi mở "cần người có chuyên môn", kể cuối việc |
| Tiêu tiền thật · xoá dữ liệu · gửi ra ngoài cho khách · đưa app lên mạng | **Luôn hỏi, cố định** (không nằm trong UT8, không ai tắt được) | Hỏi lúc hành động thật (không phải câu business) |
| Việc user chọn thêm ở UT8 | **PHẢI hỏi** | Hỏi lúc hành động thật |
| Mọi việc khác | Có | Ghi `(AI suy)` |

Thứ tự tra khi bản chưa nói: `BUSINESS.md`/`STACK.md` ⇒ sổ chốt ⇒ suy theo hồ sơ + cờ + luật đánh đổi (UT1) ⇒ mặc định phổ biến + giả định. **Mặc định thua điều user đã nói** (mức [Bạn nói]). Bản mâu thuẫn với suy luận của AI ⇒ bản thắng, nói ra.

## Lỗi hay gặp

| Lỗi | Xấu ⇒ tốt |
|---|---|
| Câu dẫn dắt | "Bạn nghĩ app giúp tiết kiệm thời gian đúng không?" ⇒ "Lần gần nhất bạn làm việc này mất bao lâu?" |
| Hỏi tương lai giả định | "Khách có mua không?" ⇒ "Họ đã từng trả tiền cho cách nào để làm việc này?" |
| Thuật ngữ | "Mô hình doanh thu", "ARPU" ⇒ "Bạn kiếm tiền từ app này bằng cách nào?" |
| Câu kép | "Ai dùng và dùng lúc nào?" ⇒ tách hai câu |
| Đáp án đẹp đứng đầu ở câu sự thật | "Khách sẵn trả tiền: Có" ⇒ đáp án trung lập + "Chưa biết" |
| Tin lời khen "ai cũng cần" | Hỏi họ đã làm gì; ghi `[AI đoán]` |
| Hỏi giải pháp thay vì vấn đề | "Bạn muốn tính năng gì?" ⇒ "Kể lần gần nhất họ gặp khó" |
| AI bịa chuyện để user gật | Câu kể sự việc (VD1) không có đáp án nháp; user kể |
| Gặng khi user không biết | Lấy mặc định, ghi giả định, đi tiếp |
| Hỏi cái AI tra được | "Đối thủ giá bao nhiêu?" ⇒ AI tra, user xác nhận |
| Bịa số, bịa điều luật | Chỉ ghi điều user nói hoặc điều tra được kèm ngày; còn lại `[CẦN XÁC MINH]` |
| Hỏi pháp lý như tư vấn | "Bạn đã tuân thủ NĐ 356 chưa?" ⇒ "Có lưu CCCD không?" rồi app tự đổi theo |
| Mơ hồ định lượng | "Nhiều người" ⇒ bậc số 10, 100, 1.000, 10.000 |
| Lấy ý của user làm giá | Mức theo nơi cùng ngành đã tra, ghi `(giả định)`; muốn chắc thì hỏi 5–10 khách |
| Hồ sơ nặng cho app nhỏ | 146 câu cho công cụ riêng ⇒ hồ sơ R còn 12 câu |
| Hỏi tiền và pháp lý khi chưa có niềm tin | Đẩy về vòng 9 đến 16 (trừ hồ sơ S) |
| Không ghi lý do, mức chắc, ngày | Mỗi mục `[Bạn nói] 2026-…` kèm "ảnh hưởng tới đâu" |
| Quay lại sửa câu cũ lặng lẽ | Đi đường "đổi ý" ở `SKILL.md`: nói, làm, ghi nhật ký |

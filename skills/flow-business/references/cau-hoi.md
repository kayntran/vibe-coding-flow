# Danh sách điều cần biết — 146 điều, 16 chương

Đây là **mục tiêu phủ**, không phải kịch bản: AI viết câu và đáp án theo đúng app, bỏ điều đã rõ, hỏi thêm câu đào sâu ngoài bảng. Mã đầy đủ khi ghi vào bản là `B-` + mã (vd `B-TQ2`).

## Mục lục
TQ Tổng quan · KH Khách hàng · VD Vấn đề · GT Giá trị · DT Đối thủ · TG Thu tiền · CP Chi phí · KN Kênh khách · TD Thước đo · PV Phạm vi · VH Vận hành · PL Dữ liệu và pháp lý · TH Thương hiệu và giọng · RR Rủi ro · MR Mở rộng · UT Ưu tiên khi đánh đổi

## Cách đọc bảng
- `⭐` cốt lõi: hồ sơ hoặc cờ đã mở câu đó thì không bao giờ cắt, dù quá ước tính số vòng (đường nhanh vẫn hỏi xác nhận từng điều ⭐). Không ⭐ ⇒ có thể gom vào đường nhanh hoặc lấy giả định, ghi `(giả định)`.
- `⇄ N1…` thay câu cũ của kit (`C1–C6`, `N1–N12` ở `yeu-cau.md`; `ban-mau-*` cùng thư mục `flow-system-design`). Câu đã có đáp án ở đây thì skill sau không hỏi lại.
- **Hỏi khi** (từ khoá đầu ô, phần sau dấu `·` là điều kiện phụ): `R` mọi hồ sơ · `N` từ hồ sơ nội bộ trở lên (N, C, $) · `C` từ hồ sơ mở miễn phí trở lên (C, $) · `$` chỉ hồ sơ có thu tiền · `cờ x` chỉ khi cờ x bật, ngoài hồ sơ (bảng cờ ở phần thích ứng) · `mặc định` không hỏi, lấy giả định, trừ khi lời kể hoặc câu đào sâu chạm tới. Hồ sơ nền là danh sách các dòng mang `R`, `N`, `C`, `$`; cờ mở thêm dòng mang `cờ x`, **nhưng chỉ khi chương của câu đó còn hỏi trong hồ sơ**: chương hồ sơ đã bỏ hẳn thì cờ không mở lại (vd CP2 với hồ sơ R, TG14 với hồ sơ C). Ngoại lệ: cờ an toàn `nhay`, `tre-em`, `nganh` luôn mở câu PL của chúng.
- **Lời kể đã rõ thì không hỏi** (vd lời kể nói "miễn phí" thì bỏ TG1; "khách chuyển khoản tiền cọc" thì bỏ TG1 và TG7): điền sẵn mức "Bạn nói", xác nhận một dòng ở bản tóm tắt.
- **Kiểu:** `QĐ` quyết định ("bạn chọn gì") ⇒ đáp án khuyên dùng đứng đầu + lý do đời thường · `ST` sự thật hoặc hoàn cảnh của user ("đã có ai trả tiền chưa") ⇒ đáp án trung lập, không đáp án đẹp đứng đầu · `TD` tả tự do ⇒ đáp án 1 là bản nháp AI viết từ ngữ cảnh, đáp án 2 "Sửa lại".
- **Hộp hỏi nhận 2 đến 4 đáp án** (ô tự gõ có sẵn). Câu chọn một: tối đa **3 đáp án thật**, ô thứ 4 là "Chưa biết". Câu `(chọn nhiều)`: tối đa 4 đáp án, không cần "Chưa biết" (bỏ trống = mặc định). Nhiều hơn thì gộp nhóm hoặc tách thành hai câu (dấu `//` trong cột Đáp án = hai câu). Điều không vừa hộp thì để ô tự gõ.
- **"Chưa biết" ⇒ lấy phương án AI suy riêng cho đúng app** (từ lời kể và câu đã trả lời, kèm lý do, ghi `(giả định)`); cột Mặc định chỉ dùng khi không có căn cứ riêng. Cả hai là giả định của AI, không phải điều user đã nói, và thua điều user đã nói. Số ghi `(kit)` lấy từ `yeu-cau.md`/`ban-mau-*`.
- Cột "Câu hỏi" là ý để AI hiểu, không đọc nguyên văn: viết lại theo ngành, khách, tên gọi của app, mỗi câu một ý (ý phụ ghi ở "Quyết định trong app" sau chữ "Đào sâu", hỏi khi cần). Không dùng thuật ngữ (SaaS, freemium, ARPU…).

## 1. Tổng quan và bối cảnh (TQ)

| # | Câu hỏi (đời thường) | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| TQ1 ⭐ | Kể một câu: app này giúp ai làm được việc gì? | Tên, mô tả trên trang đầu/store, mọi chữ AI viết về sau | (tả tự do; AI nháp sẵn từ ý ban đầu cho bạn sửa) | Không có, bắt buộc | R | TD |
| TQ2 ⭐ | App này để ai dùng? | **Hồ sơ buổi hỏi**, mức chống spam, có cần trang giới thiệu/hỗ trợ không. Có thu tiền hay không do TG1 lo | Mình hoặc gia đình tôi · Nhóm hoặc công ty tôi · Người ngoài (khách, cộng đồng) | Không đoán, bắt buộc | R | ST |
| TQ3 ⭐ | Ai đứng tên làm chủ app? | Tên chủ trong điều khoản/chính sách/hoá đơn, cách nhận tiền, quyền sở hữu tài khoản dịch vụ. Đào sâu: có đối tác chia không (TQ6) | Cá nhân · Hộ kinh doanh hoặc công ty · Chưa có | Cá nhân, một mình `(giả định)` | $ | ST |
| TQ4 | Đang ở đâu: mới có ý tưởng, đã có bản thử, hay đã có khách? | Có dữ liệu cũ cần mang sang không; mức tin của các câu sau | Mới có ý tưởng · Đã có bản thử · Đã có khách hoặc làm lại app cũ | Mới có ý tưởng | mặc định | ST |
| TQ5 | Bạn muốn app đưa bạn tới đâu? | Mức đầu tư vào độ chắc, mức chấp nhận làm tạm | Chỉ để dùng · Thu nhập phụ hoặc nghề chính · Học hoặc làm mẫu | Hồ sơ R ⇒ chỉ để dùng; C ⇒ thu nhập phụ | mặc định | ST |
| TQ6 | Nếu có người khác cũng quyết (đối tác, sếp, khách đặt hàng), ai chốt cuối? | Ai duyệt SPEC/giao diện, ai nhận báo cáo | Chỉ mình tôi · Tôi và đối tác · Người khác (tên) | Chỉ tôi | mặc định · hỏi nếu TQ3 có đối tác | ST |
| TQ7 | Mỗi tuần bạn dành được bao nhiêu giờ cho app, trong bao lâu? | Cắt phạm vi cho vừa sức, thứ tự việc | Dưới 5 giờ · 5–20 giờ · Toàn thời gian | 5–10 giờ/tuần `(giả định)` | mặc định | ST |
| TQ8 | Vì sao là lúc này? | Độ gấp, thứ tự ưu tiên. Đào sâu: có chuyện gì thúc bạn bắt đầu | (tả) | Bỏ trống | mặc định | TD |
| TQ9 ⭐ | App có đụng tới sức khoẻ, tiền của người khác, trẻ em, giáo dục, tuyển dụng hay ngành cần giấy phép không? | **Cờ ngành nhạy cảm**: có hoặc "Chưa biết" (= không chắc) ⇒ hỏi PL12 SỚM, vì có thể đổi cả hướng đi | Không · Có (ghi nhóm ở ô tự gõ) | Chưa biết ⇒ coi là không chắc ⇒ hỏi lại ở PL12 | R | ST |

## 2. Khách hàng và người dùng (KH)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| KH1 ⭐ | Hình dung MỘT người dùng chính bạn từng gặp: làm nghề gì, tuổi, ở đâu? | Giọng chữ, độ đơn giản, cỡ chữ, ngôn ngữ; dòng "Ai dùng" của `flow-ux` | (tả) kèm "đã gặp thật" hoặc "hình dung" | AI đoán từ TQ1 `(AI đoán)` | C | TD |
| KH2 ⭐ | Người trả tiền có phải người dùng không? | Hai loại màn (mua vs dùng), hoá đơn công ty, bước duyệt mua | Cùng người · Công ty trả, nhân viên dùng · Người khác trả (phụ huynh, quảng cáo) | Cùng người | $ | ST |
| KH3 ⭐ ⇄ C1, C3 | Trong app có mấy loại người dùng (khách, chủ cửa hàng, nhân viên, quản trị)? | Bảng vai–quyền, trang quản trị, **tách dữ liệu theo công ty (khó sửa sau)**. Đào sâu: ai xem/sửa dữ liệu của ai | Một loại, hoặc khách + quản trị là tôi · Nhiều loại trong cùng một nơi (chủ, nhân viên) · Nhiều công ty, mỗi nơi chỉ thấy dữ liệu của mình | Khách + quản trị là tôi | N | QĐ |
| KH4 ⭐ ⇄ N11 | Khách chủ yếu ở nước nào? | Ngôn ngữ giao diện, múi giờ, tiền tệ, cổng thanh toán, luật nước ngoài. Đào sâu: nói tiếng gì | Chỉ Việt Nam · Việt Nam + vài nước · Quốc tế | Việt Nam là chính | C | ST |
| KH5 | Khách quen dùng công nghệ cỡ nào? | Độ đơn giản, hướng dẫn, chữ to, số bước | Ít (người lớn tuổi) · Vừa · Rành | Vừa | mặc định | ST |
| KH6 ⭐ ⇄ flow-ux | Họ chủ yếu dùng app bằng máy gì, ở đâu? | Ưu tiên điện thoại hay máy bàn, nhớ đăng nhập, offline, thông báo. Đào sâu: vào lúc nào | Điện thoại ngoài đường · Máy tính văn phòng · Cả hai | Cả hai, ưu tiên điện thoại | N | ST |
| KH7 | Bao lâu họ mở app một lần? | Giữ chân hay dùng một lần; nhớ đăng nhập; nhắc việc | Hằng ngày · Hằng tuần · Thỉnh thoảng hoặc một lần | Hằng tuần | C | ST |
| KH8 ⭐ ⇄ ban-mau-tai-khoan | Khách có phải đăng ký tài khoản mới dùng được không? | Đăng nhập, xác minh email, dữ liệu khách chưa đăng nhập | Dùng ngay, không cần tài khoản · Xem ngay, đăng ký khi lưu hoặc mua · Bắt đăng ký hoặc chỉ người được mời | Xem ngay, đăng ký khi cần (kit) | N | QĐ |
| KH9 | Có nhóm người KHÔNG được dùng (dưới tuổi nào, nước nào, đối thủ cạnh tranh)? | Chặn tuổi/vùng, điều khoản | Không · Trẻ em · Nước (tên) | Không | mặc định | QĐ |
| KH10 | Bạn đã nói chuyện với bao nhiêu người thuộc nhóm này (không tính bạn bè khen)? | Mức tin: "Bạn nói" hay "AI đoán"; có nên thử trước khi làm lớn | Chưa ai · Dưới 5 người · Từ 5 người trở lên, hoặc họ đã là khách | Chưa ai `(AI đoán)` | C | ST |

## 3. Vấn đề và cách đang làm (VD)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| VD1 ⭐ | Kể lần gần nhất họ (hoặc bạn) gặp khó: chuyện gì xảy ra, họ làm gì? (kể sự việc, không phải ý kiến) | Nhu cầu thật, tình huống mẫu cho UX. Không có đáp án nháp của AI: AI không bịa chuyện để user gật | Tôi đã chứng kiến, sẽ kể ở ô tự gõ · Chỉ nghe kể lại | Không | C | ST |
| VD2 ⭐ ⇄ flow-ux | Hiện giờ họ làm việc này bằng cách nào? | Nhập dữ liệu cũ, giao diện quen thuộc, "đối thủ thật" (thường là Excel/Zalo) | Sổ giấy hoặc Excel · Zalo/Facebook · App khác (ghi tên) | Excel/Zalo `(AI đoán)` | R | ST |
| VD3 | Cách cũ tệ ở chỗ nào? | Điều app phải hơn rõ rệt; thông điệp | Chậm hoặc tốn công · Dễ sai hoặc mất dữ liệu · Tốn tiền hoặc khó chia sẻ | Chậm + dễ sai `(AI đoán)` | C | ST |
| VD4 | Chuyện này xảy ra thường không? | Có đủ lý do để mở app; nhắc việc | Hằng ngày · Hằng tuần · Hằng tháng hoặc ít hơn | Hằng tuần | mặc định | ST |
| VD5 | Điều gì thúc họ chịu tìm cách mới (cuối tháng chốt sổ, mất dữ liệu…)? | Thời điểm và nơi thấy app; thông điệp | (tả) | Không rõ | C | TD |
| VD6 | Điều gì khiến họ ngại đổi sang app mới? | Nhập dữ liệu cũ, hướng dẫn, dùng thử, cam kết xuất lại dữ liệu | Mất dữ liệu cũ hoặc phải học lại · Sợ lộ thông tin · Giá | Mất dữ liệu cũ + học lại | mặc định | ST |
| VD7 ⭐ ⇄ C2, flow-spec | Mở app ra, họ muốn xong việc gì? | Việc chính, tiêu chí đạt, test chấp nhận. Đào sâu ngay sau: làm xong mà thấy gì thì bạn nói "sai ý rồi"? (thành tiêu chí đạt) | (tả 1 việc) | Lấy từ TQ1 | R | TD |
| VD8 | Họ từng thử công cụ khác rồi bỏ chưa? | Điểm yếu đối thủ cần tránh. Đào sâu: vì sao bỏ | Chưa thử · Bỏ vì đắt hoặc thiếu tính năng · Bỏ vì khó dùng | Chưa biết | mặc định | ST |
| VD9 | Ngoài người thân khen, có bằng chứng nào nhiều người cần việc này (họ đã tốn tiền hoặc thời gian cho nó)? | Mức rủi ro "chưa ai cần"; có nên làm trang đăng ký chờ trước | Đã có người trả tiền cho cách cũ · Họ tự tìm công cụ · Chỉ nghe nói | Chỉ nghe nói `(AI đoán)` | C | ST |

## 4. Giá trị và khác biệt (GT)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| GT1 ⭐ | Nếu app chỉ làm được MỘT việc thật giỏi, đó là việc gì? | Việc chính, màn đầu, thứ tự trên màn | AI nháp từ VD7 · Sửa lại | = VD7 | C | QĐ |
| GT2 ⭐ | Vì sao họ chọn app này thay cách cũ? (một câu) | Điểm nhấn UI, thông điệp, mô tả trên store | Nhanh hơn hoặc dễ hơn · Rẻ hơn · Hợp người Việt (tiếng Việt, VietQR, Zalo) | Dễ hơn `(AI đoán)` | C | ST |
| GT3 | Có kết quả/con số cụ thể nào bạn hứa với khách (tiết kiệm mấy giờ, mấy đồng)? | Thước đo thành công, chữ onboarding | Tiết kiệm X giờ/tuần · Giảm X% sai sót · Không hứa số | Không hứa số | C | QĐ |
| GT4 | Lúc nào khách thấy "à, được rồi" lần đầu: phút đầu, sau việc đầu tiên, sau một tuần? | Onboarding ngắn nhất tới lúc đó; màn trống; sự kiện "kích hoạt" | Trong vài phút · Sau khi nhập dữ liệu đầu · Sau 1 tuần | Trong vài phút | C | ST |
| GT5 | Có thứ gì đối thủ khó chép (dữ liệu riêng, quan hệ khách, chuyên môn ngành, tốc độ, giá)? | Có nên đầu tư thứ làm "hào" (dữ liệu, cộng đồng) | Chuyên môn hoặc dữ liệu riêng · Cộng đồng sẵn · Chưa có | Chưa có (thật thà) | mặc định | ST |

## 5. Đối thủ và lựa chọn thay thế (DT)

AI **tra sẵn trước** (agent `researcher`), user chỉ xác nhận hoặc sửa, không bắt kể từ đầu.

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| DT1 ⭐ | Khách đang dùng thay thế bằng những gì (kể cả Excel, Zalo)? AI đã liệt kê 2–4 mục, bạn gật hoặc sửa | Ứng dụng tham khảo (`flow-ux` 5b), điểm khác, nhập dữ liệu cũ | Đúng như danh sách · Thiếu thứ khác · Có thứ sai | AI tra, ghi ngày | C | ST |
| DT2 | Đối thủ gần nhất thu bao nhiêu? (AI tra, bạn xác nhận) | Khung giá TG3. Đào sâu: có gói miễn phí không. App thu tiền dịch vụ (cọc, đặt chỗ) thì AI tra mức cọc và chính sách của các nơi cùng ngành, không tra giá app | Đúng như AI tra · Có chỗ sai | AI tra, ghi ngày | $ | ST |
| DT3 | Tính năng nào ai cũng có mà bạn bắt buộc phải có (không có khách bỏ)? | Phần "phải có" trong bản đầu | Đăng nhập Google · Xuất Excel · App điện thoại | AI đoán từ DT1 | C | QĐ |
| DT4 | Họ dở ở đâu mà bạn muốn làm hơn? | Điểm nhấn khác biệt | (tả) | Lấy từ VD8 | mặc định | TD |
| DT5 | Có đối thủ Việt Nam, hoặc app nước ngoài đã dịch tiếng Việt chưa? | Ngôn ngữ, VietQR/ví nội địa, luật | Có · Chưa thấy | AI tra | mặc định | ST |
| DT6 | Nếu công ty lớn (Google, Zalo, Shopee) thêm tính năng này thì bạn còn gì? | Rủi ro, hướng ngách | Còn cộng đồng hoặc ngành · Không còn · Chưa nghĩ | Chưa nghĩ | cờ ban-app | ST |

## 6. Thu tiền và giá (TG)

TG1 là **câu cổng**, hỏi ở vòng 1 cùng TQ1 TQ2 TQ9 (bỏ khi lời kể đã rõ có hay không thu tiền; hồ sơ R không hỏi). Giá cụ thể: AI tra lúc hỏi (DT2), không ghi cứng. Cách thu (cổng nào, skill nào) thuộc buổi công nghệ (`flow-stack`), ở đây chỉ hỏi hoàn cảnh. **Hai kiểu thu khác nhau**: thu tiền dịch vụ hoặc hàng của mình qua app (cọc, đặt chỗ, bán hàng; cờ `thu-dich-vu`) và thu tiền người dùng chính app (thuê bao, gói, trả theo lượt; cờ `ban-app`). Câu theo khuôn bán phần mềm (gói, dùng thử, gia hạn, đối thủ lớn, tự nuôi mình) chỉ mở khi `ban-app`.

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| TG1 ⭐ | App có thu tiền không, theo kiểu nào? | Có hay không có code thanh toán, gói, màn giá, hoá đơn; cờ `tien`, `thu-dich-vu`, `ban-app`; hồ sơ $. Cả hai kiểu thì gõ ở ô tự gõ | Miễn phí hẳn · Thu tiền dịch vụ hoặc hàng của mình qua app (cọc, đặt chỗ, bán hàng) · Thu tiền người dùng app (thuê bao, gói, trả theo lượt) | Miễn phí giai đoạn đầu, **chừa chỗ** để thêm sau `(giả định)` | N · câu cổng, vòng 1 | ST |
| TG3 ⭐ | Mức tiền khách trả qua app (cọc, giá, gói) khoảng bao nhiêu? | Bảng giá, tiền tệ, bậc gói. Đào sâu: dựa vào đâu. Thu dịch vụ: mức cọc theo nơi cùng ngành đã tra; bán app: khung giá theo đối thủ đã tra | Theo mức AI đã tra, tôi xác nhận · Con số riêng của tôi | AI đề xuất khung theo DT2 `(giả định)`; không lấy ý riêng của user làm giá | $ | QĐ |
| TG4 ⇄ ban-mau-tien | Có gói miễn phí hay dùng thử không, giới hạn ở đâu? | Giới hạn gói, quyền theo gói, rào chống lạm dụng. Đào sâu: dùng thử có bắt nhập thẻ | Miễn phí mãi có giới hạn · Dùng thử 7–14 ngày · Không có | Dùng thử không thẻ (kit) | cờ ban-app | QĐ |
| TG5 | Các gói khác nhau ở 1–2 điểm nào? | Cấu hình gói | Số lượt dùng · Số người hoặc số dự án · Tính năng khác nhau | 1 điểm | cờ ban-app | QĐ |
| TG6 | Trả theo tháng, năm hay một lần? | Chu kỳ, gia hạn, huỷ. Đào sâu: năm có rẻ hơn không | Tháng + năm rẻ hơn · Chỉ tháng · Một lần | Tháng + năm rẻ hơn | cờ ban-app | QĐ |
| TG7 ⭐ | Khách trả bằng cách nào? | Chọn cổng, đối soát tự động hay tay. **Extension Chrome: cửa hàng không thu tiền hộ ⇒ phải qua web riêng** | Chuyển khoản hoặc quét VietQR · Ví hoặc thẻ (MoMo, ZaloPay, thẻ quốc tế) · Tiền mặt, tôi tự xác nhận | VietQR/chuyển khoản; thẻ quốc tế qua cổng "bán hộ" | $ | ST |
| TG8 ⭐ | Tiền về tài khoản nào: của bạn (cá nhân), của công ty, hay qua cổng "bán hộ" lo cả thuế? | Cổng nào chọn được, hoá đơn, thuế; có cần tài khoản đứng tên pháp nhân | Cá nhân · Công ty · Cổng bán hộ | Tài khoản của chủ app (TQ3) | $ | ST |
| TG9 ⇄ ban-mau-tien | Khách muốn huỷ hoặc hoàn tiền thì sao (bao nhiêu ngày, ai quyết)? | Chính sách đổi trả/huỷ cọc, nút huỷ, hoàn tiền (SePay chỉ báo tiền vào: hoàn là việc của chủ, xem mảng thu tiền ở buổi công nghệ) | Hoàn nếu huỷ sớm (ghi rõ hạn) · Không hoàn · Từng ca tôi quyết | 14 ngày với gói, 24 giờ với cọc, ghi rõ trên trang mua (kit) | $ | QĐ |
| TG10 ⇄ ban-mau-tien | Gia hạn thất bại (thẻ hết hạn) thì khách còn dùng được bao lâu? | Thời gian ân hạn, nhắc đổi thẻ, hạ gói | 3 ngày · 7 ngày · Ngưng ngay | 7 ngày rồi về miễn phí, không xoá dữ liệu (kit) | cờ ban-app | QĐ |
| TG11 | Khách (doanh nghiệp) có cần hoá đơn VAT hoặc hoá đơn điện tử không? | Ô mã số thuế/địa chỉ khi mua, nhà cung cấp hoá đơn, trang lịch sử hoá đơn. Đào sâu: ai xuất. Luật: tra ngày | Không · Có, tôi xuất tay · Có, tự động qua nhà cung cấp | Chừa chỗ, mặc định không; ghi "hỏi kế toán" | $ · khi khách là doanh nghiệp | ST |
| TG12 | Khách nước ngoài: ai lo thuế bán hàng/VAT của nước họ? | Cổng "bán hộ" lo thay hay tự khai | Cổng bán hộ · Tự lo · Chưa biết | Cổng bán hộ (kit); ghi "hỏi kế toán" | cờ quoc-te | QĐ |
| TG13 | Khi nào bắt đầu thu: ngay bản đầu hay sau khi có người dùng thật? | Có code thanh toán ở bản đầu không | Ngay · Sau khi có người dùng · Chưa quyết | Sau khi có người dùng, nhưng chừa chỗ | $ | QĐ |
| TG14 ⇄ ban-mau-ai | Nếu app dùng AI/SMS/email tốn tiền theo lượt: ai chịu, mỗi người miễn phí bao nhiêu lượt? | Hạn mức lượt/người, trần chi | Tính trong giá · Bán lượt thêm · Mình chịu có trần | Mình chịu, trần theo người (kit) | cờ ai, gui-thu | QĐ |

## 7. Chi phí và ngân sách (CP)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| CP1 ⭐ ⇄ N7 | Mỗi tháng chịu chi tối đa bao nhiêu cho máy chủ và dịch vụ? | **Trần chi mỗi tháng**: chọn gói nền (Nhẹ hay Chắc), gói miễn phí hay trả phí, báo động khi chạm 80%. Đào sâu: riêng AI/SMS/email bao nhiêu. Hồ sơ R không hỏi: mặc định 0 đồng, app chạy trên máy | 0 đồng · Dưới 500 nghìn · Từ 500 nghìn trở lên | Gói miễn phí rồi gói trả phí thấp nhất `(giả định)` | N | ST |
| CP2 | Ngân sách một lần (tên miền, chứng chỉ ký app, tài khoản store, tư vấn kế toán/luật)? | Tên miền, có ký số app Windows không, tài khoản store | 0 · Dưới 5 triệu · Từ 5 triệu trở lên | Chỉ tên miền | cờ may-tinh, extension | ST |
| CP3 | Khi chi phí vượt trần thì làm gì? | Cơ chế ngắt, báo cho ai | Ngừng tính năng tốn tiền + báo tôi · Chỉ báo · Tôi tự trả thêm | Ngừng tính năng tốn tiền + báo | $ | QĐ |
| CP4 ⭐ | Các tài khoản dịch vụ (tên miền, máy chủ, email, cổng thanh toán) đứng tên ai, trả bằng thẻ của ai? | Rủi ro mất quyền, chuyển giao; tài liệu "chìa khoá ở đâu" | Tên tôi · Tên công ty · Người khác lập hộ | Tên chủ app | $ | ST |
| CP5 | Bao lâu thì app phải tự nuôi mình? | Mức đầu tư, giá | 6 tháng · 1 năm · Không cần | Không cần | cờ ban-app | ST |
| CP6 | Có chi phí cố định đã biết (thuê người, quảng cáo, luật sư)? | Ngân sách thực | (tả) | Không | mặc định | TD |

## 8. Kênh tìm khách và giữ chân (KN)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| KN1 ⭐ | 10 khách đầu tiên là ai? Nêu tên hoặc nơi họ tụ tập (nhóm Zalo/Facebook, cửa hàng, lớp…) | Cách mời người thật, link chia sẻ, có cần trang đăng ký chờ | Có danh sách · Biết nhóm (tên) · Chưa biết | Chưa biết ⇒ ghi vào Rủi ro (rủi ro lớn nhất của nhiều app) | C | ST |
| KN2 ⭐ | Khách sẽ biết đến app từ đâu? | Trang đích, SEO, ảnh chia sẻ (Open Graph), mô tả store, theo dõi nguồn. Cần Google hoặc chia sẻ link ⇒ loại app `web-public` | Facebook hoặc Zalo · Google · Người quen giới thiệu · Cửa hàng ứng dụng hoặc quảng cáo trả tiền (chọn nhiều) | Giới thiệu + một cộng đồng | C | ST |
| KN3 | Bạn đã có danh sách, cộng đồng hay khách sẵn không, khoảng bao nhiêu? | Quy mô thực (liên quan TD5), gửi thư mời | 0 · Dưới 100 · Từ 100 trở lên | 0 | mặc định | ST |
| KN4 | Có định chạy quảng cáo (Facebook, Google) không? | Mã theo dõi, banner đồng ý, trang đích; luật quảng cáo (PL15). Đào sâu: ngân sách | Không · Có dưới 3 triệu · Có từ 3 triệu | Không | mặc định | QĐ |
| KN5 | Khách có tự giới thiệu cho nhau (làm chung, chia sẻ kết quả, mời đồng nghiệp) không? | Nút mời, link công khai, thưởng giới thiệu | Có sẵn · Cần khuyến khích · Không | Không | mặc định | ST |
| KN6 | Làm sao khách quay lại sau lần đầu (nhắc việc, email, thông báo, thói quen có sẵn)? | Email/thông báo, đồng ý nhận | Nhắc qua email · Thông báo đẩy hoặc Zalo · Tự nhớ | Email nhắc nếu có tài khoản | C | QĐ |
| KN7 | Cần trang giới thiệu, hướng dẫn, blog công khai không? | Trang đích, SEO, nơi viết nội dung | Chỉ 1 trang · Có hướng dẫn · Có blog | 1 trang giới thiệu | mặc định | QĐ |
| KN8 | Có bán/nhúng qua đối tác (Zalo OA, Shopify, đại lý) không? | Tích hợp, API, nhãn riêng | Không · Có (tên) | Không | mặc định | QĐ |
| KN9 | Khách bỏ đi, bạn có muốn biết lý do không? | Ô phản hồi một câu khi huỷ/gỡ | Có · Không | Có, 1 câu | mặc định | QĐ |

## 9. Thước đo và mục tiêu (TD)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| TD1 ⭐ | 3 tháng sau ra mắt, thấy con số nào thì bạn nói "được rồi"? | **Thước đo chính** (sự kiện app phải ghi lại), bảng số cho admin | Số người quay lại mỗi tuần · Số việc hoàn thành · Doanh thu hoặc số người trả phí | Số người quay lại mỗi tuần `(AI đoán)` | C | QĐ |
| TD2 ⭐ | Thấy con số nào thì bạn dừng hoặc đổi hướng? | Tiêu chí dừng; ngày đánh giá | Dưới 10 người dùng sau 3 tháng · Không ai trả tiền · Chi vượt trần | Chưa đặt ⇒ ghi Câu hỏi mở | C | QĐ |
| TD3 | Doanh thu mục tiêu 6 và 12 tháng? | Quy mô, giá, gói; kiểm hoà vốn | Có mục tiêu (ghi con số) · Chưa đặt | Không đặt | $ | ST |
| TD4 | Khách làm điều gì thì coi là "đã nhận giá trị" (kích hoạt)? | Sự kiện kích hoạt, thứ tự onboarding | Tạo xong mục đầu · Mời 1 người · Xuất kết quả | Lấy từ GT4 | C | QĐ |
| TD5 ⭐ ⇄ N1, N2 | Năm đầu, một ngày bình thường khoảng bao nhiêu người mở app? | Hạng quy mô, hạ tầng, chống tải; chọn gói nền ở buổi công nghệ. Đào sâu: con số cụ thể, có dịp bùng (khuyến mãi, cuối tháng) không | Dưới 100 · Từ 100 đến 10.000 · Hơn 10.000 | 1.000/ngày (kit); a thì 1–10, b thì bằng số nhân viên | N | ST |
| TD6 | Được theo dõi hành vi khách (analytics) tới mức nào? | Công cụ phân tích, banner đồng ý, chính sách (PL6). Đào sâu: có gì tuyệt đối không theo dõi | Số liệu ẩn danh · Theo dõi chi tiết · Không | Ẩn danh | cờ tre-em | QĐ |
| TD7 | Ai xem số liệu, bao lâu một lần? | Báo cáo/email tuần cho admin | Tôi xem hằng tuần · Báo cáo email · Không | Tôi xem hằng tuần | mặc định | QĐ |

## 10. Phạm vi bản đầu (PV)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| PV1 ⭐ | Bản đầu cho người thật dùng được phải có đúng những việc nào (3–5 việc)? | **Phạm vi V1** | AI đề xuất từ VD7/GT1 · Sửa lại | AI đề xuất | R | QĐ |
| PV2 ⭐ | Việc nào bạn muốn nhưng để SAU? | Danh sách V2+ (`docs/IDEAS.md`); chừa chỗ nhưng không làm | AI liệt kê phần thừa của PV1 · Sửa lại | AI liệt kê phần thừa của PV1 | N | QĐ |
| PV3 ⭐ ⇄ C6 | Việc nào chắc chắn KHÔNG làm (dễ bị hiểu là có)? | Mục "Không làm" của SPEC | Lấy từ PV2 · Sửa lại | Lấy từ PV2 | R | QĐ |
| PV4 ⭐ ⇄ N9 | Cần ra bản đầu vào ngày nào? | Cắt phạm vi, bản mỏng chạy đầu–cuối trước. Đào sâu: có sự kiện cố định (đợt khuyến mãi, buổi giới thiệu) | Không gấp · Trong 1 tháng · Có ngày cố định | Không gấp | N | ST |
| PV5 | Bản đầu cho ai thử: riêng bạn hoặc vài người quen · nhóm kín · mở công khai? | Mức chống spam, đăng ký mở hay đóng, độ chắc | Riêng tôi hoặc vài người quen · Nhóm kín · Mở công khai | Vài người quen → nhóm kín | N | QĐ |
| PV6 | Làm sao biết bản đầu "xong"? | Tiêu chí đạt `AC-nn` | (tả) | Từ VD7 | mặc định | TD |
| PV7 | Có dữ liệu cũ cần chuyển vào (Excel, app cũ)? | Chức năng nhập (bản mẫu nhập), file mẫu | Không · Excel · App khác | Không | mặc định · hỏi nếu TQ4 ≠ ý tưởng hoặc VD2 có công cụ cũ | ST |
| PV8 ⭐ ⇄ C5 | Có cần dùng khi mất mạng không? | Lưu tại máy, đồng bộ sau | Không · Chỉ xem · Dùng đầy đủ | Không (trừ app máy tính) | R | QĐ |
| PV9 ⭐ ⇄ C4 | Hai câu chọn nhiều: (a) khách làm gì trong app, (b) app làm gì thay họ | **Mở bản mẫu đúng nhóm và bật cờ cho các chương sau**: tải file ⇒ `tai-file`, nội dung người dùng ⇒ `ugc`, email/SMS ⇒ `gui-thu`, AI ⇒ `ai`, thanh toán ⇒ `tien` | (a, chọn nhiều) Đăng nhập · Đăng nội dung hoặc chat · Tải file lên · Nhập hoặc xuất Excel // (b, chọn nhiều) Gửi email, SMS hoặc thông báo · Dùng AI · Thanh toán | Không cái nào `(giả định)` | R | ST |
| PV10 ⭐ | App phải nối với dịch vụ ngoài nào (Zalo, Google Sheets/Lịch, phần mềm kế toán, máy in, dữ liệu công cộng)? | Tích hợp (`ban-mau-ket-noi`), rủi ro phụ thuộc (RR4) | Không · Có (tên) | Không | R | ST |
| PV11 ⇄ ban-mau-ai | Nếu dùng AI: AI làm gì với dữ liệu khách, và nếu trả lời sai thì khách thấy gì? | Cảnh báo "AI có thể sai", nút báo sai, người xác nhận việc quan trọng | Chỉ gợi ý, người quyết · AI tự làm | Ghi rõ "AI có thể sai" (kit) | cờ ai | QĐ |
| PV12 | Webapp có cần cài ra màn hình điện thoại như app không? | Cài được (PWA) hay không | Không · Có | Không | mặc định | QĐ |
| PV13 | Xác nhận nền tảng: webapp, app máy tính, extension hay điện thoại (điện thoại chưa có mẫu, khuyên webapp dùng được trên điện thoại) | Loại app; chốt chi tiết ở mảng 1 của buổi công nghệ | Web · App máy tính hoặc extension · Điện thoại | Theo lời kể; lời kể chưa rõ thì buổi công nghệ hỏi | mặc định | QĐ |

## 11. Vận hành và hỗ trợ (VH)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| VH1 ⭐ | Khách gặp lỗi hoặc có câu hỏi thì liên hệ ở đâu? | Màn Hỗ trợ/Liên hệ, giờ làm việc, thư tự động. Đào sâu: ai trả lời, trong bao lâu | Email hoặc form trong app · Zalo · Chưa nghĩ | Email + form, tôi trả lời trong 1–2 ngày | C | QĐ |
| VH2 ⭐ ⇄ N8 | App lỗi lúc nửa đêm thì ai xử lý? | Chỉ dùng dịch vụ có người vận hành hộ; cảnh báo gửi cho ai. Đào sâu: có ai biết kỹ thuật | Không ai · Tôi · Có người thuê | 1 người không code, không trực đêm (kit) | N | ST |
| VH3 ⇄ N4 | App ngừng một giờ giữa giờ làm thì mất gì: khách chờ được, mất đơn, hay mất tiền? | Mục tiêu hoạt động, có cần nhiều vùng | Chờ được · Mất đơn · Mất tiền | Khách chờ được (99,9%) (kit) | mặc định | ST |
| VH4 ⇄ N5, N6 | Nếu sự cố, mất tối đa bao lâu dữ liệu mới nhất thì còn chấp nhận được? | Tần suất sao lưu, bài khôi phục. Đào sâu: khôi phục trong bao lâu | Vài phút · 1 giờ · 1 ngày | 1 giờ; chạy lại trong 1 ngày làm việc (kit) | mặc định | ST |
| VH5 ⇄ ban-mau-van-hanh | Ai vào được trang quản trị? | Vai admin, mã 2 lớp, nhật ký, "xem như người dùng". Đào sâu: admin có được xem nội dung riêng của khách không | Chỉ tôi · Có nhân viên · Không xem nội dung riêng | Chỉ tôi; không xem nội dung riêng mặc định (kit) | N | QĐ |
| VH6 | Cần trang để xem/sửa dữ liệu bằng tay không? | Trang quản trị tối giản | Có · Không | Có, tối giản | N | QĐ |
| VH7 | Ai cập nhật nội dung (giá, danh mục, bài viết, thông báo)? | Nơi sửa nội dung, quyền | Tôi qua trang admin · Khách tự sửa · Sửa trong code | Tôi qua trang admin | C | QĐ |
| VH8 ⇄ N12 | Khách xin xoá tài khoản/xuất dữ liệu thì tự động hay bạn làm tay? | Nút xoá, việc dọn định kỳ, giữ hoá đơn. Đào sâu: xoá ngay hay sau 30 ngày | Tự động · Làm tay | Xoá sau 30 ngày, giữ hoá đơn theo luật kế toán (kit) | C | QĐ |
| VH9 | Nếu bạn vắng hai tuần thì app còn chạy được không? | Tự động hoá, tài liệu bàn giao. Đào sâu: ai thay | Tự chạy · Có người thay · Chấp nhận ngừng | Tự chạy, không ai thay | mặc định | ST |
| VH10 | Khi bảo trì hoặc ra bản mới có cần báo khách không? | Banner/email; extension: bản mới đến chậm vì chờ duyệt | Banner trong app · Email · Không | Banner trong app | mặc định | QĐ |

## 12. Dữ liệu và pháp lý (PL)

Hỏi **sự việc** ("có lưu CCCD không?"), không hỏi "bạn tuân thủ NĐ 356 chưa?". Không phải tư vấn pháp lý; không nói "đúng luật"; phần "Quyết định trong app" chỉ là thứ app phải thể hiện. Mọi mốc luật dưới đây **tra ngày 2026-11-22 qua nguồn thứ cấp** (chưa đối chiếu Công báo) và hết hạn sau 90 ngày (từ 2027-02-20): quá hạn, hoặc quá `phap_ly_tra_ngay` của bản ⇒ `researcher` tra lại trước khi dựa vào. Câu trả lời cuối kèm "hỏi kế toán/luật sư".

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| PL1 ⭐ ⇄ N10 | App lưu những thông tin gì của người dùng (tên, email, số điện thoại, địa chỉ, ảnh, vị trí, thanh toán, nội dung họ tạo…)? | Bảng dữ liệu, chính sách bảo mật, ô đồng ý, lưu ít nhất. Lưu dữ liệu của người khác ⇒ cờ `dlcn` (hồ sơ R mà lưu thì mâu thuẫn với TQ2 = a, nâng hồ sơ) | Cơ bản (tên, email) · Thêm vị trí, ảnh hoặc thanh toán · Không lưu gì | Tên + email `(giả định)` | N | ST |
| PL2 ⭐ | Có loại nhạy cảm không? | Mã hoá, không ghi vào log, nhật ký truy cập, hồ sơ đánh giá tác động (NĐ 356 mở rộng nhóm nhạy cảm), báo vi phạm 72 giờ với vị trí/sinh trắc. Dữ liệu trẻ em: PL3 | (chọn nhiều) Sức khoẻ · Tài chính (ngân hàng, thẻ) · Giấy tờ tuỳ thân hoặc sinh trắc học · Vị trí chính xác, tin nhắn riêng hoặc mật khẩu | Không | N · khi PL1 có lưu dữ liệu | ST |
| PL3 ⭐ | Có người dưới 16 tuổi dùng không, hoặc app nhắm vào trẻ em? | Xác minh tuổi, đồng ý của phụ huynh, tắt theo dõi (Luật BVDLCN Điều 24: từ 7 tuổi cần đồng ý của cả trẻ và người đại diện khi công khai đời tư; NĐ 330/2026 phạt không xác minh tuổi) | Không · Có, 13–15 tuổi · Chủ yếu trẻ em | Không; ghi "từ đủ 16 tuổi" trong điều khoản `(giả định)`. **Chưa biết mà có cờ `nganh` hoặc `nhay` ⇒ giả định an toàn: bật cờ `tre-em`** (xác minh tuổi, đồng ý phụ huynh, tắt theo dõi) | C | ST |
| PL4 | Dữ liệu của người Việt có được lưu hoặc xử lý ở nước ngoài (đám mây, AI, email, phân tích) không? | Vùng đặt dữ liệu (đào sâu: đặt ở máy chủ nào), hồ sơ chuyển dữ liệu ra nước ngoài (NĐ 356: thẩm định tại A05; doanh nghiệp nhỏ/khởi nghiệp miễn 5 năm từ 1/1/2026, hộ kinh doanh và doanh nghiệp siêu nhỏ miễn hoàn toàn, **trừ** khi có dữ liệu nhạy cảm, từ 100.000 người hoặc cung cấp dịch vụ xử lý dữ liệu) | Chỉ máy chủ Việt Nam · Có ra nước ngoài (Cloudflare, Supabase…) | Nước ngoài, ghi rõ trong chính sách; dữ liệu nhạy cảm hoặc quy mô lớn ⇒ hỏi chuyên gia | N · khi PL1 có lưu dữ liệu | ST |
| PL5 | Có chia sẻ dữ liệu khách với bên thứ ba (nhà cung cấp AI, quảng cáo, đối tác, kế toán)? | Chính sách, ô đồng ý riêng, hợp đồng nhà cung cấp, AI không dùng dữ liệu để huấn luyện | Không · Chỉ nhà cung cấp kỹ thuật · Có đối tác | Chỉ nhà cung cấp kỹ thuật | cờ dlcn | ST |
| PL6 | Có gửi quảng cáo/khuyến mãi (email, SMS, Zalo) cho khách không? | Ô đồng ý riêng không tick sẵn, nút huỷ một chạm, lưu bằng chứng thời điểm đồng ý (NĐ 356: cấm đồng ý mặc định/giao diện đánh lừa). Tin giao dịch (nhắc lịch, hoá đơn) không phải quảng cáo | Không · Có, khách đồng ý · Có, cho mọi người | Chỉ thư giao dịch | C | ST |
| PL7 | Giữ dữ liệu bao lâu? | Thời hạn giữ, việc dọn định kỳ. Đào sâu: khi khách xoá tài khoản thì giữ lại gì | 30 ngày · 1 năm · Theo luật kế toán | 30 ngày, giữ hoá đơn theo luật kế toán (kit) | cờ dlcn | QĐ |
| PL8 ⭐ ⇄ N11 | Có khách ở châu Âu, Mỹ hoặc nước khác (luật riêng của họ) không? | Xoá/xuất dữ liệu, banner cookie, văn bản xử lý dữ liệu | Không · Có | Việt Nam là chính; quốc tế ghi "không phải tư vấn pháp lý" (kit) | cờ quoc-te | ST |
| PL9 ⭐ | Khách có đặt hàng, mua, thanh toán ngay trên app/web này không? | **Luật TMĐT 122/2025 + NĐ 248/2026 (từ 1/7/2026)**: thông báo hoặc đăng ký với Bộ Công Thương (thủ tục đổi, tra lại ở online.gov.vn), trang chính sách (đổi trả, thanh toán, giao hàng, bảo mật, khiếu nại), thông tin chủ sở hữu ở chân trang; sàn thì thêm xác thực người bán, quy chế, gỡ vi phạm trong 24 giờ. Đào sâu: bạn bán thứ của mình hay là sàn cho người khác bán | Không bán · Tự bán · Sàn nhiều người bán | Không bán | $ | ST |
| PL10 | (Sàn) Bạn có giữ tiền hộ người bán không? | Xác thực người bán, quy chế, khiếu nại (đào sâu: người bán là ai, xác thực ra sao); **giữ tiền hộ có thể là "trung gian thanh toán" cần giấy phép (NĐ 52/2024 Điều 23–24)** | Không giữ tiền, để cổng đã có phép giữ · Tự giữ | Không giữ tiền (cổng đã cấp phép giữ) | cờ san | ST |
| PL11 | Doanh thu dự kiến năm đầu có dưới ngưỡng miễn thuế của hộ kinh doanh (1 tỷ/năm theo NĐ 141/2026) không? | Ghi chú thuế/hoá đơn cho kế toán (hình thức kinh doanh lấy từ TQ3) (AI **không tư vấn thuế**); sàn có chức năng thanh toán có thể khấu trừ thuế thay (NĐ 117/2025) | Dưới 1 tỷ · Hơn · Chưa biết | Dưới 1 tỷ; ghi "hỏi kế toán" | $ | ST |
| PL12 ⭐ | App thuộc ngành có điều kiện hoặc nhạy cảm không (y tế, tài chính, giáo dục/trẻ em, tuyển dụng, thực phẩm–thuốc–mỹ phẩm, bất động sản, game/cờ bạc)? | Giấy phép, dòng "không thay thế tư vấn chuyên môn", người xác nhận, loại quảng cáo bị cấm. **AI dừng phần app đưa ra đánh giá, khuyên hoặc quyết định chuyên môn** (chẩn đoán, liều thuốc, đầu tư, pháp lý…); phần ghi, nhắc, gửi dữ liệu do người dùng tự nhập vẫn làm; ghi Câu hỏi mở "cần người có chuyên môn". Đào sâu: đã có giấy phép hoặc người chuyên môn chưa | Không · Có nhóm (ghi ở ô tự gõ) · Không chắc | Không chắc ⇒ dừng phần chuyên môn như trên | cờ nganh | ST |
| PL13 | App có hiện nội dung do AI tạo cho khách, hoặc để AI quyết thay người không? | Nhãn "do AI tạo", đường để người xác nhận (Luật AI 134/2025, từ 1/3/2026; chi tiết nghĩa vụ chưa xác minh) | Chỉ gợi ý · AI tự làm | Có nhãn + nút báo sai | cờ ai | QĐ |
| PL14 | Khách có đăng nội dung công khai (bình luận, ảnh, đánh giá) không? | Nút báo vi phạm, quy chế, kiểm duyệt; có thể phải xác thực số điện thoại nếu thuộc diện "mạng xã hội" (NĐ 147/2024; phạm vi chưa xác minh) | Hiện ngay + nút báo · Chờ duyệt · Không | Hiện ngay + nút báo cáo | cờ ugc | QĐ |
| PL15 | Có chạy quảng cáo hoặc nhờ KOL/affiliate không? | Gắn nhãn quảng cáo, trách nhiệm người quảng bá (Luật Quảng cáo 75/2025 Điều 15a) | Không · Có | Không | mặc định · hỏi nếu KN4 có | ST |
| PL16 | Có dùng ảnh, font, nhạc, dữ liệu, thương hiệu của người khác không? | Licence, trang ghi nguồn. Đào sâu: mã nguồn mở nào bắt buộc ghi công | Không · Có (tên) | Chỉ thứ có licence thoáng | N | ST |
| PL17 ⭐ | Điều khoản sử dụng và chính sách bảo mật: bạn có bản sẵn, hay để AI soạn nháp rồi nhờ người có chuyên môn xem? | Trang pháp lý, chân trang. Đào sâu: ai là người liên hệ khi khách hỏi về dữ liệu của họ (tên + email) | AI soạn nháp · Có sẵn · Chưa cần | AI nháp + ghi "cần rà soát" | C | QĐ |
| PL18 | Khi lộ dữ liệu, bạn muốn báo ai và bằng cách nào? | Kế hoạch sự cố, mẫu thông báo | Tôi + email khách · Có người pháp lý | Tôi + email khách | cờ dlcn | QĐ |

## 13. Thương hiệu, giọng nói, xưng hô (TH)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| TH1 ⭐ | Tên app chốt chưa? | Tên trong mọi chữ; **mã định danh app (khó đổi sau)**; tên trên store. Đào sâu: đã kiểm trùng (Google, store, tên miền) chưa | Chốt · Còn 2–3 tên · Chưa | Chưa ⇒ tên tạm, **không dùng cho mã định danh** (theo `chot-tu-dau.md` của `flow-new-app`) | C · hồ sơ R, N: `flow-new-app` hỏi tên khi tạo | ST |
| TH2 | Tên miền: đã có chưa? | Email gửi đi, đăng nhập Google, link nằm lại trong tin nhắn khách. Đào sâu: muốn .vn hay .com | Đã có tên miền · Sẽ mua sau | Chưa; hoãn gắn đăng nhập Google và email (kit) | C | ST |
| TH3 ⭐ | Giọng nói của app, chọn 2? | Chữ giao diện, email, câu báo lỗi | (chọn nhiều) Thân thiện · Chuyên nghiệp · Vui, trẻ trung · Nghiêm túc | Thân thiện + rõ ràng | C | QĐ |
| TH4 ⭐ | App xưng và gọi người dùng thế nào? | Toàn bộ chữ giao diện, email, thông báo ("tôi – bạn" hoặc tiếng Anh we – you thì gõ ô tự gõ) | "Mình – bạn" · "Em – anh/chị" · "Chúng tôi – quý khách" | "Mình – bạn" cho khách trẻ, "chúng tôi – quý khách" cho doanh nghiệp `(AI đoán theo KH1)` | N | QĐ |
| TH5 | Người dùng được gọi là gì (khách, thành viên, học viên, người bán…)? | Tên bảng, nhãn UI, **từ điển**. Đào sâu: từ nào KHÔNG dùng | (tả) | Từ khách đang quen (VD2) | C | TD |
| TH6 | Đã có logo, màu hoặc thương hiệu nào làm mẫu chưa? | Bộ giá trị giao diện (`flow-ui-demo`). Đào sâu: cảm giác app mô tả bằng 3 từ | Có bộ · Chỉ logo · Chưa có | Chưa; 5 bản demo giúp chọn | mặc định | ST |
| TH7 ⭐ ⇄ ban-mau-van-hanh | Ngôn ngữ app: Việt, Anh, hay cả hai? | Tệp dịch, chữ không viết cứng trong code | Việt · Anh · Cả hai | Việt, nhưng chữ để trong tệp dịch từ đầu (kit) | N | QĐ |
| TH8 ⇄ ban-mau-van-hanh | Định dạng tiền, ngày, số: chỉ đồng Việt Nam hay nhiều loại tiền? | Tiền lưu số nguyên, báo cáo theo giờ doanh nghiệp. Đào sâu: giờ theo máy người xem hay theo doanh nghiệp | VND · Nhiều loại tiền | VND, dd/mm/yyyy, giờ theo máy người xem (kit) | $ | QĐ |
| TH9 | Email gửi đi mang tên gì (tên hiển thị, chữ ký)? | Email giao dịch | (tả) | "Tên app <no-reply@tên miền>" | cờ gui-thu | TD |

## 14. Rủi ro (RR)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| RR1 ⭐ | Một năm sau app thất bại lặng lẽ, lý do dễ xảy ra nhất là gì? | Rủi ro lớn nhất ⇒ thử rẻ sớm hoặc cắt | Không ai biết tới · Khách không trả tiền hoặc không quay lại · Tôi hết thời gian | Không ai biết tới | C | ST |
| RR2 ⭐ | Niềm tin nào nếu sai thì cả dự án sai? | **Danh sách giả định**; thử rẻ trước khi làm lớn (trang đăng ký chờ, 10 tin nhắn). Đào sâu: cách thử rẻ nhất | Khách thật sự cần · Tìm được khách · Khách chịu trả tiền | "Khách chịu trả tiền" | C | ST |
| RR3 ⭐ | Điều tệ nhất xảy ra với khách nếu app sai, lỗi hoặc lộ? | Mức xác nhận, nhật ký, cảnh báo, kiểm quyền | Phiền nhẹ hoặc mất thời gian · Mất tiền · Ảnh hưởng sức khoẻ hoặc pháp lý | Mất thời gian | N | ST |
| RR4 | Có dịch vụ ngoài nào mà nếu họ đổi chính sách/ngừng thì app hỏng (Zalo, Google, nhà cung cấp AI, Chrome Web Store)? | Lớp bọc quanh dịch vụ, phương án dự phòng | (liệt kê) | Lấy từ PV10 | mặc định · hỏi nếu PV10 có hoặc là extension | TD |
| RR5 | Nếu cổng thanh toán hoặc store từ chối hồ sơ thì sao? | Xin duyệt SỚM trước khi viết code thanh toán; chuyển khoản dự phòng | Có phương án khác · Chưa nghĩ | Xin sớm + chuyển khoản dự phòng | $ | ST |
| RR6 | Ai có thể lạm dụng app (spam, bot, gian lận, người xấu)? | Chống lạm dụng (bản mẫu) | (tả) | Bắt đăng nhập + giới hạn tần suất | cờ ugc | TD |
| RR7 | Nếu bạn hết thời gian/hứng thì app sống tiếp bằng cách nào? | Tài liệu bàn giao, đơn giản hoá | Tài liệu + tự chạy · Người nhận · Chấp nhận dừng | Tài liệu + tự chạy | mặc định | QĐ |

## 15. Hướng mở rộng 1–2 năm (MR)

Mục đích: tìm những thứ **khó đổi sau** để chừa chỗ từ ngày đầu, không phải để làm ngay.

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| MR1 ⭐ | Nếu thành công, 2 năm nữa app thành gì? (thêm ai dùng, thêm nước, thêm nền tảng, thêm tính năng) | Chừa chỗ cho thứ khó đổi; không làm trước | (tả) | Chỉ làm tốt thứ hiện tại | C | TD |
| MR2 ⭐ ⇄ C1 | Có thể về sau nhiều công ty/nhóm dùng, mỗi nơi chỉ thấy dữ liệu của mình? | **Cột công ty (tenant) trong mọi bảng từ ngày đầu, khó sửa sau**; ảnh hưởng chọn gói nền | Không · Có thể · Chắc chắn | Không `(giả định)` | C | ST |
| MR3 | Có thể thêm nền tảng khác (điện thoại, app máy tính, extension) sau này? | Tách logic khỏi giao diện/API | Không · Có | Webapp dùng được trên điện thoại | mặc định | ST |
| MR4 | Có thể bán ra nước ngoài, thêm ngôn ngữ, tiền tệ? | Tệp dịch, tiền, múi giờ | Không · Có | Việt Nam trước | cờ quoc-te | ST |
| MR5 | Có thể mở API cho đối tác, chia hoa hồng, bán lại app, gọi vốn? | Khoá API, tách quyền, licence sạch, quyền sở hữu mã | Không · Có | Không | mặc định | ST |
| MR6 | Mơ tới quy mô gấp 10 hay 100 lần số người dùng năm đầu? | Hạng quy mô, `flow-scale` | 10× · 100× | 10× | mặc định | ST |
| MR7 | Thứ gì tuyệt đối KHÔNG muốn app trở thành? (vd "đừng thành app nhiều tính năng rối") | Rào chống phình tính năng | (tả) | Không | mặc định | TD |

## 16. Thứ tự ưu tiên khi phải đánh đổi (UT)

| # | Câu hỏi | Quyết định trong app | Đáp án điển hình | Mặc định | Hỏi khi | Kiểu |
|---|---|---|---|---|---|---|
| UT1 ⭐ | Khi phải chọn, điều nào quan trọng nhất với bạn? | **Luật đánh đổi**: AI áp dụng khi tự quyết; chọn gói nền (Chạy chắc ⇒ Chắc, Ra nhanh và rẻ ⇒ Nhẹ). Hộp hỏi không xếp hạng được nên chỉ hỏi điều quan trọng nhất; điều thứ hai (đào sâu) chỉ hỏi khi cần, câu hai bỏ nhóm đã chọn, ước tính số vòng đã tính cả nó. "Nhiều tính năng" gõ ô tự gõ | Chạy chắc và riêng tư · Ra nhanh và rẻ · Dễ dùng và gọn | Chạy chắc > đơn giản > ra nhanh `(giả định)` | R | QĐ |
| UT2 ⇄ N4 | Ngừng vài giờ để rẻ hơn được không? | Độ dự phòng, gói dịch vụ | Được · Chỉ ngoài giờ · Không | Được | C | QĐ |
| UT3 | Thà ít tính năng dễ dùng, hay nhiều tính năng? | Cắt phạm vi, độ sâu menu | Ít mà dễ · Nhiều | Ít mà dễ | C | QĐ |
| UT4 | Thà thêm một bước xác minh cho an toàn, hay ít bước cho nhanh? | Đăng nhập, xác nhận tiền/xoá | An toàn · Nhanh · Tuỳ việc | An toàn cho việc tiền/xoá, nhanh cho phần còn lại | C | QĐ |
| UT5 | Ra bản 70% để thử sớm, hay chờ đủ rồi mới ra? | Phạm vi, chất lượng | Ra sớm · Chờ đủ | Ra sớm, bản mỏng chạy đầu–cuối (kit) | N | QĐ |
| UT6 | Tăng nhanh dù chưa có lãi, hay phải có lãi sớm? | Giá, gói miễn phí | Tăng nhanh · Có lãi sớm | Có lãi sớm, nhỏ | cờ ban-app | QĐ |
| UT7 | Nếu phải chọn giữa khách Việt Nam và khách quốc tế (giờ, giá, ngôn ngữ), ưu tiên bên nào? | Mặc định giờ/giá/ngôn ngữ | Việt Nam · Quốc tế | Việt Nam | cờ quoc-te | QĐ |
| UT8 ⭐ | Ngoài 4 việc kit luôn hỏi (tiêu tiền thật, xoá dữ liệu, gửi ra ngoài cho khách, đưa app lên mạng), bạn muốn AI hỏi thêm việc nào? | **Ranh giới tự quyết**: bốn cổng của kit LUÔN hỏi, cố định, không ai tắt được, **không nằm trong đáp án**; câu này chỉ hỏi việc thêm. Bản ghi: bốn cổng luôn hỏi + việc chọn ở đây; còn lại AI tự suy. Việc khác gõ ô tự gõ | (chọn nhiều) Đổi giá hoặc khuyến mãi · Đổi chữ hiện cho khách (điều khoản, thông báo) · Thêm tính năng ngoài phạm vi | Không thêm gì (bỏ trống = không thêm, khuyên dùng); bốn cổng vẫn luôn hỏi | R | QĐ |

---
name: flow-stack
description: Buổi hỏi công nghệ đầu dự án cho người không code, chạy sau flow-business — hỏi "gói nền" (Nhẹ, Chắc, Máy chủ riêng) trước, rồi chỉ các mảng áp dụng cho app (loại app, khung web, cơ sở dữ liệu, đăng nhập, lưu file, email, thu tiền, nơi chạy…); mỗi câu nói rõ chọn gì, vì sao, chịu tới đâu, lớn hơn đổi gì, bị trói nhà cung cấp không, kèm phí tra lúc hỏi; lưu docs/STACK.md và ghi vào luật của app. Dùng khi tạo app mới sau flow-business, làm tính năng ở app chưa có docs/STACK.md, hoặc user nói "chọn công nghệ", "đổi cơ sở dữ liệu", "đổi nơi chạy". KHÔNG dùng cho hỏi business (flow-business), thiết kế hệ thống của một tính năng (flow-system-design), phát hành (flow-publish), thêm một thư viện lẻ.
---

# Buổi hỏi công nghệ đầu dự án

Ra `docs/STACK.md` (mẫu `assets/stack.md`). Chỉ skill này ghi; skill khác chỉ đọc. **Ngoại lệ đã chốt [p125]:** nền công nghệ đầu dự án là
chỗ DUY NHẤT AI hỏi user lựa chọn kỹ thuật, vì khó đổi sau; mọi chỗ khác AI tự quyết. Hỏi bằng lời đời thường kèm lý do. Mảng, điều
kiện bỏ câu, phương án, ký hiệu kit: `references/mang.md`.

## Quy trình
1. **Điều kiện.** Cần `docs/BUSINESS.md` đã duyệt (hoặc nháp đủ hồ sơ và cờ); chưa có ⇒ chạy `flow-business` trước. Đọc mục 0 và các
   chương hợp (TD5 KH3 KH4 CP1 PV8 PV9 PV10 TG VH2 PL4 TH2 TH7 MR2 MR6, các cờ). App đã có code ⇒ đọc cấu hình, schema, thư viện đang dùng,
   ghi mảng đó là "Đang dùng", chỉ hỏi mảng chưa chốt. Có nháp dở ⇒ hỏi tiếp từ chỗ dừng.
2. **Câu đầu: gói nền** Nhẹ · Chắc · Máy chủ riêng, **chỉ cho app có máy chủ**. App máy tính chạy offline và extension không tài khoản
   ⇒ `goi: tai-may`, bỏ câu này. Gợi ý theo business: **Chắc** khi (có thu tiền **hoặc** nhiều công ty **hoặc** > 10.000 người/ngày **hoặc**
   cờ `nhay`/`nganh`/`tre-em`, vì cần DB khoá quyền) **và** trần chi mỗi tháng (B-CP1) đủ cho Chắc. Dữ liệu nhạy cảm mà trần thấp hơn ⇒
   vẫn khuyên Chắc, nói rõ vượt trần bao nhiêu. Trần thấp hơn (không nhạy cảm) ⇒ đưa cả hai gói, khuyên theo đáp án thật của B-UT1:
   "Chạy chắc và riêng tư" ⇒ Chắc, nói rõ vượt trần bao nhiêu; "Ra nhanh và rẻ" ⇒ Nhẹ, dữ liệu qua lớp `store` và ghi mốc đo được để
   chuyển sang Postgres; "Dễ dùng và gọn" hoặc Chưa biết ⇒ theo quy mô. Dùng riêng, không tiền ⇒ Nhẹ. Việc nặng hoặc chạy lâu ⇒ hỏi thêm
   rồi mới Máy chủ riêng. Gật gói ⇒ có mặc định cho cả 20 mảng.
3. **Chỉ hỏi mảng áp dụng** (thường 6–9 câu) theo điều kiện bỏ câu và thứ tự phụ thuộc ở `mang.md`. Mảng khó đổi (loại app, DB, tách dữ
   liệu công ty, đăng nhập, tên miền) hỏi kỹ; mảng dễ đổi chỉ cần khuyên và một dòng "đổi sau có dễ không". ≤ 4 câu một vòng
   (AskUserQuestion), đáp án khuyên dùng đứng đầu + lý do. Hộp hỏi nhận 2–4 đáp án: chọn một thì tối đa 3 đáp án thật + "Chưa biết" ⇒
   lấy phương án AI khuyên riêng cho app (kèm lý do), mặc định của gói chỉ khi không có căn cứ riêng; ghi giả định. **Mặc định và lời khuyên thua điều user đã nói ([Bạn nói])**; user đã chọn thứ kit chưa có mẫu ⇒
   vẫn làm, nói rõ "rủi ro cao hơn", đặt thành việc đầu tiên có bài kiểm và trần chi.
4. **Mỗi câu đủ 5 ý + phí:** chọn gì · vì sao · chịu tới đâu · lớn hơn đổi gì · trói nhà cung cấp và lối thoát. Phí **tra lúc hỏi** (kho
   `kho.mjs tim` trước, hết hạn thì `researcher` tra trang giá chính thức), nói "theo giá ngày …", ghi `gia_tra_ngay`. Không ghi giá hay
   hạn mức gói vào skill. Lựa chọn kit chưa có cách làm sẵn (cột Kit "chưa có") ⇒ nói thẳng "rủi ro cao hơn vì kit chưa có mẫu".
   Vd tiệm tóc có thu tiền, trần chi 500 nghìn: "Gói Chắc (Postgres trả phí, DB tự chặn khi AI sót kiểm quyền, có sao lưu) khoảng … mỗi
   tháng, **vượt trần khoảng …**. Gói Nhẹ (D1) nằm trong trần; AI viết qua lớp `store` nên khi dữ liệu chạm mốc … (đo được) chuyển sang
   Postgres không làm lại, nhưng D1 có trần dung lượng cứng. Bạn chọn "ra nhanh và rẻ" là quan trọng nhất nên tôi khuyên Nhẹ. Chọn nào, hay chưa biết?"
5. **Webapp cần Google hoặc link chia sẻ hiện đúng ảnh và tên ⇒ khuyên `web-public`** (loại app mới); không cần ⇒ `web`. "Chưa biết" ⇒
   `web-public` nếu B-KN2 có Google, Facebook hoặc Zalo, hoặc khách là người ngoài; còn lại `web`. Ghi `loai_app` vào STACK.md để
   `flow-new-app` lấy, không hỏi lại. Điện thoại ⇒ kit chưa có mẫu, khuyên web trước.
6. **Thu tiền** (app chốt có thu tiền). Khách Việt ⇒ SePay (skill chính hãng; chỉ báo tiền vào, hoàn cọc làm theo tài liệu hoàn tiền
   của skill đó). Khách quốc tế ⇒ skill `payment-integration` của AgentKit, hoặc bản công khai ClaudeKit khi không dùng được AgentKit;
   nguồn ngoài đã duyệt [wj8n] ở `kit/approved-skills.json`, ghim commit. payOS ⇒ gợi ý được, ghi "kit chưa có skill". Không gợi ý dịch vụ
   đã đóng. Cài ở bước chuẩn bị của việc đầu tiên: `node ~/.claude/hooks/skills-check.mjs --dir <app>` in lệnh cài và `source:
   official|approved`; hỏi user rồi cài **mức dự án**. Skill không thay luật an toàn của kit (`ban-mau-tien.md` của `flow-system-design`).
7. **Lưu nháp mỗi vòng** (`trang_thai: nhap`): app đã có ⇒ `docs/STACK.md`; chưa có ⇒ `<thư mục cha>/.flow-nhap/<tên-app>/STACK.md`
   (thư mục cha = giá trị `--dir` của `flow-new-app`; chưa chốt thì thư mục làm việc hiện tại của phiên, nói user một dòng).
8. **Đọc lại, xin gật.** Tóm tắt ≤ 10 dòng: gói, loại app, DB, đăng nhập, nơi chạy, thu tiền, phí tháng ước tính (giá ngày …), mốc nâng
   cấp. Gật ⇒ `trang_thai: da-duyet`; mỗi quyết định lớn (gói, loại app và khung, DB, đăng nhập, thu tiền) một dòng sổ chốt trỏ mảng. Rồi
   trả về `flow-new-app` (tạo app theo `loai_app`) hoặc `flow-feature`. Mục "Công nghệ đã chốt" trong `AI_RULES.md` ghi **sau khi app được
   tạo** (bước của `flow-new-app`), trỏ `docs/STACK.md`.

## Luật sau khi chốt
- AI **không đổi, không thêm** khung, cơ sở dữ liệu, dịch vụ ngoài khi user chưa bảo. Tính năng cần thứ chưa có trong STACK.md ⇒ dùng
  thứ có sẵn, hoặc hỏi user một câu (thêm một mảng) kèm 5 ý và phí.
- Chỉ **nhắc** khi app chạm mốc nâng cấp đã ghi ("đã quá 10.000 người/ngày, nên làm X"); không tự làm.
- Mỗi dịch vụ ngoài chỉ chạm qua một hàm bọc, nên đổi nhà là đổi một chỗ.
- User đổi ý công nghệ ⇒ nói kéo theo gì (phí, dữ liệu, mốc), xin gật, sửa tại chỗ, tăng `phien_ban`, ghi `## Nhật ký đổi`, ghi sổ chốt thay
  cho cũ. `flow-business` đổi MAJOR (khách, cách thu tiền, nền tảng) ⇒ rà lại mảng bị ảnh hưởng.
- Giá trong STACK.md quá 30 ngày ⇒ tra lại trước khi dùng làm căn cứ quyết định tiền.

## Đọc khi cần
- `references/mang.md` — bước 2 đến 6: gói nền, 20 mảng và khung web, phương án, mốc, điều kiện bỏ câu
- `assets/stack.md` — bước 7 và 8: khung file nháp và bản chốt

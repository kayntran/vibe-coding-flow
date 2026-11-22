# Mẫu BUSINESS.md

`docs/BUSINESS.md` trong app. Chưa có thư mục app: lưu nháp ở `<thư mục cha>/.flow-nhap/<tên-app>/BUSINESS.md` (thư mục cha = giá trị `--dir` của `flow-new-app`; chưa chốt thì thư mục làm việc hiện tại của phiên, nói user một dòng), chuyển vào `docs/` ngay sau khi `flow-new-app` tạo xong; app đã có thì ghi thẳng `docs/`. Chỉ `flow-business` sửa nội dung; skill khác chỉ đọc và thêm một dòng vào Nhật ký đổi.

Chép khối dưới, thay mọi `<…>`, bỏ chú thích sau `#` hoặc `←`, xoá chương chưa có câu trả lời. Tiêu đề `## 0. Tóm tắt` giữ nguyên chữ (hook tìm theo tiêu đề đó).

## Mẫu

```
---
ten_app: <tên>
phien_ban: 0.1.0               # nháp 0.x; user gật lần đầu ⇒ 1.0.0
trang_thai: nhap               # nhap | da-duyet
duyet: <YYYY-MM-DD>            # ngày user gật; nháp thì để trống
sua_cuoi: <YYYY-MM-DD>
ho_so: <R|N|C|$|S>
co: []                         # tien, thu-dich-vu, ban-app, dlcn, nhay, tre-em, quoc-te, nhieu-vai, ugc, ai, gui-thu, tai-file, san, nganh, may-tinh, extension
phap_ly_tra_ngay: <YYYY-MM-DD> # chương pháp lý hết hạn sau 90 ngày kể từ ngày này; hồ sơ R không có chương pháp lý thì ghi —
vong_da_xong: <n>/<tổng ước>   # chỉ khi nháp: hỏi tiếp từ đây
---
# BUSINESS — <tên app>
> Mức chắc mỗi mục: [Bạn nói] · [Dữ liệu cho thấy] · [AI đề xuất, bạn gật] · [AI đoán] · [Mặc định]. AI đoán và Mặc định là giả định, user chưa gật từng mục. [AI đề xuất, bạn gật] là điều ⭐ do đường nhanh đề xuất và user đã gật: skill khác coi như [Bạn nói].

## 0. Tóm tắt
<≤ 15 dòng và ≤ 1.500 ký tự, mỗi dòng một ý ≤ 100 ký tự, đời thường, đủ để chỉ đọc mục này vẫn hiểu app. Thứ tự ưu tiên, hết chỗ thì bỏ ý cuối: làm gì cho ai · tiền (có/không, kiểu, mức đã chốt hay chưa) · nền tảng · khách ở đâu, tiếng gì · hồ sơ và cờ · ưu tiên khi đánh đổi · việc AI hỏi thêm ở UT8 (ngoài 4 cổng cố định) · 3 điều KHÔNG làm · thước đo chính · trần chi mỗi tháng · xưng hô>

## 1. Luật đánh đổi và ranh giới tự quyết
**B-UT1** · Quan trọng nhất: <chạy chắc và riêng tư | ra nhanh và rẻ | dễ dùng và gọn> (thứ hai: <…> nếu đã hỏi) · [Bạn nói] · <ngày> · → AI chọn phương án khớp ưu tiên khi tự quyết; chọn gói nền
**B-UT8** · 4 cổng luôn hỏi (cố định, không tắt được, không nằm trong câu UT8): tiêu tiền thật, xoá dữ liệu, gửi gì ra ngoài cho khách, đưa app lên mạng. Hỏi thêm theo user chọn: <đổi giá hoặc khuyến mãi | đổi chữ hiện cho khách | thêm tính năng ngoài phạm vi | không thêm>. Còn lại AI tự suy · [Bạn nói] · <ngày> · → mọi skill đọc dòng này trước khi định hỏi

## Chương <mã> · <tên chương>   ← chỉ chương có câu trả lời, mỗi mục một dòng
**B-<mã><số>** · <câu trả lời> · [Bạn nói|Dữ liệu cho thấy|AI đề xuất, bạn gật|AI đoán|Mặc định] · <YYYY-MM-DD> · → <màn/bảng/quy tắc dựa vào mục này>

## Từ điển và giọng nói
- Gọi người dùng là <từ>; app xưng <từ>; giọng <2 từ>
- Dùng: <từ> · _Tránh_: <từ cấm> (vì sao)
- Ba câu mẫu: "<…>" · "<…>" · "<…>"

## Giả định
Gom theo chương, một dòng mỗi chương (mục `[Mặc định]` và `[AI đoán]` không cần dòng riêng). Dòng cuối: "Ngoài hồ sơ <R|N|C|$>: dùng cột Mặc định của danh sách (giả định)".
| Chương | Mục giả định | Hỏng thì sao | Cách kiểm rẻ nhất | Hạn |
|---|---|---|---|---|

## Câu hỏi mở
AI tự suy theo ranh giới tự quyết; chỉ nêu cho user khi tới cổng "phải hỏi" ngay lúc hành động thật.
| OQ | Chủ | Chặn việc gì | Xử lý |
|---|---|---|---|

## Hệ quả cho app
| Mã | Skill đọc | Thay đổi gì |
|---|---|---|

## Nhật ký đổi
| Ngày | Mục | Từ ⇒ thành | Vì sao | Tài liệu phải xem lại | Ghi bởi |
|---|---|---|---|---|---|
```

## Ví dụ một mục điền (tiệm tóc đặt lịch)

```
**B-TG7** · Khách trả cọc bằng chuyển khoản QR, phần còn lại trả tại tiệm · [Bạn nói] · 2026-11-22 · → màn đặt lịch có bước cọc; đối soát tay hằng ngày ở bản đầu
**B-TH4** · App xưng "mình", gọi khách là "bạn" · [AI đoán] · 2026-11-22 · → mọi chữ giao diện và tin nhắc lịch
```

## Quy tắc điền

- **Mỗi mục có mã, mức chắc, ngày, "ảnh hưởng tới đâu".** Không ghi điều user không nói; không bịa quy mô thị trường, đối thủ, điều luật. Điều tra được thì ghi ngày tra.
- **Mục 0 ≤ 15 dòng, ≤ 1.500 ký tự**: hook chỉ nạp mục này vào mỗi phiên, phần còn lại đọc khi skill cần. Điền xong đếm ký tự; vượt thì cắt ý cuối danh sách ưu tiên.
- Điều ngoài hồ sơ không ghi từng điều: dùng cột Mặc định của danh sách, một dòng gộp ở Giả định. Chương không có câu trả lời thì bỏ.
- User gật một mục `[AI đoán]` ⇒ đổi thành `[Bạn nói]`. Mặc định thua điều user đã nói.
- Chương pháp lý ghi mốc luật kèm "tra ngày …"; không viết "đúng luật" hay "tuân thủ"; thêm "hỏi kế toán/luật sư".
- Số phiên bản: MAJOR khi đổi khách, cách thu tiền hoặc nền tảng · MINOR khi thêm hoặc mở rộng · PATCH khi sửa chữ. Mỗi lần đổi ghi một dòng ở Nhật ký đổi.
- Skill khác chỉ thêm dòng Nhật ký đổi khi gặp điều bản chưa nói hoặc trái `[AI đoán]`/`[Mặc định]`: cột "Từ ⇒ thành" ghi "chưa nói ⇒ AI suy …", "Vì sao" ghi tính năng đang làm, "Ghi bởi" ghi tên skill; không sửa chương.
- Quyết định lớn (đối tượng khách, cách thu tiền, nền tảng, luật đánh đổi, ranh giới tự quyết) có thêm một dòng sổ chốt trỏ mã `B-xx`. Lệch nhau ⇒ sổ chốt thắng, sửa file.

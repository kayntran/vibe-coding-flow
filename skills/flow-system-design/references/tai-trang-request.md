# Request và tốc độ tải trang

Dùng ở bước 3, 6, 7 của `flow-system-design` cho mọi app có màn hình, và khi soát app đang chạy bị "nhiều request", "máy chủ nặng",
"tải chậm". Chốt [r69o].

## Mục lục
- Cách nghĩ
- Ngân sách ghi vào DESIGN.md
- Làm ngay: phía giao diện
- Làm ngay: phía máy chủ
- Chừa chỗ và chưa làm
- Bài kiểm bắt buộc
- Soát app đang chạy
- Mẫu lỗi hay gặp

## Cách nghĩ

Tải lên máy chủ = **số request × việc mỗi request phải làm**. App nhỏ thường nặng ở vế sau: một lần bấm kéo theo hàng chục lần đọc ghi
cơ sở dữ liệu. Đếm cả hai vế, và đếm theo **hành động của người dùng** ("trả lời một câu", "mở màn Hôm nay"), không theo endpoint.
Cache là bước sau cùng (tài liệu cache của skill này); trước đó là đừng gọi, đừng gọi lại, gọi ít hơn.

## Ngân sách ghi vào DESIGN.md

Mỗi màn chính và mỗi hành động lặp nhiều một dòng. Số dưới là mặc định cho hạng prototype/MVP (kinh nghiệm, không phải số đo); đổi số
thì ghi lý do.

| Đo gì | Mặc định |
|---|---|
| Request dữ liệu lúc mở một màn (không tính file tĩnh đã nhớ) | ≤ 3 |
| Request khi người dùng ngồi yên 60 giây | 0 |
| Request cho một hành động (bấm, trả lời, đánh dấu) | ≤ 1; chuỗi bấm nhanh thì gom lô |
| Lần đọc ghi cơ sở dữ liệu cho một request | ≤ 5; hành động lặp nhiều lần mỗi phút ≤ 3 |
| Mã chạy tải lần đầu (JS, đã nén) | ≤ 150 kB (khớp `.size-limit.json` của mẫu kit) |
| Màn đầu hiện nội dung chính (LCP) trên điện thoại, mạng 4G | ≤ 2,5 giây |
| Ảnh lớn nhất trên màn đầu | ≤ 200 kB |
| Mở lại màn đã xem | Không tải lại file tĩnh; dữ liệu còn mới thì không gọi |

## Làm ngay: phía giao diện

1. **Một lớp tải dữ liệu dùng chung có bộ nhớ đệm** (thư viện có trong `STACK.md`, vd TanStack Query, SWR): nhiều màn cần cùng một dữ
   liệu thì chỉ một request. Không để mỗi màn tự viết hook tải riêng.
2. **Đặt "còn mới trong bao lâu" có chủ ý** cho từng loại dữ liệu, bằng câu hỏi hành vi "người dùng thấy số cũ bao lâu thì vẫn ổn".
   Mặc định của thư viện thường là 0 và tự tải lại khi quay lại tab: đọc cấu hình mặc định trước khi dùng, kể cả thư viện đăng nhập.
3. **Không gọi lặp theo giờ** khi chưa có con số bắt buộc. Cần "gần tức thì" ⇒ hỏi "chậm bao lâu thì vẫn ổn" rồi mới chọn cách.
4. **Hành động nhỏ lặp nhanh** (trả lời câu hỏi, đánh dấu, kéo thả, bấm +/−, gõ tìm kiếm): màn hình đổi ngay, gửi lên theo lô (vài
   giây một lần, hoặc khi xong một cụm) hay chờ ngừng tay ~300 ms. Lô vẫn mang khoá chống gửi trùng; đóng tab thì gửi nốt.
5. **Danh sách:** một request trả đủ các dòng đang hiện, có phân trang. Không một request cho mỗi dòng.
6. **Màn đầu chỉ tải thứ nó cần:** tách mã theo màn; thư viện nặng (biểu đồ, soạn thảo, bản đồ) tải khi mở tới.
7. **Ảnh và phông:** ảnh đúng cỡ hiển thị, định dạng nén (WebP/AVIF), khai sẵn rộng × cao, ảnh dưới màn hình tải trễ; tối đa 2 kiểu
   phông, hiện chữ ngay bằng phông dự phòng, file phông để trong app.

## Làm ngay: phía máy chủ

8. **Đếm lần đọc ghi cơ sở dữ liệu của mỗi request nóng.** Gom truy vấn, không truy vấn trong vòng lặp. Thứ tính lại từ đầu mỗi lần
   (tổng, chuỗi ngày, "đã xong buổi chưa") ⇒ cột hoặc bảng tính sẵn, cập nhật lúc ghi.
9. **Phiên đăng nhập:** chọn có chủ ý giữa "đọc cơ sở dữ liệu mỗi request" và nhớ ngắn hạn (vài chục giây); ghi đánh đổi (khoá tài
   khoản có hiệu lực chậm đi bấy nhiêu) vào mục Đánh đổi.
10. **Mọi file tĩnh có hạn nhớ:** file có mã băm trong tên ⇒ 1 năm, không đổi; ảnh, logo, âm thanh không có mã băm ⇒ vẫn đặt hạn (ngày,
    tuần) hoặc chuyển vào thư mục có mã băm; trang HTML gốc ⇒ luôn hỏi lại. Thêm thư mục tĩnh mới thì kiểm lại header.
11. **Nén cả phản hồi dữ liệu** (JSON), không chỉ JS và CSS.
12. **Việc hẹn giờ:** tần suất theo nhu cầu thật (nhắc theo giờ không cần quét cả bảng mỗi phút); truy vấn của nó dùng được chỉ mục;
    không tranh kết nối cơ sở dữ liệu với phần phục vụ người dùng (giới hạn riêng).
13. **Có số đo từ ngày đầu:** nhật ký mỗi request ghi thời gian và số lần đọc ghi cơ sở dữ liệu; đếm được request của một người trong
    một phiên. Không có số đo thì mọi tối ưu về sau là đoán.

## Chừa chỗ và chưa làm

- **Chừa chỗ:** điểm nhận lô có sẵn tham số cỡ lô; mọi lần tải dữ liệu đi qua lớp dùng chung (sau này thêm nhớ lâu hơn không phải sửa
  từng màn); tên file tĩnh có mã băm.
- **Chưa làm** (ghi ngưỡng vào lộ trình): mạng phát file riêng (CDN) khi người dùng ở xa máy chủ · dùng được khi mất mạng · dựng sẵn
  trang ở máy chủ cho trang không cần lên Google · cache phân tán khi một máy chủ không còn đủ.

## Bài kiểm bắt buộc

- Mở từng màn chính bằng Playwright, đếm request dữ liệu ⇒ không vượt ngân sách. Chờ thêm 10 giây không thao tác ⇒ không có request mới.
- Làm hành động lặp 10 lần liên tiếp ⇒ số request không vượt ngân sách; dữ liệu cuối đúng đủ 10 lần.
- Test phía máy chủ đếm lần đọc ghi cơ sở dữ liệu của request nóng nhất ⇒ không vượt ngân sách.
- Tải lại màn lần hai ⇒ file tĩnh lấy từ bộ nhớ trình duyệt; kiểm header hạn nhớ của một file mỗi loại (mã, ảnh, âm thanh, HTML gốc).
- `size-limit` xanh (có sẵn trong mẫu kit).

## Soát app đang chạy

Đo trước khi đoán, rẻ trước. Phỏng đoán "chắc do gọi lặp" hay sai:

1. Nhật ký máy chủ một giờ đông: đếm request theo đường dẫn và theo người ⇒ 5 đường dẫn đứng đầu.
2. Đi luồng chính 5 phút bằng Playwright, ghi mọi request: màn nào, hành động nào sinh bao nhiêu.
3. Ba đường dẫn đứng đầu: đếm lần đọc ghi cơ sở dữ liệu mỗi request; xem việc hẹn giờ nào chạy khi không ai dùng.
4. Đối chiếu bảng dưới, báo theo khuôn soát hệ thống có sẵn của skill (người dùng gặp gì · ở ngưỡng nào · sửa tốn gì).

## Mẫu lỗi hay gặp

Rút từ một app thật bị nặng máy chủ (không có gọi lặp theo giờ nào):

| Dấu hiệu | Nguyên nhân | Sửa |
|---|---|---|
| Một đường dẫn ghi chiếm phần lớn request | Mỗi hành động nhỏ một request | Gom lô (mục 4) |
| Request ít mà máy chủ vẫn nặng | Mỗi request hàng chục lần đọc ghi, tính lại từ đầu | Gom truy vấn, tính sẵn (mục 8) |
| Chuyển qua lại các màn là gọi lại y hệt | Mỗi màn tự tải, không nhớ chung | Lớp tải dùng chung (mục 1–2) |
| Mỗi lần quay lại tab có request đăng nhập | Thư viện tự hỏi lại phiên, phiên không nhớ | Mục 2 và 9 |
| Ảnh bị hỏi lại sau mỗi lần phát hành | File tĩnh ngoài thư mục có mã băm thiếu hạn nhớ | Mục 10 |
| Máy chủ bận cả lúc không ai dùng | Việc hẹn giờ quá dày, chung kết nối với người dùng | Mục 12 |
| Không ai trả lời được "một người tốn bao nhiêu request" | Không có số đo | Mục 13 |

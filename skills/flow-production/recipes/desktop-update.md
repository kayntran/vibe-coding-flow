# Công thức phát hành: app desktop (Wails) và báo cập nhật

Wails v2 không có tự cập nhật sẵn. Mỗi lần có bản mới, **hỏi user chọn kiểu báo cho app đó** (AskUserQuestion, lời đời
thường) và làm đúng kiểu đã chọn; ghi lựa chọn vào sổ chốt:

| Kiểu | Người dùng thấy gì | Làm bằng gì |
|---|---|---|
| **A. Tải ngầm** | Bản mới tải sẵn ở nền, hiện nút **Cập nhật**; bấm là app thay bản và mở lại | `creativeprojects/go-selfupdate` (MIT) |
| **B. Báo + nút Tải** | Hiện "Có bản mới" kèm nút **Tải**; bấm mở trang tải trên trình duyệt, tự cài tay | gọi GitHub Releases hỏi bản mới nhất, so số phiên bản |

Kiểu B đơn giản và an toàn hơn cho người mới; kiểu A tiện hơn nhưng thay file đang chạy (cách thay trên Windows của
thư viện: chưa kiểm — thử trên máy Windows thật trước khi giao). Không báo gì = không chọn được.

## Luật chung (cả hai kiểu)
- **Luôn kiểm mã băm (SHA256) bản tải về** trước khi thay/mở: đăng kèm `checksums.txt` trong bản phát hành; app tải về
  tính SHA256 và so. Lệch ⇒ bỏ file, báo "bản tải về hỏng", không thay. (Kiểu A: dùng bộ kiểm checksum của thư viện.)
- Nguồn kiểm bản mới chỉ là địa chỉ cố định đã khai trong app (trang GitHub Releases của dự án), qua HTTPS.
- Số phiên bản luôn tăng; app so số, không so ngày.

## Phát hành
1. Preflight (SKILL bước 2).
2. Tăng số phiên bản, build: `wails build -platform windows/amd64 -nsis` (cần NSIS) và/hoặc `darwin/universal`; tính SHA256
   từng file rồi ghi vào `checksums.txt`.
3. Đăng: `gh release create v<số> <file…> checksums.txt --notes "<ghi chú ngắn>"` (hỏi user gật trước khi đăng).
4. Chạy thử bản vừa build ở máy; thử đường cập nhật từ bản cũ lên bản mới bằng máy thật.
Mac cần ký + notarize (Apple Developer, khoảng 99 USD/năm); Windows không ký ⇒ SmartScreen cảnh báo — nói user trước.
(Mọi bước: chưa chạy thật.)

## Quay lại bản trước
Không có lệnh. Hai đường: (1) xoá bản lỗi khỏi Releases (`gh release delete v<số> --cleanup-tag -y`, hỏi user gật) để
"bản mới nhất" quay về bản trước; hoặc (2) đăng lại mã bản cũ với **số phiên bản cao hơn** — người đã cập nhật lên
bản lỗi chỉ nhận được bản có số lớn hơn. Chọn (2) khi đã có nhiều người cài bản lỗi. Dữ liệu trong máy người dùng không đổi.

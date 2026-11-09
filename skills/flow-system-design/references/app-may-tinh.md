# App máy tính (Wails) và extension trình duyệt

Dùng ở bước 5–8 của `flow-system-design`.

## Mục lục
- Khác webapp ở đâu
- Lưu local bằng SQLite
- Offline-first
- Đồng bộ và giải quyết xung đột
- Ký code và notarize
- Tự cập nhật
- Phiên bản tối thiểu được hỗ trợ
- Khác biệt Windows, macOS, Linux
- Quyền hệ điều hành
- Báo crash
- Khoá bí mật
- Extension Chrome MV3
- Nguồn

## Khác webapp ở đâu

Code chạy trên máy người dùng ⇒ (1) không sửa ngay được bản đã cài, (2) ai cũng mở gói ra đọc được, (3) mạng có thể mất,
(4) mỗi hệ điều hành một kiểu. Bốn điều này quyết mọi mục dưới.

## Lưu local bằng SQLite

- Mặc định: một file SQLite trong thư mục dữ liệu của người dùng (Go: `os.UserConfigDir()` hoặc `os.UserCacheDir()`), không
  cạnh file chạy (thư mục cài thường không ghi được).
- Bật chế độ WAL (ghi nhật ký trước — cho đọc trong lúc ghi), một kết nối ghi; migration chạy lúc mở app, có số phiên bản schema.
- Thư viện: bản Go thuần không cần CGO dễ build chéo 3 hệ điều hành; bản CGO nhanh hơn nhưng build khó hơn (kinh nghiệm).
- Sao lưu: file nằm trên một máy ⇒ hỏng ổ là mất. Có nút "Xuất dữ liệu" từ ngày đầu; đồng bộ lên server là sao lưu thật.
- Đổi định dạng file người dùng lưu là khó đảo ngược ⇒ quyết trước, có trường phiên bản trong file.

## Offline-first

Offline-first (dữ liệu ghi vào máy trước, đồng bộ lên server sau khi có mạng). Chỉ chọn khi SPEC cần dùng lúc mất mạng.

- Mỗi bản ghi: ID sinh ở máy (UUID/ULID, không dùng số tự tăng — hai máy sẽ trùng), `updated_at`, `version`, `deleted_at`.
- Hàng đợi thay đổi cục bộ (outbox — bảng ghi các thay đổi chưa gửi), gửi lại khi có mạng; server nhận thay đổi idempotent theo ID thay đổi.
- Xoá dùng dấu đã xoá (tombstone), không xoá cứng — kẻo máy offline gửi lại làm bản ghi "sống lại".
- Hiện trạng thái cho người dùng: "Đã lưu trên máy · chưa đồng bộ" / "Đã đồng bộ".
- Hỏi user: "Hai máy cùng sửa một mục khi mất mạng thì giữ bản nào?" → khuyên: giữ bản sửa sau, hiện lịch sử để lấy lại.
- CHƯA cần: app chỉ dùng khi có mạng, hoặc chỉ một máy một người ⇒ gọi server trực tiếp, SQLite chỉ làm cache.

## Đồng bộ và giải quyết xung đột

| Cách | Làm gì | Hợp khi | Tốn gì |
|---|---|---|---|
| Ghi sau thắng (last-write-wins) | Bản có version/thời điểm sau đè bản trước | Một người, ít khi sửa song song: cài đặt, trạng thái đã đọc, ghi chú cá nhân | Mất lần sửa thua — không báo |
| Gộp theo trường | Mỗi trường có version riêng; sửa khác trường thì giữ cả hai, cùng trường thì ghi sau thắng hoặc hỏi | Hồ sơ, danh bạ, công việc nhiều trường | Thêm cột version theo trường hoặc nhật ký thay đổi |
| CRDT (kiểu dữ liệu tự gộp không xung đột) | Mọi thay đổi gộp được theo toán học, thứ tự nào cũng ra cùng kết quả | Nhiều người soạn cùng văn bản/bảng, offline lâu | Dữ liệu phình, khó truy vấn SQL, khó xoá hẳn, thêm thư viện lớn |

- Mặc định: ghi sau thắng, so bằng `version` tăng dần do server cấp hoặc thời điểm server — **không tin giờ máy** người dùng.
- Lên gộp theo trường khi có báo cáo "mất chữ vừa sửa" từ người dùng nhiều máy.
- CRDT chỉ khi SPEC có soạn thảo cộng tác thời gian thực; ghi ADR (quyết định khó đảo ngược).
- Tiền, tồn kho, số thứ tự: **không** gộp offline — server quyết, máy chỉ gửi yêu cầu.

## Ký code và notarize

- Windows: không ký ⇒ SmartScreen cảnh báo "không rõ nhà phát hành", nhiều người bỏ cài (kinh nghiệm).
- macOS: phải ký bằng tài khoản Apple Developer **và** notarize (gửi Apple quét, nhận vé) — thiếu thì Gatekeeper chặn mở.
- Linux: thường không ký; phát hành kèm checksum.
- Chi phí chứng chỉ, thời gian xin: ghi vào mục chi phí, tra trang gốc ngày viết.

## Tự cập nhật

- Wails v3 có updater chính thức: bản phát hành ký Ed25519 (chữ ký số), **khoá riêng nằm ở máy phát hành/CI**, khoá công khai
  nhúng trong app; thay file chạy nguyên khối, có quay lại nếu hỏng; macOS vẫn cần ký + notarize (chưa mở trang, lấy qua kết quả tìm kiếm).
- Wails v2: chưa thấy updater chính thức ⇒ tự làm theo cùng mẫu (tải file + chữ ký, kiểm Ed25519 bằng khoá công khai nhúng sẵn,
  thay file, giữ bản cũ để quay lại) hoặc dùng thư viện Go self-update và tự thêm kiểm chữ ký (chưa xác minh). Kiểm dự án đang dùng v2 hay v3.
- Luật: tải qua HTTPS **và** kiểm chữ ký; không cập nhật giữa lúc đang ghi dữ liệu; báo người dùng trước khi khởi động lại.

## Phiên bản tối thiểu được hỗ trợ

Bản cũ vẫn chạy nhiều tuần sau khi phát hành bản mới ⇒ đổi API server có thể làm hỏng họ.
- App gửi phiên bản trong mỗi request (`X-App-Version`). Server có cấu hình `minSupported` theo từng client.
- Dưới mức tối thiểu ⇒ server trả mã lỗi riêng; app hiện màn "Cần cập nhật" một nút **Cập nhật**, không màn lỗi chung.
- API đổi theo kiểu chỉ thêm (thêm trường, không đổi nghĩa trường cũ); xoá trường cũ khi bản dùng nó dưới ~5% người dùng (kinh nghiệm).

## Khác biệt Windows, macOS, Linux

| Mặt | Windows | macOS | Linux |
|---|---|---|---|
| Lõi hiển thị web | WebView2 (thường có sẵn trên Win 10/11) | WKWebView | WebKitGTK (cần gói hệ thống) |
| Thư mục dữ liệu | `%AppData%` | `~/Library/Application Support` | `~/.config` hoặc `~/.local/share` |
| Cài/gỡ | Bộ cài, gỡ ở Cài đặt | Kéo vào Applications | AppImage, deb, rpm |
| Ký | Chứng chỉ ký code | Ký + notarize | Checksum |

- Đường dẫn: dùng `filepath.Join`, không ghép chuỗi bằng dấu phân cách cố định.
- Kiểm trên cả 3 trước khi phát hành (`flow-qa`); khác biệt hay gặp nhất: font, phím tắt (Ctrl vs Cmd), quyền thư mục (kinh nghiệm).
- Nguồn bảng: kinh nghiệm, chưa đối chiếu docs Wails.

## Quyền hệ điều hành

- Xin quyền đúng lúc cần, kèm một câu vì sao (micro, camera, thông báo, truy cập thư mục); không xin hết lúc mở app.
- macOS: quyền như ghi màn hình, trợ năng phải khai trong cấu hình gói; người dùng từ chối ⇒ app vẫn chạy phần còn lại.
- Không cần quyền quản trị để chạy hằng ngày.

## Báo crash

- Gửi: loại lỗi, dấu vết ngăn xếp, phiên bản app, hệ điều hành, mã máy ẩn danh. **Không gửi** nội dung tài liệu, đường dẫn có
  tên người dùng, email, khoá.
- Có công tắc tắt báo crash trong Cài đặt; lần đầu hỏi đồng ý.
- Gửi qua endpoint của mình (có rate limit), không nhúng khoá dịch vụ báo lỗi có quyền ghi rộng.

## Khoá bí mật

- Không nhúng khoá API (AI, SMS, thanh toán) vào app — giải nén là đọc được. App gọi server của mình bằng phiên người dùng.
- Token phiên người dùng lưu trong kho khoá hệ điều hành (Credential Manager, Keychain, Secret Service), không lưu file thường.
- Khoá bản quyền: kiểm ở server; ở máy chỉ lưu kết quả có chữ ký và hạn.

## Extension Chrome MV3

- **Không tải mã từ xa**: mọi JS nằm trong gói (cấm cả CDN, `eval`, `new Function`). Muốn đổi hành vi không qua duyệt ⇒ tải
  **cấu hình** (JSON) từ server, không tải mã.
- Gọi server qua API có xác thực: token phiên của chính người dùng, không dùng khoá chung nhúng trong extension.
- Khoá dịch vụ trả phí ở server; extension chỉ gọi server của mình, server có rate limit theo người dùng.
- Bản cũ tồn tại lâu (cửa hàng duyệt chậm, người dùng tắt cập nhật) ⇒ áp mục "Phiên bản tối thiểu được hỗ trợ" ở trên.
- Quyền khai trong manifest: chỉ xin cái dùng (quyền tối thiểu — trang Chrome đã đọc không nói mục này, kinh nghiệm).

## Nguồn

- https://v3.wails.io/guides/updater
- https://v3.wails.io/tutorials/04-self-update-a-wails-app/
- https://pkg.go.dev/github.com/creativeprojects/go-selfupdate
- https://developer.chrome.com/docs/extensions/develop/migrate/improve-security
- https://docs.stripe.com/api/idempotent_requests (khuôn nhận lại thay đổi idempotent)
- Chưa có nguồn trong bộ nghiên cứu: SQLite WAL/thư viện Go, offline-first, ghi sau thắng/gộp theo trường/CRDT, ký code
  Windows, khác biệt 3 hệ điều hành, quyền hệ điều hành, báo crash, kho khoá hệ điều hành, quyền tối thiểu extension.

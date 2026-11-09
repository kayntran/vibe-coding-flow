# Chốt từ ngày đầu theo loại app

Dùng ngay sau bước 3 (tạo) của `flow-new-app`. Chỉ đọc mục đúng loại app. Mỗi điều: chốt gì · để sau thì người dùng cũ bị gì · làm
thế nào · kiểm bằng gì. Chốt xong ghi một dòng vào `AI_RULES.md` của app để phiên sau không đổi bừa. Thông số nền tảng (cách làm của
Google/Apple/Microsoft) đổi theo thời gian ⇒ tra tài liệu chính hãng lúc làm, không làm theo trí nhớ.

## Extension (Chrome)

- **ID cố định.** Chrome sinh ID từ khoá công khai; không cố định thì bản chạy thử và bản trên Chrome Web Store mang hai ID khác nhau
  ⇒ đăng nhập Google, máy chủ, trang web đã ghi nhận ID cũ sẽ từ chối bản thật. Cách: theo hướng dẫn "giữ ID extension cố định" của
  Chrome (lấy khoá công khai từ trang quản lý Web Store, đưa vào `key` của manifest cho bản chạy thử). Khoá riêng nếu có ⇒ kho khoá,
  không vào git. Mọi chỗ cần ID (địa chỉ chuyển về sau đăng nhập, danh sách được phép gọi của máy chủ) dùng ID này. Kiểm: nạp bản chạy
  thử, ID khớp ID ghi trong `AI_RULES.md`.
- **Danh sách quyền.** Bản đã phát hành mà xin thêm quyền ⇒ Chrome tắt extension tới khi từng người dùng bấm đồng ý lại, nhiều người
  bỏ luôn. Mẫu đã không xin quyền nào; khi tính năng cần quyền ⇒ cân nhắc từ sớm, quyền chỉ dùng thỉnh thoảng thì xin lúc cần
  (`optional_permissions`).
- **Phiên bản khi gọi máy chủ.** Bản cũ nằm lại trên máy người dùng nhiều ngày ⇒ mọi lời gọi máy chủ gửi kèm số phiên bản extension từ
  bản đầu, để máy chủ còn biết mà giữ tương thích hoặc báo "cập nhật extension".

## App máy tính (Wails)

- **Mã định danh app** (tên công ty, tên sản phẩm, mã định danh kiểu `com.<tên>.<app>` trong cấu hình Wails). Đổi sau ⇒ hệ điều hành
  coi là app khác: người dùng mất dữ liệu ở thư mục cũ, mất quyền đã cấp, lối tắt hỏng. Chốt ngay khi tạo, không dùng tên tạm.
- **Nơi lưu dữ liệu của người dùng trên máy.** Thư mục dữ liệu chuẩn của hệ điều hành theo mã định danh (Go: `os.UserConfigDir()`
  + tên app), không ghi cạnh file chạy (thư mục cài đặt thường không ghi được và bị xoá khi cập nhật). Ghi đường dẫn vào
  `docs/ARCHITECTURE.md`.
- **Khoá ký bản cập nhật, có từ bản đầu tiên.** Bản đã cài chỉ tin bản mới ký bằng khoá nó biết. Bản đầu không có phần tự cập nhật,
  hoặc mất khoá ⇒ khách phải gỡ và cài lại bằng tay. Cách: tạo cặp khoá một lần; khoá công khai nhúng trong app; khoá riêng vào kho
  khoá và một bản sao lưu thứ hai; bản đầu đã có phần kiểm cập nhật (có thể chưa bật). Kiểm: bản thử nhận một gói ký sai ⇒ từ chối.
- **Số phiên bản dữ liệu.** File/cơ sở dữ liệu trên máy mang số phiên bản (SQLite `user_version`) để bản sau tự nâng cấp dữ liệu cũ.
- Chữ ký số của hệ điều hành (chứng chỉ Windows, tài khoản Apple Developer) chưa cần lúc tạo; ghi vào lộ trình, cần trước khi phát
  hành rộng (không có thì máy khách hiện cảnh báo "không rõ nguồn gốc").

## Webapp

- **Cài ra màn hình điện thoại** — chỉ khi user muốn "app điện thoại" (kit chưa có mẫu app điện thoại). Thêm web app manifest (tên,
  biểu tượng các cỡ, mở toàn màn hình), biểu tượng cho iPhone, service worker tối thiểu chỉ lưu sẵn phần vỏ giao diện, **không** lưu
  dữ liệu riêng của người dùng hay lời gọi cần đăng nhập. iPhone: người dùng tự "Thêm vào màn hình chính" trong Safari ⇒ màn đầu có
  một dòng hướng dẫn. Kiểm: công cụ Lighthouse báo cài được; mở từ màn hình chính không có thanh địa chỉ.
- **Tên miền trước khi gắn đăng nhập Google và gửi email.** Địa chỉ chuyển về sau đăng nhập, tên người gửi email đều gắn tên miền; làm
  trên địa chỉ tạm rồi đổi ⇒ phải sửa cấu hình nhiều nơi, link trong email cũ chết. Chưa có tên miền ⇒ ghi vào lộ trình, chưa gắn hai
  thứ này.
- **Dạng link công khai** (link chia sẻ, link trong email) sẽ nằm lại trong tin nhắn của khách ⇒ chốt dạng đường dẫn từ đầu, dùng ID
  khó đoán; đổi dạng sau thì giữ đường chuyển tiếp từ link cũ.

# Chạy thử theo loại app

- **Webapp / tiện ích (linux):** làm hết trên máy ảo:
  - `run -- "<setup>"`;
  - lần đầu chạy `npx playwright install --with-deps chromium`;
  - chạy dev server nền, rồi chạy Playwright ngay trên máy ảo, ảnh ghi vào một thư mục rồi `get` về.

  Muốn mở bằng trình duyệt máy user (cho user xem) ⇒ `forward <PORT_BASE>:<cổng app>`.
- **Desktop Windows:** lệnh qua ssh chạy ở phiên ẩn, nên app GUI phải mở bằng `gui [--cwd <thư mục>] -- <exe> <args>`
  (hiện trên màn hình của máy ảo).
  - Electron: thêm `--remote-debugging-port=<R>`. Bản dev: `gui --cmd "npm run dev -- --remoteDebuggingPort <R>"`.
  - Wails/WebView2: đặt `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<R>`.

  Sau đó `forward <PORT_BASE>:<R>`, rồi Playwright trên máy user `chromium.connectOverCDP('http://127.0.0.1:<PORT_BASE>')`.
  Chỉ một kết nối CDP, không mở trình duyệt ngầm nào trên máy user.
- **Âm thanh trên Windows:** dịch vụ âm thanh tắt sẵn. `"audio": true` ⇒ `up` bật dịch vụ. Máy ảo không có loa/mic
  thật, chỉ có thiết bị ảo do app cài (vd VB-CABLE). Cần mic/loa thật ⇒ nhãn `real-audio` ⇒ máy user.
- **App Mac:** máy macos, cùng các bước.
- **Thử cài trên máy sạch:** tải bản cài trên máy ảo (`run -- "curl -L -o …"`), cài im lặng, mở bằng `gui`. Máy của dự
  án đã cài bản cũ mà cần máy sạch thật ⇒ `rm` rồi `up`, mất đồ đã cài (ghi vào báo cáo).
- **Kit trên Mac:** `node ~/.claude/hooks/mac-check.mjs` mặc định chạy trên máy macOS Devin. `--host <ssh>` chỉ dùng
  khi có Mac riêng.

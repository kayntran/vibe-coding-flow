---
name: flow-devin
description: Chạy thử app trên máy ảo Devin (Windows/Ubuntu/macOS) thay máy user — chọn máy, đánh thức hoặc tạo máy riêng của dự án, chép code đang sửa, chạy app + Playwright, chụp ảnh qua cổng chuyển, đưa khoá, xong LUÔN cho máy ngủ. Dùng khi flow-qa / qa-tester / debugger cần mở app, chạy test Playwright, thử cài trên máy sạch, kiểm kit trên Mac, hoặc user nói "test trên máy ảo", "dùng Devin", "xoá máy ảo". KHÔNG dùng cho lint/typecheck/unit test (chạy máy user) hay việc cần GPU, mic/loa thật, đo tốc độ.
---

# Máy ảo Devin để chạy thử

Quyết định: sổ chốt phạm vi `2026-10-31-may-ao-devin` của kit. Mở app, Playwright, làm lại lỗi ⇒ mặc định máy ảo
[cs5v][z7pn][9igc]. Mỗi dự án một máy cho mỗi hệ điều hành, xong cho ngủ, không xoá [q56e]. Code lấy từ GitHub
kayntran, phần chưa đẩy thì chép riêng, KHÔNG đẩy nhánh [65mm]. Khoá tự đưa khi cần [4vrh]. Kit trên Mac ⇒ máy macOS
Devin [olp6].

Công cụ duy nhất: `node ~/.claude/hooks/devin-vm.mjs <lệnh>` (`--help` liệt kê). Không gọi REST/MCP/`devin ssh` tay.

## 1. Chọn nơi chạy — luôn hỏi công cụ
```
node ~/.claude/hooks/devin-vm.mjs where --dir <repo> [--need <nhãn,…>]
```
- `runner:"devin"` + `os` ⇒ làm mục 2.
- `runner:"local"` ⇒ chạy máy user như cũ (Playwright `--workers=2`). Báo user một dòng `reason`. Có `login` ⇒ đưa
  đúng lệnh đó. Không dừng việc.
- Nhãn `--need` lấy từ charter. Nhãn nằm trong danh sách `local` của dự án ⇒ máy user. Nhãn thường dùng:
  - `gpu`: card đồ hoạ;
  - `real-audio`: mic/loa thật;
  - `perf`: đo tốc độ, độ trễ;
  - `usb`: thiết bị cắm vào máy;
  - `user-data`: dữ liệu chỉ có trên máy user.

Cấu hình dự án `.claude/devin.json`, ghi một lần (AI dự án được ghi):
```json
{ "os": "windows", "local": ["gpu", "real-audio", "perf"], "setup": "npm ci", "env": ["OPENROUTER_API_KEY"], "audio": true }
```
Thiếu file ⇒ công cụ tự dò loại app:
- Electron, Wails, .NET ⇒ windows;
- webapp, tiện ích trình duyệt ⇒ linux;
- Xcode, Swift package ⇒ macos.

Tắt Devin: cho một dự án ⇒ `{"off": true}`; cho cả máy ⇒ biến `DEVIN_VM=off`.

## 2. Một lần chạy
Ưu tiên `job`: tự `up` + `sync`, chạy lệnh của bạn, và **luôn cho máy ngủ** khi xong, lỗi hay bị ngắt.
```
node ~/.claude/hooks/devin-vm.mjs job --dir <repo> -- node <scratchpad>/qa/drive.mjs
```
Script lái nhận `DEVIN_VM_ID`, `DEVIN_VM_OS` và gọi lại `devin-vm.mjs run|forward|gui|get` với cùng `--dir`.

Làm từng bước tay thì theo thứ tự:
1. `up` — đánh thức máy (~30 s) hoặc tạo máy mới (~20 s). Lần đầu tự cài Node trên linux/mac; `--audio` bật âm thanh Windows.
2. `sync` — máy ảo chạy đúng bản đang sửa: so cây git hai bên, lệch ⇒ dừng. `--setup` chạy luôn lệnh `setup` của
   `devin.json`; `--full` chép cả bản code (kho không ở GitHub kayntran thì tự làm vậy).
3. `run -- "<cài phụ thuộc>"` (nếu chưa `--setup`).
4. Mở app (mục 3).
5. `forward` nếu cần.
6. Lái app, chụp màn hình.
7. `get` ảnh về `<scratchpad>/qa/`.
8. **`sleep`**, rồi kiểm `status` là `suspended`.

Bước 8 không được bỏ, kể cả khi bước trước lỗi.

**Giữ máy thức:** máy do công cụ tạo bị Devin cho ngủ sau ~5 phút không có tin nhắn. Lệnh ssh, app đang chạy hay cổng
chuyển đều không tính là hoạt động. Ngủ thì app trên máy ảo mất. Vì vậy:
- `job` và `forward` tự gửi tin "giữ máy" bằng SWE-2 cứ 4 phút một lần;
- `run`, `gui`, `sync` gửi khi lần gửi trước đã quá 3 phút.

Lỡ bị ngắt giữa chừng thì cũng nhờ chính cơ chế này mà máy tự ngủ sau ~5 phút.

**Đầu ra của `run`:** dòng dài có thể bị bẻ và chèn mã lạ, do Windows chạy ssh qua ConPTY. Không đọc dữ liệu từ đó; file
kết quả (ảnh, JSON) lấy bằng `get`. Gọi từ Git Bash thì `/c` bị đổi thành `C:/` ⇒ dùng `gui --cmd "<dòng lệnh>"`, đừng
dùng `-- cmd.exe /c …`.

## 3. Theo loại app
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

## 4. Khoá
`run --env TÊN1,TÊN2 -- <lệnh>` (hoặc `--env @config` = danh sách `env` trong `devin.json`). Giá trị lấy từ môi trường hoặc `.env` của dự án, chỉ sống trong lần chạy đó. Không ghi
file, không in giá trị, không qua tệp đính kèm. Báo cáo QA ghi **tên** khoá đã dùng.

## 5. Báo cáo
Thêm dòng `Nơi chạy: máy ảo Devin <os> (<id>)` hoặc `Nơi chạy: máy user — <lý do>`, kèm `Khoá đã dùng: <tên>|không`.
Ảnh, mã AC, `User duyệt giao diện`, dấu QA: giữ nguyên như skill `flow-qa`.

## 6. Hỏng & biên
- Exit 3 (Devin chưa đăng nhập, lỗi hoặc hết hạn mức) ⇒ chạy máy user, báo một dòng. Không vòng thử lại.
- Máy của dự án bị Devin xoá ⇒ `up` tự tạo máy mới.
- `sync` báo cây lệch ⇒ dừng, không test bản sai.
- Hai `job` cùng dự án (vd 2–3 qa-tester song song) dùng chung một máy: job sau tự chờ job trước (≤ 20 phút, quá hạn ⇒ máy
  user). `sleep` báo máy bận ⇒ để job kia tự cho ngủ; `--force` chỉ khi chắc job kia đã chết. Làm từng bước tay (không
  `job`) thì không có giữ chỗ ⇒ đừng chạy song song với job khác của cùng dự án.
- User nói "xoá máy ảo của dự án" ⇒ `rm --dir <repo> [--os <os>]`, kể user rằng code và khoá trên máy đó mất theo.
  Devin bỏ qua lệnh xoá khi máy đang ngủ, nên công cụ tự đánh thức máy trước (~30 s) rồi mới xoá.
- Chỉ dùng SWE-2 để bật máy. Không giao việc cho AI của Devin, không gửi prompt nào khác.
- Phanh hạn mức: hạn mức NGÀY của Devin còn dưới 20% ⇒ `where` trả `runner:"local"` (kèm giờ hồi, giờ Việt Nam) và
  `up` từ chối bật/đánh thức máy, nên `job` tự chạy máy user. Đổi ngưỡng bằng biến `DEVIN_VM_MIN_DAILY`. `status` cho
  thấy `quota` (`daily`/`weekly` %, giờ hồi); không đọc được số thì không chặn. `devin-vm.log` ghi % ngày lúc bắt đầu và
  lúc xong của `up` / `job` để biết mỗi lần chạy tốn bao nhiêu.
- Phí: máy thức trừ hạn mức Devin (~2% ngày / 30 phút), máy ngủ không trừ. Xem máy đang thức: `status --all`. Đo thật
  31/10: một ngày dựng và thử (8 máy, có lúc 3–4 máy thức cùng lúc) tốn 100% hạn mức ngày và 53% hạn mức tuần.

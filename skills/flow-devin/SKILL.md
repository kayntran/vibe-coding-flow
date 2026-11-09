---
name: flow-devin
description: Chạy thử app trên máy ảo Devin (Windows/Ubuntu/macOS) thay máy user — chọn máy, đánh thức hoặc tạo máy riêng của dự án, chép code đang sửa, chạy app + Playwright, chụp ảnh qua cổng chuyển, đưa khoá, xong LUÔN cho máy ngủ. Dùng khi flow-qa / qa-tester / debugger cần mở app, chạy test Playwright, thử cài trên máy sạch, kiểm kit trên Mac, hoặc user nói "test trên máy ảo", "dùng Devin", "xoá máy ảo". KHÔNG dùng cho lint/typecheck/unit test (chạy máy user) hay việc cần GPU, mic/loa thật, đo tốc độ.
user-invocable: false
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
4. Mở app (mục 3, `references/theo-loai-app.md`).
5. `forward` nếu cần.
6. Lái app, chụp màn hình.
7. `get` ảnh về `<scratchpad>/qa/`.
8. **`sleep`**, rồi kiểm `status` là `suspended`.

Bước 8 không được bỏ, kể cả khi bước trước lỗi.

**Giữ máy thức:** máy do công cụ tạo bị Devin cho ngủ sau ~5 phút không có tin nhắn. Lệnh ssh, app đang chạy hay cổng
chuyển đều không tính là hoạt động. Ngủ thì app trên máy ảo mất. Vì vậy:
- `job` và `forward` tự gửi tin "giữ máy" cứ 4 phút một lần;
- `run`, `gui`, `sync` gửi khi lần gửi trước đã quá 3 phút.

Lỡ bị ngắt giữa chừng thì cũng nhờ chính cơ chế này mà máy tự ngủ sau ~5 phút.

**Đầu ra của `run`:** dòng dài có thể bị bẻ và chèn mã lạ, do Windows chạy ssh qua ConPTY. Không đọc dữ liệu từ đó; file
kết quả (ảnh, JSON) lấy bằng `get`. Gọi từ Git Bash thì `/c` bị đổi thành `C:/` ⇒ dùng `gui --cmd "<dòng lệnh>"`, đừng
dùng `-- cmd.exe /c …`.

## 3. Theo loại app
Cách mở app và lái theo từng loại (webapp, desktop Windows, âm thanh, Mac, máy sạch, kit trên Mac) ⇒ `references/theo-loai-app.md`.

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
- Hai `job` cùng dự án dùng chung một máy; làm từng bước tay (không `job`) thì không có giữ chỗ ⇒ đừng chạy song song với
  job khác của cùng dự án. Chi tiết chạy chung, xoá máy, chế độ tạo máy, phanh hạn mức, phí ⇒ `references/van-hanh-han-muc.md`.
- User nói "xoá máy ảo của dự án" ⇒ `rm --dir <repo> [--os <os>]`, kể user rằng code và khoá trên máy đó mất theo.

## Đọc khi cần

- `references/theo-loai-app.md` — đọc khi bắt đầu mở app và lái: chọn cách theo loại app (webapp, Windows, âm thanh, Mac, máy sạch, kit trên Mac)
- `references/van-hanh-han-muc.md` — đọc khi có nhiều job cùng dự án, khi xoá máy ảo, khi `where`/`up` trả về do hạn mức Devin, hoặc khi cần biết phí

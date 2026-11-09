# Design token — 3 tầng, đủ từ đầu [zgp6]

Mọi app có giao diện phải có bộ token này **trước màn đầu tiên** (`flow-new-app` dựng ngay khi tạo; app có sẵn chưa có token thì
dựng trước khi làm màn mới). Giá trị đầu lấy từ bảng mặc định khi chưa có gu; chọn xong bản demo thì chốt lại theo bản đó, ghi hướng gu vào sổ chốt.
Định dạng tham chiếu: W3C Design Tokens (DTCG) — không bắt buộc xuất file JSON, chỉ cần một nguồn trong code.

## 3 tầng

| Tầng | Là gì | Đặt tên theo | Ai được dùng |
|---|---|---|---|
| **1. Primitive (gốc)** | Giá trị thô: bảng màu, thang cỡ, thang khoảng cách | Giá trị (`--gray-100`, `--space-4`, `--radius-2`) | Chỉ tầng 2 trỏ vào |
| **2. Semantic (vai trò)** | Ý nghĩa: nền, chữ, viền, màu nhấn, lỗi… Trỏ vào tầng 1 | Vai trò (`--color-bg`, `--color-danger`) | Màn và thành phần |
| **3. Component (thành phần)** | Riêng cho nút, ô nhập, thẻ, bảng, tab, hộp thoại. Trỏ vào tầng 2 | Thành phần + phần + trạng thái (`--button-primary-bg-hover`) | Chính thành phần đó |

- Màn hình **không** dùng tầng 1 và **không** gõ số rời; máy `ui-token` của `flow-check` nhắc khi thấy màu/cỡ gõ cứng.
- Chế độ sáng/tối và độ dày chỉ đổi **tầng 2** (và vài token kích thước tầng 3); tầng 1 giữ nguyên.
- Tầng 3 chỉ tạo cho thành phần dùng từ 2 chỗ trở lên hoặc có biến thể; còn lại dùng thẳng tầng 2.

## 8 nhóm token

| Nhóm | Tầng 1 (gốc) | Tầng 2 tối thiểu (vai trò) |
|---|---|---|
| **Màu sắc** | Thang xám 50-950, thang màu nhấn 50-950, đỏ, vàng, xanh lá, xanh dương | `bg`, `bg-subtle`, `surface`, `surface-raised`, `text`, `text-muted`, `text-on-accent`, `border`, `border-strong`, `accent`, `success`, `warning`, `danger`, `info` (mỗi màu trạng thái có thêm bản nền nhạt), `overlay`, `focus-ring` |
| **Typography** | Họ font sans có đủ dấu tiếng Việt (Be Vietnam Pro, Inter, Noto Sans) + mono; cỡ 12/14/16/18/20/24/30/36; độ đậm 400/500/600(/700); cao dòng 1.2/1.4/1.5 | `text-body` (16), `text-small` (14), `text-caption` (12), `text-label`, `heading-1..3`, `number` (số thẳng cột `tabular-nums`) |
| **Khoảng cách & kích thước** | Thang bước 4px: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 | `space-inline` (giữa phần tử cạnh nhau), `space-stack` (giữa khối), `space-section`, `control-height` sm/md/lg, `icon-size` sm/md, `touch-min` 44, `content-max-width` |
| **Bo góc** | 0, 4, 8, 12, 16, full | `radius-control` (nút, ô), `radius-card`, `radius-dialog`, `radius-pill` |
| **Đổ bóng & độ sâu** | 2 bậc bóng dùng thật (`shadow-1` lớp nổi, `shadow-2` hộp thoại) | `elevation-raised`, `elevation-overlay`; thứ tự lớp `z-base`, `z-sticky`, `z-dropdown`, `z-overlay`, `z-dialog`, `z-toast` |
| **Độ trong suốt / mờ** | 0, 8%, 16%, 40%, 64%; mờ nền 4/8/16px | `opacity-disabled`, `overlay-backdrop` (nền mờ sau hộp thoại), `hover-tint`, `blur-overlay` |
| **Chuyển động** | Thời lượng 100/150/250/400ms; đường cong chuẩn, vào, ra | `motion-fast` (đổi trạng thái), `motion-normal` (mở/đóng), `motion-slow` (chuyển màn); tôn trọng `prefers-reduced-motion` (về 0) |
| **Điểm dừng giao diện** | 390 (điện thoại), 768 (máy tính bảng), 1024, 1280 (máy tính) | `bp-mobile`, `bp-tablet`, `bp-desktop` — đúng 3 cỡ kit luôn soát (390, 768, 1280) |

## Token trạng thái tương tác

Mọi thành phần bấm được (nút, link, ô nhập, tab, checkbox, dòng chọn được) có đủ token cho từng trạng thái, ở tầng 3 hoặc tầng 2:

| Trạng thái | Khi nào | Token và luật |
|---|---|---|
| **Mặc định** | Bình thường | `*-bg`, `*-text`, `*-border` |
| **Hover** | Rê chuột | `*-bg-hover`. Không phải dấu hiệu duy nhất (điện thoại không có hover) |
| **Active / Pressed** | Đang nhấn giữ | `*-bg-active` (đậm hơn hover một bậc) |
| **Focus** | Đi tới bằng phím Tab | `focus-ring` (màu, dày 2px, cách 2px), chỉ hiện khi dùng bàn phím (`:focus-visible`), tương phản ≥ 3:1 với nền ở cả sáng và tối. **Không bao giờ bỏ** |
| **Disabled** | Bị vô hiệu hoá | `*-bg-disabled`, `*-text-disabled` hoặc `opacity-disabled`; vẫn đọc được; không bắt sự kiện |
| **Selected / Activated** | Đang được chọn (tab, checkbox, dòng, mục menu) | `*-bg-selected`, `*-text-selected`, `*-border-selected`; khác hover rõ ràng, không chỉ dựa vào màu (thêm dấu, viền hoặc chữ đậm) |

Kèm trạng thái của thao tác: `loading` (nút đang xử lý), `invalid` (ô sai: viền + chữ lỗi), `readonly`.

## Chế độ xem (modes)

- **Màu sáng / tối (Color Schemes):** tầng 2 màu định nghĩa hai lần (sáng mặc định, tối dưới `.dark` hoặc `[data-theme="dark"]`),
  theo cài đặt máy (`prefers-color-scheme`) và cho người dùng đổi nếu app cần. Tối: không đen tuyệt đối, lớp càng nổi càng sáng hơn,
  màu nhấn giảm độ chói; kiểm lại tương phản và vòng focus ở cả hai.
- **Độ dày (Density Modes):** **Rộng rãi** (mặc định, hợp cảm ứng: nút 44px, khoảng cách theo thang) và **Dày đặc** (bảng, dashboard
  nhiều dữ liệu: nút 32px, đệm giảm một bậc thang) dưới `[data-density="compact"]`. Chỉ đổi token khoảng cách và kích thước; màn
  cảm ứng luôn giữ vùng bấm ≥ 44px.

## Đặt ở đâu

| Stack | Chỗ đặt |
|---|---|
| Tailwind v4 + shadcn (mẫu web của kit) | Một file `src/styles/tokens.css`: tầng 1 trong `@theme`, tầng 2 là biến CSS ở `:root`, `.dark`, `[data-density="compact"]` và ánh xạ sang tên theme của shadcn; tầng 3 là biến CSS theo thành phần |
| Wails / CSS thuần | `frontend/src/styles/tokens.css`, cùng cấu trúc bằng `:root` |
| Extension | Như web, một file token dùng chung cho popup và trang cài đặt |

Thêm giá trị mới ⇒ thêm token đúng tầng rồi dùng. Đổi gu ⇒ chỉ sửa tầng 1 và tầng 2, không sửa từng màn.

import type { Config } from "@react-router/dev/config";

export default {
  // Code của app nằm trong src/ (không phải app/) để giữ cấu trúc src/features/* của kit (docs/arch.json).
  appDirectory: "src",
  // Trang công khai được dựng ở máy chủ (Worker): Google và bot xem trước link (Zalo, Facebook) đọc được HTML ngay.
  // Đặt false = app một trang chạy ở trình duyệt, MẤT SEO — chỉ đổi khi người dùng đã chọn như vậy.
  ssr: true,
} satisfies Config;

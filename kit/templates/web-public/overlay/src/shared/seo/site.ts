// Thông tin chung của web, dùng cho thẻ SEO mặc định. Đổi tên và mô tả thành của app thật khi có SPEC.
export const SITE = {
  name: "{{APP_NAME}}",
  description: "{{APP_NAME}} — trang đầu còn trống, chưa có nội dung.",
  locale: "vi_VN",
  // Ảnh chia sẻ mặc định (Zalo, Facebook) cho trang không có ảnh riêng: public/og-default.png, 1200x630.
  // Thay bằng ảnh thật của thương hiệu (cùng tên file, cùng cỡ). Ảnh riêng từng trang: truyền image vào seoMeta.
  ogImage: "/og-default.png",
  ogImageWidth: 1200,
  ogImageHeight: 630,
  // Chỉ dùng khi không đọc được SITE_URL của Worker (hiếm); địa chỉ thật đặt ở wrangler.jsonc (vars.SITE_URL).
  fallbackUrl: "https://example.com",
} as const;

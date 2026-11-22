import { type RouteConfig, index, route } from "@react-router/dev/routes";

// File route (src/routes/*) chỉ ráp tính năng từ src/features/*. Route công khai mới: thêm dòng ở đây, khai `meta` bằng seoMeta,
// thêm đường dẫn vào PAGES của e2e/seo.spec.ts. Khu sau đăng nhập đặt dưới "admin" (header noindex + no-store tự áp, xem workers/app.ts).
export default [
  index("routes/home.tsx"),
  route("sitemap.xml", "routes/sitemap.xml.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
] satisfies RouteConfig;

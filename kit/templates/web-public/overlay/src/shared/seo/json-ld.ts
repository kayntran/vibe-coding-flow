import type { MetaDescriptor } from "react-router";

// Dữ liệu có cấu trúc (JSON-LD) cho Google: thêm kết quả đẹp (giá, sao, đường dẫn…). Là dữ liệu, không phải mã chạy
// nên không vướng script-src của CSP. Dùng trong `meta` của route: [...seoMeta({...}), jsonLd({ "@context": "https://schema.org", "@type": "Product", ... })].
export const jsonLd = (data: Record<string, unknown>): MetaDescriptor => ({ "script:ld+json": data });

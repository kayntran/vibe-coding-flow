import type { MetaDescriptor } from "react-router";

import { SITE } from "./site";

type PageSeo = {
  // Địa chỉ gốc web: lấy bằng siteUrlOf(matches) (từ SITE_URL của Worker, không lấy từ tiêu đề Host).
  siteUrl: string;
  // Đường dẫn của trang, vd "/" hoặc "/san-pham/ao-thun".
  path: string;
  title: string;
  description: string;
  // Ảnh chia sẻ riêng của trang: đường dẫn hoặc địa chỉ công khai, KHÔNG cần đăng nhập. Bỏ trống = ảnh mặc định.
  image?: string;
  type?: "website" | "article" | "product";
};

const absoluteUrl = (siteUrl: string, path: string): string => new URL(path, siteUrl).toString();

// MỌI route công khai phải gọi hàm này trong `meta`: meta của route con THAY HẲN meta của route cha (không gộp),
// nên route nào quên khai là mất og:image, canonical… Trả đủ: title, mô tả, canonical, Open Graph (Zalo/Facebook), Twitter.
export function seoMeta(page: PageSeo): MetaDescriptor[] {
  const url = absoluteUrl(page.siteUrl, page.path);
  const image = absoluteUrl(page.siteUrl, page.image ?? SITE.ogImage);
  return [
    { title: page.title },
    { name: "description", content: page.description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:title", content: page.title },
    { property: "og:description", content: page.description },
    { property: "og:image", content: image },
    { property: "og:image:width", content: String(SITE.ogImageWidth) },
    { property: "og:image:height", content: String(SITE.ogImageHeight) },
    { property: "og:url", content: url },
    { property: "og:type", content: page.type ?? "website" },
    { property: "og:site_name", content: SITE.name },
    { property: "og:locale", content: SITE.locale },
    { name: "twitter:card", content: "summary_large_image" },
  ];
}

type MatchLike = { id: string; loaderData?: unknown } | undefined;

const hasSiteUrl = (v: unknown): v is { siteUrl: string } =>
  typeof v === "object" && v !== null && "siteUrl" in v && typeof v.siteUrl === "string";

// Địa chỉ gốc web do root loader (src/root.tsx) đọc từ SITE_URL; route nào cũng lấy được qua `matches` của meta.
export function siteUrlOf(matches: ReadonlyArray<MatchLike>): string {
  const data = matches.find((m) => m?.id === "root")?.loaderData;
  return hasSiteUrl(data) ? data.siteUrl : SITE.fallbackUrl;
}

import { env } from "cloudflare:workers";

import { PRIVATE_PREFIXES } from "~/shared/security/headers";

// robots.txt: cho Google đọc mọi trang công khai, chặn khu sau đăng nhập, chỉ đường tới sitemap.
export function loader() {
  const body = [
    "User-agent: *",
    "Allow: /",
    ...PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`),
    "",
    `Sitemap: ${new URL("/sitemap.xml", env.SITE_URL).toString()}`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

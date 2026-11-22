import type { ServerBuild } from "react-router";

import { isPrivatePath } from "../security/headers";

// sitemap.xml SINH TỪ ROUTE (không viết tay danh sách):
//  - Route tĩnh (đường dẫn không có :tham-số hay *) có thành phần trang (default export) ⇒ tự vào sitemap.
//  - Route có tham số (vd "san-pham/:slug") không tự vào được; muốn vào thì module route khai
//      export const handle = { sitemap: async () => [{ path: "/san-pham/ao-thun", lastmod: "2026-11-22" }, ...] }
//    (đọc danh sách từ nơi lưu dữ liệu của app). Route có `handle = { noindex: true }` thì không vào.
//  - Khu riêng (PRIVATE_PREFIXES: /admin) và route không phải trang (sitemap.xml, robots.txt) không bao giờ vào.
// Chuẩn sitemap: tối đa 50.000 địa chỉ mỗi file. Nhiều hơn ⇒ sitemap.xml trả danh sách các file con (?page=N); phần chia file đã có sẵn.
const MAX_URLS_PER_SITEMAP = 50_000;

export type SitemapUrl = { path: string; lastmod?: string };

type RouteInfo = ServerBuild["routes"][string];
type RouteMap = ServerBuild["routes"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isSitemapUrl = (v: unknown): v is SitemapUrl =>
  isRecord(v) && typeof v.path === "string" && (v.lastmod === undefined || typeof v.lastmod === "string");

function fullPath(routes: RouteMap, route: NonNullable<RouteInfo>): string {
  const segments: string[] = [];
  for (let r: RouteInfo | undefined = route; r; r = r.parentId ? routes[r.parentId] : undefined) {
    if (r.path) segments.unshift(...r.path.split("/").filter(Boolean));
  }
  return `/${segments.join("/")}`;
}

async function urlsOfRoute(routes: RouteMap, route: NonNullable<RouteInfo>): Promise<SitemapUrl[]> {
  const mod: unknown = route.module;
  if (!isRecord(mod) || typeof mod.default !== "function") return [];
  const handle = mod.handle;
  if (isRecord(handle) && handle.noindex === true) return [];
  const path = fullPath(routes, route);
  if (!/[:*]/.test(path)) return [{ path }];
  if (!isRecord(handle) || typeof handle.sitemap !== "function") return [];
  const list: unknown = await handle.sitemap();
  return Array.isArray(list) ? list.filter(isSitemapUrl) : [];
}

export async function collectSitemapUrls(routes: RouteMap): Promise<SitemapUrl[]> {
  const found = new Map<string, SitemapUrl>();
  for (const route of Object.values(routes)) {
    if (!route) continue;
    for (const url of await urlsOfRoute(routes, route)) {
      if (!isPrivatePath(url.path) && !found.has(url.path)) found.set(url.path, url);
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export const pageCount = (urls: SitemapUrl[]): number => Math.max(1, Math.ceil(urls.length / MAX_URLS_PER_SITEMAP));

export function renderUrlset(siteUrl: string, urls: SitemapUrl[]): string {
  const items = urls.map((u) => {
    const loc = escapeXml(new URL(u.path, siteUrl).toString());
    return `  <url><loc>${loc}</loc>${u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : ""}</url>`;
  });
  return `${XML_HEAD}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</urlset>\n`;
}

export function renderIndex(siteUrl: string, pages: number): string {
  const items = Array.from({ length: pages }, (_, i) => `  <sitemap><loc>${escapeXml(new URL(`/sitemap.xml?page=${i + 1}`, siteUrl).toString())}</loc></sitemap>`);
  return `${XML_HEAD}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</sitemapindex>\n`;
}

// Phần của sitemap ứng với ?page=N (bắt đầu từ 1).
export const sitemapPage = (urls: SitemapUrl[], page: number): SitemapUrl[] =>
  urls.slice((page - 1) * MAX_URLS_PER_SITEMAP, page * MAX_URLS_PER_SITEMAP);

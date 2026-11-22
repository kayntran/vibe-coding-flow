import { env } from "cloudflare:workers";

import { collectSitemapUrls, pageCount, renderIndex, renderUrlset, sitemapPage } from "~/shared/seo/sitemap";
import { routeManifestContext } from "~/shared/server-context";

import type { Route } from "./+types/sitemap.xml";

// sitemap.xml sinh từ danh sách route (xem shared/seo/sitemap.ts). Nhiều hơn 50.000 địa chỉ ⇒ trả danh sách file con ?page=N.
export async function loader({ request, context }: Route.LoaderArgs) {
  const urls = await collectSitemapUrls(context.get(routeManifestContext));
  const pages = pageCount(urls);
  const asked = Number(new URL(request.url).searchParams.get("page"));
  const body =
    pages > 1 && !asked
      ? renderIndex(env.SITE_URL, pages)
      : renderUrlset(env.SITE_URL, sitemapPage(urls, Number.isInteger(asked) && asked > 0 ? asked : 1));
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

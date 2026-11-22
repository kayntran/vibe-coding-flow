import { HomeScreen } from "~/features/home/ui/home-screen";
import { seoMeta, siteUrlOf } from "~/shared/seo/seo-meta";
import { SITE } from "~/shared/seo/site";

import type { Route } from "./+types/home";

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({ siteUrl: siteUrlOf(matches), path: "/", title: SITE.name, description: SITE.description });
}

export default function Home() {
  return <HomeScreen />;
}

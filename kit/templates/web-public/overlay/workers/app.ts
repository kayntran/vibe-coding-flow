import { createRequestHandler, RouterContextProvider } from "react-router";

import { newNonce, withSecurityHeaders } from "../src/shared/security/headers";
import { nonceContext, routeManifestContext } from "../src/shared/server-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// Điểm vào duy nhất của Worker: MỌI phản hồi (trang dựng ở máy chủ, sitemap, 404, lỗi) đi qua withSecurityHeaders.
// public/_headers chỉ áp cho file tĩnh (JS, CSS, ảnh); Cloudflare không áp nó cho phản hồi do mã Worker tạo ra.
export default {
  async fetch(request, env) {
    const nonce = newNonce();
    const build = await import("virtual:react-router/server-build");
    const context = new RouterContextProvider();
    context.set(nonceContext, nonce);
    context.set(routeManifestContext, build.routes);
    const response = await requestHandler(request, context);
    return withSecurityHeaders(response, {
      nonce,
      url: new URL(request.url),
      dev: import.meta.env.DEV,
      version: env.CF_VERSION_METADATA?.id,
    });
  },
} satisfies ExportedHandler<Env>;

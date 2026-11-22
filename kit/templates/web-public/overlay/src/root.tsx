import { env } from "cloudflare:workers";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

// Địa chỉ gốc của web (SITE_URL ở wrangler.jsonc): route nào cũng đọc được qua `matches` của meta (siteUrlOf trong shared/seo).
export function loader() {
  return { siteUrl: env.SITE_URL };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Trang lỗi giữ ĐÚNG mã trạng thái (404 cho trang không có thật, 500 cho lỗi) và không cho Google ghi nhận.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;
  return (
    <main data-s="S-404" className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-2 p-6 text-center">
      <title>{notFound ? "Không tìm thấy trang" : "Có lỗi xảy ra"}</title>
      <meta name="robots" content="noindex" />
      <h1 className="text-2xl font-semibold">{notFound ? "Không tìm thấy trang" : "Có lỗi xảy ra"}</h1>
      <Link to="/" className="text-muted-foreground underline">
        Về trang chủ
      </Link>
      {stack && (
        <pre className="w-full overflow-x-auto p-4 text-left">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

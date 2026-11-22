import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";

import { nonceContext } from "~/shared/server-context";

export const streamTimeout = 5_000;

// Bản của kit dựa trên entry mặc định của React Router, thêm MỘT việc: nonce của CSP (Worker sinh, xem workers/app.ts)
// đi vào ServerRouter và renderToReadableStream để mọi script nội tuyến của trang mang đúng nonce đó.
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const nonce = loadContext.get(nonceContext);
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Lỗi trong lúc truyền dần nội dung (sau khi phần vỏ đã dựng xong) mới ghi lại; lỗi dựng phần vỏ đã được React Router ghi.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Bot (Google, Facebook, Zalo…) chờ dựng xong toàn bộ nội dung rồi mới nhận HTML, để thấy đủ thẻ và chữ.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}

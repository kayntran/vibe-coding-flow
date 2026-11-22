// Header bảo mật cho MỌI phản hồi do Worker tạo ra (workers/app.ts gọi withSecurityHeaders).
// Vì sao ở đây mà không chỉ public/_headers: _headers chỉ áp cho file tĩnh, KHÔNG áp cho trang dựng ở máy chủ.
//
// CSP có nonce: trang dựng ở máy chủ có script nội tuyến để "đánh thức" React; mỗi yêu cầu một nonce ngẫu nhiên đi vào
// script-src 'nonce-…' (entry.server.tsx đặt cùng nonce lên các thẻ script). Không nới thành 'unsafe-inline'.
// Dùng thêm dịch vụ ngoài (Analytics, Pixel, chat nhúng) ⇒ thêm ĐÚNG tên miền vào script-src / connect-src ở đây, hỏi người dùng trước.

// Đường dẫn chỉ dành cho người đã đăng nhập: không cho Google ghi nhận, không cho bộ nhớ đệm giữ.
export const PRIVATE_PREFIXES = ["/admin"] as const;

export const isPrivatePath = (pathname: string): boolean =>
  PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

type Options = {
  nonce: string;
  url: URL;
  // Chạy thử (react-router dev): Vite chèn script nội tuyến không có nonce nên bỏ CSP; bản build/preview luôn có CSP.
  dev?: boolean;
  version?: string;
};

export function withSecurityHeaders(response: Response, { nonce, url, dev = false, version }: Options): Response {
  // Bản sao có header sửa được (header của Response gốc có thể bất biến).
  const res = new Response(response.body, response);
  const h = res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!dev) h.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  if (version) h.set("x-flow-version", version);
  if (isPrivatePath(url.pathname)) {
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("Cache-Control", "private, no-store");
  } else if (url.hostname.endsWith(".workers.dev")) {
    // Địa chỉ *.workers.dev trả cùng nội dung với tên miền thật ⇒ không cho Google ghi nhận (tránh trùng nội dung).
    h.set("X-Robots-Tag", "noindex");
  }
  return res;
}

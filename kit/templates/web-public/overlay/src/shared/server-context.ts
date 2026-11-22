import { createContext, type RouterContext, type ServerBuild } from "react-router";

// Hai thứ Worker (workers/app.ts) giao cho mỗi yêu cầu, đọc bằng context.get(...) trong loader hoặc entry.server.tsx.
// nonce: mã dùng một lần của CSP cho script nội tuyến của trang. routeManifestContext: danh sách route (sitemap.xml sinh từ đây).
// Khai kiểu rõ ràng (không để TypeScript suy ra: kiểu suy ra trỏ vào file nội bộ của react-router, báo lỗi TS2742).
export const nonceContext: RouterContext<string> = createContext<string>();
export const routeManifestContext: RouterContext<ServerBuild["routes"]> = createContext<ServerBuild["routes"]>();

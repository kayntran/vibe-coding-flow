import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Cổng lấy từ biến PORT (mặc định 5173): nhiều bản sao app, hoặc nhiều lần kiểm chạy song song, đặt PORT khác nhau để khỏi đụng cổng.
// Chạy thử (react-router dev) và xem bản build (vite preview) dùng cùng cổng.
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: { port },
  preview: { port, strictPort: true },
});

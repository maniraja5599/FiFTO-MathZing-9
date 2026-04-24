import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 8008,
    strictPort: true,
    proxy: {
      '/nse-api': {
        target: 'https://www.nseindia.com',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/nse-api/, ''),
        configure: (proxy) => {
          // Accumulate cookies from NSE responses and forward them on subsequent requests
          let nseCookies = '';

          proxy.on('proxyRes', (proxyRes) => {
            const setCookie = proxyRes.headers['set-cookie'];
            if (setCookie) {
              const incoming = setCookie.map((c: string) => c.split(';')[0]).join('; ');
              nseCookies = nseCookies ? `${nseCookies}; ${incoming}` : incoming;
            }
          });

          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            proxyReq.setHeader('Accept', 'application/json, text/plain, */*');
            proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9,en-IN;q=0.8');
            proxyReq.setHeader('Referer', 'https://www.nseindia.com/option-chain');
            proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
            if (nseCookies) proxyReq.setHeader('Cookie', nseCookies);
          });
        },
      },
    },
  },
});

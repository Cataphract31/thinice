import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

function serveArcade(): Plugin {
  const root = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    process.env.ARCADE ?? "../../../GIELINOR",
    "arcade/web",
  );
  const handler = (req: any, res: any, next: () => void): void => {
    if (!req.url || !req.url.startsWith("/arcade/web/")) return next();
    const rel = decodeURIComponent(req.url.slice("/arcade/web/".length).split("?")[0]);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end(`no arcade checkout for: ${rel}`);
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "serve-arcade-wallet",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

const DEFAULT_BETA = "wss://34.70.75.204.sslip.io";

const DEFAULT_ARCADE = "https://gielinor.34-70-75-204.sslip.io";

export default defineConfig(({ command }) => {
  const url = process.env.VITE_SERVER_URL ?? (command === "build" ? DEFAULT_BETA : undefined);
  const arcade = process.env.VITE_ARCADE_URL ?? DEFAULT_ARCADE;
  return {
    base: "./",
    plugins: [react(), tailwindcss(), serveArcade()],
    resolve: {
      alias: {
        "@zinc/engine": fileURLToPath(
          new URL("../../packages/engine/src/index.ts", import.meta.url),
        ),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: { rollupOptions: { external: [/^\/arcade\/web\//] } },
    define: {
      ...(url !== undefined ? { "import.meta.env.VITE_SERVER_URL": JSON.stringify(url) } : {}),
      "import.meta.env.VITE_ARCADE_URL": JSON.stringify(arcade),
    },
    server: { port: 5173 },
  };
});

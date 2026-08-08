import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Standalone build for deployment: the engine lives in ./engine instead of a
// workspace package, so this folder builds on Vercel with no monorepo around it.

// The live beta server. Baked here — in a NORMAL file — because this folder is
// deployed by dragging it into GitHub's web uploader, which silently drops
// dot-files: a .env.production carrying this address never arrived, and the
// deploy quietly fell back to the offline single-player demo. An environment
// variable still overrides for other deployments; an explicit "demo" opts back
// into the offline build.
const raw = process.env.VITE_SERVER_URL ?? "wss://35.184.125.131.sslip.io";
/** Empty string = no server = the client runs its offline demo. */
const SERVER_URL = raw === "demo" ? "" : raw;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@zinc/engine": fileURLToPath(new URL("./engine/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    "import.meta.env.VITE_SERVER_URL": JSON.stringify(SERVER_URL || ""),
  },
});

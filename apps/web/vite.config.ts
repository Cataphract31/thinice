import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Which game a build talks to — resolved HERE, in the repo, not in a
 * dashboard.
 *
 * The beta address used to live baked inside the deleted upload/ mirror's
 * config, and when that mirror retired, the address was left to a Vercel
 * environment variable that nothing enforced. The variable went unset, the
 * client fell back to its designed offline mode, and the production site
 * spent a stretch serving the single-player demo crowd as if it were the
 * live room. A deploy's correctness must not depend on somebody remembering
 * a dashboard field.
 *
 * So: production builds default to the beta server. `VITE_SERVER_URL` still
 * overrides for any other deployment. There is no offline mode to fall into
 * any more — the demo client is deleted — so a build without a URL produces a
 * client that refuses to boot, loudly, instead of playing pretend. Dev takes
 * its URL from `.env.local` (the local server), never a baked default,
 * because `npm run dev` on a fresh clone must not quietly attach to the
 * public beta.
 */
const DEFAULT_BETA = "wss://34.70.75.204.sslip.io";

export default defineConfig(({ command }) => {
  const url = process.env.VITE_SERVER_URL ?? (command === "build" ? DEFAULT_BETA : undefined);
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@zinc/engine": fileURLToPath(
          new URL("../../packages/engine/src/index.ts", import.meta.url),
        ),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    // Set explicitly so the resolution above is the single authority over
    // what a production bundle connects to.
    define: url !== undefined ? { "import.meta.env.VITE_SERVER_URL": JSON.stringify(url) } : {},
    server: { port: 5173 },
  };
});

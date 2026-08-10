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
 * overrides for any other deployment, and the literal value `demo` opts a
 * build back into the offline game on purpose. Dev is the opposite — it
 * defaults to whatever `.env.local` says (the local server, usually), and to
 * the offline demo when nothing is set, because `npm run dev` on a fresh
 * clone must never quietly attach to the public beta.
 */
const DEFAULT_BETA = "wss://34.70.75.204.sslip.io";

export default defineConfig(({ command }) => {
  const raw = process.env.VITE_SERVER_URL ?? (command === "build" ? DEFAULT_BETA : undefined);
  const url = raw === "demo" ? "" : raw;
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
    // Set explicitly so the resolution above is the single authority: without
    // this, an .env file could hand the raw variable straight to the client
    // and bypass the "demo" opt-out spelling.
    define: url !== undefined ? { "import.meta.env.VITE_SERVER_URL": JSON.stringify(url) } : {},
    server: { port: 5173 },
  };
});

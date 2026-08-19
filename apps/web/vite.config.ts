import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * THE ARCADE'S WALLET IS FETCHED, NOT COPIED.
 *
 * This app used to carry eight files of it in src/arcade/, kept in step by a
 * sync script. They were byte-identical to C:\GIELINORrcade\web\ by
 * construction -- that was the point -- and they still cost a sync, a rebuild
 * and a re-vendor every time a wallet bug was fixed, in three separate repos,
 * for a fix that was already written.
 *
 * The copies existed for one reason and it was never about the wallet: a
 * bundler in a separate repository cannot resolve `#arcade/web/wallet.js`,
 * because that import map is the arcade's and the file is not in this tree.
 * Build-time resolution, nothing else.
 *
 * SO IT IS NOT RESOLVED AT BUILD TIME ANY MORE. Every world is served from one
 * origin -- voidsolana.com/thin-ice/ sits beside voidsolana.com/arcade/web/,
 * which the arcade's .vercelignore publishes on purpose -- so the specifier is
 * a real URL on the same site. Marked external below, the import survives into
 * the output untouched and the browser fetches the one copy the arcade serves,
 * `must-revalidate`, so a fix lands the moment GIELINOR deploys.
 *
 * WHAT THIS TRADES, PLAINLY: no version pinning. A broken wallet.js breaks
 * every world at once instead of one at a time. Chosen deliberately; the way
 * back is to import a copy again.
 *
 * AND DEV FETCHES IT TOO, from the arcade checkout next door, so `npm run dev`
 * exercises the real module over a real request rather than a bundled stand-in.
 * Without a checkout it 404s, which is loud and honest -- the alternative is a
 * dev build that silently disagrees with production.
 */
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

/**
 * Where the ARCADE is, which is a different box from the game.
 *
 * This game holds no money: balances live in the arcade's shared ledger and
 * deposits and withdrawals happen at the arcade's one custody edge. The bank
 * panel therefore talks to a second origin.
 *
 * IT IS USED EVERYWHERE EXCEPT LOCALHOST, including from
 * voidsolana.com/thin-ice/ where the panel could have gone same-origin through
 * the portal's /api/* proxy instead. It does not: game/arcade.ts goes DIRECT to
 * the box, matching CURSORS.EXE, on the grounds that only one of the two roads
 * is already carrying signed custody traffic in production and money is a poor
 * place to be the first caller down a new one. The cost is one entry in the
 * box's ALLOWED_ORIGINS, which the two voidsolana hosts already have.
 *
 * `VITE_ARCADE_URL` overrides it at build time. The `?arcade=` query override
 * is LOCALHOST ONLY -- see the note in game/arcade.ts for why that matters when
 * the thing on the other end decides where a transfer goes.
 */
const DEFAULT_ARCADE = "https://gielinor.34-70-75-204.sslip.io";

export default defineConfig(({ command }) => {
  const url = process.env.VITE_SERVER_URL ?? (command === "build" ? DEFAULT_BETA : undefined);
  const arcade = process.env.VITE_ARCADE_URL ?? DEFAULT_ARCADE;
  return {
    /*
     * RELATIVE, BECAUSE THIS GAME HAS TWO HOMES.
     *
     * It is served from its own deploy at the root AND from a folder on the
     * arcade, voidsolana.com/thin-ice/. The folder is the point: a wallet
     * extension grants access PER SITE, so a game on its own subdomain costs
     * the player a second permission dialog, and a game in a folder of the
     * portal's own site costs nothing -- one approval covers every world. A
     * root-relative base would 404 every asset in one of the two homes.
     */
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
    /* The arcade's wallet is a URL on this same site, not a file in this repo.
       Marked external so the import survives into the output untouched and the
       browser fetches the one copy the arcade serves. See serveArcade above. */
    build: { rollupOptions: { external: [/^\/arcade\/web\//] } },
    // Set explicitly so the resolution above is the single authority over
    // what a production bundle connects to.
    define: {
      ...(url !== undefined ? { "import.meta.env.VITE_SERVER_URL": JSON.stringify(url) } : {}),
      "import.meta.env.VITE_ARCADE_URL": JSON.stringify(arcade),
    },
    server: { port: 5173 },
  };
});

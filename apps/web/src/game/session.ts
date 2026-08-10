import { NetClient } from "./net";

/**
 * The one client this build can produce.
 *
 * There used to be a second: with no server URL configured, the browser fell
 * back to a full offline simulation. That fallback put the demo on the
 * production domain once, wearing the live game's face, so it is gone — the
 * URL is resolved at build time (vite.config.ts bakes the beta address into
 * production builds) and a build that somehow lacks one refuses to boot
 * rather than quietly playing pretend.
 */
const url = import.meta.env.VITE_SERVER_URL as string | undefined;

let instance: NetClient | null = null;

export function getClient(): NetClient {
  if (!instance) {
    if (!url) {
      throw new Error(
        "no VITE_SERVER_URL: this build has no game server. " +
          "Set it in apps/web/.env.local (dev) or the build environment.",
      );
    }
    instance = new NetClient(url);
  }
  return instance;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instance?.destroy();
    instance = null;
  });
}

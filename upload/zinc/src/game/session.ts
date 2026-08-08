import { getGameClient, type GameClient } from "./client";
import { NetClient } from "./net";

/**
 * Which game you are actually playing.
 *
 * With `VITE_SERVER_URL` set the browser talks to the real server and decides
 * nothing; without it, it runs the local demo against bots. Both produce the
 * same `Snapshot`, so every component upstream of here is identical in both
 * modes — which is what makes going live a configuration change rather than a
 * rewrite.
 */
export type AnyClient = GameClient | NetClient;

const url = import.meta.env.VITE_SERVER_URL as string | undefined;

let instance: AnyClient | null = null;

export function getClient(): AnyClient {
  if (!instance) instance = url ? new NetClient(url) : getGameClient();
  return instance;
}

/** True when this build is pointed at a server. */
export const NETWORKED = Boolean(url);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instance?.destroy();
    instance = null;
  });
}

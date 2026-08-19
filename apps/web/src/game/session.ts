import { NetClient } from "./net";

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

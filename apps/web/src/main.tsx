import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CrashScreen } from "./ui/Crash";
import { completeDeeplink } from "@/game/arcade";
import "./styles.css";

/*
 * FINISH A TRIP TO A WALLET APP, BEFORE ANYTHING ELSE ON THIS PAGE.
 *
 * On a phone the wallet is another app. Signing in NAVIGATES: this tab is
 * destroyed, the wallet opens, and the player comes back to a FRESH page load
 * with the answer in the query string. Nothing that started the trip still
 * exists, so the work has to be picked up here, on load, by whatever runs
 * first. arcadeSignIn's own note in game/arcade.ts says exactly this -- "the
 * player returns to a fresh load where completeDeeplink() finishes the job".
 *
 * IT WAS ONLY EVER CALLED INSIDE THE BANK PANEL, and that is the whole bug.
 * The Bank was where the phone DEPOSIT round trip landed, so the call went in
 * beside it and looked complete. But the SIGN-IN round trip starts at the Hud
 * chip, and comes back to a page with no Bank mounted -- so nothing read the
 * reply, no session was ever minted, and the URL still carried the wallet's
 * answer while the chip went on asking the player to sign in. Pressing it
 * again did the same nothing. Reported as: "i pressed sign in, my wallet
 * opened, then it went back to my browser but im still not signed in, even if
 * i do the whole sign in thing 5 times it never signs in."
 *
 * HERE RATHER THAN IN A COMPONENT because it must not depend on which screen
 * happens to be mounted -- that dependency IS the bug. It is memoised inside
 * the module, so the Bank's own call is still correct and still cheap: the
 * first caller does the work and every later one gets its answer. And it is
 * cheap on every ordinary load, returning immediately when the URL carries no
 * reply.
 */
void completeDeeplink();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);

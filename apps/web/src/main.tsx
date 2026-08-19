import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CrashScreen } from "./ui/Crash";
import { completeDeeplink } from "@/game/arcade";
import "./styles.css";

void completeDeeplink();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);

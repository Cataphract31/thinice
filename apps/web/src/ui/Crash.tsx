import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line. A render error anywhere in the tree would otherwise unmount
 * the whole application: React tears everything down and the player is left
 * staring at a blank page with, as far as they know, money on the table.
 *
 * This cannot happen to a gambling product. The boundary catches the throw
 * and puts up an honest screen with the one action that always works. It
 * deliberately renders from nothing — no Snapshot, no client, no styles.css
 * classes beyond what inline styles restate — because whatever broke the tree
 * must not be able to break the screen that reports it.
 *
 * The socket and the round are unharmed: the game client lives outside React
 * and the server settles a vanished player by its own rules (auto cash-out on
 * disconnect, refunds on abort). Reloading rejoins the same session.
 */
export class CrashScreen extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the bug report channel; there is no telemetry to send to.
    console.error("render crash:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error.message || String(this.state.error);
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0c0e",
          color: "#eef1e8",
          fontFamily: "Oxanium, ui-sans-serif, system-ui, sans-serif",
          padding: 16,
        }}
      >
        <div style={{ maxWidth: 380, textAlign: "center" }}>
          <div
            style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 10,
              letterSpacing: "0.11em",
              textTransform: "uppercase",
              color: "#8b9793",
            }}
          >
            display fault
          </div>
          <h1
            style={{
              margin: "10px 0 0",
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            The picture dropped
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: 1.6, color: "#8b9793" }}>
            The screen hit a fault, not the game. Your seat, balance and any
            live round are safe on the server. Reload to pick the picture back
            up.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20,
              width: "100%",
              padding: "13px 0",
              border: 0,
              borderRadius: 2,
              background: "#3fe0d8",
              color: "#03211f",
              fontFamily: "inherit",
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            reload
          </button>
          <div
            style={{
              marginTop: 14,
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 10,
              color: "#8b9793",
              overflowWrap: "anywhere",
            }}
          >
            {msg}
          </div>
        </div>
      </div>
    );
  }
}

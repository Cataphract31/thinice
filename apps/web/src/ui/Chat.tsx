import { useEffect, useRef, useState, type JSX } from "react";
import type { Snapshot } from "@/game/client";
import { CharArt } from "./Chars";

/** The one thing the panel needs from either client. Both satisfy it. */
export interface Talker {
  isLocal: boolean;
  sendChat(text: string): void;
}

/**
 * Table talk. This is what makes the room feel occupied: the roster proves
 * other people exist, chat proves they are present. Kept deliberately flat —
 * avatar, name, line — because the lattice is the show and this is the crowd
 * noise around it.
 */
export function ChatPanel({
  snap,
  client,
  bare = false,
  onSelect,
}: {
  snap: Snapshot;
  client: Talker;
  /** Inside the mobile tab panel, which already owns the surface and padding. */
  bare?: boolean;
  /** Opens a speaker's plate profile, same as clicking them on the roster. */
  onSelect?: (id: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Stick to the newest line only while the reader is already at the bottom.
   * Yanking the view down while someone is reading scrollback is how chat
   * panels teach people not to scroll up.
   */
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [snap.chat.length]);

  const offline = !client.isLocal && !snap.connected;
  const submit = (): void => {
    const t = draft.trim();
    if (!t || offline) return;
    client.sendChat(t);
    setDraft("");
  };

  const body = (
    <>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-1 py-1.5"
      >
        {snap.chat.length === 0 && (
          <div className="label px-1 py-1">
            {client.isLocal
              ? "offline demo — nobody can hear you"
              : "quiet ice. say something."}
          </div>
        )}
        {snap.chat.map((m) =>
          m.system ? (
            <div key={m.id} className="label px-1 py-0.5 text-[var(--color-warn)]">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="flex items-start gap-1.5 px-1 py-0.5">
              {/* Speaker opens their plate profile, exactly like the roster —
                  when they hold a plate this round. A speaker who is only
                  spectating has no plate to profile, so the click is a no-op
                  rather than an error. Cosmetic lookup by display name is
                  fine here; nothing money-bearing hangs off it. */}
              <button
                type="button"
                onClick={() => {
                  const target = m.you
                    ? snap.players.find((p) => p.you)
                    : snap.players.find((p) => p.name === m.name);
                  if (target) onSelect?.(target.id);
                }}
                className="flex min-w-0 items-start gap-1.5 text-left"
              >
                <div className="mt-[1px] shrink-0">
                  <CharArt charId={m.charId} pose="head" size={16} />
                </div>
                <div className="min-w-0 text-[12px] leading-snug [overflow-wrap:anywhere]">
                  <span
                    className="font-semibold hover:underline"
                    style={{
                      color: m.you ? "var(--color-cyan)" : "var(--color-zinc-hi)",
                    }}
                  >
                    {m.you ? "YOU" : m.name}
                  </span>{" "}
                  <span className="text-[var(--color-text)]">{m.text}</span>
                </div>
              </button>
            </div>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex shrink-0 gap-1 p-1"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={160}
          placeholder={offline ? "reconnecting…" : "say something"}
          disabled={offline}
          aria-label="Chat message"
          className="min-w-0 flex-1 rounded-sm bg-[var(--color-panel2)] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-dim)] focus:ring-1 focus:ring-[var(--color-cyan)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={offline || draft.trim() === ""}
          className="label rounded-sm bg-[var(--color-panel2)] px-2.5 hover:text-[var(--color-text)] disabled:opacity-50"
        >
          send
        </button>
      </form>
    </>
  );

  if (bare) return <div className="flex h-full min-h-0 flex-col">{body}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline justify-between px-2 pt-1.5">
        <span className="label">chat</span>
        <span className="label tnum">{snap.online} online</span>
      </div>
      {body}
    </div>
  );
}

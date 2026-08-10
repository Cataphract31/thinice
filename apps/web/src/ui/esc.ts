import { useEffect } from "react";

/**
 * Escape closes the thing on top.
 *
 * Every dismissible overlay in the product should answer the same key, and
 * they did not: the info page listened, while the character picker, the bank
 * and the jackpot history could only be dismissed by finding their ✕ or
 * clicking the backdrop. A modal that ignores Escape reads as stuck to anyone
 * driving by keyboard.
 */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
}

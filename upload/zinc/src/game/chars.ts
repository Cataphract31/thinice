/**
 * The character roster.
 *
 * Every player in a round wears a character: yours is chosen in the select
 * screen, bots draw theirs at lobby open. Art ships as three stills per
 * character dropped into `public/chars/<id>/` — probed on startup exactly like
 * the sound pack, so files appearing is the whole integration:
 *
 *     head.png   roster rows, plates on the lattice, the select screen
 *     win.png    the winner scene at round end
 *     lose.png   defeated players in the winner scene
 *
 * Until a file exists its emoji placeholder stands in, tinted with the
 * character's hue, so the entire system is judgeable with zero assets.
 */

export type Pose = "head" | "win" | "lose";

export interface CharacterDef {
  /** Slug, also the folder name under public/chars/. */
  id: string;
  label: string;
  emoji: string;
  /** Placeholder disc tint and the winner scene's accent, 0-360. */
  hue: number;
}

export const CHARACTERS: CharacterDef[] = [
  { id: "chad", label: "CHAD", emoji: "\u{1F5FF}", hue: 205 },
  { id: "soyjak", label: "SOYJAK", emoji: "\u{1F62E}", hue: 330 },
  { id: "wojak", label: "WOJAK", emoji: "\u{1F610}", hue: 0 },
  { id: "ansem", label: "ANSEM", emoji: "\u{1F98D}", hue: 275 },
  { id: "saylor", label: "SAYLOR", emoji: "\u{1F574}\u{FE0F}", hue: 30 },
  { id: "pepe", label: "PEPE", emoji: "\u{1F438}", hue: 110 },
  { id: "chud", label: "CHUD", emoji: "\u{1F621}", hue: 15 },
  { id: "bogdanoff", label: "BOGDANOFF", emoji: "\u{1F4DE}", hue: 185 },
  { id: "bobo", label: "BOBO", emoji: "\u{1F43B}", hue: 25 },
  { id: "mumu", label: "MUMU", emoji: "\u{1F402}", hue: 145 },
];

const FALLBACK = CHARACTERS[0]!;

export function charById(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? FALLBACK;
}

/** Decoded images, keyed "<id>/<pose>". Serves both <img> tags and the canvas. */
const images = new Map<string, HTMLImageElement>();
let probed = false;

export function initCharAssets(): void {
  if (probed) return;
  probed = true;
  const base = import.meta.env.BASE_URL || "/";
  for (const c of CHARACTERS) {
    for (const pose of ["head", "win", "lose"] as Pose[]) {
      const img = new Image();
      const url = `${base}chars/${c.id}/${pose}.png`;
      // A static host that rewrites misses to index.html answers 200 with
      // HTML; an image that actually decodes is the real existence test.
      img.onload = () => images.set(`${c.id}/${pose}`, img);
      img.src = url;
    }
  }
}

/** The decoded image for a pose, or null while the placeholder should show. */
export function charImage(id: string, pose: Pose): HTMLImageElement | null {
  return images.get(`${id}/${pose}`) ?? null;
}

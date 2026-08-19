export type Pose = "head" | "win" | "lose";

export interface CharacterDef {
  id: string;
  label: string;
  emoji: string;
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
  { id: "milady", label: "MILADY", emoji: "\u{1F380}", hue: 240 },
  { id: "sbf", label: "SBF", emoji: "\u{1F4B8}", hue: 70 },
];

const FALLBACK = CHARACTERS[0]!;

export function charById(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? FALLBACK;
}

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
      img.onload = () => images.set(`${c.id}/${pose}`, img);
      img.src = url;
    }
  }
}

export function charImage(id: string, pose: Pose): HTMLImageElement | null {
  return images.get(`${id}/${pose}`) ?? null;
}

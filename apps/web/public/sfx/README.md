# Sample pack (optional)

Drop real recorded sound effects in this folder and the game uses them
automatically, replacing the synthesised fallback. No code change, no rebuild
config — the loader just looks for these names on startup:

**Levels are handled for you.** Every file is scanned on load and normalised to
match the synthesised voices, so it does not matter how hot your export is —
a file mastered to 0dB and one at -12dB will play at the same level. Don't
bother normalising before dropping them in.

| file            | when it plays                          |
| --------------- | -------------------------------------- |
| `tick`          | **not recommended** — see below         |
| `shatter`       | 1–3 plates break                       |
| `shatter_many`  | 4+ plates break at once                |
| `extract`       | you cash out                           |
| `died`          | your own plate shatters                |
| `seal`          | the lattice seals, round starts        |
| `join`          | you bond in                            |

`.mp3`, `.wav` or `.ogg` — the loader tries each in that order. Anything
missing keeps its synthesised version, so the pack can be filled in one sound
at a time.

### Why not `tick`

The tick is the only cue carrying continuous information: it morphs across the
whole risk range, so a player can hear how dangerous the shaft is without
looking at the number. A recorded sample is one fixed sound and throws that
away — it can only get louder, which reads as "same thing, louder" rather than
as danger. Dropping in `tick.mp3` still works, and it is still modulated by
level, filtering and rate, but it will always be a blunter instrument than the
synthesised one. Leave it out unless you have a specific reason.

Keep files short: `tick` under ~80ms, the shatters under ~600ms. Mono is fine;
the game adds its own reverb and stereo width on top, so use dry source
material.

**Licensing:** only ship sounds cleared for commercial use.
[freesound.org](https://freesound.org) filtered to CC0 is free and safe;
Soundly, A Sound Effect and Krotos sell properly licensed impact/debris packs.
Do not use sounds pulled from other games or from YouTube.

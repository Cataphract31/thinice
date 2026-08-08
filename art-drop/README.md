# Art drop

Raw Gemini output goes here. Any size, any filename, green backgrounds and all.
Claude fetches, chroma-keys, crops and packs from this folder — nothing in here
ships directly.

## Characters

One folder per team: `chad cuck wojak ansem saylor pepe wif bogdanoff`

Three images each, generated in the SAME Gemini chat so the face stays
consistent (portrait first, then "same character, now ..."):

| image | aspect | pose |
| ----- | ------ | ---- |
| head  | 1:1    | close-up head and shoulders portrait, facing viewer |
| win   | 2:3    | full body victory pose, flexing and grinning triumphantly |
| lose  | 2:3    | full body defeat pose, on knees, head down, devastated |

Base prompt:

> 16-bit pixel art in the style of a 90s arcade fighting game, [CHARACTER],
> [POSE], single character only, centered, chunky black outlines, limited
> color palette, plain solid bright green background (#00FF00), no text,
> no logos

Put "head", "win" or "lose" somewhere in the filename.

## Tiles

`tiles/` — four 1:1 images, same chat, in order:

1. "top-down pixel art hexagonal ice floe tile, pale glacial blue, subtle
   frozen texture, flat lighting, solid bright green background (#00FF00)"
2. "same tile with fine hairline cracks"
3. "same tile heavily cracked"
4. "same tile splitting apart into shards"

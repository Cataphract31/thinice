# Art drop

The recipe for the art the game ships, kept so any of it can be remade. The raw
masters are **not** stored here any more — they were deleted on 2026-08-13, and
the packed output in `apps/web/public` is now the only copy. To re-crop a
character or add one, regenerate from the prompts below.

Working drops go in this folder: any size, any filename, green backgrounds and
all. They get chroma-keyed, cropped and packed into `apps/web/public`; nothing
here ships directly and the raws are gitignored.

## Characters

One folder per character. The twelve that ship today:

`ansem bobo bogdanoff chad chud milady mumu pepe saylor sbf soyjak wojak`

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

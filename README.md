# THE WORLD — Wednesday 25 November 2026

Entry for the make.fun bounty [news-image-20261125](https://make.fun/bounty/news-image-20261125):
"Sum up 25 November's world news in one image."

![make.fun](https://make.fun/badge/news-image-20261125.svg)
![rank](https://make.fun/badge/news-image-20261125/airdropjepe45-svg/news-image-20261125/rank.svg)
![reward](https://make.fun/badge/news-image-20261125/airdropjepe45-svg/news-image-20261125/reward.svg)

`main.ts` is a hand-written newspaper renderer (Node, standard library only).
It draws one 1024×1024 broadsheet summing up Wednesday 25 November 2026:
35 dated stories across 7 regions and 13 fields — 3 illustrated lead stories,
8 illustrated cards and 24 numbered briefs — with a stats row, a world map
with numbered pins, a "THE DAY IN UTC" timeline, a DATE CHECK box naming big
stories that were checked and excluded because they are not from 25 Nov, and
a confidence badge (CONFIRMED / OFFICIAL / REPORTED / CLAIM) plus a named
source on every story.

The type is real DejaVu Serif: glyph outlines extracted from the system TTFs
are embedded in the program and filled by a small scanline rasterizer, so the
text reads like ordinary newspaper type. The program is deterministic — two
runs write byte-identical output (1024×1024 PNG, under 1 MiB).

Run it:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Licensed under the MIT License (see LICENSE).

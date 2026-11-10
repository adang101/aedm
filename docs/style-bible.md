# Style bible and prompt templates

The look is a bright, top-down three-quarter tile RPG with chibi characters, drawn on a 48-pixel grid with one shared palette. Treat every value here as a starting point for the art spike.

**Look spec**

| Item | Spec |
| --- | --- |
| Perspective | Top-down three-quarter view. Walls show a front face; characters are seen from slightly above. |
| Mood | Warm, friendly, saturated, readable at phone size. Eerie scenes use cooler ramps and darker values, not different art rules. |
| Tiles | 48 x 48 pixels, seamless on all four edges where marked |
| Character canvas | 48 x 64 pixels, character about 40 x 56 inside it, feet on y = 60 |
| Proportions | Chibi: head about 45% of total height, eyes as simple dots or small ovals, stubby limbs |
| Outline | 1 pixel selective outline in a hue-shifted dark, never pure black. No outline inside tiles. |
| Shading | Three tones plus one highlight per material, light from the top left. No gradients, blur, anti-aliasing or dithering (sparse texture dots are fine). |
| Transparency | Alpha is 0 or 255 only |
| Detail budget | At most 4 colors per small prop and 6 per character part |

**Master palette (33 colors)**

Extend by at most 31 colors per biome, and keep the total under 64.

| Ramp | Dark | Mid-dark | Mid-light | Light |
| --- | --- | --- | --- | --- |
| Grass | `#2f5d34` | `#4f8a3c` | `#7cb342` | `#b5d66b` |
| Stone | `#3b3f55` | `#5c6380` | `#8b93b0` | `#c4c9dc` |
| Earth | `#4a2f24` | `#70472f` | `#9a6a3f` | `#c99a63` |
| Sand | `#8a6a2b` | `#c99a3a` | `#e8c95a` | `#f6e8a0` |
| Water | `#1f3f7a` | `#2f6bb5` | `#4f9fe0` | `#9fd4f5` |
| Fire | `#7a1f2b` | `#c0392b` | `#e8683a` | `#f5a65b` |
| Magic | `#3d2a6b` | `#6a45a8` | `#9b72d8` | `#cbb0f0` |
| Skin | `#6b3b2e` | `#a5654a` | `#d39a72` | `#f2cfa6` |

Outline color: `#1b1626`.

**Sprite layout (three-layer composite)**

| Item | Spec |
| --- | --- |
| Canvas | 48 x 64 pixels for every layer, transparent background |
| Poses | Front (down), back (up), and right side. Left is the mirrored right pose. |
| Neck anchor | (24, 32) in every pose. The head layer sits above it and the body layer below it. |
| Head layer | Occupies y = 2 to 34, including hair and headgear |
| Body layer | Occupies y = 28 to 62, including torso, arms and legs, with feet on y = 60 |
| Held item layer | The item drawn at the hand position: front (34, 46), back (14, 46), right side (30, 46). Refine these in the spike. |
| Draw order | Body, head, held item. In the back pose the held item draws before the body. |
| Alignment | Auto-align each layer to the anchor. Parts may start up to 2 pixels off; reject anything still more than 4 pixels off. |
| Margins | Keep at least 4 pixels of empty margin around every part, because procedural animation bounces the sprite 2 to 4 pixels |

**Tile rules**

- Ground tiles are seamless on all four edges, with 3 to 5 variants per material to break up repetition.
- Wall tiles come in two parts: a top face seen from above, and a front face with two or three rows of masonry or planks. Both are 48 x 48 and tile left to right.
- Transitions between materials (grass to path, for example) are produced by code from two base tiles and a mask, not generated. Confirm this in the spike.
- Props (trees, rocks, doors, torches) are drawn on transparent backgrounds with the base on the bottom edge.

**Prompt templates**

Placeholders in double braces are filled by the asset service. Tools that output true pixel art at the target size need no downscaling. General image models do: generate at 8 times the target size (tiles at 384 x 384, sprites at 384 x 512), then downscale with nearest-neighbor and snap to the palette.

Shared blocks:

```text
STYLE_BLOCK:
Top-down three-quarter view fantasy game art in a clean pixel art style. Bright saturated palette, 1 pixel dark outline, three tones of shading plus one highlight, light from the top left, flat colors, no gradients, no blur, no anti-aliasing. Large visible pixels. No text, no logos, no watermark.

NEGATIVE_BLOCK:
Avoid photographic detail, smooth gradients, soft shadows, 3D rendering, text, borders, frames, signatures, and cropped objects.
```

Ground tile:

```text
{{STYLE_BLOCK}}
A single square ground tile of {{material}} for a {{biome}} map, {{descriptor}}. Seamless and tileable on all four edges, evenly filled to the edges, no border, nothing crossing the edge. Colors from these palette families: {{ramps}}.
{{NEGATIVE_BLOCK}}
```

Wall tile:

```text
{{STYLE_BLOCK}}
A {{material}} wall {{wall_part}} for a {{biome}} map. A wall top is the flat top surface seen from above. A wall front is the vertical front face with two or three rows of {{texture}}. Square image that fills the frame edge to edge and tiles left to right. Colors from these palette families: {{ramps}}.
{{NEGATIVE_BLOCK}}
```

Prop:

```text
{{STYLE_BLOCK}}
A single {{prop}} for a {{biome}} map, {{descriptor}}, centered on a plain flat magenta background (#FF00FF) with 10 percent empty margin on every side. Colors from these palette families: {{ramps}}.
{{NEGATIVE_BLOCK}}
```

Character pose (whole character):

```text
{{STYLE_BLOCK}}
Chibi fantasy character, {{pose}} view, full body, standing, centered on a plain flat magenta background (#FF00FF) with 10 percent empty margin. Head about 45 percent of the character's height. {{traits}}.
{{NEGATIVE_BLOCK}}
```

Character layers:

```text
HEAD ONLY: {{STYLE_BLOCK}} Chibi fantasy character head only, no body, {{pose}} view, neck cut flat at the bottom edge, plain flat magenta background. {{head_traits}}. {{NEGATIVE_BLOCK}}

BODY ONLY: {{STYLE_BLOCK}} Chibi fantasy character body only, no head, {{pose}} view, neck stump cut flat at the top edge, standing, plain flat magenta background. {{outfit_traits}}. {{NEGATIVE_BLOCK}}

HELD ITEM: {{STYLE_BLOCK}} Only a {{item}} as held in a hand, no hand and no body, {{pose}} view, plain flat magenta background. {{NEGATIVE_BLOCK}}
```

**Art spike inputs**

Run each prompt 3 times per tool and record how many attempts it takes to get one result that passes the gates.

| # | Biome | Item | Descriptor |
| --- | --- | --- | --- |
| 1 | forest | Grass tile | Short mossy grass with a few tiny flowers |
| 2 | forest | Dirt path tile | Packed dirt with small pebbles |
| 3 | forest | Water tile | Shallow pond water with small ripples |
| 4 | forest | Tree (prop) | A single tree with a round leafy canopy |
| 5 | forest | Rock (prop) | A mossy boulder |
| 6 | dungeon | Stone floor tile | Worn grey flagstones with cracks |
| 7 | dungeon | Wall front | Dark stone brick front face |
| 8 | dungeon | Wall top | Flat dark stone top surface |
| 9 | dungeon | Door (prop) | A closed arched wooden door with iron bands |
| 10 | dungeon | Torch (prop) | A wall torch with a small flame |

Test character for the three poses (front, back, right side): a stocky demolitions expert with round goggles pushed up on the forehead, short messy brown hair, a leather jerkin, and a satchel of small canisters. For the layer test, repeat the front pose as head only, body only, and a held item (a small round bomb with a lit fuse).

**Acceptance gates (automated)**

Thresholds are set during the spike. The rules are fixed.

| Check | Pass rule |
| --- | --- |
| Size | Exactly 48 x 48 for tiles and 48 x 64 for sprites after processing |
| Alpha | Only 0 or 255 |
| Palette | Every opaque pixel snaps to the master palette within a set distance, with at most 32 colors per tile and 24 per sprite |
| Crispness | After downscaling, fewer than a set share of opaque pixels needed a large palette change |
| Seams (ground tiles) | The difference between left and right edge columns, and between top and bottom rows, is under a set limit; the tile also looks right in a 3 x 3 grid |
| Margins (sprites) | No opaque pixels within 2 pixels of the canvas border |
| Anchor (sprite layers) | Neck anchor within 4 pixels after auto-alignment |
| Duplicates | Perceptual hash distance to existing assets above a minimum |
| Safety | No text detected and the image classifier is clean |

**Real people and other franchises**

- Prompts are built only from screened trait descriptions. A screening step rewrites a character description into generic traits and replaces names of real people, brands and other franchises' characters.
- Never use artist names or "in the style of" in a prompt.
- Never name other games in prompts, in the product, or in marketing.

**Reference images to gather before the art spike**

Collect 3 to 5: one tile sheet in the target style, one chibi character, and one mood image. Write one line on each saying what to copy (proportions, palette, outline weight). Use only references you have the rights to, such as your own mockups or openly licensed pixel art, and do not upload screenshots of commercial games.

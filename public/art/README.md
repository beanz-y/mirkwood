# Custom art for Mirkwood

Drop image files into this folder and list them in `manifest.json`. Any key
present in the manifest replaces the built-in procedural SVG art; anything
missing keeps the default look, so you can replace art one piece at a time.

```json
{
  "draugr": "/art/draugr.webp",
  "gate-valhalla": "/art/gate-valhalla.png",
  "token-0": "/art/tokens/gold-flame.png"
}
```

Refresh the page (dev) or redeploy (`npm run deploy`) to see changes.

## Art keys

| Key | What it skins | Openings at rotation 0 |
|---|---|---|
| `start` | Start tile (forest clearing) | **North + East** |
| `straight` | Straight path | **North + South** |
| `tee` | T-fork path | **North + East + West** (wall on South) |
| `cross` | Four-way crossroads | all four |
| `rune` | Rune Circle | all four |
| `draugr` | Draugr tile | all four |
| `gate-valhalla` | Gate of Valhalla | doorway on **North** only |
| `gate-folkvangr` | Gate of Fólkvangr | doorway on **North** only |
| `rift` | Void Rift (never rotated) | — |
| `mist` | Unlit empty cell (never rotated) | — |
| `board-bg` | Full-board background under the grid (552×552 aspect) | — |
| `sigil-helm` `sigil-shield` `sigil-sword` `sigil-hammer` `sigil-ship` `sigil-raven` `sigil-horn` `sigil-triquetra` | The eight soul **sigils** (marks worn on the token) | — |
| `token-0` … `token-3` | Whole player token per seat (legacy — overrides the disc *and* mark; ignores the chosen sigil) | — |

### Soul sigils (`sigil-*`)

Each soul wears one of eight sigils on a disc of its chosen color. A `sigil-<key>`
image **replaces just the mark** — the coloured disc (the player's colour) is
still drawn behind it — so it shows up on the board token, the player/soul
cards, and the lobby picker, all at once. Reskin one sigil at a time; any you
don't map keep the built-in vector.

- **Square, transparent background**, 256×256 recommended (SVG/PNG/WebP).
- Design it as a **mark that reads on the coloured disc** — a dark silhouette
  (roughly `#0a100d`) is the safe default, matching the built-in look. It sits
  centred at ~74% of the token's width.
- No colour recolouring is applied to the image (unlike the built-in vectors),
  so bake in whatever styling you want — just keep it legible on every one of
  the eight soul colours.

Prefer `sigil-*` over `token-0..3` for commissioned soul art: `sigil-*` keeps
the player's colour choice and every sigil option, while `token-N` hard-codes
one fixed image for a seat.

### Fractured variants (optional)

Add `-fractured` to any tile key (e.g. `"straight-fractured"`) to supply
dedicated art for the crumbling version. If absent, the base art is used and
the engine draws its generic crack marks on top — so fractured tiles are
always distinguishable either way.

## Authoring rules

- **Square images**, 512×512 recommended (any size works; they're scaled).
  PNG, WebP, or SVG. The image fills the whole cell (full bleed, corners
  visible — a little rounding is fine).
- **Paint the paths into the art.** The image *replaces* the tile entirely,
  including its passages. Path mouths must be centered on the tile edges
  listed above, roughly **29% of the edge wide** (26px of a 90px cell), so
  they visually connect with neighboring tiles — including default procedural
  ones during a partial reskin.
- **Author at rotation 0.** The engine rotates the whole image clockwise in
  90° steps when the tile is placed, so avoid text or strongly "upright"
  elements on rotatable tiles (everything except `rift`, `mist`, `board-bg`,
  and tokens can end up rotated — gates included).
- Tokens are drawn round at ~36px; transparent-background PNGs look best.
  Hope state is conveyed by the engine (glow ring when hopeful, dimmed when
  hopeless), so a single token image per soul is enough.
- A worked example lives in `examples/cross-sample.svg` — try it with
  `"cross": "/art/examples/cross-sample.svg"` in the manifest.

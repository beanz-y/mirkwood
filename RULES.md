# MIRKWOOD (Myrkviðr)

*A cooperative tile-placement game for 4 souls, adapted from The Night Cage.*

---

## The Saga

You died without glory and without peace. Your soul awoke beneath the black
boughs of **Myrkviðr**, the mist-forest between the worlds, where the paths
move when no one watches them. Somewhere in the forest stand two gates: the
**Gate of Valhalla**, for those who would feast among warriors, and the
**Gate of Fólkvangr**, Freyja's meadow, for those who seek peace.

Your only light is your **Flicker of Hope** — and the mist devours every path
it touches the moment your hope stops shining on it. Worse: the **Draugr**
wander here. They too once sought the gates. They failed. They will make sure
you fail as well.

## Object

The four souls **win together** if all four stand on the *same* Gate, each
bearing a **different rune** of that gate's set (all four Valhalla runes, or
all four Fólkvangr runes, spread across the four souls).

The souls **lose together** if:

- Both Gates are swallowed by the mist before being placed.
- Too few Rune Circles remain for the souls to complete the four marks a gate
  demands (checked automatically: each soul not yet holding a distinct rune of
  the best available gate needs one remaining circle).
- A falling soul has no tile left to land on (they fall through the void forever).
- The group concedes to Niflheim.

---

## The Runes

> **Corrections from the draft:** several glyphs were mislabeled
> (ᛃ is Jera, not Isa; ᛞ is Dagaz, not Berkano; ᛄ is a Jera variant, not Ansuz;
> Wunjo was listed with Thurisaz's glyph ᚦ; Eihwaz is ᛇ, not ᛖ/Ehwaz).
> The correct Elder Futhark glyphs for the chosen runes:

| Gate | Rune | Glyph | Meaning |
|---|---|---|---|
| Valhalla | **Thurisaz** | ᚦ | Thorn — strength, defense, warding off evil |
| Valhalla | **Eihwaz** | ᛇ | Yew — endurance, overcoming death, Yggdrasil |
| Valhalla | **Isa** | ᛁ | Ice — stillness, willpower, sacrifice |
| Valhalla | **Raido** | ᚱ | Ride — the journey, righteous action, fate |
| Fólkvangr | **Berkano** | ᛒ | Birch — nurture, motherhood, protection |
| Fólkvangr | **Uruz** | ᚢ | Aurochs — vitality, untamed growth |
| Fólkvangr | **Ansuz** | ᚨ | God — wisdom, inspiration, Odin's insight |
| Fólkvangr | **Wunjo** | ᚹ | Joy — harmony, fulfilment, community |

---

## Components (digital)

- **6×6 board.** The edges wrap: the forest loops back on itself, as Myrkviðr
  famously turns travelers in circles.
- **4 Start tiles** (one per soul; 2 pathways; *Fractured*).
- **Path stack of 74 tiles** (the group's shared reserve of hope):
  - 10 Straight paths (*Fractured*)
  - 32 T-paths (2 of them *Fractured* — same ratio as TNC)
  - 12 Four-way paths
  - 6 Rune Circles (four-way; *Fractured*)
  - 12 Draugr (four-way)
  - 2 Gates — one to Valhalla, one to Fólkvangr (**one entrance only**)
- The first 8 tiles of the stack are always plain paths (2 straight, 4 T,
  2 four-way), so the opening reveals are never lethal — as in TNC.

The stack is the timer. Every tile drawn, discarded, or lost to the mist is
hope burned. **When the stack is empty, Niflheim's Embrace begins** (see below).

---

## Setup

In seat order, each soul:

1. Chooses any empty space and places their Start tile in any orientation.
2. Draws one tile per open pathway and places it so the passages connect
   (any rotation that connects is legal).

All souls begin **Hopeful** with **1 Resolve**.

---

## A Soul's Turn

On your turn you either **Stay** or **Move**. A Hopeless soul may first
**Rekindle** (see Hope).

### Stay
1. Gain **1 Resolve** (maximum 2). *(Hopeless souls may not Stay unless they
   spend 1 Resolve — and gain none.)*
2. Standing still burns hope: discard the top tile of the stack, face up.
   - **If it is a Draugr, it does not go quietly:** you must replace one tile
     connected to yours with the Draugr (never a Gate or an occupied tile;
     if nothing is connected, the Draugr sinks back into the mist).
3. If you are standing on a **Fractured** tile, it crumbles beneath you —
   you fall into the Rift (your turn ends).

### Move
1. Move 1 space along a connected pathway. Two souls may never share a tile
   — **except Gates**, which hold any number.
2. If you left a Fractured tile, it crumbles into a **Rift** behind you.
3. Any Draugr that saw you move **attacks** (see Draugr).
4. Tiles no longer lit by anyone's Hope are lost to the mist, forever.
5. If you are Hopeful, **illuminate**: draw one tile per open pathway leading
   from your new tile and place each so it connects (your choice of space and
   rotation, one tile at a time).
6. You may spend Resolve to **Move again** (up to twice per turn).

---

## Hope & Hopelessness

- **Hopeful:** your inner light pierces one layer of mist — you illuminate
  all pathways one space around you (no diagonals). A tile that blocks one of
  your pathways stays visible (you can see the wall it makes).
- **Hopeless:** you see only the tile you stand on. You are compelled to
  **Move every turn** (Stay costs 1 Resolve). You move blind: when you step
  into empty mist, draw a single tile for that space and orient it so it
  connects behind you. If it is a Draugr, it attacks immediately and you
  scramble off it.
- **Rekindling:** a Hopeless soul adjacent to a Hopeful soul along a connected
  pathway is rekindled automatically. A Hopeless soul may also spend
  **1 Resolve** at the start of their turn to rekindle their own hope
  *(Mirkwood addition — this is what makes Rift falls survivable alone)*.

## Resolve

Souls harden their resolve in two ways (max 2 held):

- **Stand fast:** Stay on your turn (+1).
- **Defiance:** move within a Draugr's line of sight and escape its strike
  untouched (+1). *(This is the draft's "gain Resolve by moving in sight of a
  Draugr", tightened so being hit doesn't pay — otherwise Brace would be free.)*

Spend 1 Resolve to:

| Act | Effect |
|---|---|
| **Move Again** | Take another Move after your move resolves (max twice). |
| **Rekindle** | Regain Hope at the start of your turn. |
| **Endure** | Stay while Hopeless. |
| **Brace** | When a Draugr strikes you, lose 2 tiles from the stack instead of 3. |
| **Charge** | Deliberately move onto a Draugr: its strike always lands on you (Brace still allowed). Once its attack concludes, the Draugr is **banished from the forest** — its tile is lost — and you scramble onto an adjacent space. |
| **Sustain** | During Niflheim's Embrace, skip removing an extra tile at the end of your turn. |

## Fractured Paths & Void Rifts

Fractured tiles crumble into **Rifts** the moment you leave them (or at the
end of a turn you Stay on them). A Rift is a wound in the world — it blocks
Draugr sight, and a soul may deliberately leap into a connected Rift.

**Falling:** your turn ends and you plummet through the void. At the start of
your next turn, choose any empty, unlit space in the row **or** column of the
Rift you fell through, draw a tile to land on (any orientation), and land.

- **You land Hopeless** *(Mirkwood change)* — spend 1 Resolve to Rekindle, or
  find a Hopeful friend.
- If you land on a Draugr, it attacks you and everything it can see; it then
  collapses into a Rift and you scramble to an adjacent space.
- If there are no empty spaces in that row/column, land on an existing tile.
- **If the stack is empty and you must draw to land — you fall forever, and
  the game is lost.**

## The Draugr

Lost souls who sought Valhalla and failed. They despise your hope.

- Draugr are drawn and placed like any tile (four-way).
- They are **motion-sensitive**: whenever a soul moves along, into, or out of
  an unbroken pathway connected to a Draugr — in a straight line, in any of
  the four directions, wrapping around the board edges — it attacks.
- Rifts, empty spaces, and walls break its sight.
- **Every soul in its line of sight is struck:** discard 3 tiles from the
  stack per victim (2 with Brace) and that soul becomes **Hopeless**.
- Moving *out* of the line means the strike **misses you** — every other soul
  still in its sight is struck as normal — and evading its gaze steels your
  Resolve (+1). *(Unchanged from TNC's Wax Eaters, save the Resolve reward.)*
- If a Draugr's sight reaches another Draugr, it too attacks — a chain of
  spite.
- Falling breaks line of sight: a soul that falls triggers watching Draugr
  but drops away before the strike lands.
- **Charging** (1 Resolve) destroys a Draugr outright: its strike lands on
  you, you scramble onto an adjacent space — and then its spite is spent and
  the Draugr dissolves behind you, leaving bare ground. But it is not the
  only way past one: evade its line, or simply walk away — a Draugr no soul
  lights any longer fades back into the mist like any tile. (One *fallen
  onto* from the void collapses into a Rift; one merely stumbled onto in the
  dark remains — though the mist claims it before any rekindled hope can
  light it again.)

## Rune Circles

Ancient stone rings where the old marks can still be taken.

- Move onto a Rune Circle to **attune** to any one rune of either gate
  (a free action; you may also choose a rune already held by another soul,
  but duplicates can never open a gate).
- A soul bears **one rune at a time**; attuning again replaces the old mark.
  Runes are marks on the soul — **they cannot be passed between players**
  *(replaces TNC key-passing; re-attunement is the safety valve instead)*.
- Rune Circles are Fractured: they crumble behind the soul who uses them.

## The Gates

- One Gate to **Valhalla**, one to **Fólkvangr**. Each has a **single
  entrance**; it is placed like any tile (its doorway will face the passage it
  was revealed from).
- **Once placed, a Gate is permanent.** The mist cannot take it, and it is
  immune to Niflheim's Embrace.
- A Gate still in the stack *can* be lost when tiles are discarded from the
  stack (Draugr strikes, Staying). Watch the discard pile. If both gates are
  lost this way, the game is over.
- **Victory:** all four souls stand on the same Gate bearing four different
  runes of that gate's set.

## Niflheim's Embrace (endgame)

When the last tile leaves the stack, the primordial cold closes in:

- No new paths can ever be revealed.
- At the end of **every** soul's turn (after any extra Moves), the group must
  remove one remaining tile from the board (never a Gate, never a tile a soul
  stands on) — unless that soul spends 1 Resolve to **Sustain**.
- Play continues on the dwindling board until the souls win, are cut off,
  or fall.

---

## Design decisions & departures (flagged for review)

1. **Rune glyphs corrected** to real Elder Futhark (table above).
2. **Resolve from Draugr:** paid on *evading* a triggered Draugr, not on being
   hit — being hit can't grant the Resolve that pays for Brace.
3. **Rekindle (new Resolve spend):** implements your "spend a Resolve to regain
   Hope after a fall," generalized to any start of turn. Without it, a soul
   who falls while alone could be unrecoverable.
4. **Gates:** exactly 2, single-entrance, permanent once placed, exempt from
   Niflheim removal (permanence would be meaningless otherwise). They can
   still be lost from the stack — that's the drama of the discard pile.
5. **No rune passing** (TNC allows passing keys). Re-attuning at circles is
   the replacement flexibility. If playtests feel too tight, add back a
   "transfer marks between adjacent souls" action.
6. **Fall landing:** you may choose the row *or* column of the rift at landing
   time (TNC forces you to commit when you fall). Slightly kinder; simpler online.
7. **Stay ends your turn** — you cannot Stay and then spend Resolve to Move
   (TNC's sequencing arguably allows it; disallowed here to keep Stay a real cost).
8. **Landing Hopeless** (your rule) is harsh but kept: with Rekindle + the
   auto-rekindle adjacency rule it plays fine.
9. **Fractured T-paths:** kept TNC's literal "2 of the T tiles."
10. **Scrambling off a Draugr never re-triggers it** (it's part of the attack's
    resolution), and you may never deliberately scramble onto another visible Draugr.
11. **Charge banishes** (departure from TNC, where monsters persist): the
    charged Draugr disappears once its attack resolves and the charger
    scrambles off it, making Charge a true monster-removal tool — a Resolve
    plus a guaranteed hit buys a cleared corridor.
12. **Rekindled souls reveal their own paths** (departure from TNC, where the
    current player draws relit tiles) — playtest rule: a player always places
    their own tiles, even mid another player's turn.
13. **The mist sweeps before hope spreads**: after every arrival, unlit tiles
    are removed *before* the rekindle check — a monster (or path) abandoned in
    hopelessness cannot be saved by being rekindled a moment later.

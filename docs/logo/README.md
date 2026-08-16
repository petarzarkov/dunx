# The dunx mark

The mark brackets the wordmark: a **`d`** bowl holding the **`x`**, the first letter
of `dunx` and the last. Same 4-unit stroke, same round caps, same geometry as the
letterforms, so the glyph and the wordmark are cut from one drawing rather than
designed next to each other. The `x` carries the cyan → indigo → violet accent;
everything else is neutral.

The bowl was an `n` arch over the `x` until the same drawing turned 90 degrees
clockwise read as the `d`. The path data is that rotation about (16, 16).

## Which file to use

Three cuts exist because colour inheritance differs by host, not because three
looked nice.

| File                                                                                | Use it for                        | Colour                                    |
| ----------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| [`logo.svg`](../../internal/docs/public/logo/logo.svg)                                 | The full lockup, mark + wordmark  | Neutral is `currentColor`, accent is fixed |
| [`logo-mark.svg`](../../internal/docs/public/logo/logo-mark.svg)                       | Square glyph, for inlining        | Neutral is `currentColor`, accent is fixed |
| [`logo-mark-color.svg`](../../internal/docs/public/logo/logo-mark-color.svg)           | Favicon, README, anywhere foreign | All gradient, adapts to nothing            |

**The rule that decides between them:** an `<img>` element cannot inherit
`currentColor` - the SVG loads as its own document and the keyword resolves against
that document's root, which is black. So the `currentColor` cuts are only correct
when the SVG is **inlined into the page**, and anything referenced by `src=` or
pasted into a README must be `logo-mark-color.svg`.

So the docs site draws the paths in
[`Logo.tsx`](../../internal/ui/src/components/Logo.tsx) instead of loading the files:
the header has to follow the theme toggle. It reads `BOWL` and `CROSS` from
[`logo.ts`](../../internal/ui/src/logo.ts), which is where the geometry is written;
the three files above restate it and have to be edited alongside.

## Do not add a `prefers-color-scheme` block

It was tried and removed. An `@media (prefers-color-scheme: dark)` rule **inside**
the SVG is evaluated against the operating system, not against the page embedding
it, and the SVG's own rule beats the host's theme. A dark-OS visitor reading the
site in light mode got a pale, near-invisible arch. The neutral cuts inherit and
nothing else; opening one directly in a browser gives black on white, which is
correct.

`logo-mark-color.svg` is all-gradient **on purpose**. A browser tab strip and
GitHub's page background are not things this repo controls, so the one asset used
in both cannot depend on inherited colour. Verified legible on white, on Mantine's
`#1a1b1e`, and on GitHub's `#0d1117` - see `05-colour-study.png`.

## The concepts that were not chosen

Kept here because the reasoning is worth more than the drawings, and because the
next person to want a logo change should start from what already failed.

Six ideas were drawn and rendered at 16 px magnified 5×, which is what decided it.
A mark that dies at favicon size is not a logo.

| Concept                     | Why not                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `(x)` - a constructor taking one parameter | The aptest idea of the six and the biggest loss. Three thin vertical elements across 16 device pixels degrade to `( : )`, and thickening the strokes closes the gaps. |
| `dx` monogram               | Survives 16 px, but two letters set side by side in a rounded gradient tile is the most generic option available. The mark that won holds the `x` inside the `d` and carries no tile. |
| The injection graph         | Reads as a git-merge icon at 512 px and as a smear at 16. A three-node graph does not have 16 px in it.                                       |
| The unmarked centre         | Four blades converging on a missing `x`. The void **is** the concept and the void is what dies first - at 16 px it separates into four unrelated diamonds, and shrinking the void to fix that deletes the idea. |
| Monolinear wordmark alone   | Chosen, but as the wordmark half. On its own it collapses to two bars at favicon size.                                                       |

A solid dome was also cut before the arch this was rotated from: it reads as a ghost
or a "blocked" icon (`05-cuts-rejected.png`). What replaced it is hollow, open along
one side and cool-toned, which is also what settles any question of it being derived
from Bun's mark - that one is a solid, warm, faced shape, and this shares no fill, no
palette and no closed silhouette with it.

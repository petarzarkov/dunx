# Design at Elysia's level

**Partially done. The bar was set at "something out of this world".**

## Done

Full-width landing page outside the docs sidebar, hero with a tabbed editor frame
and a copyable install line, a stat band read off the generated model, a six-card
feature grid with inline SVG icons, a nine-sample code tour, the request lifecycle
as a rail, a "where it loses" section, an integrations strip, the examples, the
packages, a three-step start, and a footer. A logo and favicon. Syntax
highlighting on every code block, in both themes. Verified on a phone at 393px.

## Not done

The page is well-organised rather than striking. Specific gaps against Elysia:

- **No motion anywhere.** Elysia animates the hero and the bars. Everything here is
  static.
- **The gradient is used once**, on the hero headline. Elysia carries its accent
  through the whole page.
- **No illustration or diagram.** The request lifecycle is a text rail; it wants to
  be a drawing.
- **The benchmark section is a table**, not the graphic in
  [elysia-style-hero-graphic.md](./elysia-style-hero-graphic.md).
- Dark mode is the better of the two themes. Light mode is correct but plainer.

`prefers-reduced-motion` is already respected in `landing.css` and any motion added
has to keep that.

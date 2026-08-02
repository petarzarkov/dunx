# Design at Elysia's level

**Mostly done.** The bar was set at "something out of this world".

## Done

Full-width landing page outside the docs sidebar, hero with a tabbed editor frame
and a copyable install line, a stat band read off the generated model, a six-card
feature grid with inline SVG icons, a nine-sample code tour, a "where it loses"
section, an integrations strip, the examples, the packages, a three-step start,
and a footer. A logo and favicon. Syntax highlighting on every code block, in both
themes. Verified on a phone at 393px.

The speed panel is the first thing under the hero, which is what a reader is
actually there for.

Since then:

- **The request lifecycle is a drawing.** Five layers nested inside each other
  with the handler at the centre, and a return row on each layer that calls
  `next()`. Replaces a flat list that asserted the wrapping in prose while its
  own shape said "one thing after another".
- **Motion.** Layers stagger in on scroll by nesting depth, benchmark bars grow
  from zero. `prefers-reduced-motion` is honoured in both stylesheets.
- **The gradient recurs**: a hairline between sections, and tint increasing with
  nesting depth, rather than appearing once on the hero headline.
- **Light mode** has its own accent shades and glow opacity. The dark values read
  as smudges on white.

## Left

- The benchmark section is a table plus the speed panel, not the graphic in
  [elysia-style-hero-graphic.md](./elysia-style-hero-graphic.md), if that file is
  still open.
- No illustration anywhere else. The lifecycle is the only drawing on the page.
- Light mode is now correct and still the plainer of the two.

Any motion added has to keep the `prefers-reduced-motion` handling.

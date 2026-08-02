# A `?h=` deep link lands on a blank viewport

**Suspected defect, not confirmed against a real browser.** Found while fixing the
table-of-contents links.

`router.ts` runs a scroll-retry loop for `?h=`: up to 30 `requestAnimationFrame`
attempts, scrolling to the anchored element and stopping once it stops moving. It
exists so a symbol search hit lands on the symbol rather than on the top of its
package page, and `site.test.tsx`'s "a symbol search hit" tests cover it.

In headless Chrome it produces a **blank viewport**:

| URL                                      | distinct colours in a 1280x900 shot |
| ---------------------------------------- | ----------------------------------: |
| `#/api/core`                             |                               7,065 |
| `#/api/core?h=symbol-AppFactory`         |                               **1** |
| `#/guide/configuration`                  |                               4,487 |
| `#/guide/configuration?h=reading-it`     |                               **1** |
| `#/guide/configuration?h=does-not-exist` |                               4,497 |

The last row is the tell: with an anchor that matches nothing the loop never
scrolls and the page is fine, so it is the scroll and not the routing. Reproduced
with `--run-all-compositor-stages-before-draw` and a 20 s virtual time budget. At a
4000px viewport the content begins 1600px down, so the page is scrolled to a point
above where the content ends up.

## Why this is not yet called a bug

`--virtual-time-budget` advances time aggressively, so all 30 attempts can fire
before the body chunk's promise resolves and before layout settles - which is
exactly the situation the retry loop was written for, and exactly the situation
virtual time makes unrepresentative. The unit tests pass in a real DOM.

**So this needs one minute in a real browser** to become either a bug or a
measurement artefact. Load
`/#/api/core?h=symbol-AppFactory` and see whether it lands on `AppFactory`.

## What was done meanwhile

The table of contents links to the page's own route and scrolls from an `onClick`,
where the page is already laid out. That fixes the reported problem - the entries
used to be bare `#anchor` fragments, which a hash router reads as a route, so
clicking one navigated away from the page - without adding new surface on a path
that could not be verified.

The cost is that copying a contents link loses the anchor. Worth reversing once the
loop is confirmed working, since `?h=` is the mechanism the site already uses.

Ten cross-document anchor links (`[x](./04-modules.md#section)`) already went
through `?h=` before any of this, so if the loop really is broken it has been
broken for those too.

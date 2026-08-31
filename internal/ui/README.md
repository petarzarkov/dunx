# @dunx/ui

The Mantine theme and the React components every dunx frontend shares. Private
tooling: never published, and consumed **as source** - its `exports` point at
`src/`, there is no build step, and each consumer's bundler compiles what it
imports.

```bash
bun run test
bun run typecheck
```

## Three consumers, one design

| Workspace               | Ships as                                     |
| ----------------------- | -------------------------------------------- |
| `internal/docs`          | the documentation site, built by Vite        |
| `internal/dashboard-ui`  | inlined into the page `@dunx/dashboard` serves |

The point is that someone who reads the dunx docs and then opens their own app's
`/_dunx` cannot tell the two were built separately. Every symbol here exists because
**two or more consumers needed it** and had written it twice.

**There were three consumers, and now there are two.** `internal/openapi-ui` was
deleted when `@dunx/openapi` moved to `swagger-ui-dist`, so several symbols here are
down to one external consumer. None went to zero - the colour maps and icons the
explorer used are still used by this package's own `MethodBadge`, `StatusBadge` and
`ColorSchemeToggle`. Re-check that before deleting one, rather than assuming.

- `Prose` was a rich version in `docs` and a thinner one in `openapi-ui`, so the
  same markdown rendered differently depending on which page you opened it in.
- `ColorSchemeToggle` was correct in `docs` and buggy in `openapi-ui`. The
  explorer's first click was a no-op on a dark-OS machine, because it read the
  stored `auto` rather than the computed scheme.
- `statusColor` and `METHOD_COLOR` lived in the explorer's `model.ts`, where the
  dashboard could not reach them and would have picked its own greens.
- `.prose`, `.dunx-json` and `.dunx-verb` were in two stylesheets.

## What belongs here

Something at least two frontends render, or a mapping they must agree on. A
component only one page has stays on that page.

Two things it must **not** grow:

- **A union that another package already declares.** `methodColor` and
  `jobStateColor` take a plain `string` and fall back to grey on purpose.
  `HttpMethod` is `@dunx/http`'s, `OperationKey` is `@dunx/openapi`'s and
  `JOB_STATES` is `@dunx/dashboard`'s, so a fourth here would only ever be
  converted to and from those three.
- **A dependency.** Icons are inline paths rather than an icon package -
  `@tabler/icons-react` is 20 MB installed, and two of the three consumers inline
  their entire bundle into a page a backend serves.

## Keep it small

Two consumers inline what they import, so anything added here is paid for twice.
Tree shaking drops what is not named, so the list may grow - what it may not grow
is weight per component. Before adding one, check what it drags in: `Tooltip`
(floating-ui) and `ScrollArea` were dropped from the explorer for `title=` and
`overflow: auto`, which took that bundle from 490 KiB to 437 KiB.

## Styles

`@dunx/ui/styles.css` holds the rules more than one frontend needs. A consumer
imports it and adds only what is genuinely its own - `internal/docs` keeps its
Shiki rules and its reading measure, and nothing else.

Mantine ships one stylesheet per component. `openapi-ui` and `dashboard-ui` import
only the components they render rather than the 234 KiB barrel, so **adding a
component to a page means adding its CSS file to that page's `styles.ts`**. A
component from here that renders unstyled is almost always that.

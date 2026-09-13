# @dunx/ui

The Mantine theme and the React components every dunx frontend shares. Private
tooling: never published, and consumed **as source** - its `exports` point at
`src/`, there is no build step, and each consumer's bundler compiles what it
imports.

```bash
bun run test
bun run typecheck
```

## Two consumers, one design

| Workspace               | Ships as                                     |
| ----------------------- | -------------------------------------------- |
| `internal/docs`          | the documentation site, built by Vite        |
| `internal/dashboard-ui`  | inlined into the page `@dunx/dashboard` serves |

The point is that someone who reads the dunx docs and then opens their own app's
`/_dunx` cannot tell the two were built separately. Every symbol here exists because
**two or more consumers needed it** and had written it twice.

**There were three consumers, and now there are two.** `internal/openapi-ui` was
deleted when `@dunx/openapi` moved to `swagger-ui-dist`, so several symbols here are
down to one external consumer. Check which before adding to one of them: what the
explorer alone rendered - `statusColor`, the bullmq job-state map, and the icons
only its request pane drew - went to zero consumers and was deleted with it.

- `Prose` was a rich version in `docs` and a thinner one in `openapi-ui`, so the
  same markdown rendered differently depending on which page you opened it in.
- `ColorSchemeToggle` was correct in `docs` and buggy in `openapi-ui`. The
  explorer's first click was a no-op on a dark-OS machine, because it read the
  stored `auto` rather than the computed scheme.
- `METHOD_COLOR` lived in the explorer's `model.ts`, where the dashboard could not
  reach it and would have picked its own greens.
- `.prose`, `.dunx-json` and `.dunx-verb` were in two stylesheets.

## What belongs here

Something at least two frontends render, or a mapping they must agree on. A
component only one page has stays on that page.

Two things it must **not** grow:

- **A union that another package already declares.** `methodColor` takes a plain
  `string` and falls back to grey on purpose. `HttpMethod` is `@dunx/http`'s and
  `OperationKey` is `@dunx/openapi`'s, so a third here would only ever be converted
  to and from those two.
- **A dependency.** Icons are inline paths rather than an icon package -
  `@tabler/icons-react` is 20 MB installed, and one of the two consumers inlines its
  entire bundle into a page a backend serves.

## Keep it small

`dashboard-ui` inlines what it imports, so anything added here is paid for in the
page a backend serves. Tree shaking drops what is not named, so the list may grow -
what it may not grow is weight per component. Before adding one, check what it drags in: `Tooltip`
(floating-ui) and `ScrollArea` were dropped from the explorer for `title=` and
`overflow: auto`, which took that bundle from 490 KiB to 437 KiB.

## Styles

`@dunx/ui/styles.css` holds the rules more than one frontend needs. A consumer
imports it and adds only what is genuinely its own - `internal/docs` keeps its
Shiki rules and its reading measure, and nothing else.

Mantine ships one stylesheet per component. `dashboard-ui` imports only the
components it renders rather than the 234 KiB barrel, so **adding a component to a
page means adding its CSS file to that page's `styles.ts`**. A
component from here that renders unstyled is almost always that.

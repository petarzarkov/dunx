# The tools

The documentation site and the API explorer: private workspaces, and the only place the
dependency rules do not govern.

## Documentation site (`internal/docs`)

React + Mantine over **Vite**, static output, deployed to GitHub Pages. It replaced the
coverage report as the Pages root; coverage is now a page inside it.

**The bundler was `Bun.build` and was moved back to Vite, by measuring rather than
by preference.** The original swap traded ~25% more gzipped JS for a 41 ms build
against Vite 5's 1.7 s. Vite 8 ships Rolldown, which removed the speed argument,
and the size argument had grown as Mantine and `@mantine/charts`/recharts entered
the graph. Same site, same content, both bundlers, gzip -9:

| Bundler           | JS raw    | JS gzip      | CSS raw  | CSS gzip | Build   |
| ----------------- | --------- | ------------ | -------- | -------- | ------- |
| `Bun.build`       | 1829.6 KB | **506.5 KB** | 312.4 KB | 35.0 KB  | ~0.15 s |
| Vite 8 (Rolldown) | 1558.1 KB | **426.8 KB** | 212.5 KB | 31.2 KB  | ~0.30 s |

83.5 KB less over the wire, for 150 ms nobody waits on - a docs site is built in
CI and read over a network. What the move costs, and what has to move with it if
it is ever reversed:

- Text imports are Vite's `?raw`, not `with { type: 'text' }`. `src/env.d.ts`
  declares `*?raw` locally rather than pulling `vite/client` in, which would mean
  overriding the root tsconfig's `types`. `happydom.ts` registers a `Bun.plugin`
  teaching the test runner the same suffix - the runner is still `bun test`.
- `public/` copying and the `dist/` clean are Vite's; `scripts/build.ts` is gone.

**Every `@mantine/*` is on one major, and it is 8.** `@mantine/charts` had
drifted to 9.5.0 against core 8.3.18, which its own `peerDependencies` forbids
(it pins `@mantine/core` and `@mantine/hooks` to an exact version). The fix was
pinning `charts` back to `^8.3.6` rather than moving the whole site to Mantine
9, and the reason it works is that `charts@8.3.18` peers `recharts` at
`>=2.13.3`, so the installed recharts 3.10.1 satisfies both majors.

`BarChart` in 8 carries every prop `BenchChart.tsx` passes, and a
headless-Chrome render of `#/benchmarks` produced 5 recharts surfaces with 55
bars and the focus colour on `@dunx/http`, so this is verified rather than
assumed. `@mantine/code-highlight` went with it: highlighting happens at
generate time now, and nothing under `internal/docs` imported it.

**The model is one file per route, and the landing page carries none of them.**
`site.json` was imported into the entry chunk, so `#/` downloaded all 21 guide
bodies and all eight package readmes before rendering a page that shows neither.
`generate.ts` now writes `index.json` (nav, landing page, footer, search index),
`guides/<slug>.json` and `packages/<dir>.json`. Measured on the entry chunk, which
is all `#/` fetches, `gzip -9`:

| Entry chunk     | JS raw    | JS gzip      |
| --------------- | --------- | ------------ |
| one `site.json` | 2529.9 KB | **595.2 KB** |
| split per route | 937.2 KB  | **266.1 KB** |

329.1 KB off the landing page, 55% of it. Summed over all 30 chunks the total rises
instead, 595.2 KB to 626.3 KB gzipped, because each is compressed against its own
dictionary; nobody downloads all 30, which is the point.

Three things decided rather than derived:

- **The chunk table is generated, not globbed.** `import.meta.glob` is a Vite
  feature `bun test` does not have, and a template-literal `import()` is a bundler
  feature rather than a language one. `generated/chunks.ts` is a table of literal
  specifiers, so Vite splits on it, the test runner resolves it through the `?raw`
  plugin `happydom.ts` already installs, and `tsc` checks it. Nothing in `src/`
  became bundler-specific.
- **The index keeps a symbol's name, kind and line** and drops its signature, doc
  comment and members, which is what lets `Search` still index all 382 public
  symbols across all eight packages from a 50 KB index.
- **`site.home` is gone.** It rendered the root README into the model and no
  component had read it since the landing page was rebuilt.

**The site carries a projection of the benchmark report, not the report.**
`results/latest.json` holds every run's samples, each scenario's expected body and
each subject's entry file - evidence for the harness, and ~48 KB of JSON that
reaches no pixel. `scripts/extract/bench.ts` narrows it to what renders, which is
10.6 KB. `BenchReport` in `model.ts` stays the harness's mirror; `BenchModel` is
the site's shape, and a field surviving the projection means something renders it.

**A README is rendered minus its repo-plumbing sections.** A package page
showed `## Install`, `## License` and the monorepo's own build instructions,
which are for someone working in this repository and not for someone reading
the docs. `siteMarkdown` in `scripts/content.ts` drops a `##` section whose
slug matches `EXCLUDED_SECTIONS` with a `-` word boundary - so `## Install it
as a devDependency` goes with `## Install` - plus the centered title-and-badges
block every README opens with.

The list is published in `internal/docs/README.md`, and an author decides which
side a section falls on by naming it. Guides under `docs/` are exempt: they
_are_ repository documentation, and dropping sections from them would lose real
content.

**The API reference is extracted, not written.** `internal/docs/scripts/extract/`
parses every `packages/*/src/**/*.ts` with **`oxc-parser`** - the parser
`@dunx/transform` already depends on - and reads three things off each exported
declaration:

- the **signature**, sliced from the source text between AST offsets (from the
  declaration's start to its body's start). The signature is therefore the one
  that was _written_, which for annotated source is better documentation than a
  checker-normalised expansion.
- the **doc comment**, bound by adjacency: a `/** */` block with nothing but
  whitespace between it and the declaration.
- the **public surface**, by resolving each manifest `exports` entry to its
  source entrypoint and following `export * from` / `export { x } from` through
  the module graph. A symbol no entrypoint reaches is marked internal.

TypeScript's own API was the alternative and was rejected: the only thing it
adds is _inferred_ types for un-annotated declarations, which this codebase
barely has, in exchange for running a full type checker over five packages at
build time. What that costs is recorded in `internal/docs/README.md` along with the
gaps it leaves - no cross-package type links, no namespace re-export expansion,
one entry per overload set.

Two details worth not re-deriving:

- **Routing is hash-based** (`#/api/core`). GitHub Pages serves static files
  with no SPA fallback, so a path router 404s on every deep link. A symbol is
  `#/api/core?h=symbol-ConsoleLogger`, and three things have to hold together
  for that to land: the search action has to emit the `?h=`, the package page
  has to open its API tab in response to it (`Tabs` is `keepMounted={false}`, so
  the card does not exist on the readme tab), and the scroll has to keep looking
  across frames because the card mounts a commit after the route changes. All
  three were wrong at once, which is why a search hit opened the package readme.
- **The frozen-object-plus-union `enum` replacement declares one name twice**, as
  a value and as a type. The extractor merges both declarations into one entry;
  keying by name alone would document half the construct.

`scripts/coverage-report.ts` writes into the site rather than publishing
standalone: the model to `internal/docs/src/generated/coverage.json`, the badges to
`internal/docs/public/badges/`, which the build copies to `/badges/`. CI therefore
rebuilds the site after `test:cov`, because the first build (inside
`bun run build`) predates the coverage data.

## The API explorer: built, measured, then replaced by Swagger UI

**`internal/openapi-ui` is deleted and `@dunx/openapi` mounts `swagger-ui-dist`.**
This section is the record of the round trip, because most of what it measured is
still true and one of its findings governs every package's build.

The page began as hand-written HTML inside a backend package: a `<style>` block,
`<details>` for folding, and ~90 lines of inlined DOM code with no auth handling and
schemas printed as `JSON.stringify(…, null, 2)`. Growing that was the wrong
direction, so it became a Vite + React + Mantine workspace whose built bundle the
package inlined.

That worked, and it was still the wrong answer. Swagger UI is the reference
implementation for reading an OpenAPI document, and building an alternative to a
mature tool is the failure mode `@dunx/queue-dashboard` demonstrated once already.
Rule 1's second half, arrived at the long way.

### What the explorer cost, and what swagger costs instead

| Build                           | Raw         | gzip        |
| ------------------------------- | ----------- | ----------- |
| react + react-dom, nothing else | 188 KiB     | 60 KiB      |
| + Mantine, `styles.css` barrel  | 517 KiB     | 128 KiB     |
| + Mantine, per-component CSS    | 381 KiB     | 110 KiB     |
| the explorer as shipped         | 434 KiB     | 121 KiB     |
| **`swagger-ui-dist` 5.32.14**   | **1.7 MiB** | **443 KiB** |

So the replacement is **3.7x larger gzipped**, and that is the honest cost of the
decision rather than a footnote to it. Two things follow, and both are in the code:

- **It is not inlined.** 1.7 MiB in every page response would resend it on every
  load. The two files are served as routes with `cache-control: immutable` and the
  installed version in the query, so a browser fetches them once.
- **It is an optional peer, resolved on the first request for the page.** An app
  serving only `/openapi.json` neither installs nor loads it.

Two measurements from the explorer era that are still the reason things are shaped
as they are: **per-component Mantine CSS** beat the `styles.css` barrel 381 KiB to
517 KiB, and dropping `Tooltip` and `ScrollArea` for `title=` and `overflow: auto`
took 490 KiB to 434 KiB because `Tooltip` drags in floating-ui. Both applied to
`internal/dashboard-ui`, which still exists and still follows them.

### `splitting: true`, which outlived the thing that needed it

The explorer used to sit behind a `@dunx/openapi/ui` subpath reached with
`await import()`, because inlining it put 456 KB into every consumer's
`dist/index.js` whether or not `/docs` was mounted. That subpath is gone with the
bundle: there is no large string to split out any more.

**The finding underneath it is not gone, and it still governs
`scripts/build-package.ts`.** The dynamic import alone would have been a no-op.
With `splitting: false`, `Bun.build` inlines a relative `await import()` into the
importing entry: a 200 KB module behind a dynamic import produced a **200,980 B**
entry with splitting off and a **350 B** entry plus a chunk with it on. Shipping
the subpath without flipping the flag would have claimed a win it could not
demonstrate.

`splitting: true` is shared by every package because there is one build script, and
it turned out to be an improvement for the multi-entry ones rather than a risk: a
module two subpaths share is emitted once as a chunk instead of duplicated into
both.

The other thing that era proved, and that a future contributor should not have to
rediscover: a generated declaration holding the literal type of a minified bundle
was **456,550 B** of tarball nobody's `tsc` read, and one `: string` annotation
collapsed it to 98 B. If anything here is ever generated into a `.ts` constant
again, annotate its type.

### Markdown and samples came back to the server, then left with the model

`Bun.markdown.html` rendered every description and `sampleFor` pre-computed every
request body, both in a `model.ts` that fed the explorer a `PageModel`. Swagger UI
takes a raw OpenAPI document and renders its own markdown and its own samples, so
`model.ts` is deleted along with `buildModel`, `fieldsFor`, `PageModel` and
`TryField` - all four of which were public API, which is why this is a major bump.

What the page still does is embed the **document** rather than let Swagger UI fetch
it with `url`. That costs a round trip and makes the page depend on the JSON route
being reachable and guarded the same way, and the server already has the bytes.

### The no-external-requests guarantee narrowed, and the test says so

The old page fetched nothing at all, and the assertion had already had to move once

- `expect(page).not.toContain('src=')` is sound over hand-written HTML and
  meaningless over a minified React bundle that contains `.src=`, `href="` and the
  literal string `"<script>"` in its own code, so it moved to the **tags**.

It has now narrowed for real, and that is a genuine loss rather than a rephrasing:
the page does fetch two assets. What `html.test.ts` pins is that both are
**same-origin relative URLs** and that nothing reaches a CDN, `unpkg`, `jsdelivr` or
Google Fonts. `examples/full` proves the other half over a real server with a global
prefix, which a unit test cannot: both assets answer 200 under `/api/docs/`, with
the immutable header, and the page requests nothing off-origin.

### Vite in `internal/dashboard-ui`, `bun build` in `internal/docs`

The docs site measured Vite at 1.7 s against `bun build ./index.html` at 41 ms and
took Bun's ~25 % larger output, which is right for a site. Both numbers have since
been re-measured and reversed - see "Documentation site" above. The dashboard bundle
is inlined into a page a backend serves, so Rollup's tree-shaking wins there and the
~1.5 s is paid once per package build.

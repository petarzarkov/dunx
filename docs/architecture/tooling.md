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

**Every `@mantine/*` is on one major, and it is 8.** `@mantine/charts` had drifted
to 9.5.0 against core 8.3.18, which its own `peerDependencies` forbids (it pins
`@mantine/core` and `@mantine/hooks` to an exact version). The fix was pinning
`charts` back to `^8.3.6` rather than moving the whole site to Mantine 9, and the
reason it works is that `charts@8.3.18` peers `recharts` at `>=2.13.3`, so the
installed recharts 3.10.1 satisfies both majors. `BarChart` in 8 carries every
prop `BenchChart.tsx` passes, and a headless-Chrome render of `#/benchmarks`
produced 5 recharts surfaces with 55 bars and the focus colour on `@dunx/http`,
so this is verified rather than assumed. `@mantine/code-highlight` went with it:
highlighting happens at generate time now, and nothing under `internal/docs`
imported it.

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

**A README is rendered minus its repo-plumbing sections.** A package page showed
`## Install`, `## License` and the monorepo's own build instructions, which are
for someone working in this repository and not for someone reading the docs.
`siteMarkdown` in `scripts/content.ts` drops a `##` section whose slug matches
`EXCLUDED_SECTIONS` with a `-` word boundary - so `## Install it as a
devDependency` goes with `## Install` - plus the centered title-and-badges block
every README opens with. The list is published in `internal/docs/README.md`, and an
author decides which side a section falls on by naming it. Guides under `docs/`
are exempt: they _are_ repository documentation, and dropping sections from them
would lose real content.

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

## The API explorer (`internal/openapi-ui`)

`@dunx/openapi`'s page was hand-written HTML inside a backend package: a `<style>`
block, `<details>` for the folding and ~90 lines of inlined DOM code. It had no
auth handling, no disclosure affordance and printed schemas as
`JSON.stringify(…, null, 2)`. Growing it further was the wrong direction, so the
UI is now a frontend workspace whose built bundle the package serves.

### The bundle is inlined, and that is what constrains everything

The page's guarantee is that it fetches **nothing** - no CDN, no `src=`, no
`<link>`. `swagger-ui-dist` (11.7 MB unpacked) and `@scalar/api-reference` (11 MB)
were rejected over exactly that, and the guarantee did not get cheaper because the
UI got better. So the bundle is a string in `packages/openapi/src/ui-bundle.ts`,
written by `internal/openapi-ui/scripts/build.ts` and interpolated into one
`<script>`. `</` is escaped at build time, not per request.

`ui-bundle.ts` is **generated and committed**. `bun test ./packages` at the root
and `tsc --noEmit` in a fresh clone both have to work without a Vite run, and the
publish path must not depend on one. `packages/openapi`'s `build` runs the UI
build first, so the committed copy cannot go stale.

### What it costs - measured

| Build                                     | Raw         | gzip        |
| ----------------------------------------- | ----------- | ----------- |
| react + react-dom, nothing else           | 188 KiB     | 60 KiB      |
| + Mantine, `styles.css` barrel            | 517 KiB     | 128 KiB     |
| + Mantine, per-component CSS              | 381 KiB     | 110 KiB     |
| **shipped** (the explorer, per-component) | **437 KiB** | **123 KiB** |

The served page went from **70 KiB to 458 KiB** (6.5x; 6.6 KiB to ~125 KiB
gzipped). React is 188 KiB of it and is the floor - Mantine adds ~150 KiB of JS
and ~80 KiB of CSS on top.

Two decisions came out of measuring rather than guessing:

- **Per-component CSS, not the barrel.** `@mantine/core/styles.css` is 234 KiB for
  a dozen components; importing `styles/Accordion.css` and friends is a third of
  that. The list in `src/styles.ts` is load-bearing - a missing file is an
  unstyled component, not a build error.
- **`Tooltip` and `ScrollArea` were dropped** for `title=` and `overflow: auto`,
  which took 490 KiB to 437 KiB. `Tooltip` drags in floating-ui.

437 KiB inlined is ~3x smaller than swagger-ui's own bundle and normal for a
modern web app. What made it the one number worth revisiting was not the bytes but
**where they were paid**: it landed in a package that otherwise ships ~40 KiB with
zero runtime dependencies, and it landed at import, on every consumer, whether or
not `/docs` was ever mounted.

### The explorer is behind `@dunx/openapi/ui`, and that needed `splitting: true`

`html.ts` exports `renderShell(document, options, ui)` and takes the script to
inline as an argument rather than importing it. `src/ui.ts` is the entrypoint that
pairs it with `UI`, exported as `./ui` in the manifest, and
`OpenApiExplorer.page()` does `await import('./ui.js')` on the first request for a
given mount prefix. `page()` is async as a result, and so is the controller
handler; the per-prefix cache is unchanged, so only the first request pays.

|                 |  inlined | behind `./ui` | pre-explorer baseline |
| --------------- | -------: | ------------: | --------------------: |
| `dist/index.js` |  479,596 |    **19,807** |                40,948 |
| import          | 10.88 ms |   **5.73 ms** |               ~6.1 ms |
| RSS             | 42.5 MiB |  **37.0 MiB** |              37.0 MiB |

Import and RSS are the median of 15 interleaved `bun` processes each, one import
and out. The `inlined` column is a bundle rebuilt from the same source with the
explorer imported statically (480,901 B), so both sides are measured in the same
session rather than one being quoted from an earlier run; the real pre-split
`dist/index.js` measured 9.64-11.64 ms over 5 runs, which agrees. The absolute
figures move with machine load - a second 15-run pass gave 9.45 against 5.19 - so
the number to hold onto is the **ratio, a stable ~1.8x**, and the RSS delta.

The whole of the explorer's boot cost is recovered. `dist/index.js` is 19,807 B
plus a 13,132 B shared chunk against a 40,948 B pre-explorer baseline, and
`dist/ui.js` carries the 447,850 B.

The split turned up a **type-graph** cost that had been shipping unnoticed. `UI`
was only ever used in a value position, so `html.d.ts` never named it and
`dist/ui-bundle.d.ts` - a 456 KB single-line declaration holding the literal type
of a minified bundle - was 456 KB of tarball nobody's tsc read. Exporting `UI`
from `./ui` would have made every consumer of the subpath parse it. The generator
in `internal/openapi-ui/scripts/build.ts` now emits `export const UI: string`, and
the widening annotation collapses that declaration from **456,550 B to 98 B**. The
annotation is load bearing; removing it silently restores the 456 KB file.

**The dynamic import alone would have been a no-op**, and that was measured rather
than assumed. `scripts/build-package.ts` set `splitting: false`, and with splitting
off `Bun.build` inlines a relative `await import()` into the importing entry: a
200 KB module behind a dynamic import produced a **200,980 B** entry with
`splitting: false` and a **350 B** entry plus a chunk with it on. Shipping the
subpath without flipping the flag would have claimed a win it could not
demonstrate.

`splitting: true` is shared by all eight packages, because there is one build
script and it stays that way. It turned out to be an improvement for the
multi-entry ones rather than a risk: a module two subpaths share was previously
duplicated into both entries, giving a consumer who imports both **two module
instances**. Sharing a chunk fixes that and shrinks the output - `@dunx/infra`
127.7 KB → 71.7 KB of dist JS, `@dunx/transform` 10.3 KB → 5.6 KB, `@dunx/auth`
18.7 KB → 14.8 KB, `@dunx/create-app` 7.5 KB → 5.1 KB. Single-entry packages with
no dynamic imports (`@dunx/core`, `@dunx/http`) emit byte-identical output. The
`bin` chmod, the test-declaration sweep and the `bin`-declaration sweep are all
keyed off entrypoints, not chunks, so none of them changed.

With the boot cost gone, 437 KiB is paid by the person looking at the page, which
is the right place for it. **`preact/compat` is therefore rejected rather than
pending**: it would remove ~170 KiB from a cost nobody pays until they ask for it,
in exchange for running Mantine on a compatibility shim.

### Vite here, `bun build` in `internal/docs`

The docs site measured Vite at 1.7 s against `bun build ./index.html` at 41 ms and
took Bun's ~25 % larger output, which is right for a site. Every byte here is
inlined into a page a backend serves, so Rollup's tree-shaking wins and the ~1.8 s
is paid once per package build.

### Markdown and samples stay on the server

`Bun.markdown.html` renders every description and `sampleFor` pre-computes every
request body, both in `packages/openapi/src/model.ts`; the results travel in the
model. Rendering markdown in the browser would have meant a parser in the bundle,
and re-implementing `sampleFor` would have meant two of it. This is also what
keeps the raw-HTML escaping (`noHtmlBlocks`, `noHtmlSpans`, `tagFilter`) in one
place - the client only ever sees already-escaped HTML.

### The no-external-requests test had to change shape

`expect(page).not.toContain('src=')` was sound over hand-written HTML and is
meaningless over a minified React bundle, which contains `.src=`, `href="` and the
literal string `"<script>"` in its own code. The assertion moved to the **tags**:
the page is stripped of both script bodies, and the remaining markup must carry no
`src=`, no `<link>` and no off-origin `href`. The whole page is still checked for
`url(http`, `@import` and CDN hosts. `page-ui.test.ts` then proves it positively -
it runs the real bundle in happy-dom and asserts zero fetches during boot.

# @dunx/docs

The documentation site for dunx: **React + Mantine over Vite**, built to static
output and deployed to GitHub Pages at <https://petarzarkov.github.io/dunx>.

Private, never published. Per CLAUDE.md, `tools/*` may depend on anything -
The dependency rules govern what dunx _ships_, not what builds its website.

```bash
bun run docs:dev      # extract, then serve with HMR
bun run docs:build    # extract, then build to internal/docs/dist
```

## Vite, and why it is not `Bun.build`

It was `Bun.build` - `bun build ./index.html` did the same job in 41 ms against
Vite 5's 1.7 s, at ~25% more gzipped JS. Vite 8 is Rolldown, which removed the
speed argument, and Mantine plus `@mantine/charts`/recharts had grown the size
one. Re-measured on this site, same content, `gzip -9`:

| Bundler            | JS raw    | JS gzip      | CSS gzip | Build   |
| ------------------ | --------- | ------------ | -------- | ------- |
| `Bun.build`        | 1829.6 KB | **506.5 KB** | 35.0 KB  | ~0.15 s |
| Vite 8 (Rolldown)  | 1558.1 KB | **426.8 KB** | 31.2 KB  | ~0.30 s |

83.5 KB less over the wire for 150 ms nobody waits on. Two consequences worth
knowing before reversing it: text imports are Vite's `?raw` rather than
`with { type: 'text' }` (typed by `src/env.d.ts`, taught to `bun test` by
`happydom.ts`), and `public/` copying and the `dist/` clean are Vite's rather
than a hand-written `scripts/build.ts`.

## What the site is made of

Almost nothing here is hand-maintained prose. Every page is generated from
something that already exists in the repo:

| Page             | Source                                                    |
| ---------------- | --------------------------------------------------------- |
| Benchmarks       | `internal/bench/results/latest.json`                         |
| Landing          | the package manifests, plus a summary of the benchmark run |
| Guides           | `docs/*.md`, rendered by `Bun.markdown.html`              |
| Package overview | that package's `README.md`                                |
| API reference    | the doc comments in `packages/*/src/**/*.ts`              |
| Coverage         | `internal/docs/src/generated/coverage.json`                  |

The landing page's hero, its dependency-injection sample and its four claim
panels are the exception, and are written by hand - but the numbers inside them
are not. The request-logging cost, the throughput range and the win/tie/loss
scoreboard are all read off the benchmark model, so a rerun rewrites the page
rather than leaving it overstating.

`scripts/generate.ts` writes `src/generated/`; `bun run gen:cov`
(`scripts/coverage-report.ts` at the repo root) writes
`src/generated/coverage.json` and the badge SVGs in `public/badges/`. Both
directories are gitignored - they are build output.

## One file per route, not one model

The model used to be a single `site.json` imported into the entry chunk, so
opening `#/` downloaded all 21 guide bodies and all eight package readmes to
render a page that shows none of them. `generate.ts` now writes:

| File                            | Holds                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `index.json`                    | the nav, the landing page, the footer, and the search index  |
| `guides/<slug>.json`            | one guide's rendered HTML                                    |
| `packages/<dir>.json`           | one package's readme and its full symbol documentation       |
| `chunks.ts`                     | a `slug -> () => import(...)` table over the two above       |

Measured, `gzip -9`, entry chunk only - which is all `#/` downloads:

| Entry chunk       | JS raw     | JS gzip      |
| ----------------- | ---------- | ------------ |
| one `site.json`   | 2529.9 KB  | **595.2 KB** |
| split per route   |  937.2 KB  | **266.1 KB** |

329.1 KB less on the landing page, 55% of it. The sum over *every* chunk goes the
other way, 2529.9 KB to 2554.8 KB raw and 595.2 KB to 626.3 KB gzipped, because
each chunk is compressed against its own dictionary - the trade is deliberate:
nobody downloads all 30.

**`chunks.ts` is generated rather than a glob.** `import.meta.glob` is a Vite
feature the `bun test` runner does not have, and a template-literal `import()` is
a bundler feature rather than a language one. A generated table of literal
specifiers is neither: Vite splits on it, `bun test` resolves it through the same
`?raw` plugin `happydom.ts` already installs, and `tsc` checks it.

The index keeps every public symbol's **name, kind and line** so `Search` can
still index all 382 of them across all eight packages without pulling in a
signature, a doc comment or a member list. `Guide` and `PackagePage` render their
frame from the index on the first paint - title, source link, contents, export
counts - and fill the body in when its chunk lands, so the split costs no layout
shift.

## What a README loses on the way in

A package README also serves someone working in this repository, and that reader
is not the one on the docs site. `siteMarkdown` in `scripts/content.ts` drops:

- the centered title-and-badges block a README opens with, and
- every `##` section whose heading begins with one of:

  **Install** · **Installation** · **License** · **Licence** · **Contributing** ·
  **Development** · **Building** · **Project Structure** · **Scripts** ·
  **Commit Convention** · **Versioning** · **Adding a New Package** ·
  **Packages**

Matching is on the heading's slug with a `-` word boundary, so
`## Install it as a devDependency` goes with `## Install`, and `## Setup` - which
is API documentation in `@dunx/transform` - stays. Nested `###` headings go with
their parent `##`. Fenced code is tracked, so the `# bunfig.toml` inside
`packages/transform/README.md`'s example is not mistaken for a heading.

**Naming a section is how an author chooses.** Content worth keeping should not
live under one of those headings; `@dunx/testing`'s single-copy-of-`@dunx/core`
reasoning sits under `## Install it as a devDependency` and is therefore not on
the site.

`Packages` is on the list for a different reason: the site generates its own
package index from the manifests, and the root README's version of it is a wall
of shields. The guides under `docs/` are exempt from all of this - they *are*
repository documentation.

## The benchmark page

`scripts/extract/bench.ts` reads `internal/bench/results/latest.json`, checks its
`schemaVersion` against the mirror of the harness's shape in
`scripts/extract/model.ts`, and writes a **projection** of it to
`src/generated/bench.json`. The report is the harness's evidence - every run's
startup samples, each scenario's expected body and mime type, each subject's
entry file and preloads - and none of that reaches a pixel. Copying it verbatim
put ~48 KB of JSON in the bundle where the projection is 10.6 KB. `BenchReport`
is the mirror, `BenchModel` is what the site carries, and a field that survives
`projectBench` is a field something renders.

A run is not required to build: when the file is missing - or written by a newer
schema - `bench.json` is the literal `null`, and the page says how to produce one
instead of rendering half a report. `results/latest.json` is the one file under
`results/` that is _not_ gitignored, because CI builds the site from a clean
checkout and an untracked report would deploy a page with no numbers on it.

`@dunx/http` is marked in every table, and rows are ordered by the measured value
alone - so it is marked where it comes third on cold start exactly as it is where
it comes second on throughput. Colour encodes the **runtime**, not the ranking: a
Bun subject beating a Node one says something about Bun and nothing about the
framework.

Every claim on the page is computed from the report:

- the **scoreboard** classifies each scenario against the fastest rival through
  `NOISE_PCT`, a ±3 point band. A rerun that turns a win into a tie rewrites the
  sentence. `Verdict` is what the badges read.
- `Where dunx loses` uses **strict ordering**, not the band, so a 1.1 point
  deficit is still listed as a loss even where the scoreboard calls it a tie.
  The two are deliberately not the same test.
- request logging is a **separate subject**, because it is on by default and no
  other subject does it. Its cost appears on the landing page next to the claim,
  not buried.

## Why `oxc-parser` and not the TypeScript compiler API

The extractor reads every `.ts` file under each package's `src/`, finds the
exported declarations, and pulls the doc comment, the signature and the source
location off each one. `packages/transform` already drives `oxc-parser` for the
constructor-dependency transform, and the same parser answers every question the
extractor has:

- **Signatures.** They are sliced out of the source text between AST offsets -
  from the declaration's start to the start of its body. That yields the
  signature as it was _written_, which for a codebase this heavily annotated is
  better documentation than a compiler-inferred type would be:
  `export const inject = <T>(token: InjectionToken<T>): T =>` rather than a
  resolved, normalised, and much longer expansion.
- **Doc comments.** oxc returns a flat `comments` array with offsets. A block
  comment binds to a declaration when only whitespace separates them.
- **The public surface.** Each package's `exports` map gives the entrypoints;
  following `export * from` and `export { x } from` through the module graph
  says which subpath a consumer actually reaches a symbol through. Symbols no
  entrypoint reaches are marked internal and hidden behind a toggle.

TypeScript's own API would add one thing: **inferred** types, for declarations
that carry no annotation. That is worth very little here - dunx exports are
annotated, `.d.ts` emission already requires it in most positions, and the cost
would be loading a full type checker over five packages at build time. It is
also the parser this repo already ships. So: oxc.

The honest limits of that choice, all consequences of reading syntax rather than
types:

- A signature is only as informative as its annotation. An un-annotated
  `export const x = compute()` documents as `const x = compute()`.
- `export * as ns from './x'` is not expanded into a namespace.
- Overload sets show as one entry - the last declaration wins.
- Nothing is resolved across packages: `Logger` in a `@dunx/http` signature is
  text, not a link to `@dunx/core`'s class.

## Layout

```
vite.config.ts         # base path, react plugin - the whole build config
happydom.ts            # test preload: a DOM, plus Vite's ?raw for bun test
scripts/
  generate.ts          # entrypoint: writes src/generated/ - index, bodies, chunks.ts
  content.ts           # markdown -> HTML, heading ids, links, siteMarkdown
  extract/
    ast.ts             # structural views over oxc's ESTree output
    jsdoc.ts           # doc-comment binding and tag parsing
    signature.ts       # source-slice signatures
    symbols.ts         # a module's exported declarations
    surface.ts         # entrypoint -> re-export graph -> public surface
    bench.ts           # report -> the projection the site carries
    index.ts           # per-package orchestration
    model.ts           # the JSON model both sides share
src/
  App.tsx              # shell, navigation
  router.ts            # hash router, symbol anchors, scroll restoration
  data.ts              # the index, parsed once, plus the per-route body loaders
  chunk.ts             # useChunk: a per-route body as it arrives
  bench.ts             # ranking, baseline percentages, verdicts, scoreboard
  components/          # Prose, SymbolCard, Search, CodeBlock, NoDecorators, Bench*
  pages/               # Benchmarks, Home, Guide, PackagePage, Coverage, NotFound
```

Routing is hash-based (`#/api/core`) on purpose: GitHub Pages serves static
files with no SPA fallback, so a path-based router would 404 on every deep link.

## Deep-linking a symbol

`#/api/core?h=symbol-ConsoleLogger` is what a search hit navigates to, and three
things have to hold for it to land - all three were wrong at once, which is why
clicking a symbol used to open the package readme:

1. `symbolHref` in `router.ts` emits the `?h=`. The search action used to
   navigate to the bare package route.
2. `PackagePage` opens the **API tab** when the anchor names a symbol. `Tabs` is
   `keepMounted={false}`, so on the readme tab the card is not in the DOM at all.
   A linked symbol also bypasses the kind filter, the text filter and the
   Internal switch: the reader asked for that one by name.
3. `useScrollTo` **retries across frames** and re-scrolls until the target stops
   moving. The card mounts a commit after the route changes, and the cards below
   it finish laying out after that, so one lookup lands near the symbol rather
   than on it. Instant, not smooth - a cold load can be thousands of pixels
   short.

The card the anchor names renders with `data-linked="true"` and a ring, because
being on screen and being findable are not the same thing.

## Tests

`bun test` runs two suites: `scripts/extract.test.ts` over the extractor
(including a real extraction of `@dunx/core` and the `siteMarkdown` rules), and
`src/site.test.tsx`, which mounts the app in happy-dom and asserts the generated
model actually reaches the DOM. `happydom.ts` is the test preload; it registers a
`Bun.plugin` for Vite's `?raw` suffix so `src/data.ts` needs no test-only code
path.

The benchmark assertions are `test.if(bench !== null)`, so they check real
numbers when the build had a run and skip rather than fail when it did not.

## Not done yet

- No syntax highlighting in code blocks - they are styled, not tokenised.
- The OpenAPI document `@dunx/openapi` produces is not yet a page here.
- The *content* is code-split per route, but the *code* is not: `recharts` is in
  the entry chunk whether or not the reader ever opens the benchmark page.

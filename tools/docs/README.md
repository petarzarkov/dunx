# @dunx/docs

The documentation site for dunx: **React + Mantine over `Bun.build`**, built to static
output and deployed to GitHub Pages at <https://petarzarkov.github.io/dunx>.

Private, never published. Per CLAUDE.md, `tools/*` may depend on anything —
Rule 1 governs what dunx _ships_, not what builds its website.

```bash
bun run docs:dev      # extract, then serve with HMR
bun run docs:build    # extract, then build to tools/docs/dist
```

## What the site is made of

Nothing here is hand-maintained prose. Every page is generated from something
that already exists in the repo:

| Page             | Source                                                     |
| ---------------- | ---------------------------------------------------------- |
| Benchmarks       | `tools/bench/results/latest.json`                          |
| Landing          | the root `README.md`, plus a summary of the benchmark run   |
| Guides           | `docs/*.md`, rendered by `Bun.markdown.html`               |
| Package overview | that package's `README.md`                                 |
| API reference    | the doc comments in `packages/*/src/**/*.ts`               |
| Coverage         | `tools/docs/src/generated/coverage.json`                   |

`scripts/generate.ts` writes `src/generated/site.json` and
`src/generated/bench.json`; `bun run gen:cov` (`scripts/coverage-report.ts` at
the repo root) writes `src/generated/coverage.json` and the badge SVGs in
`public/badges/`. Both directories are gitignored — they are build output.

## The benchmark page

`generate.ts` copies `tools/bench/results/latest.json` into
`src/generated/bench.json` after checking its `schemaVersion` against the mirror
of the harness's shape in `scripts/extract/model.ts`. A run is not required to
build: when the file is missing — or written by a newer schema — `bench.json` is
the literal `null`, and the page says how to produce one instead of rendering
half a report. `results/latest.json` is the one file under `results/` that is
_not_ gitignored, because CI builds the site from a clean checkout and an
untracked report would deploy a page with no numbers on it.

Nothing on that page is a chart library. The bars are `<div>`s whose width is
the same percentage the neighbouring cell prints, which is both zero bytes of
dependency and impossible to drift from the number it claims to show. Colour
encodes the **runtime**, not the ranking: a Bun subject beating a Node one says
something about Bun and nothing about the framework. `@dunx/http` is marked in
every table, and rows are ordered by the measured value alone — so it is marked
where it comes third on cold start exactly as it is where it comes second on
throughput. `Where dunx loses` is computed from the report rather than written
down, so it cannot go stale against a newer run.

## Why `oxc-parser` and not the TypeScript compiler API

The extractor reads every `.ts` file under each package's `src/`, finds the
exported declarations, and pulls the doc comment, the signature and the source
location off each one. `packages/compiler` already drives `oxc-parser` for the
constructor-dependency transform, and the same parser answers every question the
extractor has:

- **Signatures.** They are sliced out of the source text between AST offsets —
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
that carry no annotation. That is worth very little here — dunx exports are
annotated, `.d.ts` emission already requires it in most positions, and the cost
would be loading a full type checker over five packages at build time. It is
also the parser this repo already ships. So: oxc.

The honest limits of that choice, all consequences of reading syntax rather than
types:

- A signature is only as informative as its annotation. An un-annotated
  `export const x = compute()` documents as `const x = compute()`.
- `export * as ns from './x'` is not expanded into a namespace.
- Overload sets show as one entry — the last declaration wins.
- Nothing is resolved across packages: `Logger` in a `@dunx/http` signature is
  text, not a link to `@dunx/core`'s class.

## Layout

```
scripts/
  generate.ts          # entrypoint: writes src/generated/site.json
  content.ts           # markdown -> HTML, heading ids, link rewriting
  extract/
    ast.ts             # structural views over oxc's ESTree output
    jsdoc.ts           # doc-comment binding and tag parsing
    signature.ts       # source-slice signatures
    symbols.ts         # a module's exported declarations
    surface.ts         # entrypoint -> re-export graph -> public surface
    index.ts           # per-package orchestration
    model.ts           # the JSON model both sides share
src/
  App.tsx              # shell, navigation
  router.ts            # hash router — GitHub Pages needs no rewrite rules
  data.ts              # the generated JSON, parsed once
  bench.ts             # ranking, baseline percentages and headlines over the run
  components/          # Prose, SymbolCard, Search, BenchBars, BenchSummary
  pages/               # Benchmarks, Home, Guide, PackagePage, Coverage, NotFound
```

Routing is hash-based (`#/api/core`) on purpose: GitHub Pages serves static
files with no SPA fallback, so a path-based router would 404 on every deep link.

## Tests

`bun test` runs two suites: `scripts/extract.test.ts` over the extractor
(including a real extraction of `@dunx/core`), and `src/site.test.tsx`, which
mounts the app in happy-dom and asserts the generated model actually reaches the
DOM. `happydom.ts` is the test preload; it registers that
text-import suffix so `src/data.ts` needs no Bun-specific code path.

The benchmark assertions are `test.if(bench !== null)`, so they check real
numbers when the build had a run and skip rather than fail when it did not.

## Not done yet

- No syntax highlighting in code blocks — they are styled, not tokenised.
- The OpenAPI document `@dunx/openapi` produces is not yet a page here.
- The bundle is one chunk; it is not code-split per package.

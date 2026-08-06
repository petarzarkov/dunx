# @dunx/openapi-ui

The API explorer `@dunx/openapi` serves at `GET /docs`. Private tooling: it is
never published, and it is not a dependency of the package that serves it.

```bash
bun run dev        # vite, against the fixture model in index.html
bun run bundle     # build, and write packages/openapi/src/ui-bundle.ts
bun run test
bun run typecheck
```

## How the bundle reaches the published package

`@dunx/openapi` has **zero runtime dependencies** and its page provably fetches
nothing - no CDN, no `src=`, no `<link>`. So the explorer cannot be a dependency
and cannot be an asset the browser requests. It is **text**, inlined into the
HTML.

`scripts/build.ts` runs the Vite build, folds any extracted CSS back into the
JavaScript, escapes `</` so the string cannot close the `<script>` it lands in,
and writes `packages/openapi/src/ui-bundle.ts`. That file is **generated and
committed**: `bun test` and `tsc --noEmit` have to work in a fresh clone without
a Vite run, and the publish path must not depend on one. `packages/openapi`'s
`build` script runs this first, so the committed copy cannot go stale.

Vite here, where `internal/docs` deliberately uses `bun build ./index.html`: the
docs site pays ~25 % more gzipped JS for a 41 ms build, which is the right trade
for a site. Every byte of this bundle is inlined into a page a backend serves, so
Rollup's tree-shaking is worth the ~1.8 s.

## The contract with the server

The page carries a `<script type="application/json" id="dunx-openapi-model">`
holding a `PageModel` - the OpenAPI document verbatim, plus the three things only
the server can compute:

| Field     | Written by                            | Why not in the browser                       |
| --------- | ------------------------------------- | -------------------------------------------- |
| `prose`   | `Bun.markdown.html`, HTML off         | a markdown parser would be ~30 KiB inlined   |
| `samples` | `sampleFor`                           | already implemented and tested in the package |
| `fields`  | `fieldsFor`                           | synthesises path parameters a document omits |

Types come from `packages/openapi/src` by relative `import type`, so there is one
declaration of the model and no build-order dependency between the two.

## Keeping it small

Every component costs bytes twice - once in JavaScript, once in the CSS file
`src/styles.ts` has to import. `Tooltip` (floating-ui) and `ScrollArea` were
dropped for `title=` and `overflow: auto`, which took the bundle from 490 KiB to
437 KiB. Icons are four inline paths rather than an icon package. Before adding a
component, check what it drags in.

That is why a documented response renders through **`SchemaView`**, the component
the request body already uses, rather than through a response-shaped copy of it:
one property table, one set of styles, and a `$ref` resolves the same on both
sides. It is still kept clearly apart from the **try-it-out** result below the
`Send it` divider - one is the contract, the other is one real request.

## Tests

`src/explorer.test.ts` covers the logic with no DOM: auth assembly, URL and header
building, grouping and filtering. `src/operation.test.tsx` mounts one operation and
asserts what a reader sees - the documented responses, their resolved schemas, and
that they stay separate from the send panel.

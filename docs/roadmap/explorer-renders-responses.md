# The explorer does not render documented response bodies

**Open.** Surfaced by the change that added them.

`RouteSchemas.response` now puts response schemas in `openapi.json`, hoisted into
`components` and `$ref`d from the operation. The HTML explorer shows none of it:
`tools/openapi-ui`'s `model.ts` never reads `responses`, so a route with a fully
documented 200 renders exactly as one without.

That is the more visible half of the feature. Someone reading the page - which is
the whole reason the page exists - sees no more than before.

## What it needs

- Read `operation.responses` in `tools/openapi-ui/src/model.ts`, resolving `$ref`
  against `components.schemas` the same way the request side already does.
- Render each status with its schema, next to the existing request panel. The
  property table component that renders a request body takes the same shape.
- The try-it-out panel already shows the actual response; this is the _documented_
  one, so the two should be distinguishable rather than merged.

Remember that every component added to `tools/openapi-ui` costs bytes twice, in the
JS and in the CSS list in `src/styles.ts`, and the bundle is inlined into
`@dunx/openapi`. Reuse the request-side table rather than adding a second one. See
[openapi-ui-subpath](./openapi-ui-subpath.md), which is about that weight.

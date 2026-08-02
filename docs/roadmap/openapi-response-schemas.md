# No success-response bodies are ever documented

**Missing feature. High for anything consuming the spec.**

`RouteSchemas` has `body`, `query`, `params` and `status`, and no `response`. There
is no `@ApiResponse` equivalent. Every success response in a generated document is:

```json
"200": { "description": "OK" }
```

No `content`, no schema, on any route.

Two consequences:

- **The spec cannot drive client codegen.** A generator sees eight paths returning
  nothing.
- **`.meta({ id })` on a response-only schema is inert.** It never enters
  `components`, because nothing references it. The template's document has 8 paths
  and exactly three components, all of them request shapes.

`@ApiOkResponse({ type: X })` has no counterpart at all.

## Shape of the fix

A `response` key on `RouteSchemas`, keyed by status, taking the same Standard Schema
values the request side takes. That keeps one contract for both directions and
means a response schema hoists into `components` the same way a request one does.

Pinned by `src/openapi.spec.ts` in `dunx-template` under `KNOWN GAP`, so it turns
into a passing test when fixed.

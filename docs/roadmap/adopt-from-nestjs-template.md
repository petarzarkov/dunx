# Adopt what is good from nestjs-template

**Ongoing.** The owner spent months on `~/repos/nestjs-template`
and rates it. Treat it as a source of proven patterns.

## Adopted

- **Merging Better Auth's OpenAPI schema into the app document.** Done, with four
  deliberate differences from the original: a declared route wins a collision
  rather than being overwritten, the fragment type is loose because a foreign
  library's operations cannot satisfy dunx's strict `OperationObject`, a missing
  `openAPI()` plugin contributes nothing rather than throwing, and `@dunx/auth`
  restates the fragment shape structurally so it does not depend on
  `@dunx/openapi`. The mechanism is general: anything mounting its own handler can
  contribute.
- **One log entry per request, carrying request and response together.** Adopted
  earlier from the template's `RequestMiddleware` plus `HttpLoggingInterceptor`,
  and simplified: dunx needs one middleware because middleware wraps `next()`.
- **`ConfigService` with a single validation function**, and the `as` subclass that
  keeps the type through a factory's `inject`.
- **Keyset pagination**, as `@dunx/infra/pagination`. Adopted from the template's
  `PaginationFactory` with four deliberate differences, each recorded in the source:
  it awaits the query builder rather than calling `.all()`, so it serves `Bun.SQL` as
  well as `bun:sqlite` where the original was SQLite-only; the cursor's id is any
  non-empty string rather than a UUID, which silently broke keyset pagination over a
  serial or composite id; the envelope mints a cursor only when there is a page in
  that direction, where a `nextCursor` on the last page reads as "there is more" to
  any client checking for null; and the two enums became frozen objects, since
  `dunx/no-enum` rejects the one TS construct that cannot be erased.
- **A queue dashboard page**, as `@dunx/queue-dashboard`. The template had judged
  this unportable - Bull Board is Express-mounted React and `Bun.serve` is not
  Express - and served the data as admin-only JSON instead. It turned out to be
  portable after all: bull-board's `IServerAdapter` is a sink, so `BunServeAdapter`
  implements it over `Bun.serve` in about a page of code. The same division
  `createBunRedisClient` establishes: the library owns the abstraction, Bun owns the
  I/O. That page is now being superseded in turn by
  [dunx-dashboard](./dunx-dashboard.md), which makes queues one panel of four.

## Still to mine

- Swagger UI preauthorization: the template hooks the sign-in response and calls
  `preauthorizeApiKey` so the explorer is authenticated after a login. The dunx
  explorer has an Authorize dialog but does not do this.
- `env-vars.md` as a generated document. **Adopted in `dunx-template` rather than
  here**, and that is probably the wrong side of the line: the document is derived
  from an app's own validator, but the deriving is framework plumbing of exactly the
  kind `bunx dunx-openapi` absorbed when the template's `gen-openapi.ts` proved to be
  37 lines that belonged in `@dunx/openapi`. Watch whether the template's
  `gen-env-docs.ts` goes the same way.
- The e2e layout, and `docker-compose.full.yml` versus `docker-compose.yml`. **Read
  this one sceptically.** The dunx template's compose drifted into building the app
  and running the worker as a second container, which is not what a template's compose
  is for - it starts the backing services you cannot run from source, and Redis is the
  only one of those. Fixed there; the lesson is that copying the NestJS template's
  compose layout is what caused it.
- `scripts/` and `lint-staged.config.mjs`.

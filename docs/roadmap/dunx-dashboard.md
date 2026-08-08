# `@dunx/dashboard` - one page for the whole framework, not just the queues

> **BUILT.** `packages/dashboard` ships, `internal/dashboard-ui` is its page, and
> `examples/full` mounts it at `/api/_dunx` with a leg in the tour. What follows is
> the design record; the four places the build **departed** from it are marked
> **[changed]** and are the ones to read. The package's own README is the user-facing
> document.

**Requested, designed, and now built - the only queue UI in dunx.**
`@dunx/queue-dashboard` mounted bull-board for one release and has been **deleted**,
from this repo and from npm, so this page is the whole plan rather than a replacement
for something already working. Nothing serves queue data today.

The observation behind it: an operator looking at a running dunx app has three
separate surfaces over the same data and none of them is the one they want. The
OpenAPI explorer at `/docs` answers "what can a client call". `@dunx/mcp` answers
the same questions for an agent, over stdio. bull-board answers "what is in the
queue". Nothing answers "what is this process actually doing" - the route table, the
container it built, the queues it drains and whether its dependencies are reachable,
in one place.

That page is cheap to build because **every panel reads data dunx already computes.**

## Four panels

The user-facing scope, all four confirmed.

| Panel                       | Source                                                                                                            | Static or live |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| **Routes**                  | `routesOf` - controller, method, path, zod schemas, middleware chain, `@Roles`/`@Public`                          | static         |
| **Modules and providers**   | `providersOf`, `modulesOf`, `dependenciesOf` - every provider, what it depends on, which module bound it          | static         |
| **Queues**                  | bullmq's own `getJobCounts`, `getJob`, `retry`, `drain`                                                           | live           |
| **Health, config, runtime** | the container's own providers: redacted config, health indicators, gateway paths, uptime, heap, Bun/Node versions | live           |

The provider panel is the one that earns its place fastest. A missing-binding error
names one token; reconstructing which module bound what and why the graph did not
close is currently a grep. This is that graph, already computed, on a page.

## The one decision that is the opposite of `@dunx/mcp`'s

[mcp-server](../architecture/mcp.md) settled **static**: it reads an app, it never
boots one, because `AppFactory.create` instantiates every provider and awaits every
async factory, so booting to answer "what routes exist" opens databases, starts
workers and binds sockets.

The dashboard inverts that, and it is allowed to, because **it is mounted inside an
app that is already running.** There is no boot to trigger; the live container is
what it was handed. So the split is per panel:

- Routes, modules and providers use the same static readers, walking prototypes with
  no construction. They would answer identically before boot.
- Queues, health, config and runtime read the container the middleware lives in.
  These are the questions MCP deliberately refuses, and the reason it refuses them
  does not apply here.

Stating it this way is what stops the dashboard growing a `boot()` for anything.

## Where the readers live, and the refactor this forces

`routesOf`, `gatewaysOf`, `providersOf`, `modulesOf` and `dependenciesOf` are
exported from **`@dunx/mcp`** today, which is the wrong home for them the moment a
second consumer exists. A dashboard peer-depending on an MCP server to borrow a
graph traversal is upside down.

They are traversals over data other packages own, so they move down to it:

| Reader                                       | Moves to     | Reads                                        |
| -------------------------------------------- | ------------ | -------------------------------------------- |
| `providersOf`, `modulesOf`, `dependenciesOf` | `@dunx/core` | module records and `Symbol.for('dunx.deps')` |
| `routesOf`, `gatewaysOf`                     | `@dunx/http` | route and gateway metadata                   |

`@dunx/mcp` then keeps what is actually its own - the JSON-RPC protocol, the tool
definitions, stdio - and re-exports the readers so nothing consuming them breaks.
This is worth doing on its own merits: `readDeps` already lives in core, and
`describeRoutes` already lives in `@dunx/openapi` doing an overlapping walk, so
there are currently **two** route traversals in the repo and this collapses them to
one.

Do this refactor first. Building the dashboard against `@dunx/mcp` and moving the
readers afterwards means writing the imports twice.

## Server-rendered, and no second bundle - **[changed]**

**This was the recommendation. It was reversed deliberately, by the repo owner, in
favour of a React bundle sharing `@dunx/ui` with the documentation site and the API
explorer.** The reasoning below is kept because the cost it names is real and was
paid: `@dunx/dashboard`'s bundle is 454.7 KiB (126.9 KiB gzipped), an app serving
both pages carries roughly 900 KiB of inlined UI, and there is a second
generated-and-committed `ui-bundle.ts` that can go stale.

What was bought for it: one design system across all three surfaces, a real
development loop (`bun run dev`, HMR) instead of string templating, and panels -
the job drawer, per-state paging, live polling - that would have been painful as
form posts. The escape hatch this document described as "already paved" is exactly
what was used: a `./ui` subpath reached with `await import()`, `html.ts` taking the
script as an argument, and `internal/dashboard-ui` mirroring `internal/openapi-ui`
file for file.

The consequences it predicted are therefore **not** in force: the provider graph is
still a nested list (a layout engine was not worth it either way), and retry/drain
are real buttons rather than form posts.

The original argument, for the record:

`@dunx/openapi` inlines a 456 KB React bundle as text, generated by
`internal/openapi-ui` with Vite and committed as `ui-bundle.ts`. Copying that shape
gives a second `tools/dashboard-ui`, a second generated-and-committed bundle that
can go stale, and roughly another 450 KB in an app that is very likely serving both
pages. That is the wrong trade here, for a reason specific to what these two pages
are:

- The explorer is an **interactive client**. Sending a request, editing a body,
  reading a response - that is an application, and 456 KB behind a lazy
  `await import()` is a fair price for it.
- The dashboard is **six tables and a drawing**. Routes, providers, modules,
  queue counts, config keys, indicators. Server-rendered HTML with a few KB of
  vanilla JS for filtering covers all of it.

So: no framework, no build step, no `tools/` addition. The deleted package established
the precedent one notch down: it dropped `ejs` for a `String.replace` substitution
renderer, verified against bull-board's real template character for character, because
210 KB for five interpolations and no control flow is not worth it.

Two consequences to accept deliberately:

- **The provider graph is a nested list, not a force-directed diagram**, at least to
  start. An SVG can be generated server-side if it earns it - `internal/docs` already
  draws the request lifecycle as inline SVG - but a layout engine in the browser is
  what the no-bundle decision spends.
- **Retry and drain are form posts**, not optimistic UI.

The escape hatch stays open and is already paved: if a panel genuinely needs to be
an application, `tools/dashboard-ui` plus a `./ui` subpath reached with
`await import()` is exactly how `@dunx/openapi` does it, and nothing here forecloses
it. `html.ts` taking the script to inline as an argument is the pattern to copy.

Every panel also gets a **JSON sibling** (`/_dunx/routes.json`), which is the same
payload the MCP tool returns. Free, because the readers are shared, and it means the
page is not the only way to get the data.

## The mounting model, inherited from a deleted package

`@dunx/queue-dashboard` existed for one release and **has been deleted** - from this
repo and from npm. It mounted bull-board on `Bun.serve`, which worked; what was wrong
was the unit. A queue-only dashboard is not a thing a framework should ship when the
same page should be answering "what is this process doing" in full.

So this package starts from nothing, and there is **no queue UI in dunx at all** until
it lands. That is the accepted cost. What it must not do is relearn the four things
that release established, because none of them is obvious and all were worked out
against `Bun.serve`:

- **A global middleware, not a controller.** Middleware registered with `app.use`
  runs in front of the unmatched-path fallback, which is where the dashboard's paths
  land because the app declares none of them. Declaring them as dunx routes would mean
  generating controllers for a route table handed over at runtime.
- **`authorize` has no default.** Leaving it out serves the page to anyone who can
  reach the port. Fine behind a private network, bad everywhere else, so it is stated
  either way rather than guessed.
- **A rejected request gets 404, not 403.** A dashboard that announces itself to an
  unauthenticated caller has told them where to keep knocking.
- **It must be registered ahead of any session guard.** Measured in `dunx-template`:
  with the middleware last in the chain, `SessionGuard` answered every dashboard
  request `401` before `authorize` ran, which defeats the 404 contract entirely. That
  works only because `authorize` receives the raw `Request` and can ask the auth
  library itself rather than reading an `AuthContext` written earlier in the chain -
  so **keep `authorize` self-sufficient**.

Also worth carrying over: everything is built on the **first request**, memoised on
the promise so two concurrent first requests build one dashboard, and anything not the
dashboard's path **falls through** so the app's own routes and its 404 behave exactly
as before.

Gone with the package, and not to be resurrected: `BunServeAdapter` (it existed only
to satisfy bull-board's interface), the substitution renderer, the `@bull-board/api`
and `@bull-board/ui` peers, the optional `ejs` peer, and 2.7 MB of static assets.
`DashboardQueue` - a bullmq queue restated structurally so the package depends on
`@dunx/infra` not at all - is the one type worth reintroducing verbatim; that
constraint has not changed.

## The queues panel is now built from scratch - **[reversed]**

**It is not. bull-board is mounted, and dunx renders no queue UI at all.**

This document's premise - that a queue panel had to be built from scratch because
mounting bull-board on `Bun.serve` meant maintaining a `BunServeAdapter` - **expired
between the design and the build**: bull-board 8.6.0 ships `@bull-board/bun`, an
official Bun adapter. So the integration is three calls, dunx owns none of the queue
surface, and the deleted `@dunx/queue-dashboard`'s one real liability is gone.

A hand-rolled panel _was_ built first, briefly - a table over `getJobCounts` and
`getJobs` with seven commands - and it was deleted the moment `@bull-board/bun` was
found. That is Rule 1's second half working as intended, one iteration late. The
section below is kept as the record of what was reasoned and why it was wrong to
start from the assumption rather than checking the registry.

**This also settles the `getWorkers()` question** rather than working around it. It
is always `[]` on Bun, and that is bullmq's and bull-board's to surface - a dashboard
that quietly papered over a library's limitation would be a worse place to find out
about it.

The original two-command scope:

There is no bull-board underneath it any more, which makes the scope question sharper
rather than softer. It is **four calls on bullmq's own `Queue`**:

| Shown            | Call                                                 |
| ---------------- | ---------------------------------------------------- |
| counts per queue | `getJobCounts()`                                     |
| one job          | `getJob(id)` - state, result, failedReason, attempts |
| retry            | `job.retry()`                                        |
| drain            | `queue.drain()`                                      |

That is deliberately less than bull-board: no scheduler, no flows, no job logs, no
repeatable-job editor, no pagination through thousands of jobs. Nothing about expiry,
retry semantics or backoff is reimplemented - bullmq still owns all of it. Anyone who
needs that depth is better served mounting bull-board themselves, and the design
should say so in the README rather than implying parity.

**Do not call `getWorkers()`.** It always returns `[]` on Bun: bullmq matches workers
by client name through `CLIENT LIST`, and its Bun adapter never names a connection, so
a live worker draining jobs reports as absent. Measured, with the reproduction, in
[queue-shutdown-sigterm](./queue-shutdown-sigterm.md), defect C. A "workers" column
would be permanently and confidently wrong, so the panel should omit it and say why -
job counts moving is the signal that works.

## Answering Rule 1 now that there is no library underneath - **[moot]**

There is a library underneath. Everything below was an argument for why a table over
bullmq's four read calls would not violate Rule 1; it is superseded by not writing
the table. Kept because the line it draws - "a panel that needed dunx to model queue
state itself" - is still the right test for any future panel.

With bull-board mounted, the queues panel was a _scope_ decision. Without it, this is
dunx rendering a queue UI, and Rule 1's second half - never invent what a mature
library already solves - has to be answered directly.

It holds, for a reason that is about the data and not the rendering: the four calls
above are **reads and two commands on bullmq's own API**, not a reimplementation of
anything bullmq does. The queue engine, the retry policy, the backoff, the locks and
the scheduler all stay bullmq's. What dunx adds is a table, and a table over a
library's public API is not a competing implementation of that library.

What would violate the rule: a job scheduler UI, a flow editor, or anything that
needed dunx to model queue state itself rather than ask for it. The panel stays on the
four calls, and growing past them is the signal to stop and mount bull-board instead.

## What replaces it in the meantime

Nothing, in the framework. An app that needs the data today writes a controller over
`JobPublisher.queue(name)` - about sixty lines, admin-gated - which is what
`dunx-template` did before the package existed and what
[14-queues.md](../guide/14-queues.md) now documents. That is a fair holding position:
the data is four calls, and the thing that was actually worth having was the page.

## Migration, and what is already cleaned up

The deletion is complete on the dunx side:

- `packages/queue-dashboard` removed, and unpublished from npm.
- `examples/full` lost `src/dashboard/`, its `app.use(QueueDashboardMiddleware)`, and
  the `@dunx/queue-dashboard` / `@bull-board/*` dependencies.
- `create-app` lost the `dashboard` feature, its template folder, its compose test and
  the `@bull-board/*` entries in `THIRD_PARTY`.
- `scripts/first-publish.ts` lost the entry; the guide, README, CLAUDE.md and this
  folder are updated.

**`dunx-template` is the outstanding consumer.** It depends on
`@dunx/queue-dashboard@^0.8.0`, mounts it at `/api/queues` and has an integration suite
asserting the board renders - so `bun install` there now resolves a package that no
longer exists on npm. It needs the dependency dropped and either a JSON controller
back or nothing at `/api/queues` until this ships.

Names when it is built: `DashboardModule.forRoot` / `.forRootAsync`,
`DashboardMiddleware`, `DashboardOptions`, default path **`/_dunx`**. The underscore
keeps it clear of an app's own routes; `/queues` was right for a queue board and is
wrong for this.

## Security, and one new exposure

The `authorize`-with-no-default contract carries over unchanged, but the surface it
guards is much larger than a queue board's, and one panel is genuinely new risk:
routes plus config plus the provider graph on one page is a reconnaissance gift.

- **Config values are redacted, not shown.** The mechanism already exists and is
  proven - `RedisOptions.redactedUrl` and `QueueOptions.redactedUrl` are what the
  template's health endpoint already reports. The panel shows keys and redacted
  values, and there is no "reveal" affordance.
- `ConfigService` holds whatever the app's `validate` returned, which includes
  secrets. So the panel needs an explicit allow/redact decision per key rather than
  dumping `config.values`. **This is the open question of the design** - probably a
  `redact` predicate on `DashboardOptions` defaulting to redacting anything whose key
  matches the usual suspects, with the default stated in the README the way
  `authorize`'s absence is.

## Open questions - **all four resolved**

1. **The redaction default.** Resolved the safe way, and the opposite of what this
   document guessed: **there is no deny-list.** `reveal` defaults to revealing
   nothing, so the panel shows keys and types, and a value appears only where the app
   opts in per key. A deny-list that quietly misses one key is worse than no config
   panel, and it is exactly the failure a list of "the usual suspects" produces.
   `config` is also an explicit option - `ConfigService` is passed in rather than
   resolved from the container, so showing configuration is something the app says
   yes to.
2. **Does the routes panel link into the explorer?** Yes, and it is free:
   `openApiPath` is a **string**, so each route row deep-links into `/docs`.
3. **Live updates.** Polling, at `pollMs` (5 s default, `0` disables), with a pause
   toggle and a refresh button. No websocket: it would put the dashboard's own socket
   in the app's upgrade table and make the page stateful, for latency nobody needs.
   The hook schedules the next request when the last **settles**, drops superseded
   responses, and keeps the previous data when a poll fails.
4. **Is `@dunx/openapi` a peer?** No dependency at all, as the precedent said.

## What the build added that this document did not anticipate

- **`ROOT_MODULE` in `@dunx/core`**, bound into the global scope by
  `AppFactory.create`. The readers take a `ModuleRef` and a middleware has no other
  way to name the root; the alternative was an app listing its own root module inside
  its own `imports`.
- **The gateway predicate is an argument.** `providersOf`/`modulesOf` moved to core,
  which cannot import `@dunx/http`, so `isGateway` is passed in. Without it a gateway
  reports as an ordinary provider and two panels disagree about one class.
- **`queueNames`**, because `JobPublisher.opened` lists only what a process has
  _published_ to - a queue it merely consumes would be invisible on the page that
  exists to show it.
- **`probes`**, with a timeout, reporting `unknown` rather than `down` on a timeout.
- **`setGlobalPrefix` does not move the mount**, which surprised the example. It
  prefixes discovered routes and this is a middleware matching a path.

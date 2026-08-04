# @dunx/queue-dashboard

[bull-board](https://github.com/felixmosh/bull-board) mounted on `Bun.serve`, as an
opt-in dashboard for the queues `@dunx/infra/queue` runs.

```bash
bun add @dunx/queue-dashboard @bull-board/api @bull-board/ui
```

Every one of those is an **optional peer**: an app that never mounts a dashboard
installs none of them, and nothing here is loaded until the first request reaches the
board.

## Mount it

```ts
import { QueueDashboardMiddleware, QueueDashboardModule } from '@dunx/queue-dashboard';

@Module({
  imports: [
    QueueDashboardModule.forRootAsync({
      useFactory: (publisher: QueuePublisher, config: AppConfigService) => ({
        path: '/queues',
        queues: [publisher.queue('emails'), publisher.queue('thumbnails')],
        uiConfig: { boardTitle: config.get('appName') },
        authorize: (request) => isAdmin(request),
      }),
      inject: [QueuePublisher, AppConfigService],
    }),
  ],
})
export class DashboardModule {}
```

Then, between `create()` and `listen()`:

```ts
app.use(QueueDashboardMiddleware);
```

| Option      | |
| ----------- | ---------------------------------------------------------------- |
| `path`      | Where the board is mounted. Default `/queues`                     |
| `queues`    | The bullmq queues to show                                         |
| `uiConfig`  | bull-board's own UI options: board title, logo, favicon            |
| `authorize` | Called for every dashboard request. **No default** - see below     |

## `authorize` has no default, on purpose

Leave it out and the board is served to anyone who can reach the port. That is
reasonable behind a private network and bad everywhere else, so it is stated either
way rather than guessed.

A rejected request gets **404, not 403**: a queue dashboard that announces itself to
an unauthenticated caller has told them where to keep knocking.

It is a function rather than a list of guards because `app.use` is global -
middleware registered there runs for every route, and the point is a check that runs
for the board's paths only.

## Why a package, and not `@dunx/infra/queue`

Serving a dashboard needs the web layer, and `@dunx/infra` must not depend on it.
That is the same reason `@dunx/auth` is its own package, and this follows it exactly:
**it depends on `@dunx/infra` not at all.** `DashboardQueue` restates structurally
what a bullmq queue provides, the way `DrizzleSource` restates `DbConnection`.

## Why dunx writes the adapter

bull-board ships adapters for express, fastify, koa, hapi, hono and elysia, and dunx
can use none of them. express is banned repo-wide; hono or elysia would mean running
a second HTTP framework inside a dunx app to serve one page.

So `BunServeAdapter` implements bull-board's own `IServerAdapter` over `Bun.serve`.
That is the division bullmq's `createBunRedisClient` already establishes: **the
library owns the abstraction, Bun owns the I/O.** The interface makes it cheap
because it is a sink - bull-board pushes its routes, its view path, its static path,
an error handler and the UI config in, and the adapter answers requests from them.

- **Static assets** stream from `Bun.file`, so the 2.7 MB UI bundle is never read
  into memory, and are sent `immutable` since the filenames carry a content hash.
- **The entry view needs no template engine.** bull-board's `index.ejs` is 27 lines
  with five interpolations and no control flow, so it is substituted with one
  `String.replace` - `<%=` escaped through `Bun.escapeHTML`, `<%-` raw. `ejs` is 210 KB
  for that, so it is not a dependency. `render.test.ts` renders the real template both
  ways and asserts they agree, character for character, once ejs's `&#34;` and Bun's
  `&quot;` are reconciled - the same character, spelled differently.

  If a future bull-board release adds control flow, install `ejs` and pass
  `render: await ejsRenderer()`. It stays an optional peer for exactly that.
- **Path traversal** is stopped in two different places, measured rather than assumed:
  a literal `..` never reaches the adapter because `new URL()` resolves it away, and
  the percent-encoded form is refused by an explicit check.
- **Anything not the board's falls through**, so the app's own routes and its 404
  behave exactly as they did.

## Serving is a global middleware, not a controller

bull-board's route table is data it hands over at runtime - a dozen express-style
paths with parameters - so declaring them as dunx routes would mean generating
controllers. Global middleware also runs in front of the unmatched-path fallback,
which is where the board's paths land, since the app declares none of them.

## Verified against

Bun 1.3.14, `@bull-board/api` 8.5.0 and bullmq 6.0.5. The end-to-end suite runs a
real dunx app, a real bullmq queue on a real broker and the real `@bull-board/ui`,
and skips with a printed reason when no broker is reachable.

## License

MIT

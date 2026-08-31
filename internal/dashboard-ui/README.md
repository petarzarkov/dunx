# @dunx/dashboard-ui

The operations page `@dunx/dashboard` serves at `GET /_dunx`. Private tooling: it
is never published, and it is not a dependency of the package that serves it.

```bash
bun run dev        # vite, against the fixture meta in index.html
bun run bundle     # build, and write packages/dashboard/src/ui-bundle.ts
bun run test
bun run typecheck
```

This is a **real React + Mantine application** - the same one `internal/docs` and
`internal/openapi-ui` are, sharing `@dunx/ui`'s theme and components. The backend
package contains no React at all, and cannot. It is published as plain ESM plus
`.d.ts`, and a consumer must not need React or a bundler installed to serve an
HTML page.

## How the bundle reaches the published package

`@dunx/dashboard` has **zero runtime dependencies** and its page fetches nothing -
no CDN, no `src=`, no `<link>` - so the page can be opened on a host with no
egress. The UI therefore cannot be a dependency and cannot be an asset the browser
requests. It is **text**, inlined into the HTML.

`scripts/build.ts` runs the Vite build, folds any extracted CSS back into the
JavaScript, and escapes `</` so the string cannot close the `<script>` it lands
in. Then it writes `packages/dashboard/src/ui-bundle.ts`. That file is
**generated and committed**: `bun test` and `tsc --noEmit` have to work in a
fresh clone without a Vite run, and the publish path must not depend on one. `packages/dashboard`'s
`build` script runs this first, so the committed copy cannot go stale.

It is reached with `await import('./ui.js')` on the **first request for the page**,
so an app that mounts the module and never opens it pays nothing at boot. That is
why `packages/dashboard/src/html.ts` takes the bundle as an argument rather than
importing it - importing it there would silently revert the split.

## The contract with the server

Only the **meta** is embedded, in a
`<script type="application/json" id="dunx-dashboard-meta">`: the mount path, the
poll interval, whether commands are enabled, and where the API explorer lives.
Everything else is fetched, which is the difference from the explorer's model. A
queue count embedded in HTML would be stale before it painted, and the JSON
endpoints have to exist anyway so `curl` can reach them.

Types come from `packages/dashboard/src/api/types.ts` by relative `import type`, so
the wire format has one declaration and there is no build-order dependency between
the two workspaces.

## The two request lifetimes

`/api/snapshot` is fetched **once**: routes, gateways, modules, providers and config
cannot change while the process runs. `/api/runtime` and `/api/queues` are polled.

`usePoll` schedules the next request when the last one **settles** rather than on a
fixed interval. It also drops a response from a request that has been superseded,
and keeps the previous data when a poll fails. All three showed up immediately: a
five-second endpoint on a five-second poll otherwise opens a request per tick
forever, switching queues repaints with the previous queue's jobs, and one failed
poll blanks the page.

## Keeping it small

Every component costs bytes twice - once in JavaScript, once in the CSS file
`src/styles.ts` has to import. Mantine ships one stylesheet per component, and
this imports only what it renders. So **adding a component means adding its CSS
file**. A component that renders unstyled is almost always a missing line there.

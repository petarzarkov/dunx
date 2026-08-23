# Bun 1.4: what it broke, what it closed, what to adopt

Bun 1.4.0 (rev `34cbb9a40`) is installed and the repo is green on it. This file holds
the audit: what the upgrade cost, what it fixed for free, and which of its new APIs
are worth taking. Every verdict below was probed on this machine rather than read off
the release notes; the probe results live in
[../bun-apis.md](../../../docs/bun-apis.md), "Re-probed on Bun 1.4.0".

Delete this file when the adopt list is empty.

## What broke, and it was mostly not Bun

Four things failed on the upgrade. Only one of them was Bun's.

| Break                                                 | Cause                  | Fixed by                                                 |
| ----------------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `@dunx/openapi` and `@dunx/dashboard` failed to build | **Vite 8**, not Bun    | `minify: 'oxc'` in both `internal/*-ui/scripts/build.ts` |
| `lint:check` failed with 22 `no-redeclare` errors     | **oxlint 1.79**        | the rule is off; `tsc` already rejects a real one        |
| One `@dunx/infra` redis test failed                   | **Bun 1.4**            | `isServerError()`, spanning both codes                   |
| `bun.lock` reverted mid-audit                         | a stray `git checkout` | `bun install`, same resolved versions                    |

**The Vite one is the trap.** Vite 8 made `esbuild` an optional peer it does not
install, so `minify: 'esbuild'` throws `Failed to load transformWithEsbuild`. The
re-resolve that came with the upgrade dropped `esbuild@0.28.1` from the lockfile and
the two inlined UI bundles stopped building. `oxc` is Rolldown's own minifier, needs
no extra binary, and is what the rest of the repo already uses (`oxlint`, `oxfmt`,
`oxc-parser`). It also produced **12.3 KB less** per bundle:

```
packages/openapi/src/ui-bundle.ts     458,726 -> 446,412 bytes
packages/dashboard/src/ui-bundle.ts   449,008 -> 436,674 bytes
```

**The oxlint one fires on the idiom CLAUDE.md mandates.** `no-redeclare` in 1.79 flags
`export const X = Object.freeze({...})` paired with `export type X = ...`, which is the
repo's replacement for a TS `enum` and is legal declaration merging in two different
declaration spaces. 1.75 did not flag it; 1.79 does, in 22 files. The rule is redundant
here anyway, because `tsc` rejects a genuine duplicate with `TS2451`, and oxlint cannot
tell the two apart. Reinstate it if upstream teaches it about type-space merges.

**Bun's own break is one renamed error code.** An error Redis itself returned arrived
as `ERR_REDIS_INVALID_RESPONSE` on 1.3 and arrives as `ERR_REDIS_SERVER_ERROR` on 1.4.
The rename is correct: the response parsed fine and the command did not. Because
`@types/bun` is a `>=1.3.0` peer, `RedisErrorCode` lists both and
`@dunx/infra/redis` exports `isServerError()` for the check a consumer should write
instead of either constant.

## The one user-visible behaviour change dunx absorbed

`Bun.cron` flipped its default zone from UTC to the container's local zone. A schedule
written `'0 3 * * *'` fired at 03:00 UTC on 1.3 and fires at 03:00 local on 1.4.

`@dunx/infra/schedule` does not move, because `ScheduleRegistry` passes `tz` on every
call and `ScheduleOptions` defaults it to `'UTC'`. That was written for the opposite
reason - to stop a schedule drifting to the container's `TZ` - and it happens to cover
the flip exactly. Two tests now pin it rather than leaving it to the comment.

The upside is larger than the risk: 1.4 **honours** `{ tz }`, so
`@Cron('0 9 * * *', { tz: 'America/New_York' })` works instead of being a boot error.
`supportsTz()` still decides which side of the change a runtime is on, by probing
rather than by parsing `Bun.version`.

## What 1.4 closed for free

Four findings this repo had recorded as live defects now pass their own probes.

| Finding                                                             | Where it was recorded                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| A `Bun.RedisClient` connect that never completes outlives `close()` | leak A in [queue-shutdown-sigterm](./queue-shutdown-sigterm.md) |
| `Bun.SQL`'s SQLite adapter silently stored `NULL` for a `Date`      | bun-apis.md, "`Bun.SQL` and `bun:sqlite`"                       |
| `Bun.color(hex, 'ansi')` could emit a raw newline                   | bun-apis.md, "`Bun.color`"                                      |
| `AsyncLocalStorage.enterWith()` segfaulted after any `await`        | bun-apis.md                                                     |

**Leak A is the one that mattered.** It was the half of the SIGTERM hang with no
workaround at all. Leak B, bullmq's uncancellable reconnect, is still live: a real
dunx app with `QueueModule` pointed at a refused Redis still needs `ShutdownHooks`'
forced exit. The re-measured table and the reproduction that still works are in
[queue-shutdown-sigterm](./queue-shutdown-sigterm.md).

The `Date` one is worth flagging to consumers rather than only recording: an app that
shipped against 1.3 and unknowingly relied on the silence now gets a thrown error. That
is the right outcome and it is still a behaviour change on upgrade.

## Adopt

Ranked by value per unit of work. The priority rule in
[../ROADMAP.md](../../../docs/ROADMAP.md) still applies, so items landing in `core`, `transform`
or `http` come first and the frozen packages get nothing here that is not a fix.

### A1 - the test runner's new flags, in CI

`bun test` gained `--parallel[=N]`, `--isolate`, `--shard=M/N`, `--changed[=ref]`,
`--timings`/`--update-timings`, and per-test `{ retry }` / `{ repeats }`. Four of those
answer problems this repo has written about.

- **`--isolate`** gives each file a fresh global in the same process, clearing module
  registries and cancelling timers. `packages/openapi/src/page-ui.test.ts` needed
  `await happyDOM.waitUntilComplete()` to stop a react-dom commit running with no
  `window` after teardown; that whole class of cross-file leak is what `--isolate`
  exists for. Measure whether the drain is still needed, and keep it if it is - the
  guard test that fails 15/15 without it is the arbiter.
- **`--parallel`** and **`--timings`** together start the slowest file first. The
  suite is currently `bun run --filter '*' test`, which parallelises across
  workspaces but not within one; `@dunx/infra` alone is 314 tests in 24 files.
- **`--shard=M/N`** splits files across CI runners, which is only worth wiring when
  the single-runner time justifies it. Not yet.
- **`{ retry }`** is the honest tool for a genuinely flaky externality, and it is a
  trap for anything else. This repo fixed its one-in-forty failure by finding the
  teardown race rather than retrying it, and that is the precedent to keep.

**Do not turn `--parallel` on blind.** Several suites bind real ports, spawn
processes, and talk to a real Redis with keys namespaced per run. Verify, then wire it
into `ci.yml`.

### A2 - `fetch`'s new options on `HttpClientOptions`

`HttpClientOptionsInit` already exists to pass Bun-only `fetch` extensions straight
through, and it declares `proxy?: string`, `tls`, `unix`, `decompress`, `verbose`. Four
more are now declared in `bun-types` and are the same kind of pass-through:

| Option         | Shape                                                             |
| -------------- | ----------------------------------------------------------------- |
| `proxy`        | widened to `string \| URL \| { url, headers }`                    |
| `compress`     | `"gzip" \| "deflate" \| "br" \| "zstd"`, or `{ encoding, level }` |
| `protocol`     | `"http2" \| "http1.1" \| "h2" \| "h1"`                            |
| `maxRedirects` | `number`                                                          |

`protocol: "http2"` is the interesting one: concurrent requests to one origin share a
connection, which is what a service calling a single upstream in a loop wants. The
object `proxy` form carries `Proxy-Authorization` to the proxy rather than the target,
which the string form cannot express.

This is additive, in `@dunx/http`, and about thirty lines including the tests.

### A3 - `{ dir }` static routes, once two gaps close

`Bun.serve` routes take `{ dir }` in 1.4, and it does more than `StaticFiles` does:
weak `ETag`, `Last-Modified`, 304 on both conditional headers, 206 ranges,
`index.html` for a directory, a 301 for a directory without a trailing slash, and 404
on `..`, `%2e%2e%2f` and `..%2F` alike. Rule 1 points straight at it.

**It cannot replace `StaticFiles` as it stands**, and the reason is that `StaticFiles`
exists for the thing `{ dir }` has no way to express:

- No `cache-control`, and no way to set one. `DirectoryRouteOptions` is
  `{ dir, statCache }`; a `headers` key is accepted and ignored. Bun answers the route
  itself, so no dunx middleware sees the response.
- **Every method is served.** `DELETE /assets/app.js` returns 200 and the file body,
  and `OPTIONS` returns the file instead of CORS preflight headers.

So this is an upstream ask before it is an adoption. File both, and revisit. Until
then `StaticFiles` keeps its justification, and the gap in the other direction -
dunx serves no `ETag` and answers no conditional request - stays open on purpose,
because closing it by hand is the reimplementation Rule 1 forbids.

### A4 - profiling flags in the bench harness

`--cpu-prof` / `--cpu-prof-md` and `--heap-prof` / `--heap-prof-md` write a profile
without a separate tool, and the Markdown variants are readable in a terminal. The
open follow-up in [../ROADMAP.md](../../../docs/ROADMAP.md) is the `params` gap against Elysia,
where dunx runs a generic input reader per request; a CPU profile of the `params`
subject is the direct instrument for it. Cheap, and it needs no code change.

`--no-orphans` belongs next to it. The bench harness spawns a subject per subject and
the queue worker spawns a child process; a run killed part way currently leaves them.

### A5 - `bun install --linker=isolated` in CI

A shared virtual store with one `symlink()` per package instead of one
`clonefileat()`. The release notes claim 7x on a warm CI cache. Measure it on
`ci.yml` before believing the number, and check that `oxlint`'s JS plugin and the
`oxc-parser` native binary both still resolve through the symlink farm, since the
plugin already has a Node-versus-Bun resolution problem recorded in CLAUDE.md.

## Measured and rejected

**`AsyncLocalStorage.enterWith()`.** bun-apis.md said a working `enterWith` "would
remove an async frame from every logged request, against a measured `run()` cost of
+0.91 us", so the segfault fix looked like it unlocked a win. Three measurements say
it does not, and they are independent of each other.

**The prize is gone.** Re-running `bun run logging` on 1.4 prices the
`AsyncLocalStorage` scope at **+0.24 us**, down from +0.91 us on 1.3.14 and inside the
harness's own +/-0.5 us floor. Bun fixed the thing that made this worth attacking.
The same run makes `requestLogging: { correlate: false }` worth nothing measurable,
which is now recorded in `docs/guide/13-logging.md`.

**The swap would not pay even if the prize were there.** Over 200,000 iterations of
the shape request logging uses, `run()` is 0.168 us per scope and `enterWith()` is
0.151 us, against a 0.097 us floor with no store at all. The saving is **0.017 us**.

**And the semantics rule it out regardless.** `enterWith` cannot restore the
enclosing store, so an inner scope clobbers the outer one permanently, which
`RequestContext.runWithContext` is specified not to do.

Full numbers in bun-apis.md. Do not reopen this on the segfault being fixed.

## Not for dunx

Present, verified reachable, and no use here. Recorded so each is not re-evaluated.

| API                                              | Why not                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `Bun.WebView`, `Bun.Terminal`                    | A backend framework drives neither a browser nor a pty.                                                        |
| `Bun.Image` additions                            | `@dunx/infra/images` is frozen to maintenance.                                                                 |
| `Bun.JSON5`, `Bun.JSONC`, `Bun.JSONL`, `Bun.XML` | Nothing in the repo reads any of these formats. `Bun.JSONC` would suit `.oxlintrc.json`, which nothing parses. |
| `Bun.Archive`                                    | No packaging step builds a tarball; `npm publish` does that.                                                   |
| `CompressionStream` / `DecompressionStream`      | `@dunx/http` does no response compression, and adding it is a feature that needs a user first.                 |
| `URLPattern`                                     | `Bun.serve({ routes })` already matches, and a JavaScript router is banned.                                    |
| HTTP/3 on `Bun.serve`                            | Experimental, and it needs TLS, which the server adapter does not configure.                                   |
| `Bun.serve` HTML routes, `--react-compiler`      | No package ships React; both UI bundles are Vite by a decision in CLAUDE.md.                                   |
| `process.on('memoryPressure')`                   | The [stats](../research/stats.md) record already refused exposition. Revisit there, not here.                  |
| `node:sqlite`, `node:quic`, `node:repl`          | `bun:sqlite` is the Bun-native path; the other two answer no question dunx has.                                |
| `bun:bundle` `feature()` flags                   | `Bun.build` in `scripts/build-package.ts` emits library code, which must not carry build-time branches.        |
| `Bun.markdown.ansi`                              | Plausible for `@dunx/create-app`'s output. Frozen-adjacent and cosmetic; not worth a release.                  |

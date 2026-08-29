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
workaround at all. Leak B is still live and has since been narrowed out of Bun
entirely: a bullmq `Worker` against an unreachable server holds the loop after
`close()` on Node 24 with ioredis, the same as on Bun. A `Queue` is clean. So a
dunx app with `QueueModule` on a refused Redis still needs `ShutdownHooks`' forced
exit, and the report belongs at bullmq rather than at oven-sh/bun. The six-line
reproduction is in [queue-shutdown-sigterm](./queue-shutdown-sigterm.md).

The `Date` one is worth flagging to consumers rather than only recording: an app that
shipped against 1.3 and unknowingly relied on the silence now gets a thrown error. That
is the right outcome and it is still a behaviour change on upgrade.

## Adopt

Ranked by value per unit of work. The priority rule in
[../ROADMAP.md](../../../docs/ROADMAP.md) still applies, so items landing in `core`, `transform`
or `http` come first and the frozen packages get nothing here that is not a fix.

### A1 - the test runner's new flags, in CI - settled

`bun test` gained `--parallel[=N]`, `--isolate`, `--shard=M/N`, `--changed[=ref]`,
`--timings`/`--update-timings`, and per-test `{ retry }` / `{ repeats }`. All of
them are now measured on this repo, and `--parallel` is the only one adopted.

- **`--parallel`** is in the `unit` phase: 3.2s against 14.6s.
- **`--isolate`** needs nothing done. `bun test --help` states that `--parallel`
  implies it, so the `unit` phase has isolated since `--parallel` landed. Adding it
  to the sequential `coverage` phase costs 8% (16.6s to 17.9s) and inflates the
  count by five, because a fresh module registry re-evaluates
  `packages/infra/src/images/fixture.test.ts` once per importing file and its own
  `it()` re-registers each time. Numbers in [../../bun-apis.md](../../../docs/bun-apis.md).
- The reason `--isolate` was wanted has also expired. It was for the react-dom
  teardown leak in `packages/openapi/src/page-ui.test.ts`, and that file was
  deleted with the hand-built API explorer when `@dunx/openapi` moved to
  swagger-ui-dist.
- **`--timings`** changes nothing measurable: 3.12-3.17s with against 3.13-3.16s
  without, over three runs each. The timings file says why - the slowest test file
  is 3045 ms of a 21161 ms total, and the wall clock is ~3150 ms, so the run is
  bounded by that one file and no ordering helps.
- **`--shard`** is bounded by that same file, so it cannot beat 3 s either.
- **`{ retry }`** stays unused. This repo fixed its one-in-forty failure by finding
  the teardown race, and that precedent is worth more than the flag.

Re-measure if `packages/http/src/client/client.test.ts` gets faster, or another
file gets slower than it.

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

So this is an upstream ask before it is an adoption. **Both re-verified on 1.4.0 rev
34cbb9a40 and both filed:**

- [oven-sh/bun#40892](https://github.com/oven-sh/bun/issues/40892) - `{ dir }` routes
  accept a `headers` option and ignore it, so a hashed bundle cannot be served with
  an `immutable` max-age.
- [oven-sh/bun#40893](https://github.com/oven-sh/bun/issues/40893) - `{ dir }` routes
  answer every method. `DELETE /assets/app.js` returns 200 and the file body, and
  `OPTIONS` returns the file instead of the `Allow` a CORS preflight needs.

Revisit when either closes. Until then `StaticFiles` keeps its justification, and the
gap in the other direction - dunx serves no `ETag` and answers no conditional request

- stays open on purpose, because closing it by hand is the reimplementation Rule 1
  forbids.

### A4 - profiling flags in the bench harness - done

`bun run start --profile cpu` (or `heap`) adds `--cpu-prof --cpu-prof-md
--cpu-prof-dir=<dir>` to every **Bun** subject and writes into
`results/profiles`, which is gitignored. `--profile-dir` moves it. Another
runtime's subject is run unprofiled rather than failing, since these are Bun's own
flags. `--no-orphans` is on for every Bun subject now, so a run killed part way
takes the subject and the queue worker's child with it.

**Wiring the flags was not enough, and the reason is worth keeping.** Bun writes a
profile **on exit**, and a signal with no handler is not an exit: measured on
1.4.0, a `Bun.serve` process killed with `SIGKILL`, `SIGTERM` or `SIGINT` writes
nothing at all, while the same process reaching `process.exit(0)` writes both the
`.cpuprofile` and the markdown. The harness killed every subject with `SIGKILL`,
so the first profiled run produced an empty directory and a green report.

Two halves fix it. `servers/shared.ts` installs a `SIGTERM` handler that calls
`process.exit(0)`, at module scope because every Bun and Node subject imports that
file. `startSubject` takes a `graceful` flag, set only when profiling, that sends
`SIGTERM` and waits up to 5 s before falling back to `SIGKILL`. The startup samples
stay on `SIGKILL`: they start and stop the subject seven times and would leave a
profile of nothing but boot.

One limitation, unresolved and not worth resolving here: with the fallback
JavaScript load generator a 3 s `params` run collects 41 samples at the default
1 ms interval, and 98% of them land in native `json`. Install `oha` (`bun run
setup`) and lower `--cpu-prof-interval` before reading anything into a profile.

### A5 - `bun install --linker=isolated` in CI - already the default

Nothing to change, and the reason is that Bun 1.4 already picked it. A plain
`bun install` in this repo writes `node_modules/.bun`, the shared virtual store;
`--linker=hoisted` is the flag that produces a tree without one. So CI has been
installing isolated since the 1.4 bump, and `--linker=isolated` in `ci.yml` would
restate the default.

Measured on this workspace with a warm cache, `rm -rf node_modules` before each:

| Linker              | Install    | `node_modules` |
| ------------------- | ---------- | -------------- |
| default (isolated)  | 1.05-1.06s | 476 MB         |
| `--linker=isolated` | 1.01-1.10s | 476 MB         |
| `--linker=hoisted`  | 1.05-1.10s | 470 MB         |

The release notes' 7x is not visible here in either direction. At one second the
install is not what CI spends its time on, so there is nothing to chase.

The two resolution risks were checked against an isolated tree and both are fine:
`bun run lint:check` passes, so `oxlint` still finds its JS plugin through the
symlink farm and still spawns Node to load it, and the full unit suite passes at
1879/1879. `oxc-parser` resolves from `packages/transform`, where it is declared,
and **not** from the repo root - which is isolated linking working as intended
rather than a fault. A package importing something it does not declare would fail
here and pass under hoisting; nothing in this repo does.

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

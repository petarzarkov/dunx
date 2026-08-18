# Scheduler module - design plan

## Verdict

**Bun has a cron API and the owner is right.** `Bun.cron` exists on 1.3.14 with an in-process callback
overload that landed in Bun 1.3.12. It parses 5-field expressions natively, exposes `Bun.cron.parse` for
next-fire computation, returns a `CronJob` handle with `stop()`/`ref()`/`unref()`/`Symbol.dispose`, and
guarantees non-overlapping invocations by computing the next fire only after the handler settles. All
verified below. So the scheduler is `Bun.cron` plus dunx's four contributions, which are the four
`docs/architecture/queues.md:7-13` already claims for the queue area: where a handler lives, how it is
found, how it is injected, and when it stops.

Three decisions follow, and they are the plan:
1. **No cron library.** `Bun.cron.parse` is the parser. `croner` and `cron-parser` are both refused
   under Rule 1's first half.
2. **In-process and single-node, stated outright.** bullmq's `upsertJobScheduler` is the multi-node
   answer and is reachable today through `JobPublisher.queue(name)`. `@Cron` does not straddle the two.
3. **`@dunx/infra/schedule`**, a ninth subpath on an existing package. No new workspace.

The one thing that must not ship as written: the `tz` option. On 1.3.14 it is **silently ignored**,
bogus zone ids included, and Bun 1.4 flips the default from UTC to system-local. dunx pins both ends.

## What Bun gives us

`bun --version` = 1.3.14 at `/home/petarzarkov/.bun/bin/bun`. `Bun.cron` is present and enumerable:
`Object.keys(Bun)` has 113 entries including `cron`, the descriptor is `{ writable: true, enumerable:
true, configurable: false }`, the function has `length: 3` and own properties
`["length","name","remove","parse"]`. No other scheduling-shaped key exists on `Bun`; `sleep`,
`sleepSync` and `nanoseconds` are the only timing entries. It is a runtime API, not a `bunfig.toml` key,
a CLI flag, or a deploy-platform feature. Types at
`/home/petarzarkov/repos/trader/node_modules/bun-types/bun.d.ts:7455-7730` (bun-types 1.3.14; dunx's
`node_modules/@types/bun/index.d.ts` is a one-line `/// <reference types="bun-types" />`):

```
7607  (schedule: CronWithAutocomplete, handler: (this: CronJob) => unknown): CronJob;  // in-process
7694  (path: string, schedule: CronWithAutocomplete, title: string): Promise<void>;    // OS-level
7730  parse(expression: CronWithAutocomplete, relativeDate?: Date | number): Date | null;
7497  interface CronJob extends Disposable { cron; stop(); ref(); unref(); }
```

The second overload registers with crontab, launchd or Task Scheduler and survives reboot. It is not the
backbone for a framework module: it needs a writable user crontab, spawns a fresh process per fire so no
container is shared, and `bun.d.ts:7671-7674` records a Windows 48-trigger cap plus a
headless-registration failure. dunx uses the **in-process overload only**.

Probed on 1.3.14:
| Probe | Result |
| --- | --- |
| 6-field expression | throws `too many fields. Bun.cron uses 5 fields (minute hour day month weekday) - seconds are not supported` |
| `@hourly`, `MON-FRI`, `JAN`, nicknames | parse, return UTC `Date`; `@secondly` throws |
| `0 0 30 2 *` | `parse` returns `null`; `Bun.cron(...)` throws `has no future occurrences` |
| `60 * * * *`, `* * * *`, `""`, `@bogus` | each throws synchronously, with distinct messages |
| handle | prototype carries `cron`/`ref`/`stop`/`unref`; `Symbol.dispose` is a function; all three chain; double `stop()` is safe |
| `.unref()` / default `ref` | exits at once with a job pending (exit 0) / still alive after 6 s (exit 124) |
| `this` in handler | bound to the `CronJob`; `this.cron` reads the expression back |

Firing, over a 245 s run with three jobs on `* * * * *`:
- First fire landed at **boundary + 5 ms**.
- **No-overlap confirmed.** A handler doing `await Bun.sleep(70_000)` ran **2** times where a stacking
  implementation would have run 4.
- **A throwing job keeps firing.** An async rejection raised `unhandledRejection`, a synchronous throw
  raised `uncaughtException`, and both jobs fired 4 times each. Without a listener the process exits 1.

**Timezones, the finding that shapes the design.** 1.3.14 is UTC-only. `TZ=Europe/Sofia` changes
nothing, and a third argument is **accepted and silently ignored**: `Bun.cron.parse('0 12 * * *',
Date.UTC(2026,0,1), { tz: 'Asia/Kolkata' })` returns `2026-01-01T12:00:00Z`, identical to `{ tz: 'UTC'
}` and to no option at all. A bogus `{ tz: 'Not/AZone' }` does not throw. Bun 1.4 changes the default to
**system-local** and honours `{ tz }` ([oven-sh/bun#36461](https://github.com/oven-sh/bun/pull/36461),
documenting the change made in [#35122](https://github.com/oven-sh/bun/pull/35122); current
[docs/runtime/cron.mdx](https://raw.githubusercontent.com/oven-sh/bun/main/docs/runtime/cron.mdx)
already describes local-by-default, `{ tz }`, and a spring-forward-shifts-forward policy). Two
consequences dunx must encode rather than document around: an expression written today gets a different
hour on 1.4, and a `tz` passed today runs at the wrong hour with no error.

**Timers.** `Bun.sleep` (promise), `Bun.sleepSync` (blocking) and `Bun.nanoseconds` (monotonic ns since
process start) all verified present. `Bun.sleepSync` appears nowhere in this feature: it blocks the
event loop and there is no case for it here. Bun clamps an over-large timer exactly as Node does:
`setTimeout(fn, 2**31)`, `2**31+1`, `1e15` and `-1` each emit
`TimeoutOverflowWarning`/`TimeoutNegativeWarning`, are set to **1 ms**, and fired **17 ms** after
arming. `Timer` objects carry `ref`, `unref` and `hasRef`.

**One honest non-finding.** Fires 2 and 3 landed 4 s before the minute boundary, and that is this
machine rather than Bun: a companion probe measured the wall clock losing 8253 ms against
`Bun.nanoseconds` over 100 s in discrete 2 s steps, which is WSL2 resyncing to the Windows host. Bun
re-anchors on the wall clock each fire (monotonic gaps of 62.1 s and 64.2 s, wall gaps near 60 s). A
step can therefore put two fires inside one minute, so tests must not assert boundary equality.

## Library decision

**No cron parsing dependency. `Bun.cron.parse` is the parser.** Rule 1's first half is unambiguous once
the API is confirmed present, and a cron parser sits at preference level 1, a `Bun.*` API. Measured with
`bun pm view`, so the rejection rests on facts and not the rule alone:
| Candidate | Version | Deps | Size | Published | Verdict |
| --- | --- | --- | --- | --- | --- |
| `croner` | 10.0.1 | 0 | 154.69 KB | 2026-02-01 | refused: pure-JS reimplementation of `Bun.cron` |
| `cron-parser` | 5.10.0 | 1 (`luxon@^3.7.2`) | 154.36 KB | 2026-08-14 | refused twice: reimplementation, plus luxon duplicates `@arkv/timezones`' remit |

Both are healthy, ESM and typed. Neither is admissible when `Bun.cron.parse` answers the same question
in the runtime. The third option, "60 lines dunx owns", falls to the same clause: a five-field matcher
is Rule 1's first failure mode with extra steps, and `Bun.cron` already rejects `60 * * * *` and returns
`null` for February 30.

**Timezones: `@arkv/timezones` supplies zone-id validation, and nothing else is needed.** Read at
`/home/petarzarkov/repos/arkv/packages/timezones` (v0.0.2, zero runtime dependencies, dual ESM+CJS, IANA
tzdb 2026c, 597 zones). Surface is `getZone`, `getZoneUTC`, `getZoneISODate`, `IANA_TZDB_VERSION`, the
`TimezoneCode` union and `tzdb.zones`/`tzdb.map`. It is a **zone metadata catalogue, not a time-math
library**: `getZoneUTC` returns a generation-time snapshot string whose own README warns it reflects
whichever side of a DST boundary CI last ran on, and there is no offset-at-instant, no wall-clock
conversion, and no DST transition data.

That is sufficient, because dunx does not compute zoned fire times. It validates the zone id and hands
the zone to `Bun.cron`, whose 1.4 implementation owns the offset and DST policy.

I tested the alternative first, and the test is the argument. A candidate upstream `offsetAt(zone,
instant)` over `Intl.DateTimeFormat(..., { timeZoneName: 'longOffset' })` computed correct offsets for
every zone tried, including `Australia/Lord_Howe` (+11:00) and `Pacific/Chatham` (+13:45). Feeding it
into the standard shift-parse-unshift trick over `Bun.cron.parse` gave correct instants for plain zoned
schedules and then **failed on the DST gap**: `30 2 * * *` in `America/New_York` across 2027-03-14 and
`30 3 * * *` in `Europe/Sofia` across 2027-03-28 both returned `null`, because the offset-convergence
loop oscillates across the missing hour. Getting that right needs a gap-and-fold policy, which is a time
library, which is Rule 1's second failure mode. Bun 1.4 already ships one.

**Upstream addition needed in `~/repos/arkv`: one type guard, and it is optional.**

Add `export const isTimezoneCode = (v: string): v is TimezoneCode => map.has(v as TimezoneCode);` to
`packages/timezones/src/index.ts`. Validity is already answerable as `getZone(id as TimezoneCode) !==
null`, so this is ergonomics rather than capability: it removes the cast at every call site. It meets
the upstream constraints (no `Bun.*`, no top-level `await`, no `import.meta`, survives the CJS build, no
`enum`). If it is unwanted, dunx uses the cast and needs nothing upstream. **No offset or DST API should
go upstream for this feature**, since nothing in the design would call it.

## Public API

`@Cron`, `@Interval` and `@Timeout` are TC39 **method** decorators that write a marker onto the method
function and return it, matching `packages/infra/src/queue/decorators.ts:16-20`. No class-level
companion decorator, no `context` parameter, no `emitDecoratorMetadata`, no parameter decorators.

I probed `context.addInitializer` and it works under Bun's transpile, but it is the wrong tool and the
measurement says why: the initializer runs **per instance at construction**, so two `new` calls appended
the same two entries twice to the prototype array, and it cannot see the class before construction. A
marker on the function object has neither problem and is already the repo's technique in four places.

```ts
// marker.ts
const SCHEDULE = Symbol.for('dunx.schedule');
export const ScheduleKind = Object.freeze({ CRON: 'cron', INTERVAL: 'interval', TIMEOUT: 'timeout' } as const);
export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];
export const Overlap = Object.freeze({ SKIP: 'skip', CONCURRENT: 'concurrent' } as const);
export type Overlap = (typeof Overlap)[keyof typeof Overlap];
export interface ScheduleMeta {
  readonly kind: ScheduleKind;
  readonly at: string | number;  // cron expression for CRON, ms for INTERVAL and TIMEOUT
  readonly name?: string;        // registry key, defaults to `ClassName.methodName`
  readonly tz?: string;          // IANA zone id, CRON only, needs a Bun that honours it
  readonly overlap?: Overlap;
  readonly enabled?: boolean;    // arm at boot, default true
}

// decorators.ts - all three share one shape
type HandlerMethod = (...args: never[]) => unknown;
export const Cron =
  (expression: string, options: CronDecoratorOptions = {}) =>
  <T extends HandlerMethod>(value: T): T => { markSchedule(value, /* ... */); return value; };
export const Interval: (ms: number, o?: TimerDecoratorOptions) => <T extends HandlerMethod>(v: T) => T;
export const Timeout: (ms: number, o?: TimerDecoratorOptions) => <T extends HandlerMethod>(v: T) => T;

export class ReportsService {
  constructor(private readonly reports: ReportsRepository) {}
  @Cron('0 3 * * *', { tz: 'Europe/Sofia' })
  async nightly(): Promise<void> { await this.reports.rebuild(); }
  @Interval(30_000, { name: 'health', overlap: Overlap.SKIP })
  async probe(): Promise<void> {}
  @Timeout(5_000)
  warmCache(): void {}
}
```

`ScheduleOptions` is a **class**, so it is a runtime value the transform can record at an injection
site, matching `packages/infra/src/queue/options.ts:125-160`. So is `ScheduleEntry`, carrying `name`,
`kind`, `at`, `tz`, `overlap`, `running`, `runs`, `lastError`, `lastRunAt`, `nextRunAt`.

```ts
export interface ScheduleOptionsInit {
  readonly enabled?: boolean;   // arm discovered schedules at boot, default true
  readonly tz?: string;         // default zone for a @Cron with no tz, default 'UTC'
  readonly keepAlive?: boolean; // hold the event loop open, default true, matching Bun.cron
  readonly overlap?: Overlap;
}
export class ScheduleOptions {
  readonly enabled: boolean;
  readonly tz: string;
  readonly keepAlive: boolean;
  readonly overlap: Overlap;
  constructor(init: ScheduleOptionsInit = {}) { /* assertZone(this.tz) */ }
}
export class ScheduleRegistry {
  constructor(options: ScheduleOptions, logger: Logger) {}
  add(meta: ScheduleMeta, handler: () => unknown): ScheduleEntry; // throws DUPLICATE_SCHEDULE
  remove(name: string): boolean;                                  // false if not held
  list(): readonly ScheduleEntry[];
  get(name: string): ScheduleEntry | undefined;
  trigger(name: string): Promise<unknown>;  // invoke off-schedule, honouring `overlap`
}
export class ScheduleModule {
  static forRoot(init?: ScheduleOptionsInit): DynamicModule;
  static forRootAsync(load: () => ScheduleOptionsInit | Promise<ScheduleOptionsInit>): DynamicModule;
  static forRootAsync<const D extends Deps>(c: AsyncModuleConfig<ScheduleOptionsInit, D>): DynamicModule;
}
// not exported; copies QueueRunner's shape (packages/infra/src/queue/runner.ts:33-123)
class ScheduleRunner implements OnInit, OnShutdown {
  constructor(ref: AppRef, root: ModuleRef, options: ScheduleOptions,
    registry: ScheduleRegistry, logger: Logger) {}
  async onInit(): Promise<void> {}     // discover, then arm
  async onShutdown(): Promise<void> {} // stop every handle, await in-flight
}
```

`ScheduleRegistry` earns its place: `@nestjs/schedule`'s `SchedulerRegistry` is what feature flags and
per-tenant schedules are built on, and without it a schedule changes only by redeploying. `trigger` also
makes the feature testable without waiting for a minute boundary, which is `Bun.cron`'s granularity.

`ScheduleModule` takes options, so it is a `forRoot` pair. CLAUDE.md's rule that a module taking no
options must be a decorated class would bite only if the options were dropped: `forRoot()` returns a
fresh object per call and a scope is keyed on the module reference, so two importers calling a
zero-argument `forRoot()` would build two scopes, two registries and two copies of every schedule. `tz`,
`enabled` and `keepAlive` are real, so the pair stands and `forRoot()` is called once at the root,
binding `ScheduleOptions`, `ScheduleRegistry` and `ScheduleRunner` and exporting the first two.
`forRootAsync` earns its place as on `RedisModule`: reading `tz` off `ConfigService` is the one thing a
zero-argument `forRoot` cannot do.

**Overlap policy.** Default `Overlap.SKIP`, which `Bun.cron` does for free: it computes the next fire
only after the handler's returned promise settles, so returning the promise from the wrapper gives skip
semantics with no bookkeeping. `Overlap.CONCURRENT` is the wrapper *not* returning the promise, so Bun
reschedules immediately. There is no `queue` mode: an overrun that must not be dropped is a job, and
that is `@JobHandler` plus bullmq. `@Interval` and `@Timeout` track their own runs, a chained
`setTimeout` having no equivalent guarantee. A skipped run logs at `warn` with the name and the elapsed
time of the run still going.

**Timezones.** `ScheduleOptions` and `@Cron` both validate the zone id through `@arkv/timezones` at
construction, so a typo is a boot error rather than a job that never fires. The zone then goes to
`Bun.cron` as `{ tz }`, and dunx passes `{ tz: 'UTC' }` explicitly when no zone is named. That default
is correct on both sides of the 1.4 change: 1.3.x ignores the option and is already UTC, 1.4 honours it
and pins UTC instead of drifting to the container's `TZ`.

## Where it lives

**`@dunx/infra/schedule`, a ninth subpath. Not a new workspace, and not `@dunx/core`.**

A new package is refused on `docs/ROADMAP.md`, "Priority: the core three": a new package needs a user
first, and `@dunx/queue-dashboard`'s round trip is the cost argument. The owner asking unblocks the
feature, not a tenth published workspace.

`@dunx/core` is the tempting home, since a scheduler needs nothing from the web layer and `ConfigModule`
is the precedent for a non-HTTP module with a `forRoot` there. It is refused on one fact: **`@dunx/core`
has zero dependencies**, stated in CLAUDE.md, the root README and the ROADMAP table, and zone-id
validation needs `@arkv/timezones`. `@dunx/infra` already depends on `@arkv/logger`, so this is a second
first-party dependency on a package that has one, with 154 KB of generated data and no transitive
weight. Infra is the right shape positively too: `@dunx/auth` was refused entry because it needs
`@dunx/http`'s middleware and metadata types (`docs/ROADMAP.md`, "Better Auth is `@dunx/auth`"), and a
scheduler needs neither, the same test passing rather than failing.

```
packages/infra/src/schedule/
  index.ts        barrel: module, decorators, options, registry, errors
  marker.ts       Symbol.for('dunx.schedule'), ScheduleMeta, ScheduleKind, Overlap, mark/read
  decorators.ts   @Cron, @Interval, @Timeout
  options.ts      ScheduleOptions class, ScheduleOptionsInit, zone assertion
  registry.ts     ScheduleRegistry, ScheduleEntry, the Bun.cron and timer handles
  runner.ts       ScheduleRunner (OnInit/OnShutdown), the discovery call site
  module.ts       ScheduleModule.forRoot / forRootAsync
  errors.ts       ScheduleError, ScheduleErrorCode frozen object
  capability.ts   supportsTz(): probes Bun rather than parsing Bun.version
```

Manifest changes in `packages/infra/package.json`: one `exports` entry `"./schedule"` mapping to
`./dist/schedule/index.d.ts` and `./dist/schedule/index.js`, which `scripts/build-package.ts` turns into
a build entrypoint automatically, plus `@arkv/timezones` in `dependencies`. No new peer. Unlike
`/queue`, `/schedule` **is** re-exported from the package barrel, dragging no static `ioredis` import
behind it. Add it with `/new-package`.

**Rule 2 work that comes with it, in the same change.** The marker-plus-prototype-scan is already
written three times: `packages/infra/src/queue/discover.ts:22-46` and
`packages/http/src/ws/discover.ts:42-68` are byte-identical apart from the metadata reader, `classOf` at
`queue/discover.ts:75-83` and `ws/discover.ts:102-110` are byte-identical including the doc comment, and
`packages/http/src/route/discover.ts:56-94` inlines the same module-graph loop. `@Cron` would be the
fourth copy. The generic half moves to `@dunx/core`, next to `collectModules` and `readControllers`,
exported there already as the adapter seam (`packages/core/src/di/index.ts:28-31, :52-66`):

```ts
// packages/core/src/di/discover.ts
type Read<M> = (value: unknown) => M | undefined;
export const eachMarkedMethod: <M>(start: object | null, read: Read<M>) => readonly [string, M][];
export const classOf: (entry: ProviderEntry) =>
  { token: InjectionToken<unknown>; ctor: Ctor<unknown> } | undefined;
export const discoverMarked: <M>(
  modules: readonly ResolvedModule[], read: Read<M>,
  resolve: (token: InjectionToken<unknown>) => unknown,
) => readonly { instance: object; method: string; meta: M }[];
```

`@dunx/infra/queue` and `@dunx/http` call it and delete their copies. The queue's
`assertNoDuplicateJobs`, `describeJob` and `selectJobs` stay put, being queue-typed. One asymmetry must
survive the move (`docs/architecture/queues.md:126-129`): gateways throw when a marked method's class
lacks `@Gateway`, jobs have no class marker and so no orphan state. The shared walker must not force an
orphan check, and `@Cron` has no class marker either.

**Lifecycle.** `ScheduleRunner.onInit` is the arming point, reached through `AppRef` and `ROOT_MODULE`
because handler tokens are unknowable at construction. `onInit` runs inside `AppFactory.create` after
every provider resolves, in construction-completion order (`packages/core/src/di/app.ts:274-276`);
`onShutdown` runs in reverse (`app.ts:132-140`), so a runner bound after the registry is torn down
before it. `enableShutdownHooks` already maps SIGTERM and SIGINT onto that drain
(`packages/core/src/di/shutdown-hooks.ts:50-108`).

One limitation to state rather than engineer around: **`onInit` is the latest hook there is, and it runs
before `Bun.serve` binds.** `HttpFactory.create` calls `AppFactory.create` at
`packages/http/src/server/factory.ts:86`, and `Bun.serve` runs in `listen()` at
`packages/http/src/server/application.ts:315`. So `@Timeout(0)` fires before the socket is open, and
`@Timeout(ms)` is measured from container readiness rather than first request. An app needing the later
point uses `ScheduleModule.forRoot({ enabled: false })` and calls `registry.add` after `listen()`.

## What it refuses

- **A cron parser.** No `croner`, no `cron-parser`, no hand-rolled matcher.
- **Seconds.** `Bun.cron` rejects a 6-field expression, so `@Cron` does too, passing Bun's own message
  through. Sub-minute work is `@Interval(ms)`.
- **Distributed scheduling, and a facade over bullmq's schedulers.** `@Cron` is in-process and
  single-node; on three replicas it runs three times, and that goes in the guide's first paragraph and
  the decorator's doc comment rather than a footnote. The multi-node answer is `@JobHandler` plus
  `queue.upsertJobScheduler` on the bullmq `Queue` that `JobPublisher.queue(name)` already returns.
  `docs/architecture/queues.md:158-160` refuses wrappers around bullmq's own surface, so a `@Cron({
  queue })` overload would restate bullmq's repeat options as a staler copy and would make one decorator
  mean two things with different failure modes: runs-on-every-replica against
  needs-Redis-and-survives-restart. A distributed lock is leader election, and dunx does not invent one
  either.
- **An `@Interval` above 2147483647 ms.** Bun clamps it to 1 ms and fires immediately, measured at 17 ms
  with a `TimeoutOverflowWarning`. A silent hot loop is worse than a boot error naming the method and
  pointing at `@Cron`.
- **`tz` on a Bun that ignores it.** `capability.ts` compares `Bun.cron.parse('0 12 * * *',
  fixedInstant, { tz: 'Asia/Kolkata' })` against the `{ tz: 'UTC' }` answer. Equal means the option is a
  no-op, and a `@Cron` carrying a non-UTC `tz` is then a boot error rather than a job running at the
  wrong hour. The probe reads behaviour, not `Bun.version`, so it survives the 1.4 change with no
  version table.
- **`Bun.sleepSync`, and the OS-level `Bun.cron(path, schedule, title)` overload.** The latter writes to
  the user's crontab, spawns a process with no container, and caps triggers on Windows.
- **A dashboard panel.** `@dunx/dashboard` is frozen to maintenance; `registry.list()` is the data if
  someone later wants one.

## Risks and open spikes

1. **The 1.4 timezone flip changes expressions already written.** On 1.3.x `@Cron('0 3 * * *')` with no
   `tz` runs at 03:00 UTC; on 1.4 the same line would run at 03:00 container-local if dunx passed
   nothing. Passing `{ tz: 'UTC' }` explicitly fixes it in one place. Re-probe once 1.4 is installed and
   confirm the explicit option wins.
2. **Does `bun test`'s fake timer clock drive `Bun.cron`?** [#37946](https://github.com/oven-sh/bun/issues/37946),
   "keep runtime-internal timeouts out of the fake timer heap", says the two interact. Unmeasured. Spike
   before writing tests; the design holds either way, since `trigger` covers it.
3. **Two open `Bun.cron` leak reports.** [#37461](https://github.com/oven-sh/bun/issues/37461) (the source
   URL ref handed to `CallerSrcLoc`) and [#37660](https://github.com/oven-sh/bun/issues/37660) (spawned
   process ref and temp path), both open as of 2026-08-11. Measure RSS over a long `add`/`remove` cycle
   before documenting `ScheduleRegistry` as safe for churn.
4. **A wall-clock step can put two fires in one minute.** Observed at 2 s per 10 s of host skew. Not
   reproducible on a healthy clock and not Bun's defect, but an idempotent handler is the only defence
   and the guide should say so.
5. **`keepAlive` default.** `Bun.cron` refs by default, so a CLI importing `ScheduleModule` never exits.
   `true` matches Bun and `setInterval`; an HTTP app has `Bun.serve` holding the loop and would be
   better served by `false`. Decide after measuring against `examples/full`'s shutdown path, where
   `docs/bun-apis.md:463-500` already records the `unref` semantics.
6. **The `isTimezoneCode` guard is optional.** Without it dunx uses `getZone(id as TimezoneCode) !==
   null`. No offset or DST API should go upstream for this feature.

## Cost

**Files:** 9 new under `packages/infra/src/schedule/`, plus `packages/core/src/di/discover.ts`. Roughly
**700 LOC**: registry ~180, runner ~110, module ~90, options ~80, marker ~60, decorators ~50, errors
~30, capability ~25, barrel ~25, core's shared walker ~90. Every file stays under the 500-line
`max-lines` error. Against that, `packages/infra/src/queue/discover.ts` loses ~50 lines to the move and
`packages/http/src/ws/discover.ts` ~45, with `packages/http/src/route/discover.ts` rewritten onto the
shared walker or left alone if its orphan rules resist. Net growth is under 600 lines.

**Tests:** ~450 LOC across `registry.test.ts`, `discover.test.ts`, `module.test.ts`, `options.test.ts`
and `capability.test.ts`, plus updates to the two existing discover suites. No test waits on a minute
boundary; `registry.trigger` and `Bun.cron.parse` assertions replace real time. One spawn-based test
covers the `keepAlive: false` exit path, since `bun test` exits the process itself and cannot observe a
held-open loop (precedent: `@dunx/infra/redis`).

**Dependencies:** `@arkv/timezones` into `packages/infra`'s `dependencies`. Zero new peers, zero
optional peers, zero native modules; `@dunx/core` keeps its empty dependency list.

**Docs and examples.** A new guide `docs/guide/17-scheduling.md` through `/docs-pass`, a `## schedule`
section in `packages/infra/README.md`, and `docs/architecture/scheduling.md` for the measurements above,
the 1.4 flip and the rejected zoned-cron computation. `docs/bun-apis.md` gains a `Bun.cron` block under
"Verified on this machine" plus a `Cron` row in the API table. `docs/MIGRATION-FROM-NEST.md:61` changes
from "bullmq repeatable jobs / undesigned" to `@dunx/infra/schedule` / done. `docs/ROADMAP.md` gains a
"Settled" entry, CLAUDE.md's package table gains the subpath, and `bun run gen:readme` regenerates the
root table.

**Examples and CI:** `examples/full` gains one service with a `@Cron` and an `@Interval` printing its
next fire from `registry.list()`; `examples/minimal` is untouched. No new CI job: the subpath is built
from the `exports` entry by `scripts/build-package.ts`, and `bun run --filter '@dunx/example-*'` already
covers the example. Badges regenerate with `/coverage-report`. Added CI time is one entrypoint plus ~450
lines of tests, none of which sleep.
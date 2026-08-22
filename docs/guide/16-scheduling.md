# Scheduling

`@Cron`, `@Interval` and `@OnceOnBoot` run a method on a schedule. They come from
`@dunx/infra/schedule` and are built on `Bun.cron` and Bun's timers.

```ts
import {
  Cron,
  CronExpression,
  Interval,
  OnceOnBoot,
  Overlap,
  ScheduleModule,
} from '@dunx/infra/schedule';

export class ReportsService {
  constructor(private readonly reports: ReportsRepository) {}

  @Cron('0 3 * * *')
  async nightly(): Promise<void> {
    await this.reports.rebuild();
  }

  @Cron(CronExpression.HOURLY)
  async rollUp(): Promise<void> {}

  @Interval(30_000, { name: 'probe', overlap: Overlap.SKIP })
  async probe(): Promise<void> {}

  @OnceOnBoot(5_000)
  warmCache(): void {}
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ReportsService],
})
export class AppModule {}
```

A schedule is declared in `@Module({ providers })`, or on a controller, like any
other injectable. It is found by its marker, so there is no second registration and
no class decorator to remember. An abstract base's marked methods are inherited by
every subclass.

The registry name defaults to `ClassName.methodName`. Two schedules under one name is
a boot error.

## Expressions

`@Cron` takes five fields at minute resolution. A sixth is rejected: `Bun.cron` has
no seconds field, and sub-minute work belongs in `@Interval`.

Bun's named schedules work too, and an editor offers them:

```ts
@Cron('@daily')
@Cron('@hourly')
```

All seven are `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`
and `@hourly`. `CronExpression` holds the same seven as values, for a config object
that cannot carry a literal.

An expression `Bun.cron` cannot parse fails the boot.

## Timezones

A `@Cron` takes `{ tz }`, and a zone id the IANA database does not hold is a boot
error.

**Bun 1.4 honours the option; Bun 1.3 ignores it.** A zone a runtime ignores would
run at the UTC hour with no error anywhere, so dunx refuses a named zone on such a
runtime rather than accepting one and getting it wrong.

```ts
// Works on Bun 1.4. Boot error on Bun 1.3, which would run this at 09:00 UTC.
@Cron('0 9 * * *', { tz: 'America/New_York' })
```

Detection asks the parser for two answers and compares them, so a backport or a fork
is read correctly. `supportsTz()` is exported if you would rather fail your own boot
on it.

Schedules always run in UTC unless a zone is named, on every Bun version. Bun 1.4
changed `Bun.cron`'s own default from UTC to the container's local zone; dunx passes
`tz` on every call, so a schedule does not move when `TZ` does.

## Overlap

`Overlap.SKIP` is the default. A fire that lands while a run is still going is skipped
and logged at `warn` with the name and how long that run has been going.

`Overlap.CONCURRENT` starts the new run anyway.

There is no queue mode. An overrun that must not be dropped is a job, which is
`@JobHandler` and [queues](./15-queues.md).

A throwing handler is reported and never rethrown, so one bad run does not disarm the
schedule. Its message lands on the entry's `lastError`.

## The registry

`ScheduleRegistry` is exported, so a schedule can change without a redeploy.

```ts
const registry = app.get(ScheduleRegistry);

await registry.trigger('ReportsService.nightly');
registry.list(); // name, kind, at, tz, runs, running, lastError, nextRunAt
registry.remove('probe');
registry.add(
  { kind: ScheduleKind.INTERVAL, at: 60_000, name: 'tenant-7' },
  run,
);
```

`trigger` runs a schedule off its cadence, honouring `overlap`. It is also how a
schedule is tested: `Bun.cron` fires at minute resolution, so waiting for a boundary
is not a test.

## Timing and limits

`@Interval` and `@OnceOnBoot` are measured from `onInit`, the latest lifecycle hook
there is, and it runs **before** `Bun.serve` binds. So `@OnceOnBoot(0)`
fires before the socket is open, and the delay counts from container readiness rather
than from the first request.

For the later point, use `ScheduleModule.forRoot({ enabled: false })` and call
`registry.add` after `listen()`.

A delay above 2,147,483,647 ms is a boot error. Bun clamps a larger timer to 1 ms and
fires it at about 17 ms, so it would be a hot loop rather than a long wait. Use
`@Cron` past 24 days.

## One node at a time

Schedules are in-process. Two replicas both run every schedule, because nothing here
coordinates.

A schedule that must fire once across a fleet is a job. bullmq's `upsertJobScheduler`
through [`@dunx/infra/queue`](./15-queues.md) is that, and dunx does not wrap it.

## Options

```ts
ScheduleModule.forRoot({
  enabled: true, // arm at boot
  tz: 'UTC', // default zone for a @Cron that names none
  keepAlive: true, // hold the event loop open while armed
  overlap: Overlap.SKIP,
});

ScheduleModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({ tz: config.get('tz') }),
  inject: [AppConfigService],
});
```

`keepAlive: false` unrefs every handle, so a process with nothing else to do exits
instead of waiting for the next fire.

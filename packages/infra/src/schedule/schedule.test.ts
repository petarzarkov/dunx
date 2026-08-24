import { describe, expect, it } from 'bun:test';
import { AppFactory, Logger, LogLevel, Module, provide } from '@dunx/core';

import { supportsTz } from './capability.js';
import { Cron, Interval, OnceOnBoot } from './decorators.js';
import { ScheduleErrorCode } from './errors.js';
import { CronExpression, Overlap, ScheduleKind } from './marker.js';
import { ScheduleModule } from './module.js';
import { ScheduleOptions } from './options.js';
import { ScheduleRegistry } from './registry.js';

/** Silent, so a suite asserting on schedules is not read through boot noise. */
class Quiet extends Logger {
  readonly logLevel = LogLevel.DEBUG;
  readonly lines: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  override info(message: unknown): void {
    this.lines.push(String(message));
  }
  override log(message: unknown): void {
    this.lines.push(String(message));
  }
  override debug(message: unknown): void {
    this.lines.push(String(message));
  }
  override verbose(message: unknown): void {
    this.lines.push(String(message));
  }
  override warn(message: unknown): void {
    this.warnings.push(String(message));
  }
  override error(message: unknown): void {
    this.errors.push(String(message));
  }
  override fatal(message: unknown): void {
    this.errors.push(String(message));
  }
}

class Reports {
  ran: string[] = [];
  release: (() => void) | undefined;

  @Cron('0 3 * * *')
  nightly(): void {
    this.ran.push('nightly');
  }

  @Interval(3_600_000, { name: 'probe' })
  async probe(): Promise<void> {
    this.ran.push('probe');
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  @OnceOnBoot(3_600_000)
  warm(): void {
    this.ran.push('warm');
  }

  @Cron('*/5 * * * *', { overlap: Overlap.CONCURRENT })
  concurrent(): void {
    this.ran.push('concurrent');
  }
}

const boot = async (logger = new Quiet()) => {
  @Module({
    imports: [ScheduleModule.forRoot({ keepAlive: false })],
    providers: [Reports, provide(Logger, { useValue: logger })],
    exports: [Logger],
    global: true,
  })
  class Root {}

  const app = await AppFactory.create(Root);
  return {
    app,
    logger,
    registry: app.get(ScheduleRegistry),
    reports: app.get(Reports),
  };
};

describe('discovery', () => {
  it('arms every marked method, naming it after the class and method', async () => {
    const { app, registry } = await boot();

    const names = registry
      .list()
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual([
      'Reports.concurrent',
      'Reports.nightly',
      'Reports.warm',
      'probe',
    ]);

    await app.shutdown();
  });

  it('records the kind, the expression and the resolved zone', async () => {
    const { app, registry } = await boot();

    const nightly = registry.get('Reports.nightly');
    expect(nightly?.kind).toBe(ScheduleKind.CRON);
    expect(nightly?.at).toBe('0 3 * * *');
    // The module default, passed to Bun explicitly rather than left unset.
    expect(nightly?.tz).toBe('UTC');
    expect(nightly?.nextRunAt).toBeInstanceOf(Date);
    // A timer has no zone and no next fire.
    expect(registry.get('probe')?.tz).toBeUndefined();
    expect(registry.get('probe')?.nextRunAt).toBeUndefined();

    await app.shutdown();
  });

  it('does not arm anything when the module is disabled', async () => {
    @Module({
      imports: [ScheduleModule.forRoot({ enabled: false })],
      providers: [Reports, provide(Logger, { useValue: new Quiet() })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(ScheduleRegistry).list()).toEqual([]);
    await app.shutdown();
  });
});

/*
 * `Bun.cron` fires at minute resolution, so nothing here waits for a boundary.
 * `trigger` is the seam that makes the feature testable at all, which is half its
 * reason for existing.
 */
describe('trigger', () => {
  it('runs a schedule off its cadence and awaits it', async () => {
    const { app, registry, reports } = await boot();

    await registry.trigger('Reports.nightly');

    expect(reports.ran).toEqual(['nightly']);
    const entry = registry.get('Reports.nightly');
    expect(entry?.runs).toBe(1);
    expect(entry?.running).toBe(false);
    expect(entry?.lastRunAt).toBeInstanceOf(Date);
    expect(entry?.lastError).toBeUndefined();

    await app.shutdown();
  });

  it('names the schedules it holds when asked for one it does not', async () => {
    const { app, registry } = await boot();

    await expect(registry.trigger('nope')).rejects.toThrow(/No schedule named/);
    await expect(registry.trigger('nope')).rejects.toMatchObject({
      code: ScheduleErrorCode.UNKNOWN_SCHEDULE,
    });

    await app.shutdown();
  });

  it('skips a run that is already going, and says so', async () => {
    const { app, registry, reports, logger } = await boot();

    const first = registry.trigger('probe');
    // The handler is parked, so the entry is mid-run.
    expect(registry.get('probe')?.running).toBe(true);

    await registry.trigger('probe');
    expect(reports.ran).toEqual(['probe']);
    expect(registry.get('probe')?.runs).toBe(1);
    expect(logger.warnings.some((line) => line.includes('probe'))).toBe(true);

    reports.release?.();
    await first;
    expect(registry.get('probe')?.running).toBe(false);

    await app.shutdown();
  });

  it('reports a throwing handler without rethrowing or disarming', async () => {
    class Boom {
      @Interval(3_600_000, { name: 'boom' })
      go(): void {
        throw new Error('handler exploded');
      }
    }
    const logger = new Quiet();

    @Module({
      imports: [ScheduleModule.forRoot({ keepAlive: false })],
      providers: [Boom, provide(Logger, { useValue: logger })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const registry = app.get(ScheduleRegistry);

    await registry.trigger('boom');

    expect(registry.get('boom')?.lastError?.message).toBe('handler exploded');
    expect(logger.errors.some((line) => line.includes('boom'))).toBe(true);
    // Still armed: one bad run must not stop the schedule.
    expect(registry.get('boom')?.finished).toBe(false);

    await app.shutdown();
  });
});

describe('the registry at runtime', () => {
  it('adds and removes a schedule after boot', async () => {
    const { app, registry } = await boot();
    let ran = 0;

    registry.add(
      { kind: ScheduleKind.INTERVAL, at: 3_600_000, name: 'added' },
      () => {
        ran += 1;
      },
    );
    await registry.trigger('added');
    expect(ran).toBe(1);

    expect(registry.remove('added')).toBe(true);
    expect(registry.get('added')).toBeUndefined();
    expect(registry.remove('added')).toBe(false);

    await app.shutdown();
  });

  it('refuses two schedules under one name', async () => {
    const { app, registry } = await boot();

    expect(() =>
      registry.add(
        { kind: ScheduleKind.INTERVAL, at: 1000, name: 'Reports.nightly' },
        () => undefined,
      ),
    ).toThrow(/One name, one schedule/);

    await app.shutdown();
  });

  it('stops every handle on shutdown', async () => {
    const { app, registry } = await boot();

    await app.shutdown();

    for (const entry of registry.list()) {
      expect(entry.finished).toBe(true);
      expect(entry.nextRunAt).toBeUndefined();
    }
  });
});

/*
 * `Bun.CronWithAutocomplete` carries the named schedules, so a literal is accepted
 * and offered by an editor; `CronExpression` holds the same seven as values for a
 * config object that cannot carry a literal. Both reach the same parser.
 */
describe('named schedules', () => {
  it('accepts every alias Bun understands, as a literal and as a value', async () => {
    class Aliased {
      ran: string[] = [];

      @Cron('@daily', { name: 'literal' })
      nightly(): void {
        this.ran.push('nightly');
      }

      @Cron(CronExpression.HOURLY, { name: 'value' })
      hourly(): void {
        this.ran.push('hourly');
      }
    }

    @Module({
      imports: [ScheduleModule.forRoot({ keepAlive: false })],
      providers: [Aliased, provide(Logger, { useValue: new Quiet() })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const registry = app.get(ScheduleRegistry);

    expect(registry.get('literal')?.at).toBe('@daily');
    expect(registry.get('value')?.at).toBe('@hourly');
    // Armed, so Bun parsed both: an expression it rejects is a boot error.
    expect(registry.get('literal')?.nextRunAt).toBeInstanceOf(Date);
    expect(registry.get('value')?.nextRunAt).toBeInstanceOf(Date);

    await app.shutdown();
  });

  it('holds the seven Bun parses, and nothing it does not', () => {
    expect(Object.values(CronExpression).sort()).toEqual([
      '@annually',
      '@daily',
      '@hourly',
      '@midnight',
      '@monthly',
      '@weekly',
      '@yearly',
    ]);
    for (const expression of Object.values(CronExpression)) {
      expect(Bun.cron.parse(expression, new Date(0))).toBeInstanceOf(Date);
    }
  });
});

describe('refusals', () => {
  it('refuses a named zone on a Bun that ignores the option', () => {
    // Skipped rather than inverted on a Bun that honours it, so this file keeps
    // saying the same thing on both sides of the 1.4 change.
    if (supportsTz()) return;

    expect(() => ScheduleModule.forRoot({ tz: 'Europe/Sofia' })).toThrow(
      /ignores Bun.cron's tz option/,
    );
  });

  it('refuses a zone id the tzdb does not hold, whatever Bun does', () => {
    expect(() => ScheduleModule.forRoot({ tz: 'Not/AZone' })).toThrow(
      /not an IANA zone id/,
    );
  });

  it('allows UTC, which is what an ignoring runtime already does', () => {
    expect(() => ScheduleModule.forRoot({ tz: 'UTC' })).not.toThrow();
  });

  it('accepts a named zone on a Bun that honours the option', () => {
    if (!supportsTz()) return;

    expect(() =>
      ScheduleModule.forRoot({ tz: 'America/New_York' }),
    ).not.toThrow();
  });
});

/**
 * Bun 1.4 both honours `tz` and flips the default from UTC to the container's
 * local zone. The registry passes `tz` explicitly on every arm, so the flip
 * cannot reach a schedule - these assert the pinning rather than the option.
 */
describe('zones, on a Bun that honours tz', () => {
  const at = (expression: string, tz: string): string | undefined =>
    Bun.cron
      .parse(expression, new Date('2026-01-15T00:00:00Z'), {
        tz,
      })
      ?.toISOString();

  it('resolves the same expression differently per zone', () => {
    if (!supportsTz()) return;

    expect(at('0 12 * * *', 'UTC')).toBe('2026-01-15T12:00:00.000Z');
    // UTC+05:30, so an offset no rounding can hide.
    expect(at('0 12 * * *', 'Asia/Kolkata')).toBe('2026-01-15T06:30:00.000Z');
  });

  it('pins UTC rather than inheriting the container zone', () => {
    if (!supportsTz()) return;

    const registry = new ScheduleRegistry(new ScheduleOptions({}), new Quiet());
    registry.add(
      { kind: ScheduleKind.CRON, at: '0 12 * * *' },
      () => undefined,
      'nightly',
    );

    const entry = registry.get('nightly');
    expect(entry?.tz).toBe('UTC');
    expect(entry?.nextRunAt?.toISOString().endsWith('12:00:00.000Z')).toBe(
      true,
    );
    registry.stopAll();
  });
});

/**
 * `forRoot` takes a plain options object, so the only thing `forRootAsync` adds is
 * `inject`: reading `tz` or `enabled` off a `ConfigService` is the one thing a
 * zero-argument `forRoot` cannot do.
 */
describe('ScheduleModule.forRootAsync', () => {
  /**
   * From a globally published provider, which is what the API allows: this
   * `forRootAsync` takes a `FactoryProvider`, not an `AsyncModuleConfig`, so it has
   * no `imports` to forward. The documented case works because
   * `ConfigModule.forRoot` is `global: true`.
   */
  it('injects what it names', async () => {
    class Settings {
      readonly tz = 'Europe/Sofia';
    }

    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          useFactory: (settings: Settings) => ({
            tz: settings.tz,
            keepAlive: false,
            enabled: false,
          }),
          inject: [Settings],
        }),
      ],
      providers: [Settings, provide(Logger, { useValue: new Quiet() })],
      exports: [Logger, Settings],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.get(ScheduleOptions).tz).toBe('Europe/Sofia');
    expect(app.get(ScheduleOptions).enabled).toBe(false);
    expect(app.get(ScheduleRegistry)).toBeInstanceOf(ScheduleRegistry);
    await app.shutdown();
  });

  it('takes a bare loader and awaits it', async () => {
    @Module({
      imports: [
        ScheduleModule.forRootAsync(async () => {
          await Bun.sleep(1);
          return { keepAlive: false, enabled: false, tz: 'UTC' };
        }),
      ],
      providers: [provide(Logger, { useValue: new Quiet() })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.get(ScheduleOptions).tz).toBe('UTC');
    expect(app.get(ScheduleOptions).keepAlive).toBe(false);
    await app.shutdown();
  });

  it('defaults inject away when the config omits it', async () => {
    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          useFactory: () => ({ keepAlive: false, enabled: false }),
        }),
      ],
      providers: [provide(Logger, { useValue: new Quiet() })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.get(ScheduleOptions).enabled).toBe(false);
    await app.shutdown();
  });
});

import { AppFactory, Logger, Module, provide, token } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { ScheduleModule } from './module.js';
import { ScheduleOptions } from './options.js';
import { Quiet } from '../quiet.fixture.js';
import { ScheduleRegistry } from './registry.js';

describe('ScheduleModule.forRootAsync', () => {
  it('injects what it names from a global provider', async () => {
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

  /**
   * The scoped-container case: this dynamic module is its own scope, so the factory
   * cannot see a provider merely because the module that called `forRootAsync`
   * imports it. `imports` here is what puts it in reach, and without it this is a
   * boot error naming both modules.
   */
  it('injects from a module named in its own imports, not published globally', async () => {
    // A token, not a class: an unbound class self-binds into whichever scope asks
    // first, so a class here resolves whether or not `imports` reached the factory
    // and the test would pass against the bug it is guarding.
    const ZONE = token<string>('Zone');

    @Module({
      providers: [provide(ZONE, { useValue: 'Australia/Perth' })],
      exports: [ZONE],
    })
    class TzModule {}

    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          imports: [TzModule],
          useFactory: (zone: string) => ({
            tz: zone,
            keepAlive: false,
            enabled: false,
          }),
          inject: [ZONE],
        }),
      ],
      providers: [provide(Logger, { useValue: new Quiet() })],
      exports: [Logger],
      global: true,
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.get(ScheduleOptions).tz).toBe('Australia/Perth');
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

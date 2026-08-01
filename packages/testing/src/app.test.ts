import { describe, expect, it } from 'bun:test';
import {
  inject,
  Logger,
  LogLevel,
  Module,
  provide,
  RequestContext,
  token,
  type OnInit,
  type OnShutdown,
} from '@dunx/core';
import { createTestApp } from './app.js';
import { RecordingLogger } from './logger.js';

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

abstract class Database {
  abstract query(): string;
}

class RealDatabase extends Database {
  query(): string {
    return 'from postgres';
  }
}

class FakeDatabase extends Database {
  query(): string {
    return 'from memory';
  }
}

const Dsn = token<string>('Dsn');

/**
 * The consumer takes its dependency as a constructor parameter. `bun test` runs
 * from source with no `@dunx/compiler` preload, so the record the plugin would
 * have appended is written by hand — as core's own dynamic-module test does.
 */
class Reports {
  constructor(private readonly db: Database) {}

  latest(): string {
    return `report ${this.db.query()}`;
  }
}
Object.defineProperty(Reports, Symbol.for('dunx.deps'), {
  value: () => [Database],
});

@Module({
  providers: [
    provide(Dsn, { useValue: 'postgres://localhost/real' }),
    provide(Database, { useClass: RealDatabase }),
    Reports,
  ],
})
class DataModule {}

describe('createTestApp()', () => {
  it('replaces a binding in place, keyed by token', async () => {
    const app = await createTestApp({
      modules: [DataModule],
      overrides: [provide(Database, { useClass: FakeDatabase })],
    });

    expect(app.get(Database)).toBeInstanceOf(FakeDatabase);
    // Everything else in the module is untouched, and the consumer got the
    // replacement through its constructor.
    expect(app.get(Dsn)).toBe('postgres://localhost/real');
    expect(app.get(Reports).latest()).toBe('report from memory');
  });

  it('replaces a value token as readily as a class one', async () => {
    const app = await createTestApp({
      modules: DataModule,
      overrides: [provide(Dsn, { useValue: ':memory:' })],
    });

    expect(app.get(Dsn)).toBe(':memory:');
  });

  it('accepts several modules without a fixture root', async () => {
    @Module({ providers: [provide(Dsn, { useValue: 'left' })] })
    class LeftModule {}

    @Module({ providers: [provide(Database, { useClass: RealDatabase })] })
    class RightModule {}

    const app = await createTestApp({
      modules: [LeftModule, RightModule],
      overrides: [provide(Database, { useValue: new FakeDatabase() })],
    });

    expect(app.get(Dsn)).toBe('left');
    expect(app.get(Database)).toBeInstanceOf(FakeDatabase);
  });

  it('never runs the factory it replaced', async () => {
    let opened = 0;

    @Module({
      providers: [
        provide(Database, {
          useFactory: async (): Promise<Database> => {
            opened += 1;
            await Bun.sleep(0);
            throw new Error('connected to the real database');
          },
        }),
      ],
    })
    class RealDataModule {}

    const app = await createTestApp({
      modules: [RealDataModule],
      overrides: [provide(Database, { useValue: new FakeDatabase() })],
    });

    // Both halves matter: the counter proves the factory was not called, and the
    // throw would have failed create() if the counter were ever wrong.
    expect(opened).toBe(0);
    expect(app.get(Database).query()).toBe('from memory');
  });

  it('never runs the replaced provider’s lifecycle hooks', async () => {
    const events: string[] = [];

    class RealConnection extends Database implements OnInit, OnShutdown {
      onInit(): void {
        events.push('real.init');
      }
      onShutdown(): void {
        events.push('real.shutdown');
      }
      query(): string {
        return 'from postgres';
      }
    }

    class FakeConnection extends Database implements OnInit, OnShutdown {
      onInit(): void {
        events.push('fake.init');
      }
      onShutdown(): void {
        events.push('fake.shutdown');
      }
      query(): string {
        return 'from memory';
      }
    }

    @Module({ providers: [provide(Database, { useClass: RealConnection })] })
    class ConnectionModule {}

    const app = await createTestApp({
      modules: [ConnectionModule],
      overrides: [provide(Database, { useClass: FakeConnection })],
    });
    await app.shutdown();

    expect(events).toEqual(['fake.init', 'fake.shutdown']);
  });

  it('rejects an override that names a token nobody binds', async () => {
    const Clock = token<Date>('Clock');

    expect(
      await rejectionMessage(
        createTestApp({
          modules: [DataModule],
          overrides: [provide(Clock, { useValue: new Date(0) })],
        }),
      ),
    ).toBe(
      'Nothing to override for Clock: no module in the graph binds it. An ' +
        'override replaces a binding — it cannot add one, because a token nobody ' +
        'bound is a token nothing under test resolves.',
    );
  });

  it('names every unmatched override, not just the first', async () => {
    const Clock = token<Date>('Clock');
    const Mailer = token<string>('Mailer');

    expect(
      await rejectionMessage(
        createTestApp({
          modules: [DataModule],
          overrides: [
            provide(Clock, { useValue: new Date(0) }),
            provide(Database, { useClass: FakeDatabase }),
            provide(Mailer, { useValue: 'noop' }),
          ],
        }),
      ),
    ).toContain('Nothing to override for Clock, Mailer:');
  });

  it('still reports a duplicate binding — replacing is not a bypass', async () => {
    @Module({ providers: [provide(Database, { useClass: RealDatabase })] })
    class OneModule {}

    @Module({ providers: [provide(Database, { useClass: RealDatabase })] })
    class TwoModule {}

    // The override replaces both, so the count per token is unchanged and the
    // container's own check is what fires.
    expect(
      await rejectionMessage(
        createTestApp({
          modules: [OneModule, TwoModule],
          overrides: [provide(Database, { useClass: FakeDatabase })],
        }),
      ),
    ).toBe(
      'Duplicate binding for Database: bound by module "OneModule" and module ' +
        '"TwoModule". The container is flat — one binding per token.',
    );
  });

  it('boots with no overrides at all', async () => {
    const app = await createTestApp({ modules: [DataModule] });

    expect(app.get(Database)).toBeInstanceOf(RealDatabase);
  });

  it('replaces a contract core binds by default, and only that one', async () => {
    const logger = new RecordingLogger();

    class Boot implements OnInit {
      readonly logger = inject(Logger);

      onInit(): void {
        this.logger.info('booted', { area: 'test' });
      }
    }

    @Module({ providers: [Boot] })
    class BootModule {}

    const app = await createTestApp({
      modules: [BootModule],
      overrides: [provide(Logger, { useValue: logger })],
    });

    expect(app.get(Logger)).toBe(logger);
    // The other default is still core's, so overriding one does not disturb it.
    expect(app.get(RequestContext)).toBeDefined();
    expect(logger.at(LogLevel.INFO)).toEqual([
      { level: LogLevel.INFO, message: 'booted', params: [{ area: 'test' }] },
    ]);
  });
});

describe('RecordingLogger', () => {
  it('records every level and clears', () => {
    const logger = new RecordingLogger();

    logger.verbose('v');
    logger.debug('d');
    logger.info('i');
    logger.log('legacy');
    logger.warn('w');
    logger.error(new Error('boom'));
    logger.fatal({ code: 1 });

    expect(logger.logLevel).toBe(LogLevel.VERBOSE);
    expect(logger.entries.map((entry) => entry.level)).toEqual([
      LogLevel.VERBOSE,
      LogLevel.DEBUG,
      LogLevel.INFO,
      // log() is info under a deprecated name, exactly as the contract says.
      LogLevel.INFO,
      LogLevel.WARN,
      LogLevel.ERROR,
      LogLevel.FATAL,
    ]);
    expect(logger.at(LogLevel.INFO).map((entry) => entry.message)).toEqual([
      'i',
      'legacy',
    ]);

    logger.clear();
    expect(logger.entries).toEqual([]);
  });
});

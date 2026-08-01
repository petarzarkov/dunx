import { describe, expect, it } from 'bun:test';
import { AppFactory, Logger, LOG_LEVELS, LogLevel, Module } from '@dunx/core';
import {
  ContextStore,
  LOG_LEVELS as BACKING_LOG_LEVELS,
  LogLevel as BackingLogLevel,
  type Transport,
} from '@arkv/logger';
import { MemoryTransport } from '@arkv/logger/testing';
import { BackingLogger, LoggerModule, LoggerSettings } from './module.js';

/** Captures stdout, since the logger writes through console. */
const captured = async (run: () => Promise<void> | void): Promise<string[]> => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
};

describe('LoggerModule', () => {
  /**
   * The contract's level names are handed straight to the backing logger, which
   * looks them up by position in its own `LOG_LEVELS`. A name it does not know
   * indexes to `-1`, which is *below* every real level — so a drifted enum does
   * not throw, it silently disables filtering. Comparing the two arrays is the
   * only cheap guard against that.
   */
  it("mirrors the backing logger's levels, or filtering silently stops working", () => {
    expect([...LOG_LEVELS]).toEqual([...BACKING_LOG_LEVELS]);
    expect(LogLevel.INFO).toBe(BackingLogLevel.INFO);
  });

  it('drops an entry below the configured level', async () => {
    @Module({
      imports: [
        LoggerModule.forRoot({ level: LogLevel.INFO, isDevelopment: false }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const lines = await captured(() => {
      app.get(Logger).debug('below the threshold');
      app.get(Logger).info('at the threshold');
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['message']).toBe('at the threshold');
  });

  it('binds @arkv/logger to the @dunx/core contract with no adapter', async () => {
    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const logger = app.get(Logger);

    // Structural satisfaction is the whole point — assert the contract's surface.
    expect(logger.logLevel).toBe(LogLevel.DEBUG);
    // `log` alongside `info` because the contract keeps it as a deprecated alias.
    for (const level of [
      'verbose',
      'debug',
      'info',
      'log',
      'warn',
      'error',
      'fatal',
    ]) {
      expect(typeof (logger as unknown as Record<string, unknown>)[level]).toBe(
        'function',
      );
    }
  });

  it('emits a structured entry with the redaction that matters', async () => {
    @Module({
      imports: [
        LoggerModule.forRoot({ level: LogLevel.DEBUG, isDevelopment: false }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const lines = await captured(() => {
      app.get(Logger).info('hello', { userId: 7, password: 'hunter2' });
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['message']).toBe('hello');
    expect(entry['level']).toBe(LogLevel.INFO);
    expect(entry['userId']).toBe(7);
    // The upstream sanitizer, not a dunx reimplementation of one.
    expect(entry['password']).not.toBe('hunter2');
  });

  it('emits `info` from the deprecated `log` alias, not a level of its own', async () => {
    @Module({
      imports: [
        LoggerModule.forRoot({ level: LogLevel.INFO, isDevelopment: false }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const lines = await captured(() => {
      app.get(Logger).log('via the alias');
    });

    expect(JSON.parse(lines[0]!)['level']).toBe(LogLevel.INFO);
  });

  it('injects into a constructor, which is how apps consume it', async () => {
    class Users {
      constructor(readonly logger: Logger) {}
    }
    // Stands in for @dunx/compiler, which does not run over this package's tests.
    Object.defineProperty(Users, Symbol.for('dunx.deps'), {
      value: () => [Logger],
    });

    @Module({
      imports: [LoggerModule.forRoot({ level: LogLevel.INFO })],
      providers: [Users],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Users).logger.logLevel).toBe(LogLevel.INFO);
  });

  it('accepts an async config, because eager resolution settles it first', async () => {
    @Module({
      imports: [
        LoggerModule.forRoot(async () => {
          await Bun.sleep(1);
          return { level: LogLevel.WARN };
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Logger).logLevel).toBe(LogLevel.WARN);
    expect(app.get(LoggerSettings).level).toBe(LogLevel.WARN);
  });

  it('reads its config from another provider via forRootAsync', async () => {
    // The one thing forRoot cannot express: its function takes no arguments.
    class Settings {
      readonly level = LogLevel.WARN;
    }

    @Module({
      imports: [
        LoggerModule.forRootAsync({
          useFactory: (settings: Settings) => ({ level: settings.level }),
          inject: [Settings] as const,
        }),
      ],
      providers: [Settings],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Logger).logLevel).toBe(LogLevel.WARN);
  });

  it('shares one ContextStore, whose contents are per async flow', async () => {
    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const store = app.get(ContextStore);

    const seen: string[] = [];
    await Promise.all([
      store.runWithContext({ requestId: 'a' }, async () => {
        await Bun.sleep(2);
        seen.push(`a:${String(store.getContext()['requestId'])}`);
      }),
      store.runWithContext({ requestId: 'b' }, async () => {
        seen.push(`b:${String(store.getContext()['requestId'])}`);
      }),
    ]);

    expect(seen.sort()).toEqual(['a:a', 'b:b']);
    expect(store.getContext()).toEqual({});
  });

  it('nests contexts by merging, so an inner scope keeps the outer requestId', async () => {
    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const store = app.get(ContextStore);

    store.runWithContext({ requestId: 'r1' }, () => {
      store.runWithContext({ userId: 'u1' }, () => {
        expect(store.getContext()['requestId']).toBe('r1');
        expect(store.getContext()['userId']).toBe('u1');
      });
      // The merge produced a fresh object, so the inner scope did not leak out.
      expect(store.getContext()['userId']).toBeUndefined();

      store.runWithContext(
        { userId: 'u2' },
        () => {
          expect(store.getContext()['requestId']).toBeUndefined();
        },
        { inherit: false },
      );
    });
  });

  it('resolves BackingLogger to the same instance the contract does', async () => {
    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG })] })
    class Root {}

    const app = await AppFactory.create(Root);
    // Typed loosely because the two tokens are deliberately different types:
    // the contract is the narrow one, and only the implementation widens it.
    const backing: unknown = app.get(BackingLogger);
    expect(backing).toBe(app.get(Logger));
  });

  it('merges child bindings into every entry', async () => {
    const memory = new MemoryTransport();

    @Module({
      imports: [
        LoggerModule.forRoot({ level: LogLevel.DEBUG, transports: [memory] }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(BackingLogger).child({ module: 'users' }).info('created');

    expect(memory.last?.['module']).toBe('users');
    expect(memory.last?.['message']).toBe('created');
  });

  it('flushes and closes transports on app shutdown', async () => {
    const calls: string[] = [];
    const transport: Transport = {
      write: () => calls.push('write'),
      flush: () => calls.push('flush'),
      close: () => calls.push('close'),
    };

    @Module({
      imports: [
        LoggerModule.forRoot({ level: LogLevel.INFO, transports: [transport] }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(Logger).info('pending');
    // Written, but neither flushed nor closed — a buffering FileTransport is
    // still holding the entry at this point.
    expect(calls).toEqual(['write']);

    await app.shutdown();
    expect(calls).toEqual(['write', 'flush', 'close']);
  });

  it('installs no process handlers unless asked', async () => {
    const before = process.listenerCount('uncaughtException');

    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.FATAL })] })
    class Root {}

    await AppFactory.create(Root);
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('captures global errors when asked, and releases them on shutdown', async () => {
    const uncaught = process.listenerCount('uncaughtException');
    const unhandled = process.listenerCount('unhandledRejection');

    @Module({
      imports: [
        LoggerModule.forRoot(
          { level: LogLevel.FATAL },
          { captureGlobalErrors: { exitOnUncaught: false } },
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(process.listenerCount('uncaughtException')).toBe(uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(unhandled + 1);

    await app.shutdown();
    expect(process.listenerCount('uncaughtException')).toBe(uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(unhandled);
  });
});

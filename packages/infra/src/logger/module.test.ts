import { describe, expect, it } from 'bun:test';
import { AppFactory, Logger, LogLevel, Module } from '@dunx/core';
import { ContextStore } from '@arkv/logger';
import { LoggerModule, LoggerSettings } from './module.js';

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
  it('binds @arkv/logger to the @dunx/core contract with no adapter', async () => {
    @Module({ imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const logger = app.get(Logger);

    // Structural satisfaction is the whole point — assert the contract's surface.
    expect(logger.logLevel).toBe(LogLevel.DEBUG);
    for (const level of ['verbose', 'debug', 'log', 'warn', 'error', 'fatal']) {
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
      app.get(Logger).log('hello', { userId: 7, password: 'hunter2' });
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['message']).toBe('hello');
    expect(entry['userId']).toBe(7);
    // The upstream sanitizer, not a dunx reimplementation of one.
    expect(entry['password']).not.toBe('hunter2');
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
      imports: [LoggerModule.forRoot({ level: LogLevel.LOG })],
      providers: [Users],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Users).logger.logLevel).toBe(LogLevel.LOG);
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
});

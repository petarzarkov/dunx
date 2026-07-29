import { AppFactory, Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { ConsoleLogger } from './console.js';
import { ContextStore } from './context.js';
import { captureConsole } from './fixture.test.js';
import { Logger } from './logger.js';
import { LoggerModule } from './module.js';
import { LoggerOptions } from './options.js';
import { DEFAULT_MASK_FIELDS, LogLevel } from './types.js';

describe('LoggerModule.forRoot', () => {
  it('binds Logger, LoggerOptions and ContextStore', async () => {
    const app = await AppFactory.create(LoggerModule.forRoot());

    expect(app.get(Logger)).toBeInstanceOf(ConsoleLogger);
    expect(app.get(LoggerOptions)).toBeInstanceOf(Object);
    expect(app.get(ContextStore)).toBeInstanceOf(ContextStore);
    await app.shutdown();
  });

  it('resolves one Logger for the whole container', async () => {
    const app = await AppFactory.create(LoggerModule.forRoot());

    expect(app.get(Logger)).toBe(app.get(Logger));
    await app.shutdown();
  });

  it('applies the documented defaults', async () => {
    const app = await AppFactory.create(LoggerModule.forRoot());
    const options = app.get(LoggerOptions);

    expect(options).toMatchObject({
      level: LogLevel.DEBUG,
      maskFields: [...DEFAULT_MASK_FIELDS],
      filterEvents: [],
      maxArrayLength: 100,
      maxDepth: 32,
      appId: undefined,
    });
    await app.shutdown();
  });

  it('merges configured mask fields with the defaults', async () => {
    const app = await AppFactory.create(
      LoggerModule.forRoot({
        name: 'api',
        version: '2.1.0',
        env: 'staging',
        level: LogLevel.WARN,
        maskFields: ['ssn', 'password'],
        filterEvents: ['/health'],
      }),
    );
    const options = app.get(LoggerOptions);

    expect(options.level).toBe(LogLevel.WARN);
    expect(options.appId).toBe('api-2.1.0-staging');
    expect(options.maskFields).toEqual([...DEFAULT_MASK_FIELDS, 'ssn']);
    expect(app.get(Logger).logLevel).toBe(LogLevel.WARN);
    await app.shutdown();
  });

  /** No forRootAsync: eager resolution settles the factory before any ctor runs. */
  it('accepts an async config loader', async () => {
    const app = await AppFactory.create(
      LoggerModule.forRoot(async () => {
        await Bun.sleep(1);
        return { level: LogLevel.ERROR, colors: false };
      }),
    );

    expect(app.get(LoggerOptions).level).toBe(LogLevel.ERROR);
    expect(app.get(Logger).logLevel).toBe(LogLevel.ERROR);
    await app.shutdown();
  });

  it('is importable from another module', async () => {
    @Module({ imports: [LoggerModule.forRoot({ colors: false })] })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.get(Logger)).toBeInstanceOf(ConsoleLogger);
    await app.shutdown();
  });

  /**
   * The reason `Logger` is bound with an explicit factory: `@dunx/compiler` only
   * transforms `.ts` outside `node_modules`, so it never sees this package's
   * published `dist`. This test run has no preload registered, which is exactly
   * the situation a consumer's dependency is in.
   */
  it('boots with no @dunx/compiler preload registered', async () => {
    expect(
      globalThis[Symbol.for('dunx.deps') as unknown as never],
    ).toBeUndefined();

    const app = await AppFactory.create(LoggerModule.forRoot());

    expect(app.get(Logger).logLevel).toBe(LogLevel.DEBUG);
    await app.shutdown();
  });

  it('injects the contract into a service by constructor type', async () => {
    class Reporter {
      constructor(readonly logger: Logger) {}
      report(): void {
        this.logger.log('reported');
      }
    }
    // Stands in for what the compiler records; this test run has no preload.
    Object.defineProperty(Reporter, Symbol.for('dunx.deps'), {
      value: () => [Logger],
    });

    @Module({
      imports: [LoggerModule.forRoot({ colors: false })],
      providers: [Reporter],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const capture = captureConsole();
    try {
      app.get(Reporter).report();

      expect(app.get(Reporter).logger).toBe(app.get(Logger));
      expect(capture.entry()).toMatchObject({ message: 'reported' });
    } finally {
      capture.restore();
    }
    await app.shutdown();
  });

  /**
   * One store for the container, per-flow contents. The async context is a
   * separate concern from resolution — the injected logger reads whatever flow it
   * is called in, and nothing about the container changes per request.
   */
  it('shares one ContextStore with the injected logger', async () => {
    const app = await AppFactory.create(
      LoggerModule.forRoot({ colors: false }),
    );
    const store = app.get(ContextStore);
    const logger = app.get(Logger);
    const capture = captureConsole();

    try {
      await Promise.all([
        store.runWithContext({ requestId: 'first' }, async () => {
          await Bun.sleep(2);
          logger.log('one');
        }),
        store.runWithContext({ requestId: 'second' }, async () => {
          await Bun.sleep(1);
          logger.log('two');
        }),
      ]);

      // Paired by content, not by order: which timer fires first is the
      // runtime's business, and the property under test is that neither entry
      // picked up the other flow's requestId.
      const pairs = new Map(
        [capture.entry(0), capture.entry(1)].map((entry) => [
          String(entry['message']),
          String(entry['requestId']),
        ]),
      );
      expect(pairs.get('one')).toBe('first');
      expect(pairs.get('two')).toBe('second');
    } finally {
      capture.restore();
    }
    await app.shutdown();
  });
});

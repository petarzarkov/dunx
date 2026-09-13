import {
  AppFactory,
  ConsoleLogger,
  Logger,
  Module,
  provide,
  token,
  type App,
} from '@dunx/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { AmqpConnection } from './connection.js';
import { AmqpHandler } from './decorators.js';
import { AmqpModule } from './module.js';
import { AmqpOptions } from './options.js';
import { AmqpPublisher } from './publisher.js';
import { AmqpRunner } from './runner.js';

/** A port nothing answers on, so the whole suite runs without a broker. */
const unreachable = 'amqp://127.0.0.1:1';

const quiet = (): { logger: Logger; lines: unknown[] } => {
  const lines: unknown[] = [];
  const logger = new ConsoleLogger(undefined, 'fatal');
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logger[level] = (message: unknown): void => {
      lines.push(message);
    };
  }
  return { logger, lines };
};

const options = {
  url: unreachable,
  readyTimeoutMs: 50,
  drainTimeoutMs: 50,
  connection: { retryLow: 50 },
} as const;

class Orders {
  handled = 0;

  @AmqpHandler({ queue: 'orders' })
  onOrder(): void {
    this.handled += 1;
  }
}

let app: App | undefined;

afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

describe('what the module binds', () => {
  it('binds the publish side and nothing that consumes', async () => {
    app = await AppFactory.create(AmqpModule.forRoot(options));

    expect(app.get(AmqpOptions).url).toBe(unreachable);
    expect(app.get(AmqpConnection)).toBeInstanceOf(AmqpConnection);
    expect(app.get(AmqpPublisher)).toBeInstanceOf(AmqpPublisher);
    expect(app.get(AmqpRunner).subscriber).toBeUndefined();
    // Importing the module alone opens no socket.
    expect(app.get(AmqpConnection).opened).toBe(false);
  });

  it('defaults the url the way defaultAmqpUrl does', async () => {
    app = await AppFactory.create(AmqpModule.forRoot());
    expect(app.get(AmqpOptions).url).toStartWith('amqp://');
  });

  it('exports its surface to an importing module', async () => {
    @Module({ imports: [AmqpModule.forRoot(options)] })
    class Root {}

    app = await AppFactory.create(Root);
    expect(app.get(AmqpPublisher)).toBeInstanceOf(AmqpPublisher);
  });
});

describe('forRootAsync', () => {
  it('takes a bare factory', async () => {
    app = await AppFactory.create(
      AmqpModule.forRootAsync(() => ({
        ...options,
        connectionName: 'billing',
      })),
    );
    expect(app.get(AmqpOptions).connectionName).toBe('billing');
  });

  it('takes an async factory', async () => {
    app = await AppFactory.create(
      AmqpModule.forRootAsync(async () => {
        await Bun.sleep(1);
        return { ...options, connectionName: 'late' };
      }),
    );
    expect(app.get(AmqpOptions).connectionName).toBe('late');
  });

  /**
   * A dynamic module is its own scope, so a factory injecting a provider needs
   * the module that exports it in **that module's** imports. Tested with a
   * `token()` rather than a class: an unbound class self-binds into whichever
   * scope asks first, so a class would resolve whether or not `imports` reached
   * the factory and the test would pass against the bug it guards.
   */
  it('reaches a provider exported by a module in its own imports', async () => {
    const NAME = token<string>('dunx.test.amqp.name');

    @Module({
      providers: [provide(NAME, { useValue: 'from-config' })],
      exports: [NAME],
    })
    class ConfigModule {}

    @Module({
      imports: [
        AmqpModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (name: string) => ({ ...options, connectionName: name }),
          inject: [NAME] as const,
        }),
      ],
    })
    class Root {}

    app = await AppFactory.create(Root);
    expect(app.get(AmqpOptions).connectionName).toBe('from-config');
  });
});

describe('consume', () => {
  it('opens consumers when asked, and stops them before the connection closes', async () => {
    const { logger } = quiet();

    @Module({
      imports: [AmqpModule.forRoot({ ...options, consume: true })],
      providers: [Orders, provide(Logger, { useValue: logger })],
    })
    class Root {}

    // Assigned before the first assertion: a failure here would otherwise leave
    // `afterEach` with nothing to shut down, and the subscriber retrying.
    app = await AppFactory.create(Root);
    expect(app.get(AmqpRunner).subscriber?.queues).toEqual(['orders']);

    // Reverse construction order: the runner is built after the connection, so
    // it drains first and the socket closes under nothing.
    await app.shutdown();
    expect(app.get(AmqpConnection).opened).toBe(false);
  });

  /** A migration whose broker wiring lands before its first `@AmqpHandler`. */
  it("stands down with a warning under 'if-any' and no handler", async () => {
    const { logger, lines } = quiet();

    @Module({
      imports: [AmqpModule.forRoot({ ...options, consume: 'if-any' })],
      providers: [provide(Logger, { useValue: logger })],
    })
    class Root {}

    app = await AppFactory.create(Root);
    expect(app.get(AmqpRunner).subscriber).toBeUndefined();
    expect(lines.join('\n')).toContain('consumes nothing');
  });

  it('fails boot under consume: true with no handler', async () => {
    @Module({ imports: [AmqpModule.forRoot({ ...options, consume: true })] })
    class Root {}

    await expect(AppFactory.create(Root)).rejects.toThrow(/@AmqpHandler/);
  });

  /**
   * Two handlers on one queue is a wiring mistake under every setting: standing
   * down on it would start a process that splits its own deliveries.
   */
  it("fails boot on a duplicate queue even under 'if-any'", async () => {
    class Second {
      @AmqpHandler({ queue: 'orders' })
      alsoOrders(): string {
        return 'second';
      }
    }

    @Module({
      imports: [AmqpModule.forRoot({ ...options, consume: 'if-any' })],
      providers: [
        Orders,
        Second,
        provide(Logger, { useValue: quiet().logger }),
      ],
    })
    class Root {}

    await expect(AppFactory.create(Root)).rejects.toThrow(
      /Two handlers consume queue "orders"/,
    );
  });
});

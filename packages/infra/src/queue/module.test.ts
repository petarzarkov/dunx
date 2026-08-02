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
import { RedisError } from '../redis/errors.js';
import { QueueConnection } from './connection.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { QueueModule } from './module.js';
import { QueueOptions } from './options.js';
import { JobPublisher } from './publisher.js';

const url = 'valkey://localhost:6379';

let app: App | undefined;

afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

describe('QueueOptions', () => {
  it('defaults the prefix and leaves the passthrough empty', () => {
    const options = new QueueOptions({ url });

    expect(options.url).toBe(url);
    expect(options.prefix).toBe('bull');
    expect(options.worker).toEqual({});
    expect(options.defaultJobOptions).toBeUndefined();
    expect(options.jobTimeoutMs).toBeUndefined();
  });

  it('keeps the worker passthrough verbatim', () => {
    const options = new QueueOptions({
      url,
      worker: { concurrency: 8, limiter: { max: 10, duration: 1000 } },
    });

    expect(options.worker).toEqual({
      concurrency: 8,
      limiter: { max: 10, duration: 1000 },
    });
  });

  it('rejects a URL Bun would not accept, keeping the redis message', () => {
    // A QueueError, not a RedisError: each subpath is its own bundle, so a
    // RedisError thrown from here would fail `instanceof` against the class
    // `@dunx/infra/redis` exports.
    expect(() => new QueueOptions({ url: 'http://localhost:6379' })).toThrow(
      QueueError,
    );
    expect(
      () => new QueueOptions({ url: 'http://localhost:6379' }),
    ).not.toThrow(RedisError);
    expect(() => new QueueOptions({ url: 'not a url' })).toThrow(
      /not a valid URL/,
    );

    const thrown = (() => {
      try {
        new QueueOptions({ url: 'not a url' });
      } catch (error) {
        return error as QueueError;
      }
      return undefined;
    })();
    expect(thrown?.code).toBe(QueueErrorCode.INVALID_URL);
    expect(thrown?.cause).toBeInstanceOf(RedisError);
  });

  it('masks the password for logs', () => {
    const options = new QueueOptions({ url: 'redis://user:hunter2@host:6379' });

    expect(options.redactedUrl).toContain('***');
    expect(options.redactedUrl).not.toContain('hunter2');
  });
});

describe('QueueModule.forRoot', () => {
  it('binds the options, the connection and the publisher', async () => {
    app = await AppFactory.create(QueueModule.forRoot({ url }));

    expect(app.get(QueueOptions).url).toBe(url);
    expect(app.get(QueueConnection)).toBeInstanceOf(QueueConnection);
    expect(app.get(JobPublisher)).toBeInstanceOf(JobPublisher);
  });

  it('opens no socket until something asks for a client', async () => {
    app = await AppFactory.create(QueueModule.forRoot({ url }));

    expect(app.get(QueueConnection).open).toBe(0);
    expect(app.get(JobPublisher).opened).toEqual([]);
  });

  /*
   * `QueueBase` forwards its connection's errors onto the Queue itself
   * (`queue-base.js:44`), and an `error` event with no listener throws rather
   * than being ignored - so an unreachable broker wrote two raw RedisError dumps
   * to stderr, bypassing the bound Logger, in addition to rejecting the publish.
   *
   * Asserted on the Queue rather than by capturing stderr, because reproducing it
   * needs a broker that is not there and several seconds of connection timeout.
   * The behaviour behind it is checked below.
   */
  it('listens for errors on every queue it opens', async () => {
    app = await AppFactory.create(QueueModule.forRoot({ url }));
    const queue = app.get(JobPublisher).queue('emails');

    expect(queue.listenerCount('error')).toBeGreaterThan(0);
  });

  it('reports a queue error through the bound Logger, with the error', async () => {
    const entries: { message: string; params: unknown[] }[] = [];
    @Module({
      imports: [QueueModule.forRoot({ url })],
      providers: [
        provide(Logger, {
          useValue: {
            ...new ConsoleLogger(undefined, 'fatal'),
            warn: (message: string, ...params: unknown[]) =>
              entries.push({ message, params }),
          } as unknown as Logger,
        }),
      ],
    })
    class Root {}

    app = await AppFactory.create(Root);
    const queue = app.get(JobPublisher).queue('emails');
    const failure = new Error('broker went away');
    queue.emit('error', failure);

    expect(entries[0]?.message).toContain('emails');
    // Positionally, not as `{ error }`: an Error's own properties are
    // non-enumerable, so wrapping it in an object logged `"error":{}` - a line
    // saying something failed without saying what.
    expect(entries[0]?.params[0]).toBe(failure);
  });

  it('defaults the url the same way @dunx/infra/redis does', async () => {
    app = await AppFactory.create(QueueModule.forRoot());

    expect(app.get(QueueOptions).url).toMatch(/^(valkey|redis|rediss):\/\//);
  });

  it('keeps the configured url when bullmq duplicates the connection', async () => {
    // A worker's blocking connection is `connection.duplicate()`, and bullmq's
    // Bun adapter rebuilds it from `this.raw.url` - which `Bun.RedisClient` does
    // not have. Unbound, the duplicate resolves Bun's *default* url instead, so
    // a worker pointed at a remote Redis would block-poll localhost and never
    // see a job. Nothing on the port below listens, so a duplicate that reaches
    // anything at all reached the wrong server.
    app = await AppFactory.create(
      QueueModule.forRoot({ url: 'redis://127.0.0.1:6399' }),
    );
    const adapter = app.get(QueueConnection).client();
    adapter.on('error', () => undefined);
    const duplicate = adapter.duplicate();
    duplicate.on('error', () => undefined);

    await expect(duplicate.get('dunx:duplicate-probe')).rejects.toThrow();
    duplicate.disconnect();
  });
});

describe('QueueModule.forRootAsync', () => {
  it('awaits a plain loader', async () => {
    app = await AppFactory.create(
      QueueModule.forRootAsync(async () => {
        await Bun.sleep(1);
        return { url, prefix: 'awaited' };
      }),
    );

    expect(app.get(QueueOptions).prefix).toBe('awaited');
  });

  it('injects, so the url can come from config', async () => {
    class Config {
      readonly redisUrl = 'valkey://127.0.0.1:6379';
    }
    const settings = token<Config>('Settings');

    @Module({
      imports: [
        QueueModule.forRootAsync({
          useFactory: (config: Config) => ({ url: config.redisUrl }),
          inject: [settings] as const,
        }),
      ],
      providers: [provide(settings, { useValue: new Config() })],
    })
    class Root {}

    app = await AppFactory.create(Root);
    expect(app.get(QueueOptions).url).toBe('valkey://127.0.0.1:6379');
  });

  it('fails boot when the loader rejects', async () => {
    expect(
      AppFactory.create(
        QueueModule.forRootAsync(() => {
          throw new Error('no config');
        }),
      ),
    ).rejects.toThrow('no config');
  });
});

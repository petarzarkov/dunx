import { AppFactory, Module, provide, token, type App } from '@dunx/core';
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

  it('defaults the url the same way @dunx/infra/redis does', async () => {
    app = await AppFactory.create(QueueModule.forRoot());

    expect(app.get(QueueOptions).url).toMatch(/^(valkey|redis|rediss):\/\//);
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

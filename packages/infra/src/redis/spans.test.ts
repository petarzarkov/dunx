import { AppFactory, Module, NoopTracer } from '@dunx/core';
import { OtelModule, OtelTracer } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'bun:test';
import { traced } from '../otel.fixture.js';
import { redisReachable } from '../reachable.fixture.js';
import { Redis } from './client.js';
import { RedisConnection } from './connection.js';
import { RedisMetrics } from './metrics.js';
import { RedisModule } from './module.js';
import { defaultRedisUrl, RedisOptions } from './options.js';
import { serverOf } from './server.js';

const url = defaultRedisUrl();
const live = await redisReachable(url);

/** Connection refused inside a millisecond, so the failure path is deterministic. */
const deadInit = {
  url: 'redis://127.0.0.1:1/3',
  connectionTimeout: 200,
  maxRetries: 0,
  autoReconnect: false,
  enableOfflineQueue: false,
} as const;
const offline = new RedisOptions(deadInit);

describe('Redis command spans', () => {
  it('opens a CLIENT span per command, keyed by verb and never by key', async () => {
    const metrics = new RedisMetrics();
    const redis = new Redis(offline, metrics, new OtelTracer());
    const spans = await traced(() => redis.get('user:42:session'));
    await redis.onShutdown();

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe('GET');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toEqual({
      'db.system.name': 'redis',
      'db.operation.name': 'GET',
      'db.namespace': '3',
      'server.address': '127.0.0.1',
      'server.port': 1,
    });
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events[0]?.name).toBe('exception');
    expect(metrics.snapshot().errors).toBe(1);
  });

  it('opens none under the no-op tracer', async () => {
    const redis = new Redis(offline, undefined, new NoopTracer());
    const spans = await traced(() => redis.send('client', ['id']));
    await redis.onShutdown();
    expect(spans).toHaveLength(0);
  });

  it('is wired through RedisModule once OtelModule is imported', async () => {
    @Module({ imports: [OtelModule, RedisModule.forRoot(deadInit)] })
    class Root {}

    const app = await AppFactory.create(Root);
    const redis = app.get(RedisConnection);
    const spans = await traced(() => redis.ping());
    await app.shutdown();
    expect(spans.map((span) => span.name)).toEqual(['PING']);
  });

  it.if(live)(
    'leaves a command that succeeds UNSET, under its parent',
    async () => {
      @Module({
        imports: [
          OtelModule,
          RedisModule.forRoot({ url }, undefined, { metrics: true }),
        ],
      })
      class Root {}

      const app = await AppFactory.create(Root);
      const redis = app.get(RedisConnection);
      const spans = await traced(async () => {
        await redis.ping();
        await redis.exists('dunx:spans:absent');
      });
      await app.shutdown();

      expect(spans.map((span) => span.name)).toEqual(['PING', 'EXISTS']);
      expect(spans[1]?.status.code).toBe(SpanStatusCode.UNSET);
      expect(spans[1]?.parentSpanContext?.spanId).toBe(
        spans[0]?.parentSpanContext?.spanId,
      );
    },
  );
});

describe('serverOf', () => {
  it('defaults the port and names no database the URL does not', () => {
    expect(serverOf('rediss://:secret@cache.internal')).toEqual({
      'db.system.name': 'redis',
      'server.address': 'cache.internal',
      'server.port': 6379,
    });
  });

  it('names only the system for a unix socket', () => {
    expect(serverOf('redis+unix:///run/redis.sock')).toEqual({
      'db.system.name': 'redis',
    });
  });
});

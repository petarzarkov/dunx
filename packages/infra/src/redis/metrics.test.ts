import { AppFactory, Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Redis } from './client.js';
import { RedisConnection } from './connection.js';
import { RedisMetrics } from './metrics.js';
import { redisMetrics, RedisModule } from './module.js';
import { defaultRedisUrl, RedisOptions } from './options.js';

const url = defaultRedisUrl();

/** Connection refused inside a millisecond, so the failure path is deterministic. */
const DEAD = 'redis://127.0.0.1:1';
const deadInit = {
  url: DEAD,
  connectionTimeout: 200,
  maxRetries: 0,
  autoReconnect: false,
  enableOfflineQueue: false,
} as const;
const offline = new RedisOptions(deadInit);

const reachable = async (): Promise<boolean> => {
  const client = new Bun.RedisClient(url, {
    connectionTimeout: 500,
    autoReconnect: false,
    enableOfflineQueue: false,
    maxRetries: 0,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
};

const live = await reachable();

describe('RedisMetrics', () => {
  it('keys one series per verb and totals across them', () => {
    const metrics = new RedisMetrics();
    metrics.observe('GET', 1_000);
    metrics.observe('GET', 3_000);
    metrics.observe('SET', 2_000);

    const report = metrics.snapshot();
    expect(report.total).toBe(3);
    expect(report.errors).toBe(0);
    const byCommand = new Map(report.commands.map((c) => [c.command, c]));
    expect(byCommand.get('GET')?.count).toBe(2);
    expect(byCommand.get('GET')?.duration.count).toBe(2);
    expect(byCommand.get('GET')?.duration.max).toBe(3_000);
    expect(byCommand.get('SET')?.count).toBe(1);
  });

  it('counts a failure in both count and errors, and times it', () => {
    const metrics = new RedisMetrics();
    metrics.observe('HGETALL', 5_000, true);
    metrics.observe('HGETALL', 1_000);

    const report = metrics.snapshot();
    expect(report.errors).toBe(1);
    expect(report.commands[0]?.count).toBe(2);
    expect(report.commands[0]?.errors).toBe(1);
    expect(report.commands[0]?.duration.count).toBe(2);
  });

  it('collapses everything past the cap into one series', () => {
    const metrics = new RedisMetrics();
    // `send()` uppercases whatever string it is given and the error path records
    // it, so a verb built from data is one series per value without the cap.
    for (let at = 0; at < 200; at += 1) {
      metrics.observe(`VERB-${at}`, 1_000, true);
    }

    const report = metrics.snapshot();
    // 128 named series plus the one everything else lands in.
    expect(report.commands).toHaveLength(129);
    expect(report.total).toBe(200);
    expect(report.errors).toBe(200);
    const overflow = report.commands.find((one) => one.command === '(other)');
    expect(overflow?.count).toBe(72);
    expect(overflow?.errors).toBe(72);
    expect(overflow?.duration.count).toBe(72);
  });

  it('keeps counting a verb it already has a series for', () => {
    const metrics = new RedisMetrics();
    for (let at = 0; at < 200; at += 1) metrics.observe(`VERB-${at}`, 1_000);
    metrics.observe('VERB-0', 5_000);

    const report = metrics.snapshot();
    const first = report.commands.find((one) => one.command === 'VERB-0');
    expect(first?.count).toBe(2);
    expect(first?.duration.max).toBe(5_000);
    expect(report.commands).toHaveLength(129);
  });

  it('carries no key anywhere in the payload', () => {
    const metrics = new RedisMetrics();
    metrics.observe('GET', 1_000);
    expect(JSON.stringify(metrics.snapshot())).not.toContain('slowest');
  });

  it('drops every series and moves since forward on reset', () => {
    const metrics = new RedisMetrics();
    const before = metrics.snapshot().since;
    metrics.observe('PING', 1_000, true);
    metrics.reset();

    const after = metrics.snapshot();
    expect(after.commands).toHaveLength(0);
    expect(after.total).toBe(0);
    expect(after.errors).toBe(0);
    expect(Date.parse(after.since)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});

describe('the command seam', () => {
  it('records a rejected command against its verb', async () => {
    const metrics = new RedisMetrics();
    const redis = new Redis(offline, metrics);

    await expect(redis.get('missing')).rejects.toThrow();
    await redis.onShutdown();

    const report = metrics.snapshot();
    expect(report.total).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.commands[0]?.command).toBe('GET');
    expect(report.commands[0]?.duration.count).toBe(1);
  });

  it('uppercases whatever send() was given', async () => {
    const metrics = new RedisMetrics();
    const redis = new Redis(offline, metrics);

    await expect(redis.send('client', ['id'])).rejects.toThrow();
    await redis.onShutdown();

    expect(metrics.snapshot().commands[0]?.command).toBe('CLIENT');
  });

  it('caps what a caller-supplied verb can grow to', async () => {
    const metrics = new RedisMetrics();
    const redis = new Redis(offline, metrics);

    // A verb the server would never answer is still recorded, because the seam
    // records the rejection too.
    for (let at = 0; at < 200; at += 1) {
      await expect(redis.send(`verb-${at}`)).rejects.toThrow();
    }
    await redis.onShutdown();

    const report = metrics.snapshot();
    expect(report.total).toBe(200);
    expect(report.commands).toHaveLength(129);
  });

  it('records nothing when no metrics were bound', async () => {
    const redis = new Redis(offline);
    await expect(redis.get('missing')).rejects.toThrow();
    await redis.onShutdown();
  });

  it.if(live)('times a command that succeeds', async () => {
    const metrics = new RedisMetrics();
    const redis = new Redis(new RedisOptions({ url }), metrics);

    await redis.ping();
    await redis.onShutdown();

    const report = metrics.snapshot();
    expect(report.errors).toBe(0);
    expect(report.commands[0]?.command).toBe('PING');
    expect(report.commands[0]?.duration.count).toBe(1);
    expect(report.commands[0]?.duration.max).toBeGreaterThan(0);
  });
});

describe('RedisModule wiring', () => {
  // Asserted on the module rather than through `app.get`: an unbound class
  // self-binds into whichever scope asks first, so resolving one proves nothing.
  it('binds nothing by default', () => {
    const module = RedisModule.forRoot(deadInit);
    expect(module.exports).not.toContain(RedisMetrics);
    expect(
      RedisModule.forRoot(deadInit, undefined, { metrics: true }).exports,
    ).toContain(RedisMetrics);
  });

  it('binds the class for the default connection', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot(deadInit, undefined, { metrics: true }),
    );
    const metrics = app.get(RedisMetrics);
    await expect(app.get(RedisConnection).ping()).rejects.toThrow();
    expect(metrics.snapshot().total).toBe(1);
    await app.shutdown();
  });

  it('binds a token per name, so two connections do not share one', async () => {
    class SessionsRedis extends Redis {}
    class AuditRedis extends Redis {}

    @Module({
      imports: [
        RedisModule.forRootAsync(() => deadInit, SessionsRedis, {
          metrics: true,
        }),
        RedisModule.forRootAsync(() => deadInit, AuditRedis, {
          metrics: true,
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    await expect(app.get(SessionsRedis).ping()).rejects.toThrow();

    expect(app.get(redisMetrics('SessionsRedis')).snapshot().total).toBe(1);
    expect(app.get(redisMetrics('AuditRedis')).snapshot().total).toBe(0);
    // Memoised, or the module and the consumer would hold different tokens.
    expect(redisMetrics('SessionsRedis')).toBe(redisMetrics('SessionsRedis'));
    await app.shutdown();
  });

  it('reaches a named registration through forRoot as well', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({ ...deadInit, name: 'jobs' }, undefined, {
        metrics: true,
      }),
    );
    expect(app.get(redisMetrics('jobs')).snapshot().total).toBe(0);
    await app.shutdown();
  });
});

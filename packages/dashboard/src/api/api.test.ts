import { AppFactory, Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import type { DashboardProbe, RedisProbe } from '../contracts.js';
import { DashboardModule } from '../module.js';
import { DashboardOptions } from '../options.js';
import { bounded } from './bounded.js';
import { parseInfo, redisReport } from './redis.js';
import { redisProbe, runProbe, runtimeReport } from './runtime.js';

/**
 * The off-process readers, called directly rather than through a served page.
 * `dashboard.test.ts` covers position in the middleware chain against a real
 * `Bun.serve`; what is left is the behaviour on a broker that is slow, one that
 * throws, and one that is absent, which a live server cannot produce on demand.
 */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('bounded', () => {
  it('returns the work when the work wins', async () => {
    expect(
      await bounded(
        async () => 'done',
        1000,
        () => 'timed out',
      ),
    ).toBe('done');
  });

  it('returns the fallback value, not a rejection, when the clock wins', async () => {
    expect(await bounded(never<string>, 5, () => 'timed out')).toBe(
      'timed out',
    );
  });

  it('lets a rejection through rather than converting it to the fallback', async () => {
    expect(
      bounded(
        () => Promise.reject(new Error('broker refused')),
        1000,
        () => 'timed out',
      ),
    ).rejects.toThrow('broker refused');
  });

  /**
   * The timer is cleared unconditionally, so a resolved race leaves no handle
   * behind. An armed 30s timer would hold the loop open past the assertions, and
   * this test returning at all is what proves it does not.
   */
  it('clears the timer when the work wins, leaving no handle armed', async () => {
    expect(
      await bounded(
        async () => 1,
        30_000,
        () => 0,
      ),
    ).toBe(1);
  });
});

describe('runProbe', () => {
  it('reports up, and carries the probe detail through', async () => {
    const probe: DashboardProbe = {
      name: 'cache',
      check: () => ({ state: 'up', detail: 'warm' }),
    };

    expect(await runProbe(probe, 1000)).toMatchObject({
      name: 'cache',
      state: 'up',
      detail: 'warm',
    });
  });

  it('omits detail entirely when the probe gave none', async () => {
    const report = await runProbe(
      { name: 'bare', check: () => ({ state: 'up' }) },
      1000,
    );

    expect(report).toEqual({ name: 'bare', state: 'up', ms: report.ms });
    expect('detail' in report).toBe(false);
  });

  /**
   * A probe that threw told us something, so it is `down`. A probe that did not
   * answer told us nothing, so it is `unknown` - saying `down` there would send
   * somebody to restart a healthy service.
   */
  it('calls a thrown probe down, with the message as the detail', async () => {
    const report = await runProbe(
      {
        name: 'db',
        check: () => Promise.reject(new Error('ECONNREFUSED')),
      },
      1000,
    );

    expect(report).toMatchObject({ state: 'down', detail: 'ECONNREFUSED' });
  });

  it('stringifies a non-Error rejection rather than reporting nothing', async () => {
    const report = await runProbe(
      { name: 'db', check: () => Promise.reject('plain string') },
      1000,
    );

    expect(report).toMatchObject({ state: 'down', detail: 'plain string' });
  });

  it('calls a probe that never answers unknown, naming the budget', async () => {
    const report = await runProbe({ name: 'slow', check: never }, 5);

    expect(report).toMatchObject({
      name: 'slow',
      state: 'unknown',
      detail: 'no answer in 5ms',
    });
  });
});

describe('redisProbe', () => {
  it('pings rather than reading the connected flag', async () => {
    let pinged = 0;
    const result = await redisProbe({
      connected: false,
      ping: async () => {
        pinged += 1;
        return 'PONG';
      },
      send: async () => '',
    }).check();

    expect(pinged).toBe(1);
    expect(result.state).toBe('up');
    expect(result.detail).toMatch(/^PING \d+ms$/);
  });

  it('is named redis, so the lights row has one shape', () => {
    expect(
      redisProbe({
        connected: true,
        ping: async () => 'PONG',
        send: async () => '',
      }).name,
    ).toBe('redis');
  });
});

describe('runtimeReport', () => {
  it('reports the process and runs every probe', async () => {
    const options = new DashboardOptions({
      probes: [
        { name: 'a', check: () => ({ state: 'up' }) },
        { name: 'b', check: () => ({ state: 'down', detail: 'lagging' }) },
      ],
    });

    const report = await runtimeReport(options, performance.now() - 25);

    expect(report.pid).toBe(process.pid);
    expect(report.bun).toBe(Bun.version);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.memory.rss).toBeGreaterThan(0);
    expect(report.memory.heapTotal).toBeGreaterThan(0);
    expect(report.now).toBeGreaterThan(0);
    expect(report.probes.map((probe) => probe.name)).toEqual(['a', 'b']);
  });

  /**
   * From when the middleware was constructed, not `process.uptime()`, which counts
   * from the interpreter starting.
   */
  it('measures uptime from the handed start, not from the process start', async () => {
    const report = await runtimeReport(
      new DashboardOptions(),
      performance.now(),
    );

    expect(report.uptimeMs).toBeLessThan(1000);
  });

  it('puts the redis handle first, ahead of the probes the app declared', async () => {
    const report = await runtimeReport(
      new DashboardOptions({
        redis: {
          connected: true,
          ping: async () => 'PONG',
          send: async () => '',
        },
        probes: [{ name: 'mine', check: () => ({ state: 'up' }) }],
      }),
      performance.now(),
    );

    expect(report.probes.map((probe) => probe.name)).toEqual(['redis', 'mine']);
  });

  it('reports no probes at all when the app configured none', async () => {
    expect((await runtimeReport(new DashboardOptions(), 0)).probes).toEqual([]);
  });
});

describe('parseInfo', () => {
  it('keeps the wanted fields and drops the other two hundred', () => {
    expect(
      parseInfo(
        [
          '# Server',
          'redis_version:7.2.4',
          'redis_mode:standalone',
          'io_threads_active:0',
          '',
          '# Clients',
          'connected_clients:3',
          'blocked_clients:0',
          'cluster_connections:0',
        ].join('\r\n'),
      ),
    ).toEqual({
      redis_version: '7.2.4',
      redis_mode: 'standalone',
      connected_clients: '3',
      blocked_clients: '0',
    });
  });

  it('ignores a line with no colon, and one that starts with it', () => {
    expect(parseInfo(['garbage', ':leading', 'os:Linux'].join('\n'))).toEqual({
      os: 'Linux',
    });
  });

  it('keeps a value containing colons whole', () => {
    expect(parseInfo('os:Linux 6.1 x86_64:extra')).toEqual({
      os: 'Linux 6.1 x86_64:extra',
    });
  });

  it('is empty for an empty reply', () => {
    expect(parseInfo('')).toEqual({});
  });
});

describe('redisReport', () => {
  const up = (raw: unknown): RedisProbe => ({
    connected: true,
    ping: async () => 'PONG',
    send: async () => raw,
  });

  it('reports the ping and the parsed INFO', async () => {
    const report = await redisReport(up('redis_version:7.2.4'), 1000);

    expect(report.configured).toBe(true);
    expect(report.connected).toBe(true);
    expect(report.pingMs).toBeGreaterThanOrEqual(0);
    expect(report.info).toEqual({ redis_version: '7.2.4' });
    expect(report.error).toBeUndefined();
  });

  it('reports an empty info when INFO did not answer with text', async () => {
    expect((await redisReport(up(12345), 1000)).info).toEqual({});
  });

  it('carries a throwing broker through as an error row', async () => {
    const report = await redisReport(
      {
        connected: false,
        ping: () => Promise.reject(new Error('NOAUTH')),
        send: async () => '',
      },
      1000,
    );

    expect(report).toMatchObject({
      configured: true,
      connected: false,
      pingMs: undefined,
      info: {},
      error: 'NOAUTH',
    });
  });

  it('stringifies a non-Error rejection', async () => {
    expect(
      (
        await redisReport(
          {
            connected: false,
            ping: () => Promise.reject('refused'),
            send: async () => '',
          },
          1000,
        )
      ).error,
    ).toBe('refused');
  });

  /**
   * A merely slow broker never rejects: it waits out its own connection timeout,
   * 5s by default, so the row has to come from the clock instead.
   */
  it('produces the row from the clock when the broker is slow rather than broken', async () => {
    const report = await redisReport(
      { connected: true, ping: never<string>, send: async () => '' },
      5,
    );

    expect(report).toMatchObject({
      configured: true,
      connected: true,
      pingMs: undefined,
      error: 'no answer in 5ms',
    });
  });
});

describe('DashboardModule.forRootAsync', () => {
  it('takes a bare loader and awaits it', async () => {
    @Module({
      imports: [DashboardModule.forRootAsync(async () => ({ path: '/ops' }))],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DashboardOptions).path).toBe('/ops');
    await app.shutdown();
  });

  it('takes a config object and injects what it names', async () => {
    class Settings {
      readonly path = '/admin/dash';
    }

    @Module({ providers: [Settings], exports: [Settings] })
    class SettingsModule {}

    @Module({
      imports: [
        DashboardModule.forRootAsync({
          imports: [SettingsModule],
          useFactory: (settings: Settings) => ({ path: settings.path }),
          inject: [Settings],
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DashboardOptions).path).toBe('/admin/dash');
    await app.shutdown();
  });

  it('defaults inject and imports to empty for a config object without them', async () => {
    @Module({
      imports: [
        DashboardModule.forRootAsync({
          useFactory: () => ({ title: 'Ops' }),
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DashboardOptions).title).toBe('Ops');
    await app.shutdown();
  });
});

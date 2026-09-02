import { describe, expect, test } from 'bun:test';
import { provide } from '@dunx/core';
import { createTestServer } from '@dunx/testing';
import { HttpModule } from './http/http.module.js';
import { ApiKeys } from './reports/api-keys.js';
import { ReportsModule } from './reports/reports.module.js';
import { ForecastClient } from './weather/forecast.client.js';
import { WeatherModule } from './weather/weather.module.js';

class KnownKeys extends ApiKeys {
  override accepts(presented: string): boolean {
    return presented === 'good-key';
  }
}

class FixedForecast extends ForecastClient {
  override async temperatureAt(): Promise<number> {
    return 12;
  }
}

/**
 * `createTestServer` is `createTestApp` plus a real `Bun.serve` on port 0 and a
 * client pointed at it. No fake dispatcher: a fake could only exercise the parts of
 * the request path dunx wrote, not the parts Bun owns - route matching, params,
 * method dispatch, upgrades. Bun binds a socket in about a millisecond, so the real
 * server is cheaper than the lie.
 *
 * Request logging defaults to **off** here, unlike production, so a suite does not
 * print one JSON line per assertion.
 */
describe('createTestServer', () => {
  test('validates, routes and serialises through the real server', async () => {
    const server = await createTestServer({
      modules: [WeatherModule],
      overrides: [provide(ForecastClient, { useValue: new FixedForecast() })],
      prefix: 'api',
    });

    const { status, body } = await server.json<{ advice: string }>(
      'api/weather/oslo',
    );

    expect(status).toBe(200);
    expect(body.advice).toBe('take a coat');
    await server.close();
  });

  test('an unmatched path is a JSON 404, not Bun’s default', async () => {
    const server = await createTestServer({ modules: [WeatherModule] });

    const { status, body } = await server.json<{ error: string }>('nope');

    expect(status).toBe(404);
    expect(body.error).toBe('NOT_FOUND');
    await server.close();
  });
});

/**
 * A guard is worth testing through the server, because what it reads -
 * `@Public()`, `@Roles()` - is route metadata that only exists once routes have
 * been discovered. Calling `guard.handle()` directly would test a different thing.
 */
describe('a guard, through the real request path', () => {
  const withKnownKeys = () =>
    createTestServer({
      modules: [ReportsModule],
      overrides: [provide(ApiKeys, { useClass: KnownKeys })],
    });

  test('401 with no key, 403 with a bad one, 200 with a good one', async () => {
    const server = await withKnownKeys();

    expect((await server.json('reports')).status).toBe(401);
    expect(
      (await server.json('reports', { headers: { 'x-api-key': 'nope' } }))
        .status,
    ).toBe(403);

    const ok = await server.json<readonly string[]>('reports', {
      headers: { 'x-api-key': 'good-key' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(['q1-revenue', 'q2-revenue']);

    await server.close();
  });

  test('@Public() opts a route out of the guard', async () => {
    const server = await withKnownKeys();

    expect((await server.json('reports/health')).status).toBe(200);

    await server.close();
  });
});

/**
 * Global middleware reaches a fixture only if the fixture includes the module that
 * binds the `HttpOptionsProvider`. Include it and `createTestServer` runs the same
 * chain production runs, with nothing restated here and no warning about globals.
 */
describe('global middleware from an HttpOptionsProvider', () => {
  test('runs in the fixture, and the harness says nothing about it', async () => {
    const lines: string[] = [];
    const { warn } = console;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    let server: Awaited<ReturnType<typeof createTestServer>>;
    try {
      server = await createTestServer({
        modules: [HttpModule, WeatherModule],
        overrides: [provide(ForecastClient, { useValue: new FixedForecast() })],
      });
    } finally {
      // Restored even if boot throws, or every later test in this file reports
      // into a dead array.
      console.warn = warn;
    }

    try {
      const { headers } = await server.request('weather/oslo');
      expect(headers.get('server-timing')).toMatch(/^handler;dur=/);
      // Omitting `middleware` is correct here: the provider supplies it.
      expect(lines).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

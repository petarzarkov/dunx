import { afterAll, beforeAll, expect, it } from 'bun:test';
import {
  createTestServer,
  testClient,
  type TestClient,
  type TestServer,
} from '@dunx/testing';
import { configModule } from './config.js';
import { TenantsModule } from './tenants/tenants.module.js';

/**
 * A database per tenant, keyed at runtime, plus the named reporting data source
 * beside it. On its own server so `service.test.ts` stays under the line cap.
 */
let server: TestServer;
let client: TestClient;

interface Ticket {
  id: number;
  subject: string;
}

interface Live {
  keys: string[];
  size: number;
}

beforeAll(async () => {
  process.env['TENANT_MAX'] = '2';
  process.env['TENANT_IDLE_MS'] = '0';
  server = await createTestServer({ modules: [configModule(), TenantsModule] });
  client = testClient(server.url);
});

afterAll(async () => {
  await server.close();
  delete process.env['TENANT_MAX'];
  delete process.env['TENANT_IDLE_MS'];
});

const open = (tenant: string, subject: string) =>
  client.json<Ticket>(`tenants/${tenant}/tickets`, {
    method: 'POST',
    json: { subject },
  });

it('opens a data source on first use and keeps two tenants apart', async () => {
  expect((await open('acme', 'acme one')).status).toBe(201);
  await open('acme', 'acme two');
  await open('globex', 'globex one');

  const acme = await client.json<{ tickets: Ticket[] }>('tenants/acme/tickets');
  const globex = await client.json<{ tickets: Ticket[] }>(
    'tenants/globex/tickets',
  );

  expect(acme.body.tickets.map((t) => t.subject)).toEqual([
    'acme one',
    'acme two',
  ]);
  expect(globex.body.tickets.map((t) => t.subject)).toEqual(['globex one']);
});

it('reports what the pool is holding', async () => {
  const live = await client.json<Live>('tenants');

  expect(live.status).toBe(200);
  expect(live.body.size).toBeLessThanOrEqual(2);
  expect(live.body.keys).toContain('globex');
});

it('evicts the idlest tenant rather than exceeding TENANT_MAX', async () => {
  await open('initech', 'initech one');
  const live = await client.json<Live>('tenants');

  expect(live.body.size).toBe(2);
  expect(live.body.keys).not.toContain('acme');
  expect(live.body.keys).toContain('initech');
});

it('rolls a tenant up into the named reporting data source', async () => {
  await client.json('tenants/globex/rollup', { method: 'POST' });
  await client.json('tenants/initech/rollup', { method: 'POST' });

  const reported = await client.json<{
    rollups: { tenant: string; tickets: number }[];
  }>('tenants/rollups');

  expect(reported.body.rollups).toEqual([
    { tenant: 'globex', tickets: 1 },
    { tenant: 'initech', tickets: 1 },
  ]);
});

it('releases a deprovisioned tenant', async () => {
  const released = await client.json<{ released: boolean }>('tenants/initech', {
    method: 'DELETE',
  });

  expect(released.body.released).toBe(true);
  const live = await client.json<Live>('tenants');
  expect(live.body.keys).not.toContain('initech');
});

it('rejects a key that is not a tenant name', async () => {
  const bad = await client.json('tenants/NOT%20A%20TENANT/tickets');
  expect(bad.status).toBe(400);
});

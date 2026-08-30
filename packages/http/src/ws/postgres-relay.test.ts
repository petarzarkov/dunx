import { describe, expect, it } from 'bun:test';
import { HttpFactory } from '../server/factory.js';
import { PostgresRelay } from './postgres-relay.js';
import { PubSub } from './pubsub.js';
import {
  AppModule,
  open,
  released,
  stop,
  TOPIC,
  twoNodes,
  until,
} from './relay.fixture.js';

/**
 * `PostgresRelay` against a database that is not there, and against a real one
 * when `DUNX_DB_TEST_URL` answers - the same variable the `@dunx/infra` db suites
 * read, so the coverage job's Postgres serves both.
 */

const RELAY_URL = process.env['DUNX_DB_TEST_URL'];

const reachable = async (): Promise<boolean> => {
  if (RELAY_URL === undefined) return false;
  const sql = new Bun.SQL({ url: RELAY_URL, max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close();
  }
};

const HAS_POSTGRES = await reachable();

describe('PostgresRelay when Postgres is not there', () => {
  it('rejects a URL Bun would have accepted and failed on later', () => {
    expect(() => new PostgresRelay({ url: 'not-a-url' })).toThrow(
      /not a valid URL/,
    );
    // A schemeless URL is silently treated as a Postgres *host* by Bun.SQL, so
    // the check has to reject the scheme rather than trust the adapter.
    expect(() => new PostgresRelay({ url: 'redis://localhost:6379' })).toThrow(
      /Unsupported protocol/,
    );
  });

  it('redacts the password it was given', () => {
    expect(
      new PostgresRelay({ url: 'postgres://user:hunter2@localhost:5432/app' })
        .url,
    ).not.toContain('hunter2');
  });

  it('still boots, still fans out locally, and reports the failure once', async () => {
    const failures: string[] = [];
    const relay = new PostgresRelay({ url: 'postgres://127.0.0.1:1/nothing' });
    const app = await HttpFactory.create(AppModule, { requestLogging: false });
    const url = await app.listen(0);

    try {
      const pubsub = app.get(PubSub);
      await pubsub.relayThrough(relay, {
        channel: 'test',
        onError: (_error, phase) => failures.push(phase),
      });
      expect(failures).toEqual(['subscribe']);

      const client = await open(url);
      pubsub.publishEvent(TOPIC, 'said', 'local anyway');
      await until(() => client.frames.length === 1);
      await Bun.sleep(100);
      expect(client.frames).toHaveLength(1);
      // Still one entry: a database that is down must not log once per publish.
      expect(failures).toEqual(['subscribe']);
      client.close();
    } finally {
      await app.shutdown();
    }
  });

  it('releases the connection it could not open, so the process exits', async () => {
    expect(
      await released(
        './postgres-relay.ts',
        'PostgresRelay',
        "const relay = new PostgresRelay({ url: 'postgres://127.0.0.1:1/nothing' });\n" +
          "try { await relay.subscribe('ch', () => {}); } catch (error) { void error; }\n",
      ),
    ).toBe(0);
  });
});

describe.skipIf(!HAS_POSTGRES)('two nodes over real Postgres', () => {
  const url = RELAY_URL as string;

  it('delivers a publish exactly once per subscriber across both nodes', async () => {
    // A channel per run, so a leftover listener or a concurrent run cannot
    // deliver into this test. Underscores: a channel is a Postgres identifier.
    const channel = `dunx_test_${Bun.randomUUIDv7().replaceAll('-', '')}`;
    const { apps, urls } = await twoNodes(
      new PostgresRelay({ url }),
      new PostgresRelay({ url }),
      channel,
    );
    const [first, second] = apps;
    const [urlA, urlB] = urls;
    if (!first || !second || !urlA || !urlB)
      throw new Error('two nodes expected');

    try {
      const [ada, grace] = await Promise.all([open(urlA), open(urlB)]);
      if (!ada || !grace) throw new Error('clients expected');

      first.get(PubSub).publishEvent(TOPIC, 'said', 'over postgres');
      const expected = JSON.stringify({ event: 'said', data: 'over postgres' });

      await until(() => grace.frames.length > 0);
      await Bun.sleep(250);
      expect(ada.frames).toEqual([expected]);
      expect(grace.frames).toEqual([expected]);

      // And the other direction, on the same channel.
      ada.frames.length = 0;
      grace.frames.length = 0;
      second.get(PubSub).publishEvent(TOPIC, 'said', 'and back');
      const back = JSON.stringify({ event: 'said', data: 'and back' });
      await until(() => ada.frames.length > 0);
      await Bun.sleep(250);
      expect(ada.frames).toEqual([back]);
      expect(grace.frames).toEqual([back]);

      ada.close();
      grace.close();
    } finally {
      await stop(apps);
    }
  });

  it('refuses a frame past the NOTIFY ceiling', async () => {
    const channel = `dunx_test_${Bun.randomUUIDv7().replaceAll('-', '')}`;
    const { apps, urls } = await twoNodes(
      new PostgresRelay({ url }),
      new PostgresRelay({ url }),
      channel,
    );
    const [first] = apps;
    const [, urlB] = urls;
    if (!first || !urlB) throw new Error('two nodes expected');

    try {
      const grace = await open(urlB);

      // Postgres caps a NOTIFY payload at 7999 bytes and the relay envelope adds
      // a topic and an origin id, so a frame this size does not cross.
      first.get(PubSub).publishEvent(TOPIC, 'big', 'x'.repeat(8000));
      await Bun.sleep(400);
      expect(grace.frames).toEqual([]);

      // A smaller one still does, so the relay is not simply broken.
      first.get(PubSub).publishEvent(TOPIC, 'small', 'x'.repeat(1000));
      await until(() => grace.frames.length > 0);
      expect(grace.frames).toHaveLength(1);
      grace.close();
    } finally {
      await stop(apps);
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { matchBoard, type BoardRoutes } from './board.js';

/**
 * The matcher exists because bull-board's table is not a list of literals: it
 * carries `:queueName`, `:jobId`, `:queueStatus` and a `static/*` prefix. The
 * first version did exact-match plus one wildcard, and 404'd every job view and
 * every per-queue API call - `{"error":"no such bull-board route"}` on a page
 * bull-board itself renders.
 *
 * These paths are taken verbatim from `BunAdapter.getRoutes()` on 8.6.0.
 */
const handler = (name: string) => () => new Response(name);

const routes: BoardRoutes = {
  '/_dunx/queues/static/*': { GET: handler('static') },
  '/_dunx/queues': { GET: handler('entry') },
  '/_dunx/queues/queue/:queueName': { GET: handler('queue-view') },
  '/_dunx/queues/queue/:queueName/:jobId': { GET: handler('job-view') },
  '/_dunx/queues/api/queues': { GET: handler('queues') },
  '/_dunx/queues/api/redis/stats': { GET: handler('redis') },
  '/_dunx/queues/api/queues/:queueName/workers': { GET: handler('workers') },
  '/_dunx/queues/api/queues/:queueName/default-job-options': {
    GET: handler('job-options'),
  },
  '/_dunx/queues/api/queues/:queueName/:jobId': { GET: handler('job') },
  '/_dunx/queues/api/queues/pause': { PUT: handler('pause-all') },
  '/_dunx/queues/api/queues/:queueName/pause': { PUT: handler('pause-one') },
  '/_dunx/queues/api/queues/:queueName/clean/:queueStatus': {
    PUT: handler('clean'),
  },
};

const hit = async (
  method: string,
  path: string,
): Promise<string | undefined> => {
  const found = matchBoard(routes, method, path);
  if (found === undefined) return undefined;
  // A handler may answer synchronously; the route table's type allows both.
  return await (
    await found.handler(new Request(`http://x.test${path}`))
  ).text();
};

const params = (
  method: string,
  path: string,
): Record<string, string> | undefined =>
  matchBoard(routes, method, path)?.params;

describe('matchBoard', () => {
  it('matches a literal path', async () => {
    expect(await hit('GET', '/_dunx/queues')).toBe('entry');
    expect(await hit('GET', '/_dunx/queues/api/queues')).toBe('queues');
    expect(await hit('GET', '/_dunx/queues/api/redis/stats')).toBe('redis');
  });

  it('matches a parameterised path - the case that was 404ing', async () => {
    expect(await hit('GET', '/_dunx/queues/queue/thumbnails')).toBe(
      'queue-view',
    );
    expect(
      await hit(
        'GET',
        '/_dunx/queues/api/queues/thumbnails/default-job-options',
      ),
    ).toBe('job-options');
    expect(
      await hit('GET', '/_dunx/queues/api/queues/thumbnails/workers'),
    ).toBe('workers');
  });

  it('prefers the literal route where both could claim the path', async () => {
    // `/api/queues/pause` matches `:queueName/...` shapes too; specificity is
    // what stops a PUT to pause-all being read as pausing a queue called "pause".
    expect(await hit('PUT', '/_dunx/queues/api/queues/pause')).toBe(
      'pause-all',
    );
    expect(await hit('PUT', '/_dunx/queues/api/queues/emails/pause')).toBe(
      'pause-one',
    );
  });

  it('matches two parameters in one path', async () => {
    expect(await hit('GET', '/_dunx/queues/queue/emails/1234')).toBe(
      'job-view',
    );
    expect(await hit('GET', '/_dunx/queues/api/queues/emails/1234')).toBe(
      'job',
    );
    expect(
      await hit('PUT', '/_dunx/queues/api/queues/emails/clean/completed'),
    ).toBe('clean');
  });

  it('matches the static wildcard at any depth', async () => {
    expect(await hit('GET', '/_dunx/queues/static/js/main.abc.js')).toBe(
      'static',
    );
    expect(await hit('GET', '/_dunx/queues/static/locales/en-US/x.json')).toBe(
      'static',
    );
  });

  it('is method-aware', async () => {
    // The path exists but not for this verb, which is not the same as absent.
    expect(await hit('PUT', '/_dunx/queues/api/redis/stats')).toBeUndefined();
  });

  it('extracts the params bull-board reads off the request', () => {
    // Bun fills `request.params` when it matches; a manual dispatch has to, or
    // every `:queueName` route answers QUEUE_NOT_FOUND with the route found.
    expect(
      params('GET', '/_dunx/queues/api/queues/thumbnails/workers'),
    ).toEqual({ queueName: 'thumbnails' });
    expect(params('GET', '/_dunx/queues/queue/emails/1234')).toEqual({
      queueName: 'emails',
      jobId: '1234',
    });
    expect(
      params('PUT', '/_dunx/queues/api/queues/emails/clean/completed'),
    ).toEqual({ queueName: 'emails', queueStatus: 'completed' });
  });

  it('decodes a param, so a queue name may carry a space', () => {
    expect(params('GET', '/_dunx/queues/queue/my%20queue')).toEqual({
      queueName: 'my queue',
    });
  });

  it('answers nothing for a path outside the table', async () => {
    // The router then falls back to bull-board's entry route for a GET, which is
    // how its client-side routes reload.
    expect(await hit('GET', '/_dunx/queues/nope/nope/nope')).toBeUndefined();
  });
});

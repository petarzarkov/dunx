import { describe, expect, it } from 'bun:test';
import { captured, withApp } from './request-logging.fixture.test.js';

/**
 * The request-body paths, which differ only in **who reads the body**.
 *
 * A route declaring a `body` schema has already buffered it by the time this logs,
 * so `RawBody` hands the text over and no `Request.clone()` happens - the clone
 * being ~20 us of the ~21 us this option used to cost (`raw-body.ts`). Everything
 * else falls back to cloning. What these pin is that the **entry is the same either
 * way**: the optimisation is not observable from the outside except by its absence
 * in a profile.
 */
describe('logging the request body', () => {
  const post = async (
    path: string,
    body: string,
    options: Parameters<typeof withApp>[1] = {
      requestLogging: { requestBody: true },
    },
  ): Promise<Record<string, unknown>[]> =>
    captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL(path, url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      }, options);
    });

  const entryFor = (
    entries: Record<string, unknown>[],
    path: string,
  ): Record<string, unknown> | undefined =>
    entries.find((entry) =>
      String(entry['message']).startsWith(`POST ${path}`),
    );

  const bodyOf = (entry: Record<string, unknown> | undefined): unknown =>
    (entry?.['request'] as Record<string, unknown> | undefined)?.['body'];

  it('shares the buffered text on a route that declares a schema', async () => {
    const entry = entryFor(
      await post('things/validated', JSON.stringify({ name: 'ada' })),
      '/things/validated',
    );
    expect(bodyOf(entry)).toEqual({ name: 'ada' });
    expect(entry?.['statusCode']).toBe(201);
  });

  /**
   * **The case this design exists to keep working.** The text is recorded before
   * validation runs, so a schema rejection still logs the payload that caused it.
   * Recording the *validated* value instead would have lost exactly the request
   * anyone debugging wants, and recording after validation would have lost it too.
   */
  it('logs the pre-validation body when the schema rejects it', async () => {
    const entry = entryFor(
      await post('things/validated', JSON.stringify({ name: 42 })),
      '/things/validated',
    );
    expect(entry?.['statusCode']).toBe(400);
    expect(bodyOf(entry)).toEqual({ name: 42 });
  });

  /**
   * Malformed JSON never parses, so the value is useless and the text is all there
   * is. Holding text rather than a parsed value is what keeps this working - and it
   * is the second reason not to share the validated object.
   */
  it('logs the raw text when the body is not valid JSON', async () => {
    const entry = entryFor(
      await post('things/validated', '{not json'),
      '/things/validated',
    );
    expect(entry?.['statusCode']).toBe(400);
    expect(bodyOf(entry)).toBe('{not json');
  });

  it('falls back to cloning on a route that declares no schema', async () => {
    const entry = entryFor(
      await post('things', JSON.stringify({ name: 'grace' })),
      '/things',
    );
    expect(bodyOf(entry)).toEqual({ name: 'grace' });
  });

  /**
   * The clone path must leave the handler's own stream alone, which is the whole
   * reason it clones. `POST /things` declares no schema and reads `req.json()`
   * itself, so it is the case that would break.
   *
   * Not asserted here, because it is not true and never was: a route that declares
   * a schema cannot re-read `req` at all. The input reader consumed it and
   * `input.req.json()` throws `Body already used`, with request logging off
   * entirely. `input.body` is the way to read a declared body.
   */
  it('leaves the stream readable for a handler that reads it itself', async () => {
    await withApp(
      async (_app, url) => {
        const response = await fetch(new URL('things', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'ada' }),
        });
        expect(await response.json()).toEqual({ name: 'ada' });
      },
      { requestLogging: { requestBody: true } },
    );
  });

  /** The cap is characters of body text, and the shared path has the text. */
  it('caps a large body the same way on both paths', async () => {
    for (const path of ['things/validated', 'things']) {
      const entry = entryFor(
        await post(path, JSON.stringify({ name: 'a'.repeat(400) }), {
          requestLogging: { requestBody: true, maxBodyLength: 64 },
        }),
        `/${path}`,
      );
      expect(String(bodyOf(entry))).toMatch(/^\[\d+ bytes\]$/);
    }
  });

  it('omits the body entirely for maxBodyLength: 0', async () => {
    const entry = entryFor(
      await post('things/validated', JSON.stringify({ name: 'ada' }), {
        requestLogging: { requestBody: true, maxBodyLength: 0 },
      }),
      '/things/validated',
    );
    expect(bodyOf(entry)).toBeUndefined();
  });

  it('logs no body at all when the option is off', async () => {
    const entry = entryFor(
      await post('things/validated', JSON.stringify({ name: 'ada' }), {}),
      '/things/validated',
    );
    expect(bodyOf(entry)).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { ConsoleLogger, AsyncRequestContext } from '@dunx/core';
import { HttpClientOptions } from './options.js';
import { HttpService } from './service.js';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/** Captures the init `HttpService` hands `fetch`, without a server. */
const initFor = async (
  options: ConstructorParameters<typeof HttpClientOptions>[0],
): Promise<Record<string, unknown>> => {
  let seen: Record<string, unknown> = {};
  globalThis.fetch = ((_input: unknown, init: Record<string, unknown>) => {
    seen = init;
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof fetch;

  const service = new HttpService(
    new HttpClientOptions(options),
    new ConsoleLogger(undefined, 'fatal'),
    new AsyncRequestContext(),
  );
  await service.get('https://example.test/thing');
  return seen;
};

describe('Bun-only fetch options', () => {
  it('passes the four 1.4 additions through', async () => {
    const init = await initFor({
      compress: 'gzip',
      protocol: 'http2',
      maxRedirects: 3,
      proxy: { url: 'http://proxy.test', headers: { 'x-a': 'b' } },
    });

    expect(init['compress']).toBe('gzip');
    expect(init['protocol']).toBe('http2');
    expect(init['maxRedirects']).toBe(3);
    // The object form, which carries `Proxy-Authorization` to the proxy rather
    // than to the target. The string form cannot express that.
    expect(init['proxy']).toEqual({
      url: 'http://proxy.test',
      headers: { 'x-a': 'b' },
    });
  });

  it('takes the object form of compress', async () => {
    const init = await initFor({ compress: { encoding: 'br', level: 4 } });
    expect(init['compress']).toEqual({ encoding: 'br', level: 4 });
  });

  it('still passes the options that predate 1.4', async () => {
    const init = await initFor({ unix: '/tmp/x.sock', decompress: false });
    expect(init['unix']).toBe('/tmp/x.sock');
    expect(init['decompress']).toBe(false);
  });

  it('omits a key that was not set', async () => {
    const init = await initFor({});

    // Presence is what Bun reads, so `proxy: undefined` is not the same as no
    // proxy at all. Only keys the caller set may appear.
    for (const key of [
      'proxy',
      'tls',
      'unix',
      'decompress',
      'verbose',
      'compress',
      'protocol',
      'maxRedirects',
    ]) {
      expect(Object.hasOwn(init, key)).toBe(false);
    }
  });

  it('keeps an explicit false, which is not the same as absent', async () => {
    const init = await initFor({ decompress: false, verbose: false });
    expect(Object.hasOwn(init, 'decompress')).toBe(true);
    expect(init['verbose']).toBe(false);
  });
});

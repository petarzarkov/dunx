import { afterEach, describe, expect, it } from 'bun:test';
import { IMMUTABLE_CACHE_CONTROL } from '@dunx/http/internal';
import { ASSET_CACHE_CONTROL, PackageAssets } from './assets.js';
import { SCALAR_ASSETS } from './scalar/index.js';
import { SWAGGER_ASSETS } from './swagger/index.js';

afterEach(() => {
  PackageAssets.reset();
});

describe('PackageAssets', () => {
  it('resolves a package with an exports map and one without', async () => {
    for (const pkg of [SWAGGER_ASSETS, SCALAR_ASSETS]) {
      const assets = await PackageAssets.resolve(pkg);
      expect(assets.version).toMatch(/^\d+\.\d+\.\d+/);
      for (const name of Object.keys(pkg.files)) {
        expect(await Bun.file(assets.pathOf(name)).exists()).toBe(true);
        expect((await PackageAssets.serve(pkg, name)).status).toBe(200);
      }
    }
  });

  it('caches per package, so two renderers resolve once each', async () => {
    const swagger = await PackageAssets.resolve(SWAGGER_ASSETS);
    expect(await PackageAssets.resolve(SWAGGER_ASSETS)).toBe(swagger);
    expect(await PackageAssets.resolve(SCALAR_ASSETS)).not.toBe(swagger);
  });

  it('caches immutably, keyed by the installed version', async () => {
    const assets = await PackageAssets.resolve(SWAGGER_ASSETS);
    expect(assets.href('/api/docs', 'swagger-ui.css')).toBe(
      `/api/docs/swagger-ui.css?v=${assets.version}`,
    );
    expect(ASSET_CACHE_CONTROL).toBe(IMMUTABLE_CACHE_CONTROL);
    const served = await PackageAssets.serve(SWAGGER_ASSETS, 'swagger-ui.css');
    expect(served.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
  });

  /**
   * The renderers are optional peers, so a missing one is a `bun add` rather than
   * a broken install, and the message has to say which package and which command.
   */
  it('names the package and the install when it does not resolve', async () => {
    await expect(
      PackageAssets.resolve({ name: 'redoc-not-installed', files: {} }),
    ).rejects.toThrow(/bun add redoc-not-installed/);
  });

  /**
   * The allow-list is the first gate, so a junk name never reaches a resolve.
   * `toString` is the one that made `Object.hasOwn` necessary: a plain lookup
   * finds it on `Object.prototype` and would have served a path off the
   * directory. The names are checked with the package left unresolvable, which
   * is what proves nothing resolved.
   */
  it('answers 404 for a name off the allow-list, resolving nothing', async () => {
    const absent = { name: 'not-installed-at-all', files: {} };
    for (const name of [
      '../../../etc/passwd',
      'package.json',
      'toString',
      '',
    ]) {
      expect((await PackageAssets.serve(SWAGGER_ASSETS, name)).status).toBe(
        404,
      );
      expect((await PackageAssets.serve(absent, name)).status).toBe(404);
    }
  });

  /**
   * A cold page asks for the shell and every asset at once. Caching the value
   * rather than the promise had each of those miss and redo the resolve.
   */
  it('resolves once for callers that arrive together', async () => {
    const resolved = await Promise.all(
      Array.from({ length: 8 }, () => PackageAssets.resolve(SWAGGER_ASSETS)),
    );
    const first = await PackageAssets.resolve(SWAGGER_ASSETS);
    for (const assets of resolved) expect(assets).toBe(first);
  });

  /** A rejection is not a result: a peer installed later has to resolve. */
  it('does not cache a failure', async () => {
    const absent = { name: 'installed-later', files: {} };
    await expect(PackageAssets.resolve(absent)).rejects.toThrow();
    await expect(PackageAssets.resolve(absent)).rejects.toThrow();
  });
});

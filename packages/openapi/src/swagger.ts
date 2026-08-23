import { dirname } from 'node:path';

/**
 * Where `swagger-ui-dist` put its files, resolved from the consumer's install.
 * dunx shipped its own explorer until this replaced it. The cost is 1.7 MiB
 * against 434 KiB, 3.7x gzipped, which is why the files are served as two
 * cacheable assets rather than inlined.
 *
 * A `dependency` rather than a peer: nobody imports it, calls it or has a version
 * opinion about it. Resolved lazily on the first request, and cached.
 */
/**
 * The files served out of `swagger-ui-dist`, and their content types. This map is
 * the allow-list, which lets the route be a single wildcard: the package also
 * holds four other builds and 4 MB of sourcemaps.
 *
 * `swagger-ui.css.map` is here because the stylesheet points at it, and without it
 * every consumer with devtools open logs a 404.
 */
const ASSETS = Object.freeze({
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui.css.map': 'application/json; charset=utf-8',
  'favicon-32x32.png': 'image/png',
} as const);

export type SwaggerAsset = keyof typeof ASSETS;

export const isSwaggerAsset = (name: string): name is SwaggerAsset =>
  Object.hasOwn(ASSETS, name);

export const contentTypeOf = (asset: SwaggerAsset): string => ASSETS[asset];

export class SwaggerAssets {
  static #cached: SwaggerAssets | undefined;

  private constructor(
    /** The installed version, used to make `immutable` caching honest. */
    readonly version: string,
    readonly directory: string,
  ) {}

  /** The absolute path of one allow-listed file. */
  pathOf(asset: SwaggerAsset): string {
    return `${this.directory}/${asset}`;
  }

  /**
   * `swagger-ui-dist` has no `exports` map, so its `package.json` is reachable and
   * is the honest anchor: `main` is `index.js`, which is a CommonJS shim, and
   * resolving the asset files directly would work today and break the moment
   * upstream adds an `exports` map.
   */
  static async resolve(): Promise<SwaggerAssets> {
    if (SwaggerAssets.#cached) return SwaggerAssets.#cached;

    let manifestPath: string;
    try {
      manifestPath = Bun.resolveSync(
        'swagger-ui-dist/package.json',
        import.meta.dir,
      );
    } catch {
      // A hard dependency, so this is a broken install rather than a missing
      // opt-in. Say that, instead of telling someone to add what they already have.
      throw new Error(
        'swagger-ui-dist did not resolve from @dunx/openapi. It is a dependency ' +
          'of this package, so this is a broken or partial install rather than ' +
          'something to add: try `bun install`.',
      );
    }

    const root = dirname(manifestPath);
    const { version } = (await Bun.file(manifestPath).json()) as {
      version?: string;
    };

    SwaggerAssets.#cached = new SwaggerAssets(version ?? '0', root);
    return SwaggerAssets.#cached;
  }

  /**
   * The asset URL, with the installed version as a query parameter.
   *
   * A cache key is the whole URL, query included, so this both makes
   * `immutable` truthful and busts the cache on a `swagger-ui-dist` upgrade
   * without the path having to change. `StaticFiles` in `@dunx/http` documents the
   * same constraint: `immutable` is only honest for a name that changes with the
   * bytes.
   */
  href(mounted: string, asset: SwaggerAsset): string {
    return `${mounted}/${asset}?v=${encodeURIComponent(this.version)}`;
  }

  /** Only for tests, which need to observe the absent-package path. */
  static reset(): void {
    SwaggerAssets.#cached = undefined;
  }
}

/** One year, and honest because {@link SwaggerAssets.href} carries the version. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

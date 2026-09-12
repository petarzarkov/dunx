import { IMMUTABLE_CACHE_CONTROL } from '@dunx/http/internal';
import { dirname } from 'node:path';

/**
 * The header every renderer's assets carry, and the same string `StaticFiles`
 * serves a content-addressed file with. Declared once in `@dunx/http` and named
 * here for a renderer of your own, which has no business importing that package's
 * internals.
 */
export const ASSET_CACHE_CONTROL = IMMUTABLE_CACHE_CONTROL;

/** The files one renderer serves out of one npm package. */
export interface AssetPackage {
  /** The package they come from, resolved from the consumer's install. */
  readonly name: string;
  /** Where inside it they live. Absent means the package root. */
  readonly directory?: string;
  /**
   * Served name to content type, and the allow-list with it. One wildcard route
   * is safe over a directory holding other builds and megabytes of sourcemaps
   * only because a name off this list is a 404 rather than a read.
   */
  readonly files: Readonly<Record<string, string>>;
}

const notFound = (): Response => new Response('Not found', { status: 404 });

/**
 * A renderer's static files, resolved from the consumer's own install on first
 * use and cached per package. Both renderers are optional peers, so an app that
 * mounts none resolves none, and one that never opens its page resolves nothing.
 */
export class PackageAssets {
  static readonly #cache = new Map<string, Promise<PackageAssets>>();

  private constructor(
    /** The installed version, which is what makes `immutable` caching honest. */
    readonly version: string,
    readonly directory: string,
    readonly files: Readonly<Record<string, string>>,
  ) {}

  /** The absolute path of one allow-listed file. */
  pathOf(name: string): string {
    return `${this.directory}/${name}`;
  }

  /**
   * The asset URL, with the installed version as a query parameter.
   *
   * A cache key is the whole URL, query included, so this makes `immutable`
   * truthful and busts the cache on an upgrade without the path changing.
   * `StaticFiles` in `@dunx/http` documents the same constraint.
   */
  href(mounted: string, name: string): string {
    return `${mounted}/${name}?v=${encodeURIComponent(this.version)}`;
  }

  /**
   * One allow-listed file straight off disk, or a 404 for any other name.
   *
   * The list is checked against the frozen spec **before** the package is
   * resolved, so a junk name off the wildcard route costs no resolution and
   * answers 404 whether or not the optional peer is installed. `Object.hasOwn`
   * rather than a lookup, so `toString` is a name off the list rather than a
   * function off `Object.prototype`.
   */
  static async serve(pkg: AssetPackage, name: string): Promise<Response> {
    const type = Object.hasOwn(pkg.files, name) ? pkg.files[name] : undefined;
    if (type === undefined) return notFound();

    const assets = await PackageAssets.resolve(pkg);
    return new Response(Bun.file(assets.pathOf(name)), {
      headers: { 'cache-control': ASSET_CACHE_CONTROL, 'content-type': type },
    });
  }

  /**
   * The promise, not its value: a cold page load asks for the shell and every
   * asset at once, and storing the result had each miss and redo the resolve. A
   * rejection evicts, so a peer installed later resolves rather than replaying.
   */
  static resolve(pkg: AssetPackage): Promise<PackageAssets> {
    const cached = PackageAssets.#cache.get(pkg.name);
    if (cached !== undefined) return cached;

    const resolving = PackageAssets.#read(pkg).catch((error: unknown) => {
      PackageAssets.#cache.delete(pkg.name);
      throw error;
    });
    PackageAssets.#cache.set(pkg.name, resolving);
    return resolving;
  }

  /**
   * A package's `package.json` is the honest anchor: it carries the version, and
   * resolving an asset file directly breaks the moment upstream adds an `exports`
   * map. Bun resolves `<package>/package.json` whether or not one is there, which
   * `@scalar/api-reference` needs - see docs/bun-apis.md.
   */
  static async #read(pkg: AssetPackage): Promise<PackageAssets> {
    let manifestPath: string;
    try {
      manifestPath = Bun.resolveSync(
        `${pkg.name}/package.json`,
        import.meta.dir,
      );
    } catch {
      throw new Error(
        `${pkg.name} did not resolve from @dunx/openapi. It is an optional peer ` +
          `dependency of this package, so the app that mounts this renderer ` +
          `installs it: \`bun add ${pkg.name}\`.`,
      );
    }

    const root = dirname(manifestPath);
    const { version } = (await Bun.file(manifestPath).json()) as {
      version?: string;
    };

    return new PackageAssets(
      version ?? '0',
      pkg.directory === undefined ? root : `${root}/${pkg.directory}`,
      pkg.files,
    );
  }

  /** Only for tests, which need to observe the absent-package path. */
  static reset(): void {
    PackageAssets.#cache.clear();
  }
}

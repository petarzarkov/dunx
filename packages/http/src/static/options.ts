export interface StaticOptionsInit {
  /**
   * The directory served. Resolved once, at construction, and every request is
   * checked against it - see `StaticFiles.resolvePath`.
   */
  readonly root: string;
  /**
   * The URL prefix it is served under. `/` serves from the root of the app, which
   * is the usual case for a `public/` directory.
   *
   * @default '/'
   */
  readonly path?: string;
  /**
   * `max-age` in seconds for anything `immutable` does not claim.
   *
   * Deliberately short. A long max-age on a name that can change is a promise the
   * server cannot keep, and the fix - a content hash in the filename - is the
   * thing `immutable` is for.
   *
   * @default 60
   */
  readonly maxAge?: number;
  /**
   * Which paths may be cached forever.
   *
   * Only honest for a **content-addressed** name, where a change produces a
   * different URL: `(path) => /\.[0-9a-f]{8}\.(js|css)$/.test(path)`. The default
   * claims nothing, because guessing wrong here is a stale asset nobody can flush.
   */
  readonly immutable?: (pathname: string) => boolean;
}

/**
 * A class, not an interface, so it is a runtime value and can therefore be a
 * constructor parameter type that `@dunx/transform` records - the same reason
 * `QueueOptions` and `RedisOptions` are classes.
 */
export class StaticOptions {
  readonly root: string;
  readonly path: string;
  readonly maxAge: number;
  readonly immutable: (pathname: string) => boolean;

  constructor(init: StaticOptionsInit) {
    this.root = init.root;
    this.path = normalizePrefix(init.path ?? '/');
    this.maxAge = init.maxAge ?? 60;
    this.immutable = init.immutable ?? (() => false);
  }
}

/** A leading slash and no trailing one, so `${path}/x` is never `//x`. */
export const normalizePrefix = (path: string): string => {
  const trimmed = path.split('/').filter(Boolean).join('/');
  return trimmed === '' ? '/' : `/${trimmed}`;
};

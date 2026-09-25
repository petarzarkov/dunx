import { AppError } from '@dunx/core';
import { meta, metaKey, type MetaKey } from './metadata.js';

/**
 * Served under no version whatever `defaultVersion` says. Health probes, the
 * API explorer and the auth mount declare it, as Nest's `VERSION_NEUTRAL` does.
 */
export const VERSION_NEUTRAL: unique symbol = Symbol.for(
  'dunx.version.neutral',
);

/** One version, several, or {@link VERSION_NEUTRAL}. */
export type RouteVersion = string | readonly string[] | typeof VERSION_NEUTRAL;

/** What `@Version` wrote on a handler. The controller's is on its options. */
export const VERSION: MetaKey<RouteVersion> = metaKey('version');

/** A handler's version, which replaces its controller's. */
export const Version =
  (version: RouteVersion) =>
  <F extends object>(target: F, _context: ClassMethodDecoratorContext): F =>
    meta(VERSION, version)(target);

interface VersioningBase {
  /** The version of a route that declares none. Absent leaves it unversioned. */
  readonly defaultVersion?: string | readonly string[];
}

/**
 * `@Controller('users', { version: '1' })` is served at `/v1/users`, under the
 * global prefix when there is one. Each version is its own route key.
 */
export interface UriVersioning extends VersioningBase {
  readonly type: 'uri';
  /** Put before the version in the path segment. @default 'v' */
  readonly prefix?: string;
}

/** The version is the value of one request header, as Nest's `header`. */
export interface HeaderVersioning extends VersioningBase {
  readonly type: 'header';
  /** For example `'X-API-Version'`. Matched case-insensitively. */
  readonly header: string;
}

/**
 * The version is an `Accept` parameter, as Nest's `key`:
 * `key: 'v='` reads `2` out of `Accept: application/json;v=2`.
 */
export interface MediaTypeVersioning extends VersioningBase {
  readonly type: 'media-type';
  readonly key: string;
}

export type VersioningOptions =
  | UriVersioning
  | HeaderVersioning
  | MediaTypeVersioning;

const listOf = (version: string | readonly string[]): readonly string[] =>
  typeof version === 'string' ? [version] : version;

const assertSegment = (value: string, what: string): void => {
  if (value.includes('/')) {
    throw new AppError(
      `${what} "${value}" contains a /. It is one path segment.`,
    );
  }
};

const assertNamed = (value: unknown, what: string): void => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`${what} is required and cannot be empty.`);
  }
};

/**
 * The first `;`-parameter of any media range in `Accept` starting with `key`,
 * which is lower-cased: a parameter name is case-insensitive (RFC 9110 section
 * 5.6.6), its value is not.
 */
const mediaTypeVersion = (
  accept: string | null,
  key: string,
): string | undefined => {
  if (accept === null) return undefined;
  for (const range of accept.split(',')) {
    const params = range.split(';');
    for (let at = 1; at < params.length; at++) {
      const param = params[at]!.trim();
      if (param.slice(0, key.length).toLowerCase() === key) {
        return param.slice(key.length);
      }
    }
  }
  return undefined;
};

/** RFC 9110 section 5.6.2's `token`, which a field name is. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Numeric where both are, so `10` sorts after `9`; code-unit order otherwise. */
export const compareVersions = (left: string, right: string): number => {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Which versions each route is served under, and how a request names one.
 * Bound by `HttpFactory` from `HttpOptions.versioning`; `@dunx/openapi` and
 * `@dunx/dashboard` inject the same instance.
 */
export class RouteVersioning {
  #options: VersioningOptions | undefined;
  /** The media-type `key`, lower-cased once. */
  #key = '';

  /**
   * `undefined` is versioning off. A static factory rather than a constructor
   * parameter, so a container with no `HttpFactory` can still self-bind it.
   */
  static of(options?: VersioningOptions): RouteVersioning {
    const versioning = new RouteVersioning();
    if (options !== undefined) {
      const type = (options as { type: unknown }).type;
      if (type === 'uri') {
        assertSegment(
          (options as UriVersioning).prefix ?? '',
          'versioning.prefix',
        );
      } else if (type === 'header') {
        const name = (options as HeaderVersioning).header;
        assertNamed(name, 'versioning.header');
        if (!TOKEN.test(name)) {
          throw new AppError(
            `versioning.header "${name}" is not a valid header name.`,
          );
        }
      } else if (type === 'media-type') {
        assertNamed((options as MediaTypeVersioning).key, 'versioning.key');
      } else {
        throw new AppError(
          `versioning.type "${String(type)}" is not supported. Use 'uri', ` +
            "'header' or 'media-type'.",
        );
      }
      const defaults: unknown = options.defaultVersion ?? [];
      const listed: readonly unknown[] = Array.isArray(defaults)
        ? defaults
        : [defaults];
      for (const version of listed) {
        if (typeof version !== 'string' || version === '') {
          throw new AppError(
            'versioning.defaultVersion must be non-empty strings.',
          );
        }
        assertSegment(version, 'versioning.defaultVersion');
      }
    }
    versioning.#options = options;
    if (options?.type === 'media-type') {
      versioning.#key = options.key.toLowerCase();
    }
    return versioning;
  }

  get enabled(): boolean {
    return this.#options !== undefined;
  }

  /** `undefined` when versioning is off. */
  get type(): VersioningOptions['type'] | undefined {
    return this.#options?.type;
  }

  /** The `defaultVersion` list, empty when there is none. */
  get defaults(): readonly string[] {
    return listOf(this.#options?.defaultVersion ?? []);
  }

  /**
   * The header a header or media-type version is read from: the one to name in
   * `Vary`. `undefined` for URI versioning, where the path varies instead.
   */
  get header(): string | undefined {
    const options = this.#options;
    if (options?.type === 'header') return options.header;
    return options?.type === 'media-type' ? 'Accept' : undefined;
  }

  /** The version a request names, for header and media-type versioning. */
  requested(req: Request): string | undefined {
    const options = this.#options;
    // An empty value names no version, the same as an absent one.
    if (options?.type === 'header') {
      return req.headers.get(options.header) || undefined;
    }
    if (options?.type === 'media-type') {
      return (
        mediaTypeVersion(req.headers.get('accept'), this.#key) || undefined
      );
    }
    return undefined;
  }
  /**
   * The versions a route is served under, empty for none. A declared version
   * expands whether or not versioning is on, so a reader with no options still
   * lists `/v1/...`; `HttpFactory` refuses to serve it unless it is on.
   */
  versionsOf(
    declared: RouteVersion | undefined,
    where: string,
  ): readonly string[] {
    if (declared === VERSION_NEUTRAL) return [];
    if (declared === undefined)
      return listOf(this.#options?.defaultVersion ?? []);
    const versions = listOf(declared);
    if (versions.length === 0 || versions.some((version) => version === '')) {
      throw new AppError(
        `${where} declares an empty version. Name one, or use VERSION_NEUTRAL.`,
      );
    }
    for (const version of versions) assertSegment(version, `${where} version`);
    return versions;
  }

  /**
   * The path segment version `1` is served under, `v1`. `undefined` for header
   * and media-type versioning, where every version shares the path.
   */
  segmentOf(version: string): string | undefined {
    const options = this.#options;
    if (options !== undefined && options.type !== 'uri') return undefined;
    return `${options?.prefix ?? 'v'}${version}`;
  }
}

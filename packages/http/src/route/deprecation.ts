import { AppError } from '@dunx/core';
import { withResponseStamp, type ServedHandler } from '../server/middleware.js';
import {
  setAbsentHeaders,
  type HeaderPairs,
} from '../server/security-headers.js';
import { meta, metaKey, type MetaKey } from './metadata.js';

export interface DeprecationOptions {
  /**
   * When the route was, or will be, deprecated. RFC 9745 requires a date in
   * `Deprecation`, so there is no default. A string is read by `new Date()`.
   */
  readonly since: string | Date;
  /** When it stops answering, sent as `Sunset` (RFC 8594). Not before `since`. */
  readonly sunset?: string | Date;
  /** A page for humans about the deprecation, sent as `Link; rel="deprecation"`. */
  readonly link?: string;
}

/** {@link DeprecationOptions} with the dates parsed. */
export interface Deprecation {
  readonly since: Date;
  readonly sunset?: Date;
  readonly link?: string;
}

export const DEPRECATED: MetaKey<Deprecation> = metaKey('deprecated');

const dateOf = (value: string | Date, field: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(
      `@Deprecated ${field} "${String(value)}" is not a date.`,
    );
  }
  return date;
};

/**
 * Marks a handler or a whole controller deprecated. Its responses carry
 * `Deprecation` and, when given, `Sunset` and a `Link`; `@dunx/openapi` marks
 * the operation `deprecated`. A handler's replaces its controller's.
 */
export const Deprecated = (options: DeprecationOptions) => {
  const since = dateOf(options.since, 'since');
  const sunset =
    options.sunset === undefined ? undefined : dateOf(options.sunset, 'sunset');
  // RFC 9745 section 4.
  if (sunset !== undefined && sunset < since) {
    throw new AppError(
      `@Deprecated sunset ${sunset.toISOString()} is before since ` +
        `${since.toISOString()}. RFC 9745 requires it not to be.`,
    );
  }
  const link = options.link;
  if (link !== undefined && !URL.canParse(link, 'http://relative.invalid')) {
    throw new AppError(`@Deprecated link "${link}" is not a URL.`);
  }
  return meta(DEPRECATED, {
    since,
    ...(sunset !== undefined && { sunset }),
    ...(link !== undefined && { link }),
  });
};

/**
 * RFC 9745 `Deprecation` is a Structured Field Date, `@` and Unix seconds;
 * RFC 8594 `Sunset` is an HTTP-date, which `toUTCString` writes.
 */
const headerPairs = (deprecation: Deprecation): HeaderPairs => [
  ['deprecation', `@${Math.floor(deprecation.since.getTime() / 1000)}`],
  ...(deprecation.sunset === undefined
    ? []
    : [['sunset', deprecation.sunset.toUTCString()] as const]),
];

/**
 * Wraps a deprecated route's table entry at boot. The two dates are set only
 * where absent; the `Link` is appended, so a handler's own `Link` keeps it.
 */
export const withDeprecation = (
  deprecation: Deprecation,
  handler: ServedHandler,
): ServedHandler => {
  const pairs = headerPairs(deprecation);
  const link =
    deprecation.link === undefined
      ? undefined
      : `<${deprecation.link}>; rel="deprecation"; type="text/html"`;
  return withResponseStamp((response) => {
    setAbsentHeaders(response, pairs);
    if (link !== undefined) response.headers.append('link', link);
    return response;
  }, handler);
};

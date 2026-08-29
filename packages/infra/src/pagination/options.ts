import { AppError } from '@dunx/core';

/**
 * Frozen objects plus an indexed-access union, not `enum` - `dunx/no-enum` rejects
 * one, because an enum is the single TS construct that cannot be erased. The
 * reference this was ported from used two enums. One name serves as both the value
 * and the type.
 */
export const PaginationOrder = Object.freeze({
  ASC: 'asc',
  DESC: 'desc',
} as const);
export type PaginationOrder =
  (typeof PaginationOrder)[keyof typeof PaginationOrder];

export const PaginationDirection = Object.freeze({
  FORWARD: 'forward',
  BACKWARD: 'backward',
} as const);
export type PaginationDirection =
  (typeof PaginationDirection)[keyof typeof PaginationDirection];

/** The bounds `parsePageOptions` enforces. Exported so a route can state them. */
export const PAGINATION = Object.freeze({
  MIN_TAKE: 1,
  MAX_TAKE: 100,
  DEFAULT_TAKE: 20,
  DEFAULT_ORDER: PaginationOrder.DESC,
  DEFAULT_DIRECTION: PaginationDirection.FORWARD,
  /** A cursor longer than this never came from `encodeCursor`. */
  MAX_CURSOR: 512,
  MAX_SEARCH: 256,
} as const);

export interface PageOptions {
  readonly take: number;
  readonly order: PaginationOrder;
  readonly direction: PaginationDirection;
  /**
   * Omit for the first page.
   *
   * `| undefined` is stated rather than left to the `?`, because under
   * `exactOptionalPropertyTypes` those are different types and the common caller is
   * a zod schema: `z.string().optional()` infers `cursor?: string | undefined`, so
   * without this every route would have to strip the key before calling.
   */
  readonly cursor?: string | undefined;
  readonly search?: string | undefined;
}

export class PageOptionsError extends AppError {
  override readonly name = 'PageOptionsError';
  /** Page parameters the caller sent and got wrong. See {@link CursorError}. */
  override readonly status = 400;
}

const one = (value: unknown): string | undefined => {
  // A query string can repeat a key. The first wins, matching how a route's own
  // parser reads `?take=1&take=2`, rather than silently concatenating them.
  if (Array.isArray(value)) return one(value[0]);
  return typeof value === 'string' ? value : undefined;
};

const enumOf = <T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T => {
  if (raw === undefined) return fallback;
  const found = allowed.find((value) => value === raw.toLowerCase());
  if (found === undefined) {
    throw new PageOptionsError(
      `${field} must be one of ${allowed.join(', ')}; got "${raw}".`,
    );
  }
  return found;
};

/**
 * Validates raw query values into `PageOptions`, applying the defaults.
 *
 * Hand-written rather than a shipped zod schema: route validation targets Standard
 * Schema, so shipping one would pick the validator for the app. An app that wants
 * a schema builds one from `PAGINATION`, and gets the OpenAPI document with it:
 *
 * ```ts
 * const pageQuery = z.object({
 *   take: z.coerce.number().int().min(PAGINATION.MIN_TAKE).max(PAGINATION.MAX_TAKE)
 *     .default(PAGINATION.DEFAULT_TAKE),
 *   cursor: z.string().max(PAGINATION.MAX_CURSOR).optional(),
 * });
 * ```
 */
export const parsePageOptions = (
  query: Readonly<Record<string, unknown>> | URLSearchParams = {},
): PageOptions => {
  const read = (key: string): string | undefined =>
    query instanceof URLSearchParams
      ? (query.get(key) ?? undefined)
      : one((query as Record<string, unknown>)[key]);

  const rawTake = read('take');
  const take =
    rawTake === undefined ? PAGINATION.DEFAULT_TAKE : Number(rawTake);
  if (
    !Number.isInteger(take) ||
    take < PAGINATION.MIN_TAKE ||
    take > PAGINATION.MAX_TAKE
  ) {
    throw new PageOptionsError(
      `take must be an integer between ${PAGINATION.MIN_TAKE} and ` +
        `${PAGINATION.MAX_TAKE}; got "${rawTake}".`,
    );
  }

  const cursor = read('cursor');
  if (cursor !== undefined && cursor.length > PAGINATION.MAX_CURSOR) {
    throw new PageOptionsError(
      `cursor is longer than ${PAGINATION.MAX_CURSOR} characters.`,
    );
  }

  const search = read('search');
  if (search !== undefined && search.length > PAGINATION.MAX_SEARCH) {
    throw new PageOptionsError(
      `search is longer than ${PAGINATION.MAX_SEARCH} characters.`,
    );
  }

  return {
    take,
    order: enumOf(
      read('order'),
      Object.values(PaginationOrder),
      PAGINATION.DEFAULT_ORDER,
      'order',
    ),
    direction: enumOf(
      read('direction'),
      Object.values(PaginationDirection),
      PAGINATION.DEFAULT_DIRECTION,
      'direction',
    ),
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
    ...(search === undefined || search === '' ? {} : { search }),
  };
};

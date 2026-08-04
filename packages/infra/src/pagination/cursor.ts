import { AppError } from '@dunx/core';

/**
 * Keyset pagination, cursor half.
 *
 * A cursor is an opaque base64url token carrying the sort value and the row id of
 * the row it points at - the two things a keyset query needs to resume exactly
 * where it left off. Opaque on purpose: a client that parses it has coupled itself
 * to the sort column, and changing the sort would then be a breaking change.
 *
 * `base64url` rather than `base64`, because the token travels in a query string and
 * `+` and `/` need escaping there.
 */
export interface CursorPayload {
  /** The sort column's value, as an ISO string for a date or a plain string. */
  readonly s: string;
  /** The row's id, which breaks ties when two rows share a sort value. */
  readonly i: string;
}

/**
 * Raised for a cursor that does not decode. Extends `AppError`, not an HTTP error:
 * `@dunx/infra` must not depend on the web layer, and a bad cursor is the caller's
 * to map - usually to a 400.
 *
 * ```ts
 * catch (error) {
 *   if (error instanceof CursorError) throw new HttpError(400, error.message);
 *   throw error;
 * }
 * ```
 */
export class CursorError extends AppError {
  override readonly name = 'CursorError';
}

export const encodeCursor = (
  sortValue: Date | string | number,
  id: string,
): string => {
  const payload: CursorPayload = {
    s: sortValue instanceof Date ? sortValue.toISOString() : String(sortValue),
    i: id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

/**
 * Decodes a cursor, or throws.
 *
 * Every failure mode collapses to one error deliberately: a token that is not
 * base64, is not JSON, or is JSON of the wrong shape are all the same thing to a
 * caller - a cursor that did not come from `encodeCursor` - and distinguishing them
 * only tells an attacker which layer rejected their input.
 *
 * The id is checked for being a non-empty string and nothing more. The
 * implementation this was ported from required a UUID, which silently breaks
 * keyset pagination over any table with a serial or a composite id.
 */
export const decodeCursor = (cursor: string): CursorPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    throw new CursorError('Invalid pagination cursor.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).s !== 'string' ||
    typeof (parsed as CursorPayload).i !== 'string' ||
    (parsed as CursorPayload).i === ''
  ) {
    throw new CursorError('Invalid pagination cursor.');
  }

  return { s: (parsed as CursorPayload).s, i: (parsed as CursorPayload).i };
};

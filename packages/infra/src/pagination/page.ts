/**
 * The response envelope. Plain interfaces, not classes: the reference this was
 * ported from used `PageDto`/`PageMetaDto` classes carrying `@ApiProperty`
 * decorators, which dunx does not need - `@dunx/openapi` derives the document from
 * the route's own response schema, so a class whose only job is to hold decorators
 * has nothing to do here.
 */
export interface PageMeta {
  readonly take: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  /** Pass back as `?cursor=` to read forwards. Null at the end. */
  readonly nextCursor: string | null;
  /** Pass back with `?direction=backward`. Null at the start. */
  readonly previousCursor: string | null;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

/**
 * Builds the envelope, minting each cursor only when there is a page in that
 * direction to reach - a `nextCursor` on the last page is a token that returns
 * nothing, which reads as "there is more" to any client that checks for null.
 */
export const pageOf = <T>(
  rows: readonly T[],
  meta: {
    readonly take: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly cursorOf: (row: T) => string;
  },
): Page<T> => {
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    data: rows,
    meta: {
      take: meta.take,
      hasNextPage: meta.hasNextPage,
      hasPreviousPage: meta.hasPreviousPage,
      nextCursor:
        meta.hasNextPage && last !== undefined ? meta.cursorOf(last) : null,
      previousCursor:
        meta.hasPreviousPage && first !== undefined
          ? meta.cursorOf(first)
          : null,
    },
  };
};

/**
 * `@dunx/infra/pagination/cursor` - the half that needs no database, for an app
 * paginating something that is not a drizzle table. `paginate` imports drizzle
 * at module scope and drizzle is an optional peer, so the root barrel does not
 * resolve without it.
 *
 * A lazy import there would have avoided this subpath, but `paginate` has a
 * synchronous overload and `await import()` would make every call async.
 */
export {
  CursorError,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from './cursor.js';
export {
  PAGINATION,
  PageOptionsError,
  PaginationDirection,
  PaginationOrder,
  parsePageOptions,
  type PageOptions,
} from './options.js';
export { pageOf, type Page, type PageMeta } from './page.js';

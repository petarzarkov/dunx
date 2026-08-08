/**
 * What a value means, as a Mantine colour name.
 *
 * These are the mappings a reader learns once and then relies on everywhere: a
 * green POST in the API explorer has to be a green POST in the dashboard's route
 * table, or the two pages are teaching different vocabularies for the same data.
 * They were the explorer's, declared in its `model.ts`; here so a second page
 * cannot pick its own.
 */

/**
 * Keyed by lowercase verb and typed as a plain string map **on purpose**.
 *
 * The five methods are already declared twice for good reasons - `HttpMethod` in
 * `@dunx/http` is what a route may be, `OperationKey` in `@dunx/openapi` is what a
 * document may hold - and a third union here would only exist to be converted to
 * and from the other two. `methodColor` takes a string, which is what both sides
 * already have, and answers for a verb neither of them models.
 */
export const METHOD_COLOR: Readonly<Record<string, string>> = {
  get: 'blue',
  post: 'green',
  put: 'orange',
  patch: 'grape',
  delete: 'red',
};

/** Anything outside the five - HEAD, OPTIONS, or a verb from a route table. */
export const methodColor = (method: string): string =>
  METHOD_COLOR[method.toLowerCase()] ?? 'gray';

/** The colour a status code reads as, so a 500 is never mistaken for a 200. */
export const statusColor = (status: string | number): string => {
  const code =
    typeof status === 'number' ? status : Number.parseInt(status, 10);
  if (Number.isNaN(code)) return 'gray';
  if (code < 300) return 'green';
  if (code < 400) return 'cyan';
  if (code < 500) return 'orange';
  return 'red';
};

/**
 * bullmq's job states, keyed by its own names - `waiting-children` and
 * `prioritized` are not tidied, because a state the library reports under one name
 * and a page shows under another cannot be matched against `redis-cli`.
 *
 * A map, not a union, for the same reason `METHOD_COLOR` is: `@dunx/dashboard`
 * already declares the canonical list, this package must not know that package
 * exists, and a second union here would only ever be converted to and from it.
 * `jobStateColor` answers for a state a future bullmq adds.
 */
export const JOB_STATE_COLOR: Readonly<Record<string, string>> = {
  active: 'blue',
  waiting: 'gray',
  prioritized: 'violet',
  delayed: 'yellow',
  completed: 'green',
  failed: 'red',
  paused: 'orange',
  'waiting-children': 'cyan',
};

export const jobStateColor = (state: string): string =>
  JOB_STATE_COLOR[state] ?? 'gray';

/** Three states, because "we could not tell" is not the same as "it is down". */
export type HealthState = 'up' | 'down' | 'unknown';

export const HEALTH_COLOR: Readonly<Record<HealthState, string>> = {
  up: 'green',
  down: 'red',
  unknown: 'gray',
};

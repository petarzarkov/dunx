/**
 * What a value means, as a Mantine colour name.
 *
 * These are the mappings a reader learns once and then relies on everywhere: a
 * green POST in the dashboard's route table has to stay green wherever a second
 * page renders the same verb. They were the API explorer's, declared in its
 * `model.ts`; here so a second page cannot pick its own.
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

/** Three states, because "we could not tell" is not the same as "it is down". */
export type HealthState = 'up' | 'down' | 'unknown';

export const HEALTH_COLOR: Readonly<Record<HealthState, string>> = {
  up: 'green',
  down: 'red',
  unknown: 'gray',
};

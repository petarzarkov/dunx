import type { BunRequest } from 'bun';

/**
 * What an {@link Authorize} answers. `true` passes and `false` refuses with a
 * 404; a `Response` refuses with itself, which is what a browser needs - it
 * arrives with a cookie and no way to attach a bearer token.
 */
export type AuthorizeDecision = boolean | Response;

/**
 * Decides whether a request may see an ops surface at all - the dashboard page,
 * the OpenAPI explorer. Both sit outside the app's session guard, so this gets
 * the raw `BunRequest` and asks the auth library itself. Refusal is 404, not 403.
 */
export type Authorize = (
  req: BunRequest,
) => AuthorizeDecision | Promise<AuthorizeDecision>;

/** Runs the gate: `undefined` to carry on, or the response to answer with. */
export const gate = async (
  authorize: Authorize | undefined,
  req: BunRequest,
): Promise<Response | undefined> => {
  if (authorize === undefined) return undefined;
  const decision = await authorize(req);
  if (decision === true) return undefined;
  // The body an unmatched path already gets: a surface that announces itself
  // has told a prober where to keep knocking.
  return decision === false
    ? Response.json({ error: 'NOT_FOUND', status: 404 }, { status: 404 })
    : decision;
};

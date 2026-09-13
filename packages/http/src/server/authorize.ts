import type { BunRequest } from 'bun';

/**
 * What an {@link Authorize} answers. `true` passes and `false` refuses with a
 * 404; a `Response` refuses with itself, which is what a browser needs.
 */
export type AuthorizeDecision = boolean | Response;

/**
 * Decides whether a request may see an ops surface at all - the dashboard page,
 * the OpenAPI explorer. Both sit outside the app's session guard, so this gets
 * the raw `BunRequest` and asks the auth library. Refusal is 404, not 403.
 */
export type Authorize = (
  req: BunRequest,
) => AuthorizeDecision | Promise<AuthorizeDecision>;

/**
 * Runs the gate: `undefined` to carry on, or the response to answer with. Only
 * `true` admits and only a `Response` replaces the refusal, so an `authorize`
 * that falls off the end of a branch closes rather than opens.
 */
export const gate = async (
  authorize: Authorize | undefined,
  req: BunRequest,
): Promise<Response | undefined> => {
  if (authorize === undefined) return undefined;
  const decision = await authorize(req);
  if (decision === true) return undefined;
  if (decision instanceof Response) return decision;
  // The body an unmatched path already gets: announcing itself would tell a
  // prober where to keep knocking.
  return Response.json({ error: 'NOT_FOUND', status: 404 }, { status: 404 });
};

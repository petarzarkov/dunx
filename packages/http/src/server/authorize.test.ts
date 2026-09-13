import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { gate, type Authorize } from './authorize.js';

const req = (headers: Record<string, string> = {}): BunRequest =>
  new Request('http://localhost/_dunx', { headers }) as BunRequest;

describe('gate', () => {
  it('carries on when there is no gate at all', async () => {
    expect(await gate(undefined, req())).toBeUndefined();
  });

  it('carries on when the gate says true', async () => {
    expect(await gate(() => true, req())).toBeUndefined();
  });

  it('answers 404 when the gate says false', async () => {
    const refused = await gate(() => false, req());
    expect(refused?.status).toBe(404);
    // Byte for byte what an unmatched path already answers, which is the point:
    // a refusal must be indistinguishable from a mount that is not there.
    expect(await refused?.json()).toEqual({ error: 'NOT_FOUND', status: 404 });
  });

  it('sends the gate’s own response when it returned one', async () => {
    const challenge: Authorize = () => new Response('sign in', { status: 401 });
    const refused = await gate(challenge, req());
    expect(refused?.status).toBe(401);
    expect(await refused?.text()).toBe('sign in');
  });

  /**
   * The types forbid it, so this is about the consumer who compiled without
   * them: an `authorize` whose last branch falls off the end resolves to
   * `undefined`, and a gate that read that as consent would serve the page.
   */
  it('refuses anything that is not true and not a Response', async () => {
    for (const decision of [undefined, null, 0, '', 'yes', {}]) {
      const refused = await gate(() => decision as unknown as boolean, req());
      expect(refused?.status).toBe(404);
    }
  });

  it('awaits a gate that has to ask an auth library', async () => {
    const authorize: Authorize = async (request) =>
      request.headers.get('x-token') === 'ok';
    expect(await gate(authorize, req({ 'x-token': 'ok' }))).toBeUndefined();
    expect((await gate(authorize, req()))?.status).toBe(404);
  });
});

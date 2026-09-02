import { AsyncRequestContext } from '@dunx/core';
import { HttpError, mergeMeta, Public, Roles } from '@dunx/http';
import { buildContext, type DiscoveredRoute } from '@dunx/http/internal';
import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import type { Auth, Principal } from './auth.js';
import { AuthContext } from './context.js';
import { rolesOf, SessionGuard } from './guard.js';

const principal = (role?: unknown): Principal =>
  ({
    session: { id: 's', token: 't', userId: 'u' },
    user: {
      id: 'u',
      email: 'ada@example.com',
      ...(role === undefined ? {} : { role }),
    },
  }) as unknown as Principal;

/** Only `api.getSession` is reached, so only `api.getSession` is stood up. */
const stub = (resolve: Principal | null): Auth =>
  ({ api: { getSession: async () => resolve } }) as unknown as Auth;

const guardFor = (
  resolve: Principal | null,
): { guard: SessionGuard; context: AuthContext } => {
  const context = new AuthContext(new AsyncRequestContext());
  return { guard: new SessionGuard(stub(resolve), context), context };
};

const request = () => new Request('http://test/x') as BunRequest;

const contextFor = (...decorated: readonly object[]) => {
  const route: DiscoveredRoute = {
    method: 'GET',
    path: '/x',
    controller: 'XController',
    handlerName: 'handle',
    handler: () => undefined,
    meta: mergeMeta(...decorated),
  };
  return buildContext(route);
};

const publicRoute = () => contextFor(Public()({}));
const rolesRoute = (...roles: readonly string[]) =>
  contextFor(Roles(...roles)({}));

const ok = () => Promise.resolve(new Response('ok'));

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the guard to reject');
};

describe('rolesOf', () => {
  it('splits the admin plugin’s comma-separated column', () => {
    expect(rolesOf({ role: 'admin,user' })).toEqual(['admin', 'user']);
    expect(rolesOf({ role: ' admin , user ' })).toEqual(['admin', 'user']);
  });

  it('takes an array as it stands, and drops non-strings', () => {
    expect(rolesOf({ role: ['admin', 7, 'user'] })).toEqual(['admin', 'user']);
  });

  it('reads a user with no role as no roles rather than throwing', () => {
    expect(rolesOf({})).toEqual([]);
    expect(rolesOf({ role: null })).toEqual([]);
    expect(rolesOf({ role: '' })).toEqual([]);
    expect(rolesOf({ role: 7 })).toEqual([]);
  });
});

describe('SessionGuard', () => {
  it('passes a @Public route through without looking a session up', async () => {
    let asked = false;
    const context = new AuthContext(new AsyncRequestContext());
    const auth = {
      api: {
        getSession: async () => {
          asked = true;
          return null;
        },
      },
    } as unknown as Auth;

    const response = await new SessionGuard(auth, context).handle(
      request(),
      publicRoute(),
      ok,
    );
    expect(response.status).toBe(200);
    expect(asked).toBe(false);
  });

  it('401s when better-auth resolves no session', async () => {
    const { guard } = guardFor(null);
    const error = await rejection(() =>
      guard.handle(request(), contextFor(), ok),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).message).toBe('UNAUTHENTICATED');
  });

  it('puts the principal where a handler can reach it', async () => {
    const caller = principal();
    const { guard, context } = guardFor(caller);
    let seen: Principal | undefined;

    await guard.handle(request(), contextFor(), () => {
      seen = context.current();
      return ok();
    });
    expect(seen).toBe(caller);
    // The scope closes with the request - nothing leaks to the next one.
    expect(context.current()).toBeUndefined();
  });

  it('403s when @Roles is not held, and passes when it is', async () => {
    const denied = guardFor(principal('user'));
    const error = await rejection(() =>
      denied.guard.handle(request(), rolesRoute('admin'), ok),
    );
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toBe('Requires one of: admin');

    const allowed = guardFor(principal('admin,user'));
    const response = await allowed.guard.handle(
      request(),
      rolesRoute('admin'),
      ok,
    );
    expect(response.status).toBe(200);
  });

  it('ignores an empty @Roles list', async () => {
    const { guard } = guardFor(principal());
    const response = await guard.handle(request(), rolesRoute(), ok);
    expect(response.status).toBe(200);
  });
});

describe('AuthContext', () => {
  it('require() throws a 401 with no caller and returns one with', async () => {
    const context = new AuthContext(new AsyncRequestContext());
    expect(() => context.require()).toThrow(HttpError);

    const caller = principal();
    context.run(caller, () => {
      expect(context.require()).toBe(caller);
    });
  });

  it('writes userId into RequestContext so log lines carry it', () => {
    const requests = new AsyncRequestContext();
    const context = new AuthContext(requests);

    requests.runWithContext({ traceId: 'r1' }, () => {
      context.run(principal(), () => {
        expect(requests.getContext()).toEqual({ traceId: 'r1', userId: 'u' });
      });
    });
  });

  it('survives an await inside the scope', async () => {
    const context = new AuthContext(new AsyncRequestContext());
    const caller = principal();

    await context.run(caller, async () => {
      await Bun.sleep(1);
      expect(context.current()).toBe(caller);
    });
  });
});

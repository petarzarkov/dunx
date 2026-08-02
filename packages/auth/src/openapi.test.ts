import { describe, expect, it } from 'bun:test';
import { betterAuthDocument } from './openapi.js';

const schema = {
  paths: {
    '/sign-in/email': { post: { summary: 'Sign in' } },
    '/session': { get: { summary: 'Session' }, delete: { summary: 'Revoke' } },
  },
  components: { schemas: { Session: { type: 'object' } } },
};

const authWith = (generate: unknown) =>
  ({ api: generate as never }) as Parameters<typeof betterAuthDocument>[0];

describe('betterAuthDocument', () => {
  it('mounts every path under the basePath and tags the operations', async () => {
    const fragment = await betterAuthDocument(
      authWith({ generateOpenAPISchema: async () => schema }),
      { basePath: '/api/auth' },
    )();

    expect(Object.keys(fragment.paths).sort()).toEqual([
      '/api/auth/session',
      '/api/auth/sign-in/email',
    ]);
    // Every method on a path item, not just the first.
    const session = fragment.paths['/api/auth/session'] as Record<
      string,
      { tags?: string[] }
    >;
    expect(session['get']?.tags).toEqual(['auth']);
    expect(session['delete']?.tags).toEqual(['auth']);
    expect(fragment.schemas).toEqual({ Session: { type: 'object' } });
    expect(fragment.tags[0]?.name).toBe('auth');
  });

  it('does not double the prefix on a path that already carries it', async () => {
    const fragment = await betterAuthDocument(
      authWith({
        generateOpenAPISchema: async () => ({
          paths: { '/api/auth/session': { get: {} } },
        }),
      }),
      { basePath: '/api/auth' },
    )();

    expect(Object.keys(fragment.paths)).toEqual(['/api/auth/session']);
  });

  it('contributes nothing when the openAPI plugin is not enabled', async () => {
    // Better Auth only defines generateOpenAPISchema with the plugin on. A
    // missing plugin should cost documentation, never the boot.
    const fragment = await betterAuthDocument(authWith({}), {
      basePath: '/api/auth',
    })();

    expect(fragment).toEqual({ paths: {}, schemas: {}, tags: [] });
  });

  // Uncast on purpose. `authWith` goes through `as never`, so every other test
  // here would still pass if the parameter type rejected a real instance - and
  // it did: an all-optional interface is a weak type, and TypeScript refuses an
  // argument sharing no property with it. An instance built without the plugin
  // is exactly that, so the case above was documented, tested, and impossible to
  // write. This is a compile-time assertion; the runtime expectation is the one
  // above.
  it('accepts an instance whose api has no generateOpenAPISchema', async () => {
    const auth = {
      api: {
        signInEmail: async () => ({ token: 't' }),
        getSession: async () => null,
      },
    };

    const fragment = await betterAuthDocument(auth, {
      basePath: '/api/auth',
    })();

    expect(fragment.paths).toEqual({});
  });

  it('honours a custom tag', async () => {
    const fragment = await betterAuthDocument(
      authWith({
        generateOpenAPISchema: async () => ({ paths: { '/x': { get: {} } } }),
      }),
      { basePath: '/auth', tag: 'identity' },
    )();

    const op = (
      fragment.paths['/auth/x'] as Record<string, { tags?: string[] }>
    )['get'];
    expect(op?.tags).toEqual(['identity']);
    expect(fragment.tags[0]?.name).toBe('identity');
  });
});

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

import type { BetterAuthOptions } from 'better-auth';
import { describe, expect, it } from 'bun:test';
import { AuthError } from './errors.js';
import {
  AuthOptions,
  DEFAULT_BASE_PATH,
  normalizeBasePath,
} from './options.js';
import { bunPassword } from './password.js';

describe('normalizeBasePath', () => {
  it('gives one leading slash and no trailing one', () => {
    expect(normalizeBasePath('api/auth')).toBe('/api/auth');
    expect(normalizeBasePath('/api/auth/')).toBe('/api/auth');
    expect(normalizeBasePath('//api//auth//')).toBe('/api/auth');
  });

  it('rejects the root, which would claim every route in the app', () => {
    expect(() => normalizeBasePath('/')).toThrow(AuthError);
    expect(() => normalizeBasePath('')).toThrow(/claim every route/);
  });
});

describe('AuthOptions', () => {
  it('defaults the basePath and writes it back, so better-auth agrees with the mount', () => {
    const resolved = new AuthOptions<BetterAuthOptions>({ secret: 's' });
    expect(resolved.basePath).toBe(DEFAULT_BASE_PATH);
    expect(resolved.options.basePath).toBe(DEFAULT_BASE_PATH);
  });

  it('normalizes a basePath the app declared', () => {
    const resolved = new AuthOptions({ secret: 's', basePath: 'auth/' });
    expect(resolved.basePath).toBe('/auth');
    expect(resolved.options.basePath).toBe('/auth');
  });

  it('mounts at basePath unless told otherwise', () => {
    const plain = new AuthOptions({ secret: 's', basePath: '/identity' });
    expect(plain.mountAt).toBe('/identity');
    expect(plain.basePath).toBe('/identity');
  });

  it('keeps the mount path and basePath apart under a global prefix', () => {
    // `setGlobalPrefix('api')` turns the `/auth` route into `/api/auth`, which is
    // the pathname better-auth then has to match.
    const prefixed = new AuthOptions(
      { secret: 's', basePath: '/api/auth' },
      'auth/',
    );
    expect(prefixed.mountAt).toBe('/auth');
    expect(prefixed.basePath).toBe('/api/auth');
    expect(prefixed.options.basePath).toBe('/api/auth');
  });

  it('substitutes Bun.password for better-auth’s scrypt', () => {
    const resolved = new AuthOptions<BetterAuthOptions>({
      secret: 's',
      emailAndPassword: { enabled: true },
    });
    expect(resolved.options.emailAndPassword?.password).toBe(bunPassword);
  });

  it('leaves a hasher the app supplied alone', () => {
    const password = {
      hash: async () => 'x',
      verify: async () => true,
    };
    const resolved = new AuthOptions<BetterAuthOptions>({
      secret: 's',
      emailAndPassword: { enabled: true, password },
    });
    expect(resolved.options.emailAndPassword?.password).toBe(password);
  });

  it('adds no hasher when email/password is off', () => {
    const resolved = new AuthOptions<BetterAuthOptions>({
      secret: 's',
      emailAndPassword: { enabled: false },
    });
    expect(resolved.options.emailAndPassword?.password).toBeUndefined();
  });

  it('does not mutate what it was given', () => {
    const init = { secret: 's', emailAndPassword: { enabled: true } };
    new AuthOptions(init);
    expect(init.emailAndPassword).toEqual({ enabled: true });
    expect('basePath' in init).toBe(false);
  });
});

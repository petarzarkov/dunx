import { describe, expect, it } from 'bun:test';
import { AppFactory, Module, provide, token } from '@dunx/core';
import { SignedCookiesModule } from './module.js';
import { SignedCookies, SIGNED_COOKIE_DEFAULTS } from './signed.js';

const OLD = 'the-old-secret-still-thirty-two-characters';
const NEW = 'the-new-secret-also-thirty-two-characters!';

/** A request's map carrying what `from` set, as the browser would send it back. */
const returned = (from: Bun.CookieMap): Bun.CookieMap =>
  new Bun.CookieMap(
    from
      .toSetCookieHeaders()
      .map((header) => header.slice(0, header.indexOf(';')))
      .join('; '),
  );

const signedBy = (secrets: readonly string[], name: string, value: string) => {
  const map = new Bun.CookieMap();
  new SignedCookies({ secrets }).set(map, name, value);
  return returned(map);
};

describe('SignedCookies', () => {
  it('round-trips a value holding dots, spaces and non-ASCII', () => {
    const signed = new SignedCookies({ secrets: [NEW] });
    const value = 'a.b c=d é';
    expect(signed.get(signedBy([NEW], 'prefs', value), 'prefs')).toBe(value);
  });

  it('signs with the first secret and verifies with any', () => {
    const rotated = new SignedCookies({ secrets: [NEW, OLD] });
    expect(rotated.get(signedBy([OLD], 'prefs', 'old'), 'prefs')).toBe('old');
    const fresh = signedBy([NEW, OLD], 'prefs', 'new');
    expect(new SignedCookies({ secrets: [NEW] }).get(fresh, 'prefs')).toBe(
      'new',
    );
    expect(new SignedCookies({ secrets: [OLD] }).get(fresh, 'prefs')).toBe(
      undefined,
    );
  });

  it('reads a value signed under another name, or not signed, as absent', () => {
    const signed = new SignedCookies({ secrets: [NEW] });
    const moved = signedBy([NEW], 'theme', 'dark').get('theme') ?? '';
    for (const wire of [moved, 'dark', `dark.${'x'.repeat(43)}`, `dark.x`]) {
      expect(signed.get(new Bun.CookieMap({ prefs: wire }), 'prefs')).toBe(
        undefined,
      );
    }
    expect(signed.get(new Bun.CookieMap(), 'prefs')).toBe(undefined);
  });

  it('reads a 43-character signature of multibyte characters as absent', () => {
    const signed = new SignedCookies({ secrets: [NEW] });
    for (const wire of [`dark.${'é'.repeat(43)}`, `dark.${'x'.repeat(42)}é`]) {
      const cookies = new Bun.CookieMap({ prefs: wire });
      expect(() => signed.get(cookies, 'prefs')).not.toThrow();
      expect(signed.get(cookies, 'prefs')).toBe(undefined);
    }
  });

  it('sets the secure defaults, and lets a call override them', () => {
    const signed = new SignedCookies({ secrets: [NEW] });
    const map = new Bun.CookieMap();
    signed.set(map, 'a', '1');
    signed.set(map, 'b', '1', { secure: false, maxAge: 60, path: '/app' });
    const [a = '', b = ''] = map.toSetCookieHeaders();
    expect(a).toEndWith('; Path=/; Secure; HttpOnly; SameSite=Lax');
    expect(b).toEndWith('; Path=/app; Max-Age=60; HttpOnly; SameSite=Lax');
    expect(SIGNED_COOKIE_DEFAULTS).toEqual({
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('refuses a cookie the browser would drop, per rfc6265bis-22', () => {
    const signed = new SignedCookies({ secrets: [NEW] });
    const map = new Bun.CookieMap();
    for (const [name, options] of [
      ['__Secure-a', { secure: false }],
      ['__Host-a', { secure: false }],
      ['__Host-a', { path: '/app' }],
      ['__Host-a', { domain: 'example.com' }],
      ['a', { sameSite: 'none', secure: false }],
    ] as const) {
      expect(() => signed.set(map, name, '1', options)).toThrow(
        /would be dropped by the browser/,
      );
    }
    signed.set(map, '__Host-a', '1');
    signed.set(map, '__Secure-b', '1', { domain: 'example.com' });
    signed.set(map, 'c', '1', { sameSite: 'none' });
    expect(map.toSetCookieHeaders()).toHaveLength(3);
  });

  it('refuses no secrets and a short one', () => {
    expect(() => new SignedCookies({ secrets: [] })).toThrow(
      /at least one secret/,
    );
    expect(() => new SignedCookies({ secrets: [NEW, 'short'] })).toThrow(
      /at least 32 characters/,
    );
  });
});

describe('SignedCookiesModule', () => {
  it('binds SignedCookies from forRoot', async () => {
    @Module({ imports: [SignedCookiesModule.forRoot({ secrets: [NEW] })] })
    class Root {}
    const app = await AppFactory.create(Root);
    expect(app.get(SignedCookies)).toBeInstanceOf(SignedCookies);
    await app.shutdown();
  });

  it('injects from a module named in its own forRootAsync imports', async () => {
    // A `token()`, never a class: an unbound class self-binds into whichever
    // scope asks first, and the test would pass against the bug it guards.
    const SECRETS = token<readonly string[]>('CookieSecrets');

    @Module({
      providers: [provide(SECRETS, { useValue: [NEW, OLD] })],
      exports: [SECRETS],
    })
    class SecretsModule {}

    @Module({
      imports: [
        SignedCookiesModule.forRootAsync({
          imports: [SecretsModule],
          useFactory: (secrets: readonly string[]) => ({ secrets }),
          inject: [SECRETS],
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const signed = app.get(SignedCookies);
    expect(signed.get(signedBy([OLD], 'prefs', 'kept'), 'prefs')).toBe('kept');
    await app.shutdown();
  });
});

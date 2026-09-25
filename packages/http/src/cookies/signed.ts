import { AppError } from '@dunx/core';
import type { CookieInit, CookieMap } from 'bun';

/** A cookie's attributes, as `Bun.CookieMap.set` takes them. */
export type CookieOptions = Omit<CookieInit, 'name' | 'value'>;

export interface SignedCookiesInit {
  /**
   * HMAC-SHA256 keys, at least 32 characters each. The first signs; every one
   * verifies, so a rotated key is prepended and the old one kept until the
   * cookies it signed have expired.
   */
  readonly secrets: readonly string[];
}

/**
 * What `set` writes unless the call says otherwise: not readable from script,
 * sent over HTTPS only, withheld from cross-site subrequests. Bun's own
 * `CookieMap.set` defaults to `Path=/; SameSite=Lax` alone.
 */
export const SIGNED_COOKIE_DEFAULTS = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const satisfies CookieOptions;

/** An HMAC-SHA256 digest is 32 bytes, 43 characters of unpadded base64url. */
const SIGNATURE_LENGTH = 43;
const MIN_SECRET_LENGTH = 32;
const encoder = new TextEncoder();

/**
 * The rules rfc6265bis-22 gives a browser for dropping a cookie without a word:
 * 4.1.3.1 and 4.1.3.2 for the prefixes, 5.7 step 19 for `SameSite=None`. Thrown
 * here instead, where the call that wrote it is on the stack.
 */
const assertAccepted = (name: string, options: CookieOptions): void => {
  const broken =
    (name.startsWith('__Secure-') && options.secure !== true) ||
    (name.startsWith('__Host-') &&
      (options.secure !== true ||
        options.path !== '/' ||
        options.domain !== undefined)) ||
    (options.sameSite === 'none' && options.secure !== true);
  if (broken) {
    throw new AppError(
      `Cookie "${name}" would be dropped by the browser: a __Secure- name and ` +
        'SameSite=None need Secure, and a __Host- name needs Secure, Path=/ ' +
        'and no Domain (rfc6265bis-22 4.1.3, 5.7).',
    );
  }
};

/**
 * Cookies whose value the client cannot change unnoticed. The wire value is
 * `<value>.<signature>`, the signature the unpadded base64url HMAC-SHA256 of
 * `<name>=<value>`, so a value signed for one cookie does not verify under
 * another name. `Bun.CookieMap` percent-encodes it on the way out.
 *
 * Reading never throws: a missing, unsigned or tampered cookie is `undefined`,
 * which is what an absent one is.
 *
 * ```ts
 * this.signed.set(req.cookies, 'theme', 'dark', { maxAge: 86_400 });
 * this.signed.get(req.cookies, 'theme'); // 'dark', or undefined
 * ```
 */
export class SignedCookies {
  readonly #keys: readonly Bun.CryptoHasher[];

  constructor(init: SignedCookiesInit) {
    if (init.secrets.length === 0) {
      throw new AppError('SignedCookies needs at least one secret');
    }
    if (init.secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
      throw new AppError(
        `SignedCookies: every secret needs at least ${MIN_SECRET_LENGTH} ` +
          'characters, the length of the SHA-256 digest (RFC 2104 section 3).',
      );
    }
    // A keyed hasher copied per signature: 227 ns against 343 ns for a new one.
    this.#keys = init.secrets.map(
      (secret) => new Bun.CryptoHasher('sha256', secret),
    );
  }

  /** The verified value of `name`, or `undefined`. */
  get(cookies: CookieMap, name: string): string | undefined {
    const wire = cookies.get(name);
    if (wire === null) return undefined;
    const dot = wire.lastIndexOf('.');
    const signature = wire.slice(dot + 1);
    if (dot === -1 || signature.length !== SIGNATURE_LENGTH) return undefined;
    const value = wire.slice(0, dot);
    const given = encoder.encode(signature);
    for (const key of this.#keys) {
      const expected = encoder.encode(this.#sign(key, name, value));
      if (crypto.timingSafeEqual(expected, given)) return value;
    }
    return undefined;
  }

  /** Signs `value` with the first secret and sets it under the defaults. */
  set(
    cookies: CookieMap,
    name: string,
    value: string,
    options: CookieOptions = {},
  ): void {
    const merged = { ...SIGNED_COOKIE_DEFAULTS, ...options };
    assertAccepted(name, merged);
    const [signer] = this.#keys as [Bun.CryptoHasher];
    cookies.set(name, `${value}.${this.#sign(signer, name, value)}`, merged);
  }

  #sign(key: Bun.CryptoHasher, name: string, value: string): string {
    return key.copy().update(`${name}=${value}`).digest('base64url');
  }
}

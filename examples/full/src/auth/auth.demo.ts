import { Auth } from '@dunx/auth';
import { Logger } from '@dunx/core';
import { SyncDatabase } from '@dunx/infra/db';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { user } from '../database/schema.js';

const CREDENTIALS = {
  email: 'ada@example.com',
  password: 'correct horse battery',
  name: 'Ada',
};

/**
 * The whole loop over HTTP: better-auth's own mounted endpoints sign a user up and
 * in, then dunx's `SessionGuard` decides who reaches `/api/profile`. Nothing here
 * reimplements an auth flow — every `/api/auth/*` call lands in better-auth.
 */
export class AuthDemo {
  constructor(
    private readonly logger: Logger,
    private readonly auth: Auth,
    private readonly db: SyncDatabase<typeof schema>,
  ) {}

  /** What `Origin` has to be for better-auth's CSRF check — see {@link post}. */
  #origin = '';

  async demonstrate(url: string): Promise<void> {
    const base = new URL(url).origin;
    // `$context` is where the resolved configuration lands; `options.baseURL` is
    // whatever was passed in, which better-auth also allows to be a function.
    this.#origin = (await this.auth.$context).baseURL;
    this.logger.info(
      `better-auth ${this.auth.options.basePath} mounted, hashing with Bun.password bcrypt`,
    );

    await this.report(
      'POST /api/auth/sign-up/email',
      await this.post(base, 'sign-up/email', CREDENTIALS),
    );

    const signIn = await this.post(base, 'sign-in/email', {
      email: CREDENTIALS.email,
      password: CREDENTIALS.password,
    });
    await this.report('POST /api/auth/sign-in/email', signIn);

    // The `bearer` plugin returns the session token in a header, so a server-side
    // client authenticates without a cookie jar.
    const token = signIn.headers.get('set-auth-token') ?? '';
    const cookie = signIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');

    await this.call('GET /api/profile, no credentials', base, '/api/profile');
    await this.call(
      'GET /api/profile with the session cookie',
      base,
      '/api/profile',
      {
        cookie,
      },
    );
    await this.call(
      'GET /api/profile with a bearer token',
      base,
      '/api/profile',
      {
        authorization: `Bearer ${token}`,
      },
    );

    await this.call(
      '@Roles("admin") GET /api/profile/audit as "user"',
      base,
      '/api/profile/audit',
      {
        cookie,
      },
    );

    // What an admin console would do. The `admin` plugin's own `setRole` endpoint
    // needs an existing admin to call it, and there is none yet.
    this.db
      .update(user)
      .set({ role: 'admin' })
      .where(eq(user.email, CREDENTIALS.email))
      .run();
    this.logger.info(
      'promoted ada@example.com to role "admin" through drizzle',
    );

    await this.call(
      '@Roles("admin") GET /api/profile/audit as "admin"',
      base,
      '/api/profile/audit',
      {
        cookie,
      },
    );
    await this.call(
      '@Public() GET /api/profile/anonymous, cookie ignored',
      base,
      '/api/profile/anonymous',
      {
        cookie,
      },
    );

    await this.report(
      'POST /api/auth/sign-out',
      await this.post(base, 'sign-out', {}, { cookie }),
    );
    await this.call(
      'GET /api/profile after signing out',
      base,
      '/api/profile',
      {
        cookie,
      },
    );

    // The instance is injectable, so a service can ask better-auth directly rather
    // than going over HTTP.
    const session = await this.auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    this.logger.info(
      `auth.api.getSession() after sign-out -> ${session === null ? 'null' : 'still live'}`,
    );
  }

  /**
   * `Origin` is set because better-auth rejects a cookie-bearing state change without
   * one — `MISSING_OR_NULL_ORIGIN`, its CSRF check. A browser sends it for free; a
   * server-side client has to, and the value that has to match is `trustedOrigins`,
   * which defaults to the configured `baseURL`.
   */
  private post(
    base: string,
    endpoint: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: this.#origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  private async call(
    label: string,
    base: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<void> {
    await this.report(label, await fetch(`${base}${path}`, { headers }));
  }

  private async report(label: string, response: Response): Promise<void> {
    const text = await response.text();
    this.logger.info(
      `${label} -> ${response.status} ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`,
    );
  }
}

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

/** The whole loop over HTTP: better-auth's mounted endpoints sign a user up and
 * in, then `SessionGuard` decides who reaches `/api/profile`. */
export class AuthDemo {
  constructor(
    private readonly logger: Logger,
    private readonly auth: Auth,
    private readonly db: SyncDatabase<typeof schema>,
  ) {}

  /** What `Origin` has to be for better-auth's CSRF check - see {@link post}. */
  #origin = '';

  async demonstrate(url: string): Promise<void> {
    const base = new URL(url).origin;
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

    // The `bearer` plugin returns the token in a header, so no cookie jar.
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

    // The `admin` plugin's `setRole` needs an existing admin, and there is none.
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

    // Injectable, so a service can ask better-auth without going over HTTP.
    const session = await this.auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    this.logger.info(
      `auth.api.getSession() after sign-out -> ${session === null ? 'null' : 'still live'}`,
    );
  }

  /** better-auth rejects a cookie-bearing state change with no `Origin`
   * (`MISSING_OR_NULL_ORIGIN`); it has to match `trustedOrigins`. */
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

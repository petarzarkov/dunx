import type { BunRequest } from 'bun';
import { Auth } from '@dunx/auth';
import { Module } from '@dunx/core';
import type { AuthorizeDecision } from '@dunx/http';
import { AccountsModule } from './auth/auth.module.js';
import { AppConfigService } from './config.js';

/**
 * Who may read this service's API document. One class, both explorers:
 * `OpenApiModule`'s `authorize` gates Swagger UI, `ReferenceMiddleware` runs the
 * same method for Scalar. Off unless `DOCS_GUARDED` is set.
 */
export class DocsGate {
  constructor(
    private readonly auth: Auth,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get('docs').guarded;
  }

  /** A cookie, so the page's asset fetches carry the same decision. */
  async admits(req: BunRequest): Promise<AuthorizeDecision> {
    const session = await this.auth.api.getSession({ headers: req.headers });
    if (session !== null) return true;

    // `false` is a 404 and a dead end for a person, so a navigation lands on the
    // landing page's session button, which issues one when `AUTH_GUEST_ONLY` is
    // set. Guard the docs without that and there is no sign-in to land on.
    return req.headers.get('accept')?.includes('text/html') === true
      ? new Response(null, { status: 302, headers: { location: '/#who' } })
      : false;
  }
}

@Module({
  imports: [AccountsModule],
  providers: [DocsGate],
  exports: [DocsGate],
})
export class DocsGateModule {}

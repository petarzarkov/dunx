import { Auth, betterAuthDocument } from '@dunx/auth';
import { Module } from '@dunx/core';
import { DocumentSource, type DocumentFragment } from '@dunx/openapi';
import { AccountsModule } from './auth/auth.module.js';

/**
 * better-auth's endpoints, as a provider. Route discovery never sees
 * `/api/auth/*` because the library answers it, so this merges its schema in.
 *
 * Top level rather than in `docs/`: that folder is vendored as the `openapi`
 * feature, and a contributor needing both `@dunx/openapi` and `@dunx/auth`
 * belongs to neither feature alone.
 */
export class AuthDocs extends DocumentSource {
  constructor(private readonly auth: Auth) {
    super();
  }

  /** `betterAuthDocument` defers, since asking for the schema is async. */
  override async contribute(): Promise<DocumentFragment> {
    return betterAuthDocument(this.auth, {
      basePath: '/api/auth',
      tag: 'Auth',
    })();
  }
}

@Module({
  imports: [AccountsModule],
  providers: [AuthDocs],
  exports: [AuthDocs],
})
export class AuthDocsModule {}

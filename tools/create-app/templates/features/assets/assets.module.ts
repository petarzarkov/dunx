import { Module } from '@dunx/core';
import { StaticModule } from '@dunx/http';
import { AssetsDemo } from './assets.demo.js';

/** A content hash, so a change produces a different URL. */
const HASHED = /\.[0-9a-f]{8}\.(js|css)$/;

/**
 * `public/` served at `/assets`. `StaticModule` binds `StaticFiles`; the app
 * registers it in `main.ts`, because position in the chain is the app's
 * call. The mount skips the global prefix: middleware is not a discovered route.
 */
@Module({
  imports: [
    StaticModule.forRoot({
      // Inside the feature folder, which `@dunx/create-app` vendors wholesale.
      root: new URL('./public', import.meta.url).pathname,
      path: '/assets',
      maxAge: 60,
      // Only honest for a content-addressed name: guessing wrong leaves a stale
      // asset nobody can flush.
      immutable: (pathname) => HASHED.test(pathname),
    }),
  ],
  providers: [AssetsDemo],
  exports: [AssetsDemo],
})
export class AssetsModule {}

import { Module } from '@dunx/core';
import { StaticModule } from '@dunx/http';
import { AssetsDemo } from './assets.demo.js';

/** A content hash, so a change produces a different URL. */
const HASHED = /\.[0-9a-f]{8}\.(js|css)$/;

/**
 * The `public/` directory next to this file, served at `/assets`.
 *
 * `StaticModule` binds `StaticFiles`; the **app** registers it, in `bootstrap.ts`.
 * Position in the chain is the app's decision and no default can make it: assets
 * usually want to be outside an auth guard and inside request logging.
 *
 * The mount is outside `setGlobalPrefix('api')`, because middleware is not a
 * discovered route and never gets the prefix.
 */
@Module({
  imports: [
    StaticModule.forRoot({
      // Inside the feature folder rather than at the app root, so the folder is
      // self-contained: `@dunx/create-app` vendors this directory wholesale, and
      // an asset kept outside it would need machinery to travel with it.
      root: new URL('./public', import.meta.url).pathname,
      path: '/assets',
      // Short, because a long max-age on a name that can change is a promise the
      // server cannot keep.
      maxAge: 60,
      // Only honest for a content-addressed name. Guessing wrong here is a stale
      // asset nobody can flush, which is why the default claims nothing.
      immutable: (pathname) => HASHED.test(pathname),
    }),
  ],
  providers: [AssetsDemo],
  exports: [AssetsDemo],
})
export class AssetsModule {}

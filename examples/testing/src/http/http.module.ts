import { Module, provide } from '@dunx/core';
import { HttpOptionsProvider } from '@dunx/http';
import { RequestId } from './request-id.middleware.js';

/**
 * Global middleware on a provider rather than an argument to `create()`. That is
 * what makes it reach a fixture: `createTestServer` resolves the same
 * `HttpOptionsProvider` the application does, so a suite gets the chain production
 * gets without restating it.
 */
export class AppHttpOptions extends HttpOptionsProvider {
  override readonly middleware = [RequestId];
}

@Module({
  providers: [
    RequestId,
    provide(HttpOptionsProvider, { useClass: AppHttpOptions }),
  ],
  exports: [HttpOptionsProvider],
})
export class HttpModule {}

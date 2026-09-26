import { Controller, Get } from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { SelfOrigin } from './self-origin.js';

/** `Sec-Fetch-Site` values a browser sends, and the one a non-browser omits. */
const CALLERS = [
  ['cross-site', 'a form on another site'],
  ['same-origin', 'this page'],
  [null, 'curl, or a server'],
] as const;

/**
 * A browser will not let a page forge `Sec-Fetch-Site`, so the landing page asks
 * the server to make the three calls. The body is empty on purpose: a request the
 * CSRF check lets through answers the 400 of validation, and creates nothing.
 */
@ApiDoc({
  tags: ['Demo'],
  description:
    'Posts to /api/users as three callers and reports which the CSRF check refused.',
})
@Controller('demo')
export class CsrfController {
  constructor(private readonly origin: SelfOrigin) {}

  @Get('/csrf')
  async csrf(): Promise<
    readonly { secFetchSite: string | null; caller: string; status: number }[]
  > {
    const target = new URL('/api/users', this.origin.require());
    return Promise.all(
      CALLERS.map(async ([site, caller]) => {
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(site !== null && { 'sec-fetch-site': site }),
          },
          body: '{}',
        });
        await res.body?.cancel();
        return { secFetchSite: site, caller, status: res.status };
      }),
    );
  }
}

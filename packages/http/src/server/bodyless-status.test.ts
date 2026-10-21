import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get } from '../route/decorators.js';
import type { RouteContext } from './context.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { serving } from './serving.fixture.js';

@Controller('bodyless')
class BodylessController {
  @Get('no-content', { status: 204 })
  noContent() {
    return { ignored: true };
  }

  @Get('not-modified', { status: 304 })
  notModified() {
    return { ignored: true };
  }

  @Get('empty-not-modified', { status: 304 })
  emptyNotModified() {
    return undefined;
  }

  @Get('response', { status: 204 })
  response() {
    return new Response('explicit', { status: 202 });
  }
}

class PassThrough implements Middleware {
  handle(_req: BunRequest, _ctx: RouteContext, next: Next) {
    return next();
  }
}

@Module({ controllers: [BodylessController] })
class AppModule {}

for (const guarded of [false, true]) {
  for (const secured of [false, true]) {
    describe(`bodyless statuses, middleware=${guarded}, security=${secured}`, () => {
      it('discards values and preserves declared status, including undefined', async () => {
        await serving(
          () =>
            HttpFactory.create(AppModule, {
              middleware: guarded ? [PassThrough] : [],
              requestLogging: false,
              bootLogging: false,
              securityHeaders: secured,
            }),
          async (_app, url) => {
            for (const [path, status] of [
              ['no-content', 204],
              ['not-modified', 304],
              ['empty-not-modified', 304],
            ] as const) {
              const response = await fetch(`${url}/bodyless/${path}`);
              expect(response.status).toBe(status);
              expect(await response.text()).toBe('');
              expect(response.headers.has('content-type')).toBe(false);
              if (secured)
                expect(response.headers.get('x-content-type-options')).toBe(
                  'nosniff',
                );
            }
            const response = await fetch(`${url}/bodyless/response`);
            expect(response.status).toBe(202);
            expect(await response.text()).toBe('explicit');
          },
        );
      });
    });
  }
}

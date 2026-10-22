import { expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get, Post } from '../route/decorators.js';
import type { RouteContext } from './context.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { serving } from './serving.fixture.js';

const seen: RouteContext[] = [];
class Capture implements Middleware {
  handle(_req: BunRequest, ctx: RouteContext, next: Next) {
    seen.push(ctx);
    return next();
  }
}

@Controller('context')
class ContextController {
  @Post('accepted', { status: 202 })
  accepted() {
    return { ok: true };
  }

  @Get('ordinary')
  ordinary() {
    return { ok: true };
  }
}

@Module({ controllers: [ContextController] })
class AppModule {}

it('exposes the declared status on the frozen context and leaves defaults absent', async () => {
  seen.length = 0;
  await serving(
    () =>
      HttpFactory.create(AppModule, {
        middleware: [Capture],
        requestLogging: false,
        bootLogging: false,
      }),
    async (_app, url) => {
      await fetch(`${url}/context/accepted`, { method: 'POST' });
      await fetch(`${url}/context/accepted`, { method: 'POST' });
      await fetch(`${url}/context/ordinary`);
      expect(seen[0]?.status).toBe(202);
      expect(seen[2]?.status).toBeUndefined();
      expect(seen[0]).toBe(seen[1]);
      expect(Object.isFrozen(seen[0])).toBe(true);
    },
  );
});

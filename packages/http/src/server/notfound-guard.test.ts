import { expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { PUBLIC, UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import type { BunRequest } from 'bun';

/** Shaped like `SessionGuard`: honours `@Public()`, refuses everything else. */
class DenyGuard implements Middleware {
  async handle(
    _req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(PUBLIC) === true) return next();
    throw new HttpError(401, 'no session');
  }
}

/** The opposite posture: authenticate misses too, rather than reveal them. */
class DenyEvenMissesGuard implements Middleware {
  async handle(
    _req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(PUBLIC) === true && ctx.get(UNMATCHED) !== true) {
      return next();
    }
    throw new HttpError(401, 'no session');
  }
}

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

const statusFor = async (
  guard: new () => Middleware,
  path: string,
  notFound?: 'guarded' | 'public',
): Promise<number> => {
  const app = await HttpFactory.create(AppModule, {
    port: 0,
    requestLogging: false,
    middleware: [guard],
    ...(notFound !== undefined && { notFound }),
  });
  const url = await app.listen(0);
  const response = await fetch(new URL(path, url));
  await app.shutdown();
  return response.status;
};

/*
 * The default is unchanged and deliberate: a 404 on a miss while every real path
 * answers 401 enumerates the surface a prober just failed to find. `@dunx/auth`'s
 * handler test asserts this too, with that reasoning in its comment.
 */
test('a miss is guarded by default, so it answers the guard status', async () => {
  expect(await statusFor(DenyGuard, '/nope')).toBe(401);
});

test("notFound: 'public' opts into the conventional 404", async () => {
  expect(await statusFor(DenyGuard, '/nope', 'public')).toBe(404);
});

test('a matched route is guarded under either setting', async () => {
  expect(await statusFor(DenyGuard, '/users')).toBe(401);
  expect(await statusFor(DenyGuard, '/users', 'public')).toBe(401);
});

// UNMATCHED is what makes the two distinguishable, so a guard can keep refusing
// misses even where the app opted into the public 404.
test('a guard can refuse the miss even when it is public', async () => {
  expect(await statusFor(DenyEvenMissesGuard, '/nope', 'public')).toBe(401);
});

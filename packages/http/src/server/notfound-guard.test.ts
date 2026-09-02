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
 * The default is `'public'`, and the trade is worth stating because it used to run
 * the other way.
 *
 * `'guarded'` has a real security property: behind a global auth guard every real
 * path answers 401, so a miss answering 404 tells a prober which paths exist. It
 * was the default for that reason. It was also the wrong default for the far more
 * common app, which has no global auth guard and got a 401 where every other
 * framework returns a 404 - and `dunx-template` overrode it on its first day.
 *
 * So: conventional by default, and an app behind a global guard sets
 * `notFound: 'guarded'` to get the property back. `@dunx/auth`'s handler test
 * asserts the guarded case explicitly for that reason.
 */
test('a miss is a conventional 404 by default', async () => {
  expect(await statusFor(DenyGuard, '/nope')).toBe(404);
});

test("notFound: 'guarded' hides the miss behind the guard", async () => {
  expect(await statusFor(DenyGuard, '/nope', 'guarded')).toBe(401);
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

import { AppFactory, Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Auth } from './auth.js';
import { AuthError } from './errors.js';

describe('Auth', () => {
  it('refuses to self-bind, rather than handing back an empty instance', async () => {
    @Module({})
    class Root {}

    const app = await AppFactory.create(Root);
    // Every class self-binds in the container, and `abstract` is a compile-time
    // notion — so without the guard this would be an object whose `handler` is
    // `undefined`, and the first symptom would be a request failing.
    expect(() => app.get(Auth)).toThrow(AuthError);
    expect(() => app.get(Auth)).toThrow('AuthModule.forRoot');
    await app.shutdown();
  });
});

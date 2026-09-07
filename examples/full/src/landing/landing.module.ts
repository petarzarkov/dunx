import { Module } from '@dunx/core';
import { LandingMiddleware } from './landing.middleware.js';

/** Bound here rather than left to self-bind; `main.ts` places it in the chain. */
@Module({
  providers: [LandingMiddleware],
  exports: [LandingMiddleware],
})
export class LandingModule {}

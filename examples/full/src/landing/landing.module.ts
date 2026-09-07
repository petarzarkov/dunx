import { Module } from '@dunx/core';
import { LandingMiddleware } from './landing.middleware.js';

@Module({
  providers: [LandingMiddleware],
  exports: [LandingMiddleware],
})
export class LandingModule {}

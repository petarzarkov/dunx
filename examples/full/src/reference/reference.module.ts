import { Module } from '@dunx/core';
import { ReferenceDemo } from './reference.demo.js';

/** Only the demo; `ReferenceMiddleware` is registered in `main.ts`. */
@Module({ providers: [ReferenceDemo], exports: [ReferenceDemo] })
export class ReferenceModule {}

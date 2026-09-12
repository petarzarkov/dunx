import { Module } from '@dunx/core';
import { ReferenceDemo } from './reference.demo.js';

/**
 * Only the demonstration lives here. `ReferenceMiddleware` is registered with
 * `app.use()` in `main.ts`, where the container that holds the document is.
 */
@Module({ providers: [ReferenceDemo], exports: [ReferenceDemo] })
export class ReferenceModule {}

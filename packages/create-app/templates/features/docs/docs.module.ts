import { Module } from '@dunx/core';
import { DocsDemo } from './docs.demo.js';

/**
 * Only the demonstration lives here. The document's own routes come from
 * `OpenApiModule.forRoot()` in `main.ts`, which wraps the root module it documents.
 */
@Module({ providers: [DocsDemo], exports: [DocsDemo] })
export class DocsModule {}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { port } from '../shared.js';

/**
 * NestJS on its default Express adapter - the configuration most Nest apps ship.
 *
 * dunx is deliberately Nest-shaped (modules, controllers, DI, guards), so this row
 * and `nest-fastify` are the most direct answer to "what does that programming
 * model cost". Compare them against `express` and `fastify` to separate Nest's own
 * overhead from the HTTP server underneath it.
 */
const app = await NestFactory.create(AppModule, { logger: false });
await app.listen(port(), '127.0.0.1');

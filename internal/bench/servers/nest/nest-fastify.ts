import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { port } from '../shared.js';

/**
 * The same Nest application on the Fastify adapter. Paired with `nest-express` it
 * isolates the adapter from the framework, the way `hono-bun` and `hono-node`
 * isolate the runtime.
 */
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ logger: false }),
  { logger: false },
);
await app.listen(port(), '127.0.0.1');

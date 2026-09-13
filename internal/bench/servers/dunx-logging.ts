/**
 * `@dunx/http` exactly as `HttpFactory.create` leaves it: `requestLogging` on,
 * which is the default and therefore what an app gets unless it opts out.
 *
 * It is a separate subject rather than the primary one because no other subject
 * in the suite logs anything, so this row measures dunx's default *observability*
 * against seven servers that are silent. Both numbers matter and both are here:
 * `dunx` is the framework, `dunx-logging` is the framework plus a structured line
 * per request written to stdout.
 *
 * Its stdout is `/dev/null`, so this does not measure terminal rendering - but it
 * does measure building the entry, `JSON.stringify`, and a real `write(2)`.
 *
 * It used to be a pipe **nobody read**, which is not a measurement of dunx at all:
 * 64 KiB in, the pipe is full, and the server parks on every further write. That
 * alone was worth 2.68 µs/request - see `bun run logging` and ARCHITECTURE.md.
 */
import { Module } from '@dunx/core';
import { HttpFactory } from '@dunx/http';
import { BenchController, connectIo, Greeter } from './dunx-app.js';
import { port } from './shared.js';

@Module({ controllers: [BenchController], providers: [Greeter] })
class AppModule {}

await connectIo();

const app = await HttpFactory.create(AppModule, { port: port() });
await app.listen();

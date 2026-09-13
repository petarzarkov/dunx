/**
 * `dunx-logging`, with `@arkv/logger` bound instead of core's `ConsoleLogger`.
 *
 * That is what `LoggerModule.forRoot()` does, and it is the configuration
 * `packages/infra/README.md` recommends, so it is what most production apps run.
 * Nothing else in the suite measured it: `dunx-logging` binds the default
 * `ConsoleLogger`, which sanitizes nothing, and the two are not the same price.
 *
 * This row exists because the difference was estimated twice and the two estimates
 * disagreed by 5.7x. Tight-loop benches put `Logger.info` at 1474 ns against
 * `ConsoleLogger`'s 543, so +931 ns; an in-process rig with no socket under it put
 * the gap at +5324 ns. A figure derived from the second went into
 * `docs/architecture/cost-of-logging.md` and had to be retracted. Neither estimate
 * is worth quoting, and this row is the thing that settles it.
 *
 * `isDevelopment: false` so the entry is JSON rather than the coloured rendering,
 * matching what `dunx-logging` writes and what a container runs.
 */
import { Module } from '@dunx/core';
import { HttpFactory } from '@dunx/http';
import { LoggerModule } from '@dunx/infra/logger';
import { BenchController, connectIo, Greeter } from './dunx-app.js';
import { port } from './shared.js';

@Module({
  imports: [LoggerModule.forRoot({ isDevelopment: false })],
  controllers: [BenchController],
  providers: [Greeter],
})
class AppModule {}

await connectIo();

const app = await HttpFactory.create(AppModule, { port: port() });
await app.listen();

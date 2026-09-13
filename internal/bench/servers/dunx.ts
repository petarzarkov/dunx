import { Module } from '@dunx/core';
import { HttpFactory } from '@dunx/http';
import { BenchController, connectIo, Greeter } from './dunx-app.js';
import { port } from './shared.js';

@Module({ controllers: [BenchController], providers: [Greeter] })
class AppModule {}

await connectIo();

// `requestLogging: false` because **no other subject logs**, and comparing a
// framework that writes a structured line per request against seven that write
// nothing measures the logger, not the framework. The cost of dunx's default is
// not hidden - it is its own subject, `dunx-logging`, in the same table.
const app = await HttpFactory.create(AppModule, {
  port: port(),
  requestLogging: false,
});
await app.listen();

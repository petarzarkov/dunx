import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';

/**
 * `create()` builds the container and discovers routes; `listen()` builds the
 * `Bun.serve` route table and returns the URL. `enableShutdownHooks()` makes
 * `ctrl-c` drain the graph in reverse construction order.
 */
const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

const url = await app.listen(3000);
console.log(`listening on ${url}greetings`);

await app.closed;

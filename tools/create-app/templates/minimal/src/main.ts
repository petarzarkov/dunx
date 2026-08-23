import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';

const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

const url = await app.listen(3000);
console.log(`listening on ${url}greetings`);

await app.closed;

import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';

/**
 * The app the tests test. It exists so the suite is testing something that really
 * runs - `/weather/:city` will genuinely try to reach the network, which is what
 * makes the override in `container.test.ts` worth having.
 */
const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();
app.setGlobalPrefix('api');

const url = await app.listen(3000);
console.log(`listening on ${url}api/reports/health`);

await app.closed;

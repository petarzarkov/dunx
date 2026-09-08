/**
 * The driver harness's server on Bun: raw `Bun.serve`, one route, and whichever
 * client pair `$BENCH_DRIVER_SQL` and `$BENCH_DRIVER_REDIS` name.
 *
 * Raw rather than a framework, because a framework term would be added to every
 * cell equally and would only make the differences harder to read.
 */
import { port } from '../shared.js';
import { chosen, DriverPair } from './pair.js';

const pair = await DriverPair.connect(chosen().sql, chosen().redis);

Bun.serve({
  port: port(),
  routes: {
    '/plaintext': { GET: (): Response => new Response('Hello, World!') },
    '/io': {
      GET: async (): Promise<Response> => Response.json(await pair.read()),
    },
  },
});

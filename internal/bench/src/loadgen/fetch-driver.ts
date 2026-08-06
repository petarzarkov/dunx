import { availableParallelism } from 'node:os';
import type {
  LoadGenerator,
  LoadOptions,
  LoadRequest,
  LoadSample,
} from '../types.js';
import {
  BUCKET_COUNT,
  percentileFrom,
  type WorkerJob,
  type WorkerReport,
} from './protocol.js';

const workerUrl = new URL('./fetch-worker.ts', import.meta.url);

/** Leave headroom for the subject process, which is single-threaded. */
const workerCount = (connections: number): number =>
  Math.max(1, Math.min(connections, Math.max(1, availableParallelism() - 2)));

const once = (job: WorkerJob): Promise<WorkerReport> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    worker.onmessage = (event: MessageEvent<WorkerReport>): void => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(job);
  });

export const fetchGenerator = (): LoadGenerator => ({
  id: 'fetch',
  version: `bun ${Bun.version}`,
  binary: null,
  limitations: [
    'Written in JavaScript on Bun’s fetch, so it is far more expensive per request than a native generator and can itself become the bottleneck. Verify by checking that the Bun.serve subject moves when you raise --connections; if it does not, the driver has saturated, not the server.',
    'Latency is measured around fetch(), so it includes the driver’s own scheduling and body-read cost. Absolute latencies read high; the ranking is still usable.',
    'Latencies are bucketed at 1µs up to 100ms, so percentiles are quantised to 1µs and anything above 100ms only affects the maximum.',
    'Connections are spread evenly across worker threads; Bun’s connection pooling decides the real socket count, which this does not control.',
    'Runs on the same machine as the subject, competing for the same cores.',
  ],
  run: async (
    request: LoadRequest,
    options: LoadOptions,
  ): Promise<LoadSample> => {
    const workers = workerCount(options.connections);
    const base = Math.floor(options.connections / workers);
    const remainder = options.connections % workers;
    // Give every worker the same wall-clock window, so a slow thread start does
    // not shorten one worker's run and skew the aggregate rps.
    const startAtEpochMs = Date.now() + 250;

    const reports = await Promise.all(
      Array.from({ length: workers }, (_unused, index) =>
        once({
          request,
          connections: base + (index < remainder ? 1 : 0),
          durationMs: options.durationSeconds * 1000,
          startAtEpochMs,
        }),
      ),
    );

    const merged = new Uint32Array(BUCKET_COUNT);
    let requests = 0;
    let non2xx = 0;
    let errors = 0;
    let totalMicros = 0;
    let overflow = 0;
    let maxMicros = 0;
    let elapsedMs = 0;
    for (const report of reports) {
      const buckets = new Uint32Array(report.histogram);
      for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
        merged[bucket] = (merged[bucket] ?? 0) + (buckets[bucket] ?? 0);
      }
      requests += report.requests;
      non2xx += report.non2xx;
      errors += report.errors;
      totalMicros += report.totalMicros;
      overflow += report.overflow;
      maxMicros = Math.max(maxMicros, report.maxMicros);
      elapsedMs = Math.max(elapsedMs, report.elapsedMs);
    }

    const elapsedSeconds = elapsedMs / 1000;
    return {
      requests,
      elapsedSeconds,
      rps: elapsedSeconds === 0 ? 0 : requests / elapsedSeconds,
      latencyMeanMs: requests === 0 ? 0 : totalMicros / requests / 1000,
      latencyP50Ms: percentileFrom(merged, overflow, maxMicros, 0.5),
      latencyP99Ms: percentileFrom(merged, overflow, maxMicros, 0.99),
      non2xx,
      errors,
    };
  },
});

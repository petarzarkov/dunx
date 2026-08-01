import { BUCKET_COUNT, type WorkerJob, type WorkerReport } from './protocol.js';

declare const self: Worker;

const run = async (job: WorkerJob): Promise<WorkerReport> => {
  const histogram = new Uint32Array(BUCKET_COUNT);
  const init: RequestInit = {
    method: job.request.method,
    ...(job.request.body === undefined
      ? {}
      : {
          body: job.request.body,
          headers: {
            'content-type': job.request.contentType ?? 'application/json',
          },
        }),
  };

  let requests = 0;
  let non2xx = 0;
  let errors = 0;
  let totalMicros = 0;
  let overflow = 0;
  let maxMicros = 0;

  const spin = async (deadline: number): Promise<void> => {
    while (performance.now() < deadline) {
      const startedAt = performance.now();
      try {
        const response = await fetch(job.request.url, init);
        await response.arrayBuffer();
        if (response.status < 200 || response.status > 299) non2xx += 1;
      } catch {
        errors += 1;
        continue;
      }
      const micros = (performance.now() - startedAt) * 1000;
      requests += 1;
      totalMicros += micros;
      if (micros > maxMicros) maxMicros = micros;
      const bucket = Math.floor(micros);
      if (bucket < BUCKET_COUNT) {
        histogram[bucket] = (histogram[bucket] ?? 0) + 1;
      } else {
        overflow += 1;
      }
    }
  };

  const wait = job.startAtEpochMs - Date.now();
  if (wait > 0) await Bun.sleep(wait);

  const begunAt = performance.now();
  const deadline = begunAt + job.durationMs;
  await Promise.all(
    Array.from({ length: job.connections }, () => spin(deadline)),
  );

  return {
    requests,
    non2xx,
    errors,
    totalMicros,
    overflow,
    maxMicros,
    elapsedMs: performance.now() - begunAt,
    histogram: histogram.buffer as ArrayBuffer,
  };
};

self.onmessage = (event: MessageEvent<WorkerJob>): void => {
  void run(event.data).then((report) => {
    self.postMessage(report, [report.histogram]);
  });
};

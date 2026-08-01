import type {
  LoadGenerator,
  LoadOptions,
  LoadRequest,
  LoadSample,
} from '../types.js';

interface OhaReport {
  readonly summary: {
    readonly total: number;
    readonly requestsPerSec: number;
    readonly average: number;
  };
  readonly latencyPercentiles: Readonly<Record<string, number>>;
  readonly statusCodeDistribution: Readonly<Record<string, number>>;
  readonly errorDistribution?: Readonly<Record<string, number>>;
}

/** `-w` makes oha wait for in-flight requests, so this never fires; kept as a guard. */
const DEADLINE_ABORT = 'aborted due to deadline';

const sum = (record: Readonly<Record<string, number>>): number =>
  Object.values(record).reduce((total, value) => total + value, 0);

export const ohaGenerator = (
  binary: string,
  version: string,
): LoadGenerator => ({
  id: 'oha',
  version,
  binary,
  limitations: [
    'Runs on the same machine as the subject, so the loopback interface and the scheduler are shared. Numbers are a relative ranking, not an absolute capacity.',
    'Open-loop rate limiting is off, so this is a closed-loop test: latency is measured under whatever load the fixed connection count produces, and is subject to coordinated omission.',
    'HTTP/1.1 with keep-alive. No TLS, no HTTP/2, no pipelining.',
  ],
  run: async (
    request: LoadRequest,
    options: LoadOptions,
  ): Promise<LoadSample> => {
    const args = [
      '--no-tui',
      '-w',
      '--output-format',
      'json',
      '--no-color',
      '-c',
      String(options.connections),
      '-z',
      `${options.durationSeconds}s`,
      '-m',
      request.method,
    ];
    if (request.body !== undefined) {
      args.push(
        '-d',
        request.body,
        '-T',
        request.contentType ?? 'application/json',
      );
    }
    args.push(request.url);

    const proc = Bun.spawn([binary, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0)
      throw new Error(`oha exited with ${code}: ${stderr.trim()}`);

    const report = JSON.parse(stdout) as OhaReport;
    const statuses = report.statusCodeDistribution;
    const non2xx = Object.entries(statuses)
      .filter(([code_]) => !code_.startsWith('2'))
      .reduce((total, [, count]) => total + count, 0);
    const errors = Object.entries(report.errorDistribution ?? {})
      .filter(([reason]) => reason !== DEADLINE_ABORT)
      .reduce((total, [, count]) => total + count, 0);

    return {
      requests: sum(statuses),
      elapsedSeconds: report.summary.total,
      rps: report.summary.requestsPerSec,
      latencyMeanMs: report.summary.average * 1000,
      latencyP50Ms: (report.latencyPercentiles['p50'] ?? 0) * 1000,
      latencyP99Ms: (report.latencyPercentiles['p99'] ?? 0) * 1000,
      non2xx,
      errors,
    };
  },
});

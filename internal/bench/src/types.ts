export type HttpMethod = 'GET' | 'POST';

/**
 * `go`, `rust`, `jvm` and `dotnet` need a compiler the other three do not. The
 * harness probes for each one and skips its subjects when it is absent, so a
 * checkout with only Bun and Node still produces a report - see
 * `src/toolchains.ts`.
 */
export type Runtime =
  | 'bun'
  | 'node'
  | 'go'
  | 'rust'
  | 'jvm'
  | 'dotnet'
  | 'python';

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: string | undefined;
  readonly contentType?: string | undefined;
  readonly expectStatus: number;
  readonly expectBody: string;
  readonly expectMime: string;
}

export interface Subject {
  readonly id: string;
  readonly label: string;
  readonly runtime: Runtime;
  readonly entry: string;
  readonly preload: readonly string[];
  readonly versionOf: string | null;
  readonly validator: string;
  readonly notes: readonly string[];
  /**
   * The importable package this subject needs, for a `python` subject only. Two
   * Python subjects with disjoint dependencies have to skip independently, so
   * the gate asks for this name rather than for one "is Python usable" answer.
   * It doubles as what `versionOf` reads, since `node_modules` holds neither.
   */
  readonly requires?: string;
  /**
   * Unmeasured warmup this subject needs regardless of `--warmup`. Three seconds
   * warms a JIT-free binary and a Bun process; it does not warm a JVM, and
   * reporting a cold JVM would be as dishonest as under-reporting anything else
   * here. Recorded in the report so the asymmetry is visible rather than hidden.
   */
  readonly warmupFloorSeconds?: number | undefined;
  /**
   * Environment the subject process needs beyond `PORT`, merged in by
   * `startSubject`. `DOTNET_PROCESSOR_COUNT=1` is the .NET counterpart of
   * `GOMAXPROCS(1)` and is read once as the runtime starts, so it cannot live in
   * the subject's own source the way Go's and tokio's pinning does.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface LoadRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly body?: string | undefined;
  readonly contentType?: string | undefined;
}

export interface LoadOptions {
  readonly connections: number;
  readonly durationSeconds: number;
}

export interface LoadSample {
  readonly requests: number;
  readonly elapsedSeconds: number;
  readonly rps: number;
  readonly latencyMeanMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP99Ms: number;
  readonly non2xx: number;
  readonly errors: number;
}

export interface LoadGenerator {
  readonly id: string;
  readonly version: string;
  readonly binary: string | null;
  readonly limitations: readonly string[];
  readonly run: (
    request: LoadRequest,
    options: LoadOptions,
  ) => Promise<LoadSample>;
}

export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
}

export interface ScenarioResult {
  readonly subject: string;
  readonly scenario: string;
  readonly runs: readonly LoadSample[];
  readonly rps: Spread;
  readonly latencyP50Ms: Spread;
  readonly latencyP99Ms: Spread;
  readonly totalErrors: number;
  readonly totalNon2xx: number;
}

export interface StartupResult {
  readonly subject: string;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
}

export interface MachineInfo {
  readonly cpuModel: string;
  readonly cores: number;
  readonly ramGiB: number;
  readonly platform: string;
  readonly kernel: string;
  readonly arch: string;
  readonly bun: string;
  readonly node: string;
}

export type SubjectInfo = Subject & { readonly version: string };

export interface BenchConfig {
  readonly connections: number;
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly runs: number;
  readonly startupSamples: number;
}

/** One cell of the validation harness: a server variant, a path, a validator. */
export interface ValidationUnit {
  readonly id: string;
  readonly group: 'decompose' | 'validator';
  readonly label: string;
  readonly subject: string;
  readonly validator: string;
  readonly path: string;
  readonly rps: Spread;
  readonly latencyP50Ms: Spread;
  readonly latencyP99Ms: Spread;
  readonly bad: number;
}

/** What `bun run validation` writes. Rendered by `src/validation-tables.ts`. */
export interface ValidationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly machine: MachineInfo;
  readonly loadGenerator: { readonly id: string; readonly version: string };
  readonly config: {
    readonly connections: number;
    readonly durationSeconds: number;
    readonly warmupSeconds: number;
    readonly runs: number;
  };
  readonly units: readonly ValidationUnit[];
}

/** One row of the request-logging harness: how much of the logging path is on. */
export interface LoggingUnit {
  readonly id: string;
  readonly label: string;
  readonly adds: string;
  readonly stdout: 'null' | 'blocked';
  readonly rps: Spread;
  readonly latencyP50Ms: Spread;
  readonly latencyP99Ms: Spread;
  readonly bad: number;
}

/** What `bun run logging` writes. Rendered by `src/logging-tables.ts`. */
export interface LoggingReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly machine: MachineInfo;
  readonly loadGenerator: { readonly id: string; readonly version: string };
  readonly config: {
    readonly connections: number;
    readonly durationSeconds: number;
    readonly warmupSeconds: number;
    readonly runs: number;
  };
  readonly scenario: string;
  readonly units: readonly LoggingUnit[];
}

/**
 * One compiled-language toolchain, whether it was found, and what it cost to
 * build with. `buildSeconds` is here precisely so it is *not* in the startup
 * column: a Go or Rust binary and a Spring jar are produced before any
 * measurement starts, and the startup number times the artifact, not the build.
 */
export interface ToolchainInfo {
  readonly runtime: Runtime;
  readonly label: string;
  /** `null` when the toolchain was absent and its subjects were skipped. */
  readonly version: string | null;
  readonly subjects: readonly string[];
  readonly buildSeconds: number;
}

export interface Report {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly machine: MachineInfo;
  readonly loadGenerator: {
    readonly id: string;
    readonly version: string;
    readonly binary: string | null;
    readonly limitations: readonly string[];
  };
  readonly config: BenchConfig;
  readonly toolchains: readonly ToolchainInfo[];
  readonly subjects: readonly SubjectInfo[];
  readonly scenarios: readonly Scenario[];
  readonly results: readonly ScenarioResult[];
  readonly startup: readonly StartupResult[];
}

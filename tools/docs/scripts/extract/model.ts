export const SymbolKind = Object.freeze({
  Class: 'class',
  Function: 'function',
  Interface: 'interface',
  Type: 'type',
  Variable: 'variable',
} as const);
export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

export const MemberKind = Object.freeze({
  Constructor: 'constructor',
  Method: 'method',
  Property: 'property',
  Accessor: 'accessor',
} as const);
export type MemberKind = (typeof MemberKind)[keyof typeof MemberKind];

export interface DocTag {
  readonly name: string;
  readonly text: string;
}

export interface DocComment {
  /** Markdown, already rendered to HTML. */
  readonly summary: string;
  readonly tags: readonly DocTag[];
}

export interface DocMember {
  readonly name: string;
  readonly kind: MemberKind;
  readonly signature: string;
  readonly doc: DocComment | null;
  readonly isStatic: boolean;
  readonly optional: boolean;
  readonly line: number;
}

export interface DocSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly doc: DocComment | null;
  readonly members: readonly DocMember[];
  /** Repo-relative, e.g. `packages/core/src/container.ts`. */
  readonly file: string;
  readonly line: number;
  /** Public subpaths re-exporting it (`.`, `./db`). Empty means internal. */
  readonly subpaths: readonly string[];
  readonly deprecated: boolean;
}

export interface PackageDoc {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
  readonly readme: string;
  readonly subpaths: readonly string[];
  readonly symbols: readonly DocSymbol[];
}

export interface GuidePage {
  readonly slug: string;
  readonly title: string;
  /** Repo-relative path the page was rendered from. */
  readonly source: string;
  readonly html: string;
  readonly headings: readonly { readonly id: string; readonly text: string }[];
}

export interface CoverageFile {
  readonly path: string;
  readonly lines: number;
  readonly linesHit: number;
  readonly funcs: number;
  readonly funcsHit: number;
  readonly uncovered: string;
}

export interface CoveragePackage {
  readonly name: string;
  readonly lines: number;
  readonly linesHit: number;
  readonly funcs: number;
  readonly funcsHit: number;
  readonly files: readonly CoverageFile[];
}

export interface CoverageModel {
  readonly generatedAt: string;
  readonly commit: string | null;
  readonly totals: {
    readonly lines: number;
    readonly linesHit: number;
    readonly funcs: number;
    readonly funcsHit: number;
  };
  readonly packages: readonly CoveragePackage[];
  readonly untested: readonly string[];
}

/**
 * The benchmark report, as `tools/bench` writes it to `results/latest.json`.
 * The shape is that harness's contract, documented in `tools/bench/README.md`
 * and versioned by `schemaVersion`; this is a mirror of it, not a re-derivation.
 * A build with no run emits `null` in its place.
 */
export const BENCH_SCHEMA_VERSION = 1;

export type BenchRuntime = 'bun' | 'node';

export interface BenchMachine {
  readonly cpuModel: string;
  readonly cores: number;
  readonly ramGiB: number;
  readonly platform: string;
  readonly kernel: string;
  readonly arch: string;
  readonly bun: string;
  readonly node: string;
}

export interface BenchLoadGenerator {
  readonly id: string;
  readonly version: string;
  readonly binary: string | null;
  readonly limitations: readonly string[];
}

export interface BenchConfig {
  readonly connections: number;
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly runs: number;
  readonly startupSamples: number;
}

export interface BenchSubject {
  readonly id: string;
  readonly label: string;
  readonly runtime: BenchRuntime;
  readonly version: string;
  readonly validator: string;
  readonly notes: readonly string[];
  readonly entry: string;
  readonly preload: readonly string[];
  readonly versionOf: string | null;
}

export interface BenchScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly body?: string | undefined;
  readonly contentType?: string | undefined;
  readonly expectStatus: number;
  readonly expectBody: string;
  readonly expectMime: string;
}

export interface BenchSpread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
}

export interface BenchResult {
  readonly subject: string;
  readonly scenario: string;
  readonly rps: BenchSpread;
  readonly latencyP50Ms: BenchSpread;
  readonly latencyP99Ms: BenchSpread;
  readonly totalErrors: number;
  readonly totalNon2xx: number;
}

export interface BenchStartup {
  readonly subject: string;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
}

export interface BenchModel {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly machine: BenchMachine;
  readonly loadGenerator: BenchLoadGenerator;
  readonly config: BenchConfig;
  readonly subjects: readonly BenchSubject[];
  readonly scenarios: readonly BenchScenario[];
  readonly results: readonly BenchResult[];
  readonly startup: readonly BenchStartup[];
}

export interface SiteModel {
  readonly generatedAt: string;
  readonly repoUrl: string;
  readonly packages: readonly PackageDoc[];
  readonly guides: readonly GuidePage[];
  readonly home: string;
}

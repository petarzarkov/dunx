import type {
  BenchConfig,
  MachineInfo,
  Report,
  Runtime,
  Scenario,
  ScenarioResult,
  Spread,
  StartupResult,
  SubjectInfo,
} from '../../../bench/src/types.js';

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

/**
 * A symbol as the search index and the export counts see it: enough to name it
 * and link to it, and none of the documentation that makes a `DocSymbol` large.
 */
export interface SymbolRef {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
}

/** A package without its readme or its symbol documentation. */
export interface PackageMeta {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
  readonly subpaths: readonly string[];
  /** Only what a public subpath re-exports. Internal symbols live in the body. */
  readonly exports: readonly SymbolRef[];
}

/** The half of a package only `PackagePage` renders, fetched when it opens. */
export interface PackageBody {
  readonly readme: string;
  readonly symbols: readonly DocSymbol[];
}

/**
 * `guide` pages are the hand-written tour under `docs/guide/`, ordered by the
 * numeric prefix on their filename. `reference` pages are the repo's own
 * documents at the top of `docs/`, which are written for contributors rather
 * than for someone learning the framework, so the nav keeps them apart.
 */
export type GuideCategory = 'guide' | 'reference';

export interface GuideMeta {
  readonly slug: string;
  readonly category: GuideCategory;
  /**
   * Nav heading this page sits under. Seventeen pages in one flat list tells a
   * reader nothing about which they need now and which can wait, which is the
   * work Nest's Overview / Fundamentals / Techniques split is doing.
   *
   * Empty for reference pages, which are one short group already.
   */
  readonly section: string;
  /** Position within the category. Reference pages sort alphabetically. */
  readonly order: number;
  readonly title: string;
  /** Repo-relative path the page was rendered from. */
  readonly source: string;
  readonly headings: readonly { readonly id: string; readonly text: string }[];
}

/** A guide plus the rendered body, which is the part that is loaded per route. */
export interface GuidePage extends GuideMeta {
  readonly html: string;
}

/** What one guide's chunk holds. */
export interface GuideBody {
  readonly html: string;
}

/**
 * One release from the root `CHANGELOG.md`, which `scripts/version.ts` writes.
 *
 * The heading is parsed for the version and the date; the body is rendered by
 * the same markdown pipeline every other page uses. Loaded per route rather than
 * with the index, because the whole history is far larger than the nav needs.
 */
export interface ReleaseNote {
  readonly version: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /**
   * The `?h=` target for this release, and the prefix on every heading id in
   * its body. Assigned by the generator so the page never recomputes it -
   * `slugify` lives next to the highlighter, which must not reach the browser.
   */
  readonly anchor: string;
  readonly html: string;
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
 * The benchmark report, as `internal/bench` writes it to `results/latest.json`.
 * The shape is that harness's contract, documented in `internal/bench/README.md`
 * and versioned by `schemaVersion`. A build with no run emits `null` in its place.
 */
export const BENCH_SCHEMA_VERSION = 1;

/**
 * Aliases onto the harness's own types. It owns the shape because it writes the
 * file, so a field added or renamed there is a compile error here rather than a
 * silent mismatch - which is how `toolchains` came to be in the file and not in
 * the nine interfaces that used to sit here.
 */
export type BenchRuntime = Runtime;
export type BenchMachine = MachineInfo;
export type BenchLoadGenerator = Report['loadGenerator'];
export type BenchSpread = Spread;
export type ReportSubject = SubjectInfo;
export type ReportScenario = Scenario;
export type ReportResult = ScenarioResult;
export type ReportStartup = StartupResult;
export type BenchReport = Report;
export type { BenchConfig };

/**
 * What the *site* carries, which is strictly what it renders.
 *
 * The report holds the harness's evidence - every run's samples, the request
 * bodies and expected responses each scenario asserts, each subject's entry
 * file and preloads. None of that reaches a pixel, and shipping it verbatim put
 * ~48 KB of JSON in the bundle where 19 KB says the same thing. `projectBench`
 * in `scripts/extract/bench.ts` performs the narrowing, and the flattening is
 * deliberate: a field that survives it is a field something renders.
 */
export interface BenchSubject {
  readonly id: string;
  readonly label: string;
  readonly runtime: BenchRuntime;
  readonly version: string;
  readonly validator: string;
  readonly notes: readonly string[];
}

export interface BenchScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
}

export interface BenchResult {
  readonly subject: string;
  readonly scenario: string;
  readonly rps: number;
  readonly rpsStddev: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  /** Non-2xx responses plus transport errors. Anything but 0 invalidates the row. */
  readonly bad: number;
}

export interface BenchStartup {
  readonly subject: string;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
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

/**
 * Everything the shell renders before a route is chosen: the nav, the landing
 * page, the footer and the search index. It carries no guide body and no symbol
 * documentation, because none of `/` reads either - those load per route from
 * `generated/guides/<slug>.json` and `generated/packages/<dir>.json`.
 */
/**
 * What dunx is, read from `scripts/positioning.ts` rather than written here. The
 * hero and the README's opening are the same claim to the same reader, and they
 * drifted inside one release when each held its own copy.
 */
export interface Positioning {
  readonly headline: readonly [string, string];
  readonly blurb: string;
  readonly chips: readonly string[];
}

/** A real application built on dunx, from `scripts/positioning.ts`. */
export interface ShowcaseApp {
  readonly name: string;
  readonly what: string;
  readonly repo: string;
  readonly url?: string;
  readonly scale: string;
  readonly packages: readonly string[];
}

export interface SiteIndex {
  readonly generatedAt: string;
  readonly repoUrl: string;
  readonly positioning: Positioning;
  readonly showcase: readonly ShowcaseApp[];
  readonly packages: readonly PackageMeta[];
  readonly guides: readonly GuideMeta[];
}

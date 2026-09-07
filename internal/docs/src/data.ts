import benchRaw from './generated/bench.json?raw';
import coverageRaw from './generated/coverage.json?raw';
import indexRaw from './generated/index.json?raw';
import { GUIDE_BODIES, PACKAGE_BODIES } from './generated/chunks';
import type {
  BenchModel,
  CoverageModel,
  GuideBody,
  PackageBody,
  PackageMeta,
  ReleaseNote,
  SiteIndex,
} from '../scripts/extract/model';

/**
 * `?raw` rather than a JSON import: handing the model to TypeScript as a literal
 * type costs far more than parsing it at boot. The suffix is Vite's;
 * `src/env.d.ts` types it and `happydom.ts` teaches the test runner the same
 * resolution.
 *
 * This is the *index* only. Guide bodies and package documentation are one file
 * each under `generated/`, loaded when their route opens - see `chunks.ts`.
 */
export const site = JSON.parse(indexRaw) as SiteIndex;
export const coverage = JSON.parse(coverageRaw) as CoverageModel;

/** `null` when the build had no `internal/bench/results/latest.json`. */
export const bench = JSON.parse(benchRaw) as BenchModel | null;

export const packageByDir = (dir: string): PackageMeta | undefined =>
  site.packages.find((pkg) => pkg.dir === dir);

export const guideBySlug = (slug: string) =>
  site.guides.find((guide) => guide.slug === slug);

export const hasCoverage = coverage.packages.length > 0;

type Chunk = () => Promise<{ default: string }>;

/** Parsed once per key. A route revisited in the same session refetches nothing. */
const loaded = new Map<string, unknown>();

const load = async <T>(
  table: Record<string, Chunk>,
  kind: string,
  key: string,
): Promise<T | undefined> => {
  const id = `${kind}:${key}`;
  const cached = loaded.get(id);
  if (cached !== undefined) return cached as T;

  const chunk = table[key];
  if (chunk === undefined) return undefined;

  const parsed = JSON.parse((await chunk()).default) as T;
  loaded.set(id, parsed);
  return parsed;
};

export const loadGuide = (slug: string): Promise<GuideBody | undefined> =>
  load(GUIDE_BODIES, 'guide', slug);

export const loadPackage = (dir: string): Promise<PackageBody | undefined> =>
  load(PACKAGE_BODIES, 'package', dir);

export const peekGuide = (slug: string): GuideBody | undefined =>
  loaded.get(`guide:${slug}`) as GuideBody | undefined;

export const peekPackage = (dir: string): PackageBody | undefined =>
  loaded.get(`package:${dir}`) as PackageBody | undefined;

/**
 * Files prose the page was rendered with back into the cache, out of the
 * document rather than out of a chunk.
 *
 * The build renders each page with its body already loaded, so the HTML
 * carries the prose before the bundle runs. The chunk it came from is a
 * separate file the client has not fetched, and inlining it alongside the
 * markup measured at +11.9 KB gzipped a page - so `main.tsx` hands the rendered
 * element's own `innerHTML` here instead, keyed by the `data-prose-seed` the
 * `Prose` carries.
 *
 * A package seed holds no symbols: only the readme tab is rendered on a cold
 * load, and `useChunk` replaces the whole value when the real chunk lands.
 */
export const seedProse = (seed: string, html: string): void => {
  const [kind = '', ...rest] = seed.split(':');
  const id = rest.join(':');
  if (id === '' || loaded.has(seed)) return;

  if (kind === 'guide') loaded.set(seed, { html } satisfies GuideBody);
  if (kind === 'package') {
    loaded.set(seed, { readme: html, symbols: [] } satisfies PackageBody);
  }
};

/**
 * The whole release history, in one chunk loaded when `/releases` opens. It is
 * the largest generated file and no other route reads a byte of it, so it is not
 * in the index.
 */
const RELEASE_BODIES: Record<string, Chunk> = {
  all: () => import('./generated/releases.json?raw'),
};

export const loadReleases = (): Promise<ReleaseNote[] | undefined> =>
  load(RELEASE_BODIES, 'releases', 'all');

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

/** `null` when the build had no `tools/bench/results/latest.json`. */
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

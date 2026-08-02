import benchRaw from './generated/bench.json?raw';
import coverageRaw from './generated/coverage.json?raw';
import siteRaw from './generated/site.json?raw';
import type {
  BenchModel,
  CoverageModel,
  PackageDoc,
  SiteModel,
} from '../scripts/extract/model';

/**
 * `?raw` rather than a JSON import: the model is over a megabyte, and handing
 * it to TypeScript as a literal type costs far more than parsing it at boot.
 * The suffix is Vite's; `src/env.d.ts` types it and `happydom.ts` teaches the
 * test runner the same resolution.
 */
export const site = JSON.parse(siteRaw) as SiteModel;
export const coverage = JSON.parse(coverageRaw) as CoverageModel;

/** `null` when the build had no `tools/bench/results/latest.json`. */
export const bench = JSON.parse(benchRaw) as BenchModel | null;

export const packageByDir = (dir: string): PackageDoc | undefined =>
  site.packages.find((pkg) => pkg.dir === dir);

export const guideBySlug = (slug: string) =>
  site.guides.find((guide) => guide.slug === slug);

export const hasCoverage = coverage.packages.length > 0;

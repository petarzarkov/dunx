import benchRaw from './generated/bench.json' with { type: 'text' };
import coverageRaw from './generated/coverage.json' with { type: 'text' };
import siteRaw from './generated/site.json' with { type: 'text' };
import type {
  BenchModel,
  CoverageModel,
  PackageDoc,
  SiteModel,
} from '../scripts/extract/model';

/**
 * `with { type: 'text' }` rather than a JSON import: the model is over a
 * megabyte, and handing it to TypeScript as a literal type costs far more than
 * parsing it at boot. A standard import attribute, so `Bun.build` needs no
 * plugin and no `?raw` suffix.
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

import coverageRaw from './generated/coverage.json' with { type: 'text' };
import siteRaw from './generated/site.json' with { type: 'text' };
import type {
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

export const packageByDir = (dir: string): PackageDoc | undefined =>
  site.packages.find((pkg) => pkg.dir === dir);

export const guideBySlug = (slug: string) =>
  site.guides.find((guide) => guide.slug === slug);

export const hasCoverage = coverage.packages.length > 0;

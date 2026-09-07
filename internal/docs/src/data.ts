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

/**
 * A body taken out of the document that is **not** what its chunk holds.
 *
 * Only a package needs this. A cold package page renders the readme tab alone -
 * `Tabs` is `keepMounted={false}` - so the markup carries no symbols, and the
 * seed is a `PackageBody` with an empty `symbols`. Kept out of `loaded` because
 * `load` answers from there: the seed satisfied `loadPackage`, so the API tab
 * had zero symbols for the life of the page and a `?h=symbol-*` link, which
 * opens that tab on arrival, landed on nothing.
 */
const seeded = new Map<string, unknown>();

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

/** The loaded chunk when it has arrived, and the partial seed until it does. */
export const peekPackage = (dir: string): PackageBody | undefined =>
  (loaded.get(`package:${dir}`) ?? seeded.get(`package:${dir}`)) as
    | PackageBody
    | undefined;

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
 * A guide's seed is its whole body, so it goes in `loaded` and the 65 KB chunk
 * is never fetched. A package's is partial, so it goes in `seeded` and the
 * chunk still loads to fill the API tab - see the note on that map.
 */
export const seedProse = (seed: string, html: string): void => {
  const [kind = '', ...rest] = seed.split(':');
  const id = rest.join(':');
  if (id === '') return;

  if (kind === 'guide' && !loaded.has(seed)) {
    loaded.set(seed, { html } satisfies GuideBody);
  }
  if (kind === 'package' && !seeded.has(seed)) {
    seeded.set(seed, { readme: html, symbols: [] } satisfies PackageBody);
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

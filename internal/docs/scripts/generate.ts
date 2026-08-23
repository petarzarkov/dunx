import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  buildGuide,
  renderDoc,
  siteMarkdown,
  slugify,
  type LinkTargets,
} from './content';
import { readBench } from './extract/bench';
import { highlight, paletteCss, startHighlighter } from './highlight';
import { ALL_SAMPLES, langOf } from '../src/samples';
import { extractPackage, type Manifest } from './extract/index';
import { parseChangelog } from '../../../scripts/changelog.js';
import { BLURB, CHIPS, HEADLINE } from '../../../scripts/positioning.js';
import type {
  CoverageModel,
  GuidePage,
  PackageDoc,
  ReleaseNote,
  SiteIndex,
} from './extract/model';

const TOOL_ROOT = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(TOOL_ROOT, '../..');
/**
 * Both parents that hold a published workspace. `tools/` holds the CLIs, which are
 * published and therefore documented; `internal/` is the private half and is not.
 */
const PUBLISHED_DIRS = ['packages', 'tools'] as const;
const DOCS_DIR = join(REPO_ROOT, 'docs');
const OUT_DIR = join(TOOL_ROOT, 'src', 'generated');
const GUIDES_OUT = join(OUT_DIR, 'guides');
const PACKAGES_OUT = join(OUT_DIR, 'packages');
// Created here, not next to the first write. `src/generated/` is gitignored, so
// on a clean checkout it does not exist, and a write placed above the mkdir fails
// with ENOENT only in CI. That happened once already.
mkdirSync(OUT_DIR, { recursive: true });
// Emptied rather than merged into: `chunks.ts` names every file it imports, and a
// guide deleted from `docs/` would otherwise leave a body behind that no index
// entry reaches and the next build would still bundle.
for (const dir of [GUIDES_OUT, PACKAGES_OUT]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
const BENCH_RESULTS = join(REPO_ROOT, 'internal/bench/results/latest.json');

const REPO_URL = 'https://github.com/petarzarkov/dunx';

const read = (file: string): string =>
  existsSync(file) ? readFileSync(file, 'utf8') : '';

const packageDirs = (): string[] =>
  PUBLISHED_DIRS.flatMap((parent) => {
    const parentDir = join(REPO_ROOT, parent);
    return [...new Bun.Glob('*/package.json').scanSync({ cwd: parentDir })].map(
      (rel) => resolve(join(parentDir, rel, '..')),
    );
  }).sort();

/**
 * The reference documents the site publishes, listed rather than globbed.
 *
 * `docs/` holds two things with different audiences: pages written for someone
 * evaluating or using dunx, and the maintainer's record of what was measured and
 * rejected. Globbing shipped all of both, so the site carried the benchmark
 * post-mortems, the packaging and lockstep-versioning rationale, the upstream Bun
 * bug catalogue and the roadmap - an engineering notebook, in the reader's main
 * path.
 *
 * Those pages stay in the repository, where they are read by whoever changes the
 * code. `rewriteHref` turns a link to any of them into an absolute GitHub link,
 * so unpublishing one breaks nothing.
 *
 * A new page under `docs/` is therefore repo-only until it is added here, which
 * is the direction that fails safe.
 */
const PUBLISHED_REFERENCE: readonly string[] = [
  'MIGRATION-FROM-NEST.md',
  // The two that explain the shape of the public API: no `@Injectable()`, no
  // `forwardRef`, one `Middleware` interface. The rest of `docs/architecture/`
  // is a decision record rather than documentation.
  'architecture/dependency-injection.md',
  'architecture/http.md',
];

const guideFiles = (): string[] =>
  PUBLISHED_REFERENCE.filter((file) => existsSync(join(DOCS_DIR, file)));

/**
 * The hand-written tour, ordered by the numeric prefix on each filename. The
 * prefix is how the order is stated and is stripped from the slug, so renaming
 * `05-controllers.md` to `06-controllers.md` moves the page without changing its
 * URL... which is the point: the URL should survive a reordering.
 */
const tourFiles = (): string[] =>
  [...new Bun.Glob('guide/*.md').scanSync({ cwd: DOCS_DIR })].sort();

/**
 * Which nav heading each guide sits under, keyed by **slug rather than by the
 * numeric prefix**. Coupling a section to a number range would mean renumbering a
 * page silently moved it to another section, and the prefix exists to state order,
 * not membership. A page missing here lands in the last section, so adding one is
 * never a build failure.
 */
const SECTIONS: readonly (readonly [string, readonly string[]])[] = [
  ['Getting started', ['introduction', 'first-steps']],
  [
    'Fundamentals',
    ['providers', 'modules', 'controllers', 'validation', 'lifecycle'],
  ],
  ['Techniques', ['middleware-and-guards', 'websockets', 'openapi', 'testing']],
  [
    'Infrastructure',
    [
      'configuration',
      'logging',
      'database',
      'queues',
      'scheduling',
      'authentication',
      'files-and-images',
    ],
  ],
  ['Going live', ['deployment', 'health-checks', 'agent-tooling']],
];

const sectionOf = (slug: string): string => {
  const found = SECTIONS.find(([, slugs]) => slugs.includes(slug));
  return found?.[0] ?? SECTIONS[SECTIONS.length - 1]?.[0] ?? '';
};

/**
 * `docs/ARCHITECTURE.md` -> `architecture`; `docs/architecture/logging.md` ->
 * `architecture-logging`.
 *
 * Namespaced by directory because four of the architecture pages share a name with
 * a guide - logging, database, queues, authentication - and a bare basename made
 * them collide, so one silently overwrote the other's body file.
 */
const referenceSlug = (file: string): string =>
  slugify(file.replace(/\.md$/, '').replace(/\//g, '-'));

/**
 * Reading order for the architecture pages the site publishes. A page missing
 * from here sorts last rather than failing the build.
 */
const ARCHITECTURE_ORDER: readonly string[] = [
  'architecture-dependency-injection',
  'architecture-http',
];

/** Architecture pages get their own nav heading; the rest stay under Reference. */
const referencePlacement = (
  slug: string,
): { order: number; section: string } => {
  const at = ARCHITECTURE_ORDER.indexOf(slug);
  if (at === -1) return { order: 0, section: '' };
  return { order: at + 1, section: 'Architecture' };
};

/** `docs/guide/03-providers.md` -> slug `providers`, order `3`. */
const tourSlug = (file: string): { slug: string; order: number } => {
  const base = basename(file, '.md');
  const match = /^(\d+)-(.+)$/.exec(base);
  return match?.[1] !== undefined && match[2] !== undefined
    ? { slug: slugify(match[2]), order: Number(match[1]) }
    : { slug: slugify(base), order: 0 };
};

/**
 * A guide is reachable by more than one spelling, so each gets every key a
 * source document might plausibly link it by. A tour page written as
 * `./03-providers.md` from a sibling, as `guide/03-providers.md` from the repo
 * root, or as `docs/guide/03-providers.md` from a package README all have to
 * land on the same `#/guide/providers`.
 */
const linkTargets = (
  reference: string[],
  tour: string[],
  packages: string[],
): LinkTargets => {
  const guides = new Map<string, string>();

  for (const file of reference) {
    const href = `#/guide/${referenceSlug(file)}`;
    guides.set(file, href);
    guides.set(basename(file), href);
    guides.set(`docs/${file}`, href);
    guides.set(`./${file}`, href);
  }

  for (const file of tour) {
    const href = `#/guide/${tourSlug(file).slug}`;
    guides.set(file, href);
    guides.set(basename(file), href);
    guides.set(`docs/${file}`, href);
  }

  return {
    guides,
    packages: new Map(packages.map((dir) => [dir, `#/api/${dir}`])),
  };
};

const emptyCoverage = (): CoverageModel => ({
  generatedAt: new Date().toISOString(),
  commit: null,
  totals: { lines: 0, linesHit: 0, funcs: 0, funcsHit: 0 },
  packages: [],
  untested: [],
});

const dirs = packageDirs();
const dirNames = dirs.map((dir) => basename(dir));
const targets = linkTargets(guideFiles(), tourFiles(), dirNames);

await startHighlighter();

const render = (markdown: string, self = ''): string =>
  markdown === '' ? '' : renderDoc(markdown, targets, self).html;

/**
 * A README, minus the sections that document the repo rather than the package.
 *
 * `self` is the package page's own route, so a `#anchor` link inside a README
 * scrolls instead of navigating away - a bare `#` replaces the route in a
 * hash-routed site.
 */
const renderReadme = (file: string, dir: string): string => {
  const markdown = read(file);
  return markdown === '' ? '' : render(siteMarkdown(markdown), `#/api/${dir}`);
};

const packages: PackageDoc[] = dirs.map((packageDir) => {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as Manifest;

  return extractPackage({
    repoRoot: REPO_ROOT,
    packageDir,
    manifest,
    readme: renderReadme(join(packageDir, 'README.md'), basename(packageDir)),
    render,
  });
});

const tour = tourFiles().map((file) => {
  const { slug, order } = tourSlug(file);
  return buildGuide(
    slug,
    `docs/${file}`,
    read(join(DOCS_DIR, file)),
    targets,
    slug,
    'guide',
    order,
    sectionOf(slug),
  );
});

const reference = guideFiles().map((file) => {
  const slug = referenceSlug(file);
  const { order, section } = referencePlacement(slug);
  return buildGuide(
    slug,
    `docs/${file}`,
    read(join(DOCS_DIR, file)),
    targets,
    basename(file, '.md'),
    'reference',
    order,
    section,
  );
});

const guides = [...tour, ...reference];

/**
 * The landing page's samples, highlighted here so the browser still downloads no
 * highlighter. Keyed by id; `<Highlighted>` looks them up.
 */
const samples: Record<string, string> = {};
for (const sample of ALL_SAMPLES) {
  samples[sample.id] = highlight(sample.code, langOf(sample.file));
}
writeFileSync(join(OUT_DIR, 'samples.json'), `${JSON.stringify(samples)}\n`);

/**
 * One file per route, plus an index holding only what the shell reads. The whole
 * model used to be one `site.json` imported into the entry chunk, so opening `#/`
 * downloaded all 21 guide bodies and all eight package readmes to render a page
 * that shows none of them.
 */
const bodyOf = ({ html }: GuidePage): string => JSON.stringify({ html });

for (const guide of guides) {
  writeFileSync(join(GUIDES_OUT, `${guide.slug}.json`), bodyOf(guide));
}

for (const pkg of packages) {
  writeFileSync(
    join(PACKAGES_OUT, `${pkg.dir}.json`),
    JSON.stringify({ readme: pkg.readme, symbols: pkg.symbols }),
  );
}

const site: SiteIndex = {
  generatedAt: new Date().toISOString(),
  repoUrl: REPO_URL,
  positioning: { headline: HEADLINE, blurb: BLURB, chips: CHIPS },
  packages: packages.map((pkg) => ({
    name: pkg.name,
    dir: pkg.dir,
    description: pkg.description,
    subpaths: pkg.subpaths,
    exports: pkg.symbols
      .filter((symbol) => symbol.subpaths.length > 0)
      .map(({ name, kind, line }) => ({ name, kind, line })),
  })),
  guides: guides.map(({ html: _html, ...meta }) => meta),
};

/**
 * The one module naming every body file, so each specifier is a literal the
 * bundler can split on and the test runner can resolve. A glob would be Vite-only
 * and a template literal would be a bundler feature; a generated table is neither.
 */
const table = (dir: string, keys: readonly string[]): string =>
  `{\n${keys
    .map((key) => `  '${key}': () => import('./${dir}/${key}.json?raw'),`)
    .join('\n')}\n}`;

writeFileSync(
  join(OUT_DIR, 'chunks.ts'),
  `// Generated by scripts/generate.ts. Do not edit.\ntype Chunk = () => Promise<{ default: string }>;\n\n` +
    `export const GUIDE_BODIES: Record<string, Chunk> = ${table(
      'guides',
      guides.map((guide) => guide.slug),
    )};\n\n` +
    `export const PACKAGE_BODIES: Record<string, Chunk> = ${table(
      'packages',
      packages.map((pkg) => pkg.dir),
    )};\n`,
);

/**
 * The release history, from the `CHANGELOG.md` that `scripts/version.ts` writes.
 *
 * Each release's body goes through `render`, so an entry's links are rewritten
 * the same way a guide's are. The ids `renderDoc` assigns are namespaced by
 * version afterwards: it de-duplicates within one document, and every release
 * has its own "Features" heading, so thirty-five of them on one page would
 * otherwise share an id.
 */
const releases: ReleaseNote[] = parseChangelog(
  read(join(REPO_ROOT, 'CHANGELOG.md')),
).map(({ version, date, body }) => {
  const anchor = slugify(version);
  return {
    version,
    date,
    anchor,
    html: render(body, '#/releases').replace(/ id="/g, ` id="${anchor}-`),
  };
});

writeFileSync(join(OUT_DIR, 'releases.json'), JSON.stringify(releases));

const bench = readBench(BENCH_RESULTS);

writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(site));
writeFileSync(join(OUT_DIR, 'bench.json'), JSON.stringify(bench));
// Last: every highlight() call above has interned its colours by now.
writeFileSync(join(OUT_DIR, 'shiki.css'), `${paletteCss()}\n`);

// Coverage is produced by scripts/coverage-report.ts, which runs after the test
// suite - later than this in CI. Seed an empty model so the site always builds.
const coveragePath = join(OUT_DIR, 'coverage.json');
if (!existsSync(coveragePath)) {
  writeFileSync(coveragePath, JSON.stringify(emptyCoverage()));
}

const symbolCount = packages.reduce((sum, pkg) => sum + pkg.symbols.length, 0);
const publicCount = packages.reduce(
  (sum, pkg) => sum + pkg.symbols.filter((s) => s.subpaths.length > 0).length,
  0,
);

console.log(
  `docs: ${packages.length} packages, ${publicCount} public / ${symbolCount} exported symbols, ` +
    `${guides.length} guides, ` +
    (bench
      ? `${bench.results.length} benchmark cells from ${bench.generatedAt}`
      : 'no benchmark run'),
);

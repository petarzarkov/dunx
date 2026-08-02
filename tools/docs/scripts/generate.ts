import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  buildGuide,
  renderDoc,
  siteMarkdown,
  slugify,
  type LinkTargets,
} from './content';
import { readBench } from './extract/bench';
import { extractPackage, type Manifest } from './extract/index';
import type { CoverageModel, PackageDoc, SiteModel } from './extract/model';

const TOOL_ROOT = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(TOOL_ROOT, '../..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const OUT_DIR = join(TOOL_ROOT, 'src', 'generated');
const BENCH_RESULTS = join(REPO_ROOT, 'tools/bench/results/latest.json');

const REPO_URL = 'https://github.com/petarzarkov/dunx';

const read = (file: string): string =>
  existsSync(file) ? readFileSync(file, 'utf8') : '';

const packageDirs = (): string[] =>
  [...new Bun.Glob('*/package.json').scanSync({ cwd: PACKAGES_DIR })]
    .map((rel) => join(PACKAGES_DIR, rel, '..'))
    .map((dir) => resolve(dir))
    .sort();

const guideFiles = (): string[] =>
  [...new Bun.Glob('*.md').scanSync({ cwd: DOCS_DIR })].sort();

const linkTargets = (guides: string[], packages: string[]): LinkTargets => ({
  guides: new Map(
    guides.map((file) => [file, `#/guide/${slugify(basename(file, '.md'))}`]),
  ),
  packages: new Map(packages.map((dir) => [dir, `#/api/${dir}`])),
});

const emptyCoverage = (): CoverageModel => ({
  generatedAt: new Date().toISOString(),
  commit: null,
  totals: { lines: 0, linesHit: 0, funcs: 0, funcsHit: 0 },
  packages: [],
  untested: [],
});

const dirs = packageDirs();
const dirNames = dirs.map((dir) => basename(dir));
const targets = linkTargets(guideFiles(), dirNames);

const render = (markdown: string): string =>
  markdown === '' ? '' : renderDoc(markdown, targets).html;

/** A README, minus the sections that document the repo rather than the package. */
const renderReadme = (file: string): string => {
  const markdown = read(file);
  return markdown === '' ? '' : render(siteMarkdown(markdown));
};

const packages: PackageDoc[] = dirs.map((packageDir) => {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as Manifest;

  return extractPackage({
    repoRoot: REPO_ROOT,
    packageDir,
    manifest,
    readme: renderReadme(join(packageDir, 'README.md')),
    render,
  });
});

const guides = guideFiles().map((file) =>
  buildGuide(
    slugify(basename(file, '.md')),
    `docs/${file}`,
    read(join(DOCS_DIR, file)),
    targets,
    basename(file, '.md'),
  ),
);

const site: SiteModel = {
  generatedAt: new Date().toISOString(),
  repoUrl: REPO_URL,
  packages,
  guides,
  home: renderReadme(join(REPO_ROOT, 'README.md')),
};

const bench = readBench(BENCH_RESULTS);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'site.json'), JSON.stringify(site));
writeFileSync(join(OUT_DIR, 'bench.json'), JSON.stringify(bench));

// Coverage is produced by scripts/coverage-report.ts, which runs after the test
// suite — later than this in CI. Seed an empty model so the site always builds.
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

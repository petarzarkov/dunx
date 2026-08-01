import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CoverageModel } from '../tools/docs/scripts/extract/model.js';

/**
 * Turns the root `bun test --coverage` lcov into the model the documentation
 * site renders, plus the README's badge SVGs.
 *
 * The report used to be a standalone HTML page published as the GitHub Pages
 * root. `tools/docs` is the Pages root now, so this writes *into* it: the model
 * to `src/generated/`, the badges to `public/badges/` where the build copies them
 * verbatim into the deployed site.
 */

const ROOT_DIR = resolve(import.meta.dir, '..');
const PACKAGES_DIR = join(ROOT_DIR, 'packages');
const COVERAGE_DIR = join(ROOT_DIR, 'coverage');
const LCOV_PATH = join(COVERAGE_DIR, 'lcov.info');
const DOCS_DIR = join(ROOT_DIR, 'tools', 'docs');
const MODEL_DIR = join(DOCS_DIR, 'src', 'generated');
const BADGE_DIR = join(DOCS_DIR, 'public', 'badges');

interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
  uncovered: number[];
}

interface PackageCoverage {
  name: string;
  files: FileCoverage[];
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
}

/**
 * Weighted total, as lcov/istanbul define it. Note this will not match bun's own
 * `All files` row in the text reporter — that one is an unweighted mean of the
 * per-file percentages, so a tiny fully-covered file counts as much as a big one.
 */
const pct = (hit: number, found: number): number =>
  found === 0 ? 100 : (hit / found) * 100;

const format = (value: number): string =>
  value === 100 ? '100' : value.toFixed(1);

const parseLcov = (raw: string): FileCoverage[] => {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;

  for (const line of raw.split('\n')) {
    const [key, value] = line.split(':');
    if (!key) continue;

    if (key === 'SF') {
      current = {
        path: value!,
        linesFound: 0,
        linesHit: 0,
        funcsFound: 0,
        funcsHit: 0,
        uncovered: [],
      };
      continue;
    }

    if (!current) continue;

    switch (key) {
      case 'LF':
        current.linesFound = Number(value);
        break;
      case 'LH':
        current.linesHit = Number(value);
        break;
      case 'FNF':
        current.funcsFound = Number(value);
        break;
      case 'FNH':
        current.funcsHit = Number(value);
        break;
      case 'DA': {
        const [lineNo, hits] = value!.split(',');
        if (Number(hits) === 0) current.uncovered.push(Number(lineNo));
        break;
      }
      case 'end_of_record':
        files.push(current);
        current = null;
        break;
    }
  }

  return files;
};

/** Collapses [3,4,5,9] into "3-5, 9" so long gap lists stay readable. */
const formatRanges = (lines: number[]): string => {
  if (lines.length === 0) return '';

  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = start;

  for (const line of sorted.slice(1)) {
    if (previous && line === previous + 1) {
      previous = line;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);

  return ranges.join(', ');
};

const groupByPackage = (files: FileCoverage[]): PackageCoverage[] => {
  const packages = new Map<string, PackageCoverage>();

  for (const file of files) {
    const name = file.path.match(/^packages\/([^/]+)\//)?.[1];
    if (!name) continue;

    let pkg = packages.get(name);
    if (!pkg) {
      pkg = {
        name,
        files: [],
        linesFound: 0,
        linesHit: 0,
        funcsFound: 0,
        funcsHit: 0,
      };
      packages.set(name, pkg);
    }

    pkg.files.push(file);
    pkg.linesFound += file.linesFound;
    pkg.linesHit += file.linesHit;
    pkg.funcsFound += file.funcsFound;
    pkg.funcsHit += file.funcsHit;
  }

  for (const pkg of packages.values()) {
    pkg.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const findUntestedPackages = (covered: Set<string>): string[] =>
  readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !covered.has(entry.name) &&
        existsSync(join(PACKAGES_DIR, entry.name, 'package.json')),
    )
    .map((entry) => entry.name);

/** `null` means the package has no test files at all, which is not the same as 0%. */
const badge = (value: number | null): string => {
  const text = value === null ? 'no tests' : `${format(value)}%`;
  const color =
    value === null
      ? '#6e7681'
      : value >= 90
        ? '#3fb950'
        : value >= 75
          ? '#d29922'
          : '#f85149';
  const labelWidth = 62;
  const valueWidth = 8 + text.length * 7;
  const total = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="coverage: ${text}">
  <title>coverage: ${text}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">coverage</text>
    <text x="${labelWidth / 2}" y="14">coverage</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${text}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${text}</text>
  </g>
</svg>
`;
};

if (!existsSync(LCOV_PATH)) {
  console.error(
    `No coverage data at ${LCOV_PATH}. Run \`bun test --coverage\` first.`,
  );
  process.exit(1);
}

const files = parseLcov(readFileSync(LCOV_PATH, 'utf-8'));
const packages = groupByPackage(files);
const untested = findUntestedPackages(new Set(packages.map((p) => p.name)));

const totals = packages.reduce(
  (acc, pkg) => ({
    linesFound: acc.linesFound + pkg.linesFound,
    linesHit: acc.linesHit + pkg.linesHit,
    funcsFound: acc.funcsFound + pkg.funcsFound,
    funcsHit: acc.funcsHit + pkg.funcsHit,
  }),
  { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 },
);

const totalLines = pct(totals.linesHit, totals.linesFound);

const model: CoverageModel = {
  generatedAt: new Date().toISOString(),
  commit: process.env['GITHUB_SHA'] ?? null,
  totals: {
    lines: totals.linesFound,
    linesHit: totals.linesHit,
    funcs: totals.funcsFound,
    funcsHit: totals.funcsHit,
  },
  packages: packages.map((pkg) => ({
    name: pkg.name,
    lines: pkg.linesFound,
    linesHit: pkg.linesHit,
    funcs: pkg.funcsFound,
    funcsHit: pkg.funcsHit,
    files: pkg.files.map((file) => ({
      path: file.path,
      lines: file.linesFound,
      linesHit: file.linesHit,
      funcs: file.funcsFound,
      funcsHit: file.funcsHit,
      uncovered: formatRanges(file.uncovered),
    })),
  })),
  untested,
};

mkdirSync(MODEL_DIR, { recursive: true });
mkdirSync(BADGE_DIR, { recursive: true });

writeFileSync(join(MODEL_DIR, 'coverage.json'), JSON.stringify(model));
writeFileSync(join(BADGE_DIR, 'coverage.svg'), badge(totalLines));

for (const pkg of packages) {
  writeFileSync(
    join(BADGE_DIR, `coverage-${pkg.name}.svg`),
    badge(pct(pkg.linesHit, pkg.linesFound)),
  );
}

for (const name of untested) {
  writeFileSync(join(BADGE_DIR, `coverage-${name}.svg`), badge(null));
}

console.log(
  `Coverage model: ${format(totalLines)}% lines across ${packages.length} packages (${files.length} files) -> ${relative(ROOT_DIR, MODEL_DIR)}/coverage.json`,
);
console.log(
  `Badges: coverage.svg + ${packages.length + untested.length} per-package -> ${relative(ROOT_DIR, BADGE_DIR)}/`,
);
if (untested.length) {
  console.log(`No tests in: ${untested.join(', ')}`);
}

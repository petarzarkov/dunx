import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CoverageModel } from '../internal/docs/scripts/extract/model.js';
import { PUBLISHED_DIRS } from './workspace-ranges.js';

/**
 * Turns the root `bun test --coverage` lcov into the model the documentation
 * site renders, plus the README's badge SVGs.
 *
 * The report used to be a standalone HTML page published as the GitHub Pages
 * root. `internal/docs` is the Pages root now, so this writes *into* it: the model
 * to `src/generated/`, the badges to `public/badges/` where the build copies them
 * verbatim into the deployed site.
 */

const ROOT_DIR = resolve(import.meta.dir, '..');
/** Every parent that holds a published workspace, so a tool gets a badge too. */
const COVERAGE_DIR = join(ROOT_DIR, 'coverage');
/**
 * The floor every published workspace clears, on lines **and** on functions.
 * `badge()` already paints at or above this green, so the gate and the badge
 * cannot disagree. A workspace with no tests at all counts as 0.
 */
const MIN_COVERAGE = 90;
const LCOV_PATH = join(COVERAGE_DIR, 'lcov.info');
const DOCS_DIR = join(ROOT_DIR, 'internal', 'docs');
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
 * `All files` row in the text reporter - that one is an unweighted mean of the
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

/**
 * Both published parents, not just `packages/`. `tools/create-app` and `tools/mcp`
 * moved out of `packages/` when it became misleading to call a scaffolder part of
 * the framework, and this pattern did not move with them - so both reported as
 * having no tests while their lcov entries sat in the file unread. The list of
 * parents is already `PUBLISHED_DIRS`; this is the same question asked of a path.
 */
const PACKAGE_PATH = new RegExp(`^(?:${PUBLISHED_DIRS.join('|')})/([^/]+)/`);

const groupByPackage = (files: FileCoverage[]): PackageCoverage[] => {
  const packages = new Map<string, PackageCoverage>();

  for (const file of files) {
    const name = PACKAGE_PATH.exec(file.path)?.[1];
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
  PUBLISHED_DIRS.flatMap((parent) => {
    const parentDir = join(ROOT_DIR, parent);
    return readdirSync(parentDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !covered.has(entry.name) &&
          existsSync(join(parentDir, entry.name, 'package.json')),
      )
      .map((entry) => entry.name);
  });

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

// Written through a rename: the documentation site imports this file, and
// `bun run ci` runs the phase that generates it beside the phase that reads it.
// A partial `writeFileSync` is a `JSON.parse` failure in the other process.
const modelPath = join(MODEL_DIR, 'coverage.json');
writeFileSync(`${modelPath}.tmp`, JSON.stringify(model));
renameSync(`${modelPath}.tmp`, modelPath);

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

const rows = [
  ...packages.map((pkg) => ({
    name: pkg.name,
    lines: pct(pkg.linesHit, pkg.linesFound),
    funcs: pct(pkg.funcsHit, pkg.funcsFound),
  })),
  ...untested.map((name) => ({ name, lines: 0, funcs: 0 })),
].sort((a, b) => a.lines - b.lines);

const below = (value: number): boolean => value < MIN_COVERAGE;
const failing = rows.filter((row) => below(row.lines) || below(row.funcs));
const mark = (value: number): string => (below(value) ? '❌' : '✅');

/**
 * Rendered into the job summary as well as the log, because a percentage buried
 * in 14 seconds of test output is a percentage nobody reads.
 */
const table = [
  `| Package | Lines | Functions |`,
  `| --- | --- | --- |`,
  ...rows.map(
    (row) =>
      `| \`${row.name}\` | ${mark(row.lines)} ${format(row.lines)}% | ${mark(row.funcs)} ${format(row.funcs)}% |`,
  ),
].join('\n');

const headline = `${format(totalLines)}% lines, ${format(pct(totals.funcsHit, totals.funcsFound))}% functions, floor ${MIN_COVERAGE}%`;

const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
if (summaryPath !== undefined) {
  appendFileSync(
    summaryPath,
    [
      `## Coverage`,
      ``,
      failing.length === 0
        ? `${headline}. Every workspace clears it.`
        : `${headline}. **${failing.length} below the floor:** ${failing.map((row) => row.name).join(', ')}.`,
      ``,
      table,
      ``,
    ].join('\n'),
  );
}

console.log(`\n${headline}`);
console.log(table);

if (failing.length > 0) {
  console.error(`\nBelow ${MIN_COVERAGE}%:`);

  for (const row of failing) {
    console.error(
      `  ${row.name}: ${format(row.lines)}% lines, ${format(row.funcs)}% functions`,
    );

    /**
     * The files to open, not just the number. A margin of half a point moves on
     * any commit, and "infra is at 89.8%" reads as a regression when it is a
     * rounding move; the worst files say which is which.
     */
    // Ranked on the axis that actually failed: a package under on functions alone
    // listed nothing when the ranking was by line gap.
    const onLines = below(row.lines);
    const gap = (file: FileCoverage): number =>
      onLines
        ? file.linesFound - file.linesHit
        : file.funcsFound - file.funcsHit;

    const worst = (packages.find((pkg) => pkg.name === row.name)?.files ?? [])
      .filter((file) => gap(file) > 0)
      .sort((a, b) => gap(b) - gap(a))
      .slice(0, 3);

    for (const file of worst) {
      const shown = onLines
        ? `${format(pct(file.linesHit, file.linesFound))}%  ${file.linesHit}/${file.linesFound} lines`
        : `${format(pct(file.funcsHit, file.funcsFound))}%  ${file.funcsHit}/${file.funcsFound} functions`;
      console.error(`    ${shown}  ${relative(ROOT_DIR, file.path)}`);
    }
  }
  process.exit(1);
}

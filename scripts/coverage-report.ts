import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dir, '..');
const PACKAGES_DIR = join(ROOT_DIR, 'packages');
const COVERAGE_DIR = join(ROOT_DIR, 'coverage');
const LCOV_PATH = join(COVERAGE_DIR, 'lcov.info');

const REPO_URL = 'https://github.com/petarzarkov/dunx';

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

const level = (value: number): 'high' | 'medium' | 'low' =>
  value >= 90 ? 'high' : value >= 75 ? 'medium' : 'low';

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
    if (line === previous + 1) {
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

const fileRow = (file: FileCoverage): string => {
  const lines = pct(file.linesHit, file.linesFound);
  const name = file.path.replace(/^packages\/[^/]+\//, '');

  return `<tr>
  <td class="file">${name}</td>
  <td class="num ${level(lines)}">${format(lines)}%</td>
  <td class="num">${file.linesHit}/${file.linesFound}</td>
  <td class="num">${file.funcsHit}/${file.funcsFound}</td>
  <td class="gaps">${formatRanges(file.uncovered) || '—'}</td>
</tr>`;
};

const packageSection = (pkg: PackageCoverage): string => {
  const lines = pct(pkg.linesHit, pkg.linesFound);
  const funcs = pct(pkg.funcsHit, pkg.funcsFound);

  return `<details id="${pkg.name}"${lines < 90 ? ' open' : ''}>
  <summary>
    <span class="pkg">@dunx/${pkg.name}</span>
    <span class="bar"><span class="fill ${level(lines)}" style="width:${lines}%"></span></span>
    <span class="pct ${level(lines)}">${format(lines)}%</span>
    <span class="meta">${pkg.files.length} files · ${format(funcs)}% functions</span>
  </summary>
  <table>
    <thead><tr><th>File</th><th>Lines</th><th>Covered</th><th>Functions</th><th>Uncovered lines</th></tr></thead>
    <tbody>${pkg.files.map(fileRow).join('\n')}</tbody>
  </table>
</details>`;
};

const page = (
  packages: PackageCoverage[],
  untested: string[],
  totals: {
    linesFound: number;
    linesHit: number;
    funcsFound: number;
    funcsHit: number;
  },
): string => {
  const lines = pct(totals.linesHit, totals.linesFound);
  const funcs = pct(totals.funcsHit, totals.funcsFound);
  const sha = process.env.GITHUB_SHA;
  const stamp = new Date().toUTCString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dunx coverage</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --panel: #f6f8fa;
  --high: #1a7f37; --medium: #9a6700; --low: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d; --panel: #161b22;
    --high: #3fb950; --medium: #d29922; --low: #f85149;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 68rem;
  background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
a { color: inherit; }
.sub { color: var(--muted); font-size: .875rem; margin: 0 0 2rem; }
.totals { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
.card {
  flex: 1 1 12rem; padding: 1rem 1.25rem; border: 1px solid var(--line);
  border-radius: 8px; background: var(--panel);
}
.card .value { font-size: 2rem; font-weight: 600; line-height: 1.1; }
.card .label { color: var(--muted); font-size: .8125rem; text-transform: uppercase; letter-spacing: .04em; }
details { border: 1px solid var(--line); border-radius: 8px; margin-bottom: .625rem; background: var(--panel); scroll-margin-top: 1rem; }
details:target { box-shadow: 0 0 0 2px var(--medium); }
summary {
  display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem;
  cursor: pointer; flex-wrap: wrap; list-style: none;
}
/* A flex summary drops the native disclosure marker, so draw our own. */
summary::-webkit-details-marker { display: none; }
summary::before { content: '\\25B8'; color: var(--muted); font-size: .75rem; }
details[open] > summary::before { content: '\\25BE'; }
.pkg { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
.bar { flex: 1 1 8rem; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; min-width: 6rem; }
.fill { display: block; height: 100%; }
.fill.high { background: var(--high); } .fill.medium { background: var(--medium); } .fill.low { background: var(--low); }
.pct { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 3.5rem; text-align: right; }
.meta { color: var(--muted); font-size: .8125rem; flex-basis: 100%; }
.high { color: var(--high); } .medium { color: var(--medium); } .low { color: var(--low); }
table { width: 100%; border-collapse: collapse; font-size: .8125rem; display: block; overflow-x: auto; }
th, td { padding: .375rem 1rem; text-align: left; border-top: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
.file { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.gaps { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: normal; }
.untested { color: var(--muted); font-size: .875rem; margin-top: 2rem; }
.untested code { font-size: .8125rem; }
</style>
</head>
<body>
<h1>dunx coverage</h1>
<p class="sub">
  ${packages.length} packages · generated ${stamp}
  ${sha ? `· <a href="${REPO_URL}/commit/${sha}">${sha.slice(0, 7)}</a>` : ''}
  · <a href="${REPO_URL}">repository</a>
</p>

<div class="totals">
  <div class="card">
    <div class="value ${level(lines)}">${format(lines)}%</div>
    <div class="label">Lines</div>
  </div>
  <div class="card">
    <div class="value ${level(funcs)}">${format(funcs)}%</div>
    <div class="label">Functions</div>
  </div>
  <div class="card">
    <div class="value">${totals.linesHit}<span class="label"> / ${totals.linesFound}</span></div>
    <div class="label">Lines covered</div>
  </div>
</div>

${packages.map(packageSection).join('\n')}

${
  untested.length
    ? `<p class="untested">No test files found in: ${untested.map((n) => `<code>@dunx/${n}</code>`).join(', ')}</p>`
    : ''
}
<script>
  // Per-package badges link to #<package>; expand that row so the deep link lands on
  // the file table rather than a collapsed summary.
  const openTarget = () => {
    if (!/^#[a-z0-9-]+$/i.test(location.hash)) return;
    document.querySelector('details' + location.hash)?.setAttribute('open', '');
  };
  openTarget();
  addEventListener('hashchange', openTarget);
</script>
</body>
</html>
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

writeFileSync(
  join(COVERAGE_DIR, 'index.html'),
  page(packages, untested, totals),
);
writeFileSync(join(COVERAGE_DIR, 'coverage.svg'), badge(totalLines));

for (const pkg of packages) {
  writeFileSync(
    join(COVERAGE_DIR, `coverage-${pkg.name}.svg`),
    badge(pct(pkg.linesHit, pkg.linesFound)),
  );
}

for (const name of untested) {
  writeFileSync(join(COVERAGE_DIR, `coverage-${name}.svg`), badge(null));
}

console.log(
  `Coverage report: ${format(totalLines)}% lines across ${packages.length} packages (${files.length} files)`,
);
console.log(
  `Badges: coverage.svg + ${packages.length + untested.length} per-package`,
);
if (untested.length) {
  console.log(`No tests in: ${untested.join(', ')}`);
}

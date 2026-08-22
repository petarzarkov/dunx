/**
 * Regenerates the two blocks that are derived from the workspace manifests:
 * the "Packages" table in README.md, and the "Project Structure" tree in
 * CONTRIBUTING.md.
 *
 * They live in different files on purpose. The README is read by someone deciding
 * whether to install this, and a directory listing answers no question they have;
 * the tree is orientation for someone about to change the repo, which is what
 * CONTRIBUTING is for.
 *
 * Usage:
 *   bun ./scripts/update-readme.ts
 *   bun run gen:readme
 *   bun run gen:readme --check     # fail if either block is stale, write nothing
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
/**
 * Where a **published** workspace can live: `packages/` for the framework,
 * `tools/` for the CLIs. `internal/` is deliberately absent - it is the private
 * half and has nothing to put in a table of things people install.
 */
const PUBLISHED_DIRS = ['packages', 'tools'] as const;
const README_PATH = join(ROOT, 'README.md');
const CONTRIBUTING_PATH = join(ROOT, 'CONTRIBUTING.md');

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
}

function readPkg(parent: string, folder: string): PackageJson | null {
  const pkgPath = join(ROOT, parent, folder, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

interface PackageEntry {
  parent: string;
  folder: string;
  pkg: PackageJson;
}

function discoverPackages(): PackageEntry[] {
  return PUBLISHED_DIRS.flatMap((parent) =>
    readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((d) => {
        const pkg = readPkg(parent, d.name);
        return pkg ? [{ parent, folder: d.name, pkg }] : [];
      }),
  );
}

const DOCS_SITE = 'https://petarzarkov.github.io/dunx';
const COVERAGE_PAGE = `${DOCS_SITE}/#/coverage`;

function npmBadges(name: string): string {
  const encoded = encodeURIComponent(name);
  const npmUrl = `https://www.npmjs.com/package/${encoded}`;
  const version = `[![npm](https://img.shields.io/npm/v/${encoded})](${npmUrl})`;
  const downloads = `[![dls](https://img.shields.io/npm/dt/${encoded}?label=dls)](${npmUrl})`;
  const size = `[![size](https://img.shields.io/npm/unpacked-size/${encoded}?label=size)](${npmUrl})`;
  return `${version} ${downloads} ${size}`;
}

/**
 * Badge svgs are generated per package by `bun run gen:cov` into
 * `internal/docs/public/badges/`, which the build copies to `/badges/` in the deployed
 * documentation site.
 */
function coverageBadge(folder: string): string {
  return `[![cov](${DOCS_SITE}/badges/coverage-${folder}.svg)](${COVERAGE_PAGE})`;
}

function buildPackagesTable(entries: PackageEntry[]): string {
  const header = '| Package | Npm | Coverage | Description |';
  const divider = '|---------|---------|----------|-------------|';

  const rows = entries
    .filter((e) => !e.pkg.private)
    .map(({ parent, folder, pkg }) => {
      const link = `[\`${pkg.name}\`](./${parent}/${folder})`;
      const badges = npmBadges(pkg.name);
      const cov = coverageBadge(folder);
      const desc = pkg.description ?? '';
      return `| ${link} | ${badges} | ${cov} | ${desc} |`;
    });

  return [header, divider, ...rows].join('\n');
}

interface TreeNode {
  prefix: string;
  branch: string;
  name: string;
  comment: string;
}

function buildProjectStructure(entries: PackageEntry[]): string {
  const describe = (pkg: PackageJson): string =>
    // Split on '. ' to avoid breaking "Day.js"
    pkg.description ? (pkg.description.split('. ')[0] ?? pkg.name) : pkg.name;

  /** A published parent and the workspaces under it, as indented children. */
  const childrenOf = (parent: string): TreeNode[] => {
    const own = entries.filter((entry) => entry.parent === parent);
    return own.map(({ folder, pkg }, i) => ({
      prefix: '│   ',
      branch: i === own.length - 1 ? '└── ' : '├── ',
      name: folder,
      comment: describe(pkg),
    }));
  };

  const topDefs: [string, string, string][] = [
    ['├── ', 'packages/', 'The published framework'],
    ['├── ', 'tools/', 'Published CLIs - the scaffolder and the MCP server'],
    [
      '├── ',
      'internal/',
      'Private workspaces, never published - docs site, benchmarks, API explorer, shared UI',
    ],
    ['├── ', 'examples/', 'Private apps that consume the packages'],
    ['├── ', 'docs/', 'Architecture and design docs'],
    ['├── ', 'scripts/', 'Monorepo-level scripts'],
    ['├── ', '.github/workflows/', 'CI/CD pipeline'],
    ['└── ', '.husky/', 'Git hooks'],
  ];

  // Each published parent is followed by its own workspaces; the rest stand alone.
  const rendered: TreeNode[] = topDefs.flatMap(([branch, name, comment]) => [
    { prefix: '', branch, name, comment },
    ...childrenOf(name.replace('/', '')),
  ]);

  const maxKey = Math.max(
    ...rendered.map((n) => n.prefix.length + n.branch.length + n.name.length),
  );
  const fmt = (n: TreeNode): string => {
    const key = `${n.prefix}${n.branch}${n.name}`;
    return `${key.padEnd(maxKey)}  # ${n.comment}`;
  };

  return ['```', 'dunx/', ...rendered.map(fmt), '```'].join('\n');
}

/**
 * Everything between a `## ` header and the next one, or the end of the file.
 */
const sectionPattern = (heading: string): RegExp =>
  new RegExp(
    `(## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)([\\s\\S]*?)(?=\\n## |$)`,
  );

/**
 * Replace the body of a markdown section, or report that there is no such section.
 *
 * **The distinction is the whole point of this returning a discriminated result.**
 * The first version compared the rewritten string against the original and aborted
 * when they were equal, which conflated "this heading does not exist" with "this
 * block was already correct" - so the script failed on every run where there was
 * nothing to do, which is most of them. It worked once after a real change and
 * errored from then on, and neither CI nor a test ran it, so nothing said so.
 */
type SectionResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unchanged'; readonly content: string }
  | { readonly kind: 'rewritten'; readonly content: string };

function replaceSection(
  content: string,
  heading: string,
  newBody: string,
): SectionResult {
  const pattern = sectionPattern(heading);
  if (!pattern.test(content)) return { kind: 'missing' };
  const next = content.replace(pattern, `$1\n${newBody}\n`);
  return next === content
    ? { kind: 'unchanged', content }
    : { kind: 'rewritten', content: next };
}

const entries = discoverPackages();

if (entries.length === 0) {
  console.error('No packages found under packages/ or tools/. Aborting.');
  process.exit(1);
}

const check = process.argv.includes('--check');

interface Target {
  readonly file: string;
  readonly path: string;
  readonly heading: string;
  readonly body: string;
}

const targets: readonly Target[] = [
  {
    file: 'README.md',
    path: README_PATH,
    heading: 'Packages',
    body: buildPackagesTable(entries),
  },
  {
    file: 'CONTRIBUTING.md',
    path: CONTRIBUTING_PATH,
    heading: 'Project Structure',
    body: buildProjectStructure(entries),
  },
];

/**
 * Both files are resolved before either is written.
 *
 * The previous version wrote README.md and then aborted on CONTRIBUTING.md, which
 * left the repo half-regenerated - the state most likely to get committed without
 * anyone noticing, because the file someone was looking at did change.
 */
const resolved: { readonly target: Target; readonly result: SectionResult }[] =
  targets.map((target) => ({
    target,
    result: replaceSection(
      readFileSync(target.path, 'utf8'),
      target.heading,
      target.body,
    ),
  }));

const missing = resolved.filter(({ result }) => result.kind === 'missing');
if (missing.length > 0) {
  for (const { target } of missing) {
    console.error(
      `No "## ${target.heading}" section found in ${target.file}. Aborting.`,
    );
  }
  process.exit(1);
}

const stale = resolved.filter(({ result }) => result.kind === 'rewritten');

if (check) {
  if (stale.length === 0) {
    console.log(
      `Both generated blocks are current (${entries.length} packages).`,
    );
    process.exit(0);
  }
  for (const { target } of stale) {
    console.error(
      `${target.file} has a stale "## ${target.heading}" block. Run \`bun run gen:readme\`.`,
    );
  }
  process.exit(1);
}

for (const { target, result } of resolved) {
  if (result.kind === 'rewritten')
    writeFileSync(target.path, result.content, 'utf8');
}

const names = entries.map((e) => e.pkg.name).join(', ');
console.log(
  stale.length === 0
    ? `Already current: ${entries.length} packages, nothing to rewrite.`
    : `Updated ${stale.map(({ target }) => target.file).join(' and ')} ` +
        `with ${entries.length} packages:\n  ${names}`,
);

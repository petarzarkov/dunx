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
 * Replace the body of a markdown section.
 * Matches everything between the section header
 * and the next `## ` header (or end of file).
 */
function replaceSection(
  content: string,
  heading: string,
  newBody: string,
): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(## ${escaped}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  return content.replace(pattern, `$1\n${newBody}\n`);
}

const entries = discoverPackages();

if (entries.length === 0) {
  console.error('No packages found under packages/ or tools/. Aborting.');
  process.exit(1);
}

/** A section that silently fails to match would leave a stale block behind. */
const replaceOrFail = (
  content: string,
  heading: string,
  body: string,
  file: string,
): string => {
  const next = replaceSection(content, heading, body);
  if (next === content) {
    console.error(`No "## ${heading}" section found in ${file}. Aborting.`);
    process.exit(1);
  }
  return next;
};

const readme = replaceOrFail(
  readFileSync(README_PATH, 'utf8'),
  'Packages',
  buildPackagesTable(entries),
  'README.md',
);
writeFileSync(README_PATH, readme, 'utf8');

const contributing = replaceOrFail(
  readFileSync(CONTRIBUTING_PATH, 'utf8'),
  'Project Structure',
  buildProjectStructure(entries),
  'CONTRIBUTING.md',
);
writeFileSync(CONTRIBUTING_PATH, contributing, 'utf8');

const names = entries.map((e) => e.pkg.name).join(', ');
console.log(
  `Updated README.md (packages table) and CONTRIBUTING.md (project structure) ` +
    `with ${entries.length} packages:\n  ${names}`,
);

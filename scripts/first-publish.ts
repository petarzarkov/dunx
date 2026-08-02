/**
 * The **first** publish of a package, and nothing else. `scripts/version.ts` owns
 * every later release through CI and OIDC; this exists only because a package
 * with no versions on npm has no trusted-publisher settings page yet, so the
 * first one has to go up against a personal `npm login`.
 *
 *   bunx npm@11.10.1 login
 *   DRY=true bun scripts/first-publish.ts    # read it first
 *   bun scripts/first-publish.ts             # 2FA prompts in a browser
 *
 * `DUNX_VERSION` overrides the version, which defaults to 0.1.0. Publishing is
 * idempotent per package only in the sense that npm refuses a version that
 * already exists — rerunning after a partial failure will fail on the packages
 * that already went up, which is safe but noisy. Set `DUNX_VERSION` or trim
 * `ORDER` to resume.
 *
 * It does the one thing a bare `npm publish` would get wrong: `workspace:*` is
 * not expanded by npm, so every internal range is rewritten to the concrete
 * version around the publish and the manifest restored afterwards. The assertion
 * is the same one `version.ts` runs — an unresolved range reaching npm breaks
 * every consumer install.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = process.env['DUNX_VERSION'] ?? '0.1.0';
const DRY = process.env['DRY'] === 'true';
const NPM = 'bunx npm@11.10.1';
const FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Dependency order: a package is published after everything it references. */
const ORDER = [
  'core',
  'transform',
  'create-app',
  'http',
  'infra',
  'openapi',
  'auth',
  'testing',
];

const root = new URL('../packages', import.meta.url).pathname;

type Manifest = { name: string; version: string } & Record<string, unknown>;

const assertResolved = (pkg: Manifest): void => {
  const bad: string[] = [];
  for (const field of FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (range.startsWith('workspace:')) bad.push(`${field}.${name}=${range}`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `${pkg.name}: unresolved workspace ranges ${bad.join(', ')}`,
    );
  }
};

/**
 * The packument at `registry.npmjs.org/<name>` 404s for minutes after a brand-new
 * package is first published — CDN lag, not failure. The per-version document is
 * immediate and is what makes this script resumable: a rerun after a partial
 * failure skips what already went up instead of failing on it.
 */
const alreadyPublished = async (
  name: string,
  version: string,
): Promise<boolean> => {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`;
  const response = await fetch(url, { method: 'HEAD' });
  return response.ok;
};

let publishedThisRun = 0;

for (const dir of ORDER) {
  const path = join(root, dir, 'package.json');
  const original = readFileSync(path, 'utf-8');
  const pkg = JSON.parse(original) as Manifest;

  if (!DRY && (await alreadyPublished(pkg.name, VERSION))) {
    console.log(`skipped ${pkg.name}@${VERSION} — already on npm`);
    continue;
  }

  // npm rate-limits bursts of new-package publishes with a 403 that reads like a
  // permissions error. Measured: four in a row went through, the fifth did not.
  if (publishedThisRun > 0 && !DRY) await Bun.sleep(5000);

  pkg.version = VERSION;
  for (const field of FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith('workspace:')) continue;
      const suffix = range.slice('workspace:'.length);
      deps[name] =
        suffix === '*' || suffix === '' ? VERSION : `${suffix}${VERSION}`;
    }
  }
  assertResolved(pkg);

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    const flags = DRY ? '--dry-run' : '';
    // stdio is inherited, not piped. npm's 2FA is a browser flow that prints a
    // URL and then waits on the terminal — piping it makes the publish fail with
    // EOTP no matter what the user does.
    // No --provenance: it requires GITHUB_ACTIONS and errors anywhere else.
    const proc = Bun.spawnSync(
      [
        'sh',
        '-c',
        `cd ${join(root, dir)} && ${NPM} publish --access public ${flags}`,
      ],
      { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
    );
    if (proc.exitCode !== 0) {
      console.error(`\nFAIL ${pkg.name} — stopping before the rest.`);
      process.exit(1);
    }
    console.log(
      `${DRY ? 'would publish' : 'published'} ${pkg.name}@${VERSION}`,
    );
  } finally {
    // Restore the source manifest, keeping the new version.
    const restored = JSON.parse(original) as Manifest;
    restored.version = VERSION;
    writeFileSync(path, `${JSON.stringify(restored, null, 2)}\n`);
  }
}

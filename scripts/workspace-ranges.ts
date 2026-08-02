import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a `workspace:` range becomes in a published tarball, and the assertion that
 * one never survives into it.
 *
 * This lives apart from `version.ts` because two scripts publish: `version.ts` for
 * every release through CI, and `first-publish.ts` for the one manual publish a
 * package needs before a trusted publisher can be attached to it. Each had its own
 * copy of the rewrite, so a change to the range policy could reach one and not the
 * other - and the manual path is the one with no CI check behind it.
 */
const WORKSPACE_PROTOCOL = 'workspace:';

/**
 * The three fields a consumer's installer reads. `devDependencies` is deliberately
 * absent: it ships in the manifest but nothing installs it, so leaving
 * `workspace:*` there is both harmless and honest about what the range is for.
 */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface Manifest {
  name?: string;
  [field: string]: unknown;
}

export const isWorkspaceRange = (range: string): boolean =>
  range.startsWith(WORKSPACE_PROTOCOL);

/**
 * `workspace:*` publishes as `^<version>`, not as the exact version.
 *
 * Exact was the original behaviour and it is a hazard. Every internal `@dunx/*`
 * range is a `peerDependency`, so `@dunx/http@0.2.0` declaring
 * `"@dunx/core": "0.2.0"` accepts core 0.2.0 and nothing else. A consumer who wrote
 * `"@dunx/core": "^0.2.0"` and resolved 0.2.1 then gets a peer warning from bun, an
 * `ERESOLVE` failure from npm, or a nested second copy of core - and a second copy
 * of core is a second `Logger` class, so `app.get(Logger)` misses a binding the user
 * can plainly see is bound. That is the exact failure lockstep versioning exists to
 * prevent, arriving through the peer range instead.
 *
 * A caret is never worse than exact and is better across a patch series. Its known
 * pre-1.0 limit - `^0.2.0` excludes `0.3.0` - is not a regression, because an exact
 * pin excludes `0.2.1` as well. That limit is why **independent** versions still
 * need a range policy settled first, and why versioning stays lockstep: under
 * lockstep the caret can never be stale, since every package in a release carries
 * the same number as the peer it names.
 *
 * An explicit specifier is kept as written, so `workspace:~` still means `~`.
 */
export const resolveWorkspaceRange = (
  range: string,
  version: string,
): string => {
  const specifier = range.slice(WORKSPACE_PROTOCOL.length);
  return specifier === '*' || specifier === ''
    ? `^${version}`
    : `${specifier}${version}`;
};

/**
 * Rewrites every workspace range in `pkg` in place, returning one `name: from ->
 * to` line per rewrite so the caller can log what it did. An empty array means
 * there was nothing to rewrite, which is not an error.
 */
export const resolveWorkspaceDeps = (
  pkg: Manifest,
  versionFor: (name: string) => string | undefined,
): string[] => {
  const rewritten: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [name, range] of Object.entries(deps)) {
      if (!isWorkspaceRange(range)) continue;

      const version = versionFor(name);
      if (!version) {
        throw new Error(
          `${pkg.name} depends on ${name} via "${range}" but no workspace package named ${name} was found`,
        );
      }

      deps[name] = resolveWorkspaceRange(range, version);
      rewritten.push(`${name}: ${range} -> ${deps[name]}`);
    }
  }

  return rewritten;
};

/**
 * The last thing between a `workspace:` range and a published tarball.
 *
 * `npm publish` copies these ranges verbatim, so a package shipped with
 * `"@dunx/core": "workspace:*"` fails to install for every consumer. The rewrite
 * above is the mechanism that prevents it - this asserts the mechanism actually
 * ran, because the first publish of a package has to be done by hand (OIDC trusted
 * publishing cannot attach to a package that does not exist yet). That manual path
 * is exactly where this would otherwise slip through, and it now spans five
 * packages rather than one since `@dunx/core` and `@dunx/http` became peers.
 */
export const assertNoWorkspaceRanges = (pkg: Manifest): void => {
  const offenders: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (isWorkspaceRange(range)) {
        offenders.push(`${field}.${name} = "${range}"`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to publish ${pkg.name ?? 'package'}: unresolved workspace ` +
        `ranges would ship and break every consumer install - ` +
        offenders.join(', '),
    );
  }
};

/** Every workspace package's current version, keyed by its published name. */
export const readWorkspaceVersions = (
  packagesDir: string,
): Map<string, string> => {
  const versions = new Map<string, string>();

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Manifest;
    if (typeof pkg.name === 'string' && typeof pkg['version'] === 'string') {
      versions.set(pkg.name, pkg['version']);
    }
  }

  return versions;
};

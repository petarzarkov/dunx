import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';

/**
 * Enforces the CLAUDE.md rule requiring an exact version in `dependencies` and
 * `devDependencies`. What a manifest says should be what is installed: with a
 * range it is not, and `bun update --latest` proved it - zod moved 4.4.3 to
 * 4.5.4 and every `^4.4.3` manifest stayed as it was.
 *
 * `>=5.0.0` is a range as much as `^5.0.0` is, so the check is "matches
 * `1.2.3`" rather than "has no caret".
 *
 * `peerDependencies` are exempt and must stay ranges. A peer states which
 * versions the package works with, and pinning one to an exact version makes a
 * consumer's patch bump an install conflict.
 *
 * Only `workspace:*` is exempt, not `workspace:` generally: the publish resolver
 * turns `workspace:^` into `^<version>`, so that spelling would ship a range
 * through the exemption.
 */
const PINNED_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

/** Anything that is not a bare `1.2.3`. `>=5.0.0` is a range too. */
const NOT_EXACT = /^(?!\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$)/;

/** The one workspace spelling that publishes as an exact version. */
const WORKSPACE = 'workspace:*';

interface Manifest {
  readonly path: string;
  readonly json: Record<string, Record<string, string> | undefined>;
}

const manifests = async (): Promise<Manifest[]> => {
  const paths = [
    'package.json',
    ...[
      ...new Glob('{packages,tools,internal,examples}/*/package.json').scanSync(
        '.',
      ),
    ].sort(),
  ];
  return Promise.all(
    paths.map(async (path) => ({
      path,
      json: (await Bun.file(path).json()) as Manifest['json'],
    })),
  );
};

describe('dependency versions are exact', () => {
  it('has no range in a pinned section', async () => {
    const offences: string[] = [];

    for (const { path, json } of await manifests()) {
      for (const section of PINNED_SECTIONS) {
        for (const [name, spec] of Object.entries(json[section] ?? {})) {
          if (spec === WORKSPACE) continue;
          if (NOT_EXACT.test(spec)) {
            offences.push(`${path} [${section}] ${name}: ${spec}`);
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });

  /**
   * The other half of the rule. A peer pinned exactly is the failure this guard
   * exists to prevent in the opposite direction: it would force every consumer
   * onto one version of zod, drizzle or better-auth.
   */
  it('keeps peerDependencies as ranges', async () => {
    const offences: string[] = [];

    for (const { path, json } of await manifests()) {
      for (const [name, spec] of Object.entries(
        json['peerDependencies'] ?? {},
      )) {
        if (spec === WORKSPACE) continue;
        // `>=`, `*` and `x || y` are ranges too; only a bare version is a pin.
        if (/^\d/.test(spec)) {
          offences.push(`${path} [peerDependencies] ${name}: ${spec}`);
        }
      }
    }

    expect(offences).toEqual([]);
  });

  /**
   * A pin is only true if it is what the resolver produced. This catches a
   * hand-edited version that no install has ever seen.
   */
  it('pins what is actually installed', async () => {
    const offences: string[] = [];

    for (const { path, json } of await manifests()) {
      const dir =
        path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length);
      for (const section of PINNED_SECTIONS) {
        for (const [name, spec] of Object.entries(json[section] ?? {})) {
          if (spec === WORKSPACE || NOT_EXACT.test(spec)) continue;
          const installed = await Promise.all(
            [dir, '.'].map(async (base) => {
              const file = Bun.file(
                `${base}/node_modules/${name}/package.json`,
              );
              return (await file.exists())
                ? ((await file.json()) as { version: string }).version
                : undefined;
            }),
          );
          const version = installed.find((value) => value !== undefined);
          if (version === undefined) {
            // A pin naming a package no install produced is the other way this
            // can be hand-edited into a lie. `optionalDependencies` are exempt:
            // a platform-specific one is legitimately absent here.
            if (section !== 'optionalDependencies') {
              offences.push(
                `${path} [${section}] ${name}: ${spec} is not installed`,
              );
            }
          } else if (version !== spec) {
            offences.push(
              `${path} [${section}] ${name}: ${spec} installed ${version}`,
            );
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });
});

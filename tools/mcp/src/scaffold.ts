export interface ScaffoldFeature {
  /** The name the prompt lists and `scaffold({ features })` takes. */
  readonly name: string;
  readonly summary: string;
  /** Features this one imports from. `bunx @dunx/create-app` pulls them in. */
  readonly requires: readonly string[];
  /** What the generated manifest gains, beyond what every app already has. */
  readonly dependencies: readonly string[];
  /** A service that has to be running for the feature to do anything. */
  readonly service?: string;
}

export interface StarterFile {
  readonly path: string;
  readonly body: string;
}

import { ownVersion } from './own-version.js';

/**
 * Every `@dunx/*` version in the starter manifest is this placeholder, resolved
 * when the starter is served rather than when the corpus is generated.
 *
 * Versioning is lockstep, so the right version to install is the one that
 * answered. Writing the version in at generation time made the committed corpus
 * a release behind the moment `scripts/version.ts` bumped the manifests: 3.5.1
 * would have shipped a starter pinning 3.5.0, and the corpus drift test would
 * have failed on the next push to main. `@dunx/create-app` spells the same string
 * for the same reason; `gen-mcp-corpus.test.ts` holds the two to each other.
 */
export const VERSION_PLACEHOLDER = '__DUNX_VERSION__';

export interface Starter {
  /** From this package's own `engines.bun`, so it cannot claim a version it is not built against. */
  readonly runtime: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly files: readonly StarterFile[];
}

export interface Step {
  readonly run: string;
  readonly why: string;
}

/**
 * A rule a dunx app breaks by omission. The list is declared by
 * `@dunx/create-app` and bundled at generation time; the shape is restated here so
 * this package's `.d.ts` does not make `@dunx/create-app` a typing peer. The
 * generator annotates its return with this type, so the two cannot drift without a
 * compile error.
 */
export interface BootRule {
  readonly rule: string;
  readonly detail: string;
}

export interface Bunfig {
  readonly path: string;
  readonly contents: string;
  readonly why: string;
}

/**
 * What `bunx @dunx/create-app` can generate, and the smallest app it generates,
 * bundled into this package from `tools/create-app`'s own catalogue and from
 * `examples/minimal`. Both are what CI builds and boots, so neither can describe a
 * template that no longer works.
 *
 * Nothing here writes a file. It answers what a scaffold would contain, which is
 * what an agent about to write one needs; `bunx @dunx/create-app` is what writes.
 */
export class Scaffold {
  constructor(
    private readonly catalogue: readonly ScaffoldFeature[],
    private readonly minimal: Starter,
    /**
     * What {@link VERSION_PLACEHOLDER} resolves to. Defaults to this package's own
     * version, which is the answer in every real use; it is a parameter so a test
     * can assert the substitution without reading a manifest, and defaulted rather
     * than required because `Scaffold` is exported and a third argument would be a
     * breaking change.
     */
    private readonly version: string = ownVersion(),
  ) {}

  /**
   * Name or summary, because a caller asks for a capability and the catalogue is
   * keyed by folder. `queue` matched nothing while `jobs` was described as
   * "bullmq queues over Bun.RedisClient"; so did `redis`, twice over.
   */
  features(name?: string): readonly ScaffoldFeature[] {
    if (name === undefined) return this.catalogue;
    const wanted = name.toLowerCase();
    return this.catalogue.filter(
      (feature) =>
        feature.name.toLowerCase().includes(wanted) ||
        feature.summary.toLowerCase().includes(wanted),
    );
  }

  /** The starter with its `@dunx/*` versions resolved to this release's. */
  starter(): Starter {
    return {
      ...this.minimal,
      files: this.minimal.files.map((file) =>
        file.body.includes(VERSION_PLACEHOLDER)
          ? {
              ...file,
              body: file.body.replaceAll(VERSION_PLACEHOLDER, this.version),
            }
          : file,
      ),
    };
  }

  /**
   * The install commands for an app that is not being scaffolded - an existing
   * project adopting dunx, which is the case `bunx @dunx/create-app` does not cover.
   */
  steps(): readonly Step[] {
    // An empty list would render `bun add ` with nothing after it, which is a
    // command an agent would run and a person would have to diagnose.
    const install = (flag: string, names: readonly string[], why: string) =>
      names.length === 0
        ? []
        : [{ run: `bun add ${flag}${names.join(' ')}`, why }];

    return [
      ...install(
        '',
        this.minimal.dependencies,
        'The container, the Bun.serve adapter, and the constructor-dependency transform.',
      ),
      ...install(
        '-d ',
        this.minimal.devDependencies,
        'A test app with overrides against a real server on port 0, plus the toolchain the starter tsconfig.json needs.',
      ),
    ];
  }

  /**
   * The file rather than a command that appends to it. `echo 'preload = [...]' >>
   * bunfig.toml` writes a bare key onto the end, so a file ending inside `[install]`
   * or `[run]` takes the key into that table and the top-level preload never
   * applies: every provider with constructor parameters then fails at boot. It also
   * left out the `[test]` copy, which is a second boot failure under `bun test`.
   *
   * The contents are the starter's own `bunfig.toml`, so this cannot drift from
   * what `bunx @dunx/create-app` writes.
   */
  bunfig(): Bunfig | undefined {
    const file = this.starter().files.find(
      (entry) => entry.path === 'bunfig.toml',
    );
    if (file === undefined) return undefined;
    return {
      path: 'bunfig.toml',
      contents: file.body,
      why: 'Constructor injection needs the preload, and `[test]` needs its own copy. Merge these keys into an existing bunfig.toml at the top level rather than appending them, or a trailing table captures them.',
    };
  }
}

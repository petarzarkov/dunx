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
  ) {}

  features(name?: string): readonly ScaffoldFeature[] {
    if (name === undefined) return this.catalogue;
    const wanted = name.toLowerCase();
    return this.catalogue.filter((feature) =>
      feature.name.toLowerCase().includes(wanted),
    );
  }

  starter(): Starter {
    return this.minimal;
  }

  /**
   * The install commands for an app that is not being scaffolded - an existing
   * project adopting dunx, which is the case `bunx @dunx/create-app` does not cover.
   */
  steps(): readonly Step[] {
    return [
      {
        run: `bun add ${this.minimal.dependencies.join(' ')}`,
        why: 'The container, the Bun.serve adapter, and the constructor-dependency transform.',
      },
      {
        run: `bun add -d ${this.minimal.devDependencies.join(' ')}`,
        why: 'A test app with overrides, against a real server on port 0.',
      },
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
    const file = this.minimal.files.find(
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

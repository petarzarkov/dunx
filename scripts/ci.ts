/**
 * Every gate CI runs, in one command.
 *
 * `bun run ci` builds first, then runs every other phase at the same time -
 * the same graph `.github/workflows/ci.yml` expresses as parallel jobs. The
 * workflow calls this script one phase per job (`bun run ci static`) instead of
 * restating the commands, and `scripts/ci.test.ts` fails when the two disagree.
 *
 * `bun run ci <phase> [<phase>...]` runs only those. `bun run ci --list` names
 * them.
 *
 * Each step's output is captured and printed only when that step fails, so a
 * green run is one line per step rather than the request logs of 900 tests.
 */
import { relative } from 'node:path';

interface Step {
  readonly name: string;
  readonly run: readonly string[];
  /**
   * How many trailing lines of this step's output to print when it passes, for a
   * step whose *number* is the point. A green `coverage` job otherwise reported
   * nothing about coverage, and answering "what did infra score" meant downloading
   * the lcov artifact. A tail rather than all of it: `--coverage-reporter` on the
   * command line does not override `coverageReporter` in bunfig, so the per-file
   * text report is 370 lines ahead of the table that matters.
   */
  readonly echo?: number;
}

interface Phase {
  readonly name: string;
  readonly summary: string;
  /** Steps run at the same time when true, in order when false. */
  readonly concurrent: boolean;
  /**
   * Left out of a bare `bun run ci`, and named explicitly instead. Only for a
   * phase another phase already covers - see `unit`.
   */
  readonly onRequest?: boolean;
  readonly steps: readonly Step[];
}

const root = new URL('..', import.meta.url).pathname;

/**
 * `build` first because everything else needs `dist/`: type-aware lint resolves
 * a workspace import through the package's `types` entry, `examples/*` consume
 * packages through their published `exports`, and the docs site is a workspace
 * with a `build` script of its own.
 *
 * The four after it share nothing and are ordered longest-first, so a phase
 * failing early is the one most likely to have found something.
 */
export const PHASES: readonly Phase[] = Object.freeze([
  {
    name: 'build',
    summary: 'Every workspace, in dependency order',
    concurrent: false,
    steps: [{ name: 'build', run: ['bun', 'run', 'build'] }],
  },
  {
    name: 'docs',
    summary: 'The documentation site suite',
    concurrent: false,
    steps: [
      // No `--parallel` here, and it is not an oversight: a worker resolves an
      // `import x from './y.json?raw'` as a JSON module rather than as text, so
      // `src/data.ts` throws and 8 of the 12 files bail. Measured on Bun 1.4.0
      // and still reproducing on 1.4.1, recorded in docs/bun-apis.md.
      // `src/symbol-anchor.test.tsx` is 13.1s of this phase's 17.4s on its own.
      { name: 'test', run: ['bun', 'run', '--filter', '@dunx/docs', 'test'] },
    ],
  },
  {
    name: 'unit',
    summary: 'Packages, tools, repo scripts and the private workspaces',
    concurrent: false,
    /**
     * `coverage` runs these same files, so a bare `bun run ci` runs them once,
     * there. In CI the two are separate jobs on separate runners, and the
     * difference is no longer speed - `coverage` is `--parallel` too since Bun
     * 1.4.1, so both are under four seconds. What separates them is that
     * `coverage` declares valkey, Postgres and MinIO, and `unit` deliberately
     * declares none: those suites skip without a service, which is what makes
     * `unit` the fast signal and `coverage` the gate.
     *
     * Running both at once here was not merely wasteful. Both drive the local
     * Redis that `describe.if(live)` looks for, and one queue test failed once
     * under the contention of the full run and never in six runs of the sweep
     * alone.
     */
    onRequest: true,
    steps: [
      // One process over every suite with `--parallel`, which is 2.7s against
      // 13.5s for the same files run in one worker. Coverage is not on it
      // because the `coverage` phase runs these same files with the backing
      // services attached, which is the denominator the 90% floor was set from.
      {
        name: 'test',
        run: [
          'bun',
          'test',
          './packages',
          './tools',
          './scripts',
          '--parallel',
          // templates/ holds a working app whose test cannot resolve from here,
          // and a scaffold written into a gitignored `tmp/` is one of those apps
          // too - `bunx @dunx/create-app tmp/test` used to fail this phase.
          '--path-ignore-patterns=**/templates/**',
          '--path-ignore-patterns=**/tmp/**',
        ],
      },
      // The sweep above is ./packages ./tools ./scripts. These three are the
      // rest of internal/*, and nothing ran them until this phase existed.
      {
        name: 'internal',
        run: [
          'bun',
          'run',
          '--filter',
          '@dunx/ui',
          '--filter',
          '@dunx/dashboard-ui',
          '--filter',
          '@dunx/bench',
          'test',
        ],
      },
    ],
  },
  {
    name: 'examples',
    summary: 'Every example, the tour and every scaffold selection',
    concurrent: false,
    steps: [
      {
        name: 'tests',
        run: [
          'bun',
          'run',
          '--parallel',
          '--filter',
          '@dunx/example-*',
          'test',
        ],
      },
      // `start` is a long-running service, so it can never exit 0. `tour` boots
      // the same app, narrates every package and exits.
      {
        name: 'tour',
        run: ['bun', 'run', '--filter', '@dunx/example-full', 'tour'],
      },
      // The one example with no HTTP. SQLite always runs; Postgres and MySQL
      // report that they are skipping and it still exits 0.
      {
        name: 'databases',
        run: ['bun', 'run', '--filter', '@dunx/example-databases', 'start'],
      },
      { name: 'scaffolds', run: ['bun', 'run', 'check:scaffolds'] },
    ],
  },
  {
    name: 'browser',
    summary: 'The built site in a real browser',
    concurrent: false,
    steps: [
      // Needs `dist/` from the build phase and a Chrome on the machine, which
      // `ubuntu-latest` ships. `Bun.WebView` drives that one rather than
      // downloading a browser, and the suite runs from `internal/docs/browser`
      // so the happy-dom preload does not replace the global `Response`.
      {
        name: 'site',
        run: ['bun', 'run', '--filter', '@dunx/docs', 'test:browser'],
      },
    ],
  },
  {
    name: 'coverage',
    summary: 'The coverage model and the badges the site renders',
    concurrent: false,
    // `test:cov` runs `--parallel`. It could not until Bun 1.4.1, which fixed
    // `--coverage --parallel` under-reporting functions for a file whose
    // functions ran in different workers. Re-measured on the whole sweep: three
    // parallel runs and one sequential run agree to the digit, per package and
    // in total, and the phase went 13.5s to 2.6s. See docs/bun-apis.md.
    steps: [{ name: 'test:cov', run: ['bun', 'run', 'test:cov'], echo: 20 }],
  },
  {
    name: 'static',
    summary: 'Lint, format, types and the generated README blocks',
    concurrent: true,
    steps: [
      // The check variants, never `lint`/`format`: those fix in place, which
      // would let a violation pass and never reach the repo.
      { name: 'lint', run: ['bun', 'run', 'lint:check'] },
      { name: 'format', run: ['bun', 'run', 'format:check'] },
      { name: 'typecheck', run: ['bun', 'run', 'typecheck'] },
      { name: 'readme', run: ['bun', 'run', 'gen:readme', '--check'] },
    ],
  },
]);

interface Result {
  readonly label: string;
  readonly ok: boolean;
  readonly output: string;
}

const ms = (nanos: number): string => `${(nanos / 1e9).toFixed(1)}s`;

const runStep = async (phase: Phase, step: Step): Promise<Result> => {
  const label = `${phase.name}/${step.name}`;
  const started = Bun.nanoseconds();
  console.log(`▶ ${label}`);

  const proc = Bun.spawn([...step.run], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  /**
   * Both pipes into one buffer as the chunks arrive, rather than reading each to a
   * string and concatenating. `bun test` writes its report to stderr and a script's
   * own `console.log` to stdout, so `out` followed by `err` put the coverage table
   * 370 lines *above* the run that produced it, and put every failure output in the
   * wrong order the same way.
   */
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
  };

  const [code] = await Promise.all([
    proc.exited,
    drain(proc.stdout),
    drain(proc.stderr),
  ]);

  const ok = code === 0;
  console.log(`${ok ? '✓' : '✗'} ${label} ${ms(Bun.nanoseconds() - started)}`);

  const output = chunks.join('');
  const tail = step.echo ?? 0;
  if (ok && tail > 0) {
    console.log(
      output
        .trimEnd()
        .split('\n')
        .slice(-tail)
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }

  return { label, ok, output };
};

const runPhase = async (phase: Phase): Promise<Result[]> => {
  if (phase.concurrent) {
    return Promise.all(phase.steps.map((step) => runStep(phase, step)));
  }

  const results: Result[] = [];
  for (const step of phase.steps) {
    const result = await runStep(phase, step);
    results.push(result);
    // Sequential steps in a phase are ordered because the later ones are only
    // worth running once the earlier ones hold.
    if (!result.ok) break;
  }
  return results;
};

const report = (results: readonly Result[], started: number): number => {
  const failed = results.filter((result) => !result.ok);
  const elapsed = ms(Bun.nanoseconds() - started);

  console.log(
    `\n${results.length} step(s), ${results.length - failed.length} passed, ${failed.length} failed in ${elapsed}`,
  );

  for (const failure of failed) {
    console.log(`\n── ${failure.label} ──`);
    console.log(failure.output.trimEnd());
  }

  if (failed.length > 0) {
    console.log(
      `\nFailed: ${failed.map((failure) => failure.label).join(', ')}`,
    );
  }
  return failed.length === 0 ? 0 : 1;
};

const usage = (): void => {
  console.log(`bun run ci [<phase>...]\n`);
  for (const phase of PHASES) {
    const steps = phase.steps.map((step) => step.name).join(', ');
    const mark = phase.onRequest === true ? ' (on request)' : '';
    console.log(
      `  ${phase.name.padEnd(9)} ${phase.summary}${mark}\n${' '.repeat(12)}${steps}`,
    );
  }
  const onRequest = PHASES.filter((phase) => phase.onRequest === true).map(
    (phase) => phase.name,
  );
  console.log(
    `\nNo phase given: ${PHASES[0]?.name} first, then the rest together.`,
  );
  if (onRequest.length > 0) {
    console.log(
      `On request only, because another phase covers it: ${onRequest.join(', ')}.`,
    );
  }
};

if (import.meta.main) {
  const argv = process.argv.slice(2);

  if (argv.includes('--list') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  const unknown = argv.filter(
    (name) => !PHASES.some((phase) => phase.name === name),
  );
  if (unknown.length > 0) {
    console.error(`Unknown phase: ${unknown.join(', ')}\n`);
    usage();
    process.exit(2);
  }

  const started = Bun.nanoseconds();
  const results: Result[] = [];

  if (argv.length > 0) {
    for (const name of argv) {
      const phase = PHASES.find((candidate) => candidate.name === name);
      if (phase) results.push(...(await runPhase(phase)));
    }
    process.exit(report(results, started));
  }

  const [first, ...others] = PHASES;
  if (!first) throw new Error('No phases declared');
  const rest = others.filter((phase) => phase.onRequest !== true);

  console.log(
    `${relative(process.cwd(), root) || '.'}: ${rest.length + 1} phases, ${[first, ...rest].flatMap((phase) => phase.steps).length} steps`,
  );

  results.push(...(await runPhase(first)));
  // Nothing downstream can pass without dist/, so a failed build is the answer.
  if (results.every((result) => result.ok)) {
    const parallel = await Promise.all(rest.map(runPhase));
    results.push(...parallel.flat());
  }

  process.exit(report(results, started));
}

/**
 * Builds every workspace that has a `build` script, in dependency order.
 *
 * `bun run --filter '*' build` orders by `dependencies` alone. That is fine
 * while every internal edge is a real dependency, and wrong the moment one
 * becomes a `peerDependency`: moving `@dunx/core` to a peer was tried and
 * `@dunx/http` failed with `TS7016`, because `tsc` raced core's own `.d.ts`
 * emit. Bun was not told the two were related, so it built them together.
 *
 * This orders by `dependencies` **and** `peerDependencies` **and**
 * `devDependencies`, restricted to workspace packages, which is what makes
 * peers safe. Packages with no edge between them still build concurrently - the
 * sort produces waves, not a queue, so the common case costs nothing.
 *
 * Run directly (`bun scripts/build-all.ts`) or through `bun run build`.
 */
import { Glob } from 'bun';

interface Workspace {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];
}

const root = new URL('..', import.meta.url).pathname;

const manifests = async (): Promise<Workspace[]> => {
  const glob = new Glob('{packages,tools,examples}/*/package.json');
  const found: Workspace[] = [];

  for await (const rel of glob.scan({ cwd: root })) {
    const file = Bun.file(`${root}${rel}`);
    const json = (await file.json()) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (json.name === undefined || json.scripts?.['build'] === undefined) {
      continue;
    }
    found.push({
      name: json.name,
      dir: `${root}${rel.slice(0, -'/package.json'.length)}`,
      // Every kind of edge counts. A peer or dev edge still means "this
      // package's types must exist before mine compile".
      deps: [
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
        ...Object.keys(json.peerDependencies ?? {}),
      ],
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Kahn's algorithm, emitting one wave per round rather than a flat order, so
 * independent packages keep building at the same time.
 */
export const waves = (all: readonly Workspace[]): Workspace[][] => {
  const names = new Set(all.map((workspace) => workspace.name));
  const pending = new Map(
    all.map((workspace) => [
      workspace.name,
      new Set(workspace.deps.filter((dep) => names.has(dep))),
    ]),
  );

  const rounds: Workspace[][] = [];
  const done = new Set<string>();

  while (done.size < all.length) {
    const ready = all.filter(
      (workspace) =>
        !done.has(workspace.name) &&
        [...(pending.get(workspace.name) ?? [])].every((dep) => done.has(dep)),
    );

    if (ready.length === 0) {
      const stuck = all
        .filter((workspace) => !done.has(workspace.name))
        .map((workspace) => workspace.name);
      throw new Error(
        `Dependency cycle between workspaces: ${stuck.join(', ')}`,
      );
    }

    rounds.push(ready);
    for (const workspace of ready) done.add(workspace.name);
  }

  return rounds;
};

const build = async (workspace: Workspace): Promise<void> => {
  const started = Bun.nanoseconds();
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: workspace.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const ms = ((Bun.nanoseconds() - started) / 1e6).toFixed(0);
  if (code !== 0) {
    console.error(`✗ ${workspace.name} (${ms}ms)\n${out}${err}`);
    throw new Error(`${workspace.name} failed to build`);
  }
  console.log(`✓ ${workspace.name} (${ms}ms)`);
};

if (import.meta.main) {
  const all = await manifests();
  const rounds = waves(all);
  const started = Bun.nanoseconds();

  for (const [index, round] of rounds.entries()) {
    console.log(
      `wave ${index + 1}/${rounds.length}: ${round.map((w) => w.name).join(', ')}`,
    );
    await Promise.all(round.map(build));
  }

  console.log(
    `built ${all.length} workspaces in ${((Bun.nanoseconds() - started) / 1e6).toFixed(0)}ms`,
  );
}

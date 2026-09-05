import { root } from './paths.js';
import type { Scenario, Subject } from './types.js';

export interface SubjectProcess {
  readonly baseUrl: string;
  readonly startupMs: number;
  readonly stop: () => Promise<void>;
}

const READY_TIMEOUT_MS = 20_000;
/** How long a profiled subject gets to write its profile and exit. */
const GRACEFUL_TIMEOUT_MS = 5_000;

export const freePort = async (): Promise<number> => {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  });
  const port = Number(probe.url.port);
  await probe.stop(true);
  return port;
};

/**
 * Which profile to write, if any. `'cpu'` and `'heap'` add Bun's own profiler
 * flags to a Bun subject, so no separate tool is involved.
 */
export type ProfileKind = 'cpu' | 'heap';

/**
 * Bun writes both a machine-readable profile and a markdown one. The markdown is
 * readable in a terminal, which is what makes the flags worth having here rather
 * than reaching for an external profiler.
 *
 * Only Bun subjects can take these. Asking for a profile of the Node or JVM
 * subject silently gets nothing, so the caller checks `subject.runtime` first.
 */
export const profileFlags = (
  kind: ProfileKind | undefined,
  dir: string,
): readonly string[] =>
  kind === undefined
    ? []
    : kind === 'cpu'
      ? ['--cpu-prof', '--cpu-prof-md', `--cpu-prof-dir=${dir}`]
      : ['--heap-prof', '--heap-prof-md', `--heap-prof-dir=${dir}`];

/**
 * How a Bun subject is launched. Every other runtime needs a transpile or a
 * compile first, so `runSuite` works out its argv up front and hands it in - see
 * `src/toolchains.ts`.
 *
 * `--no-orphans` makes the child die with the harness and take its own
 * descendants with it. The harness spawns a subject per subject and the queue
 * worker forks a child, so a run killed part way used to leave both behind. It
 * landed in Bun 1.3.14, which is why this workspace declares `bun >=1.4.1` like
 * every published package rather than the `>=1.3.0` it used to.
 */
export const bunCommand = (
  subject: Subject,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
): readonly string[] => [
  'bun',
  '--no-orphans',
  ...profileFlags(profile?.kind, profile?.dir ?? '.'),
  ...subject.preload.flatMap((module) => ['--preload', module]),
  `${root}/${subject.entry}`,
];

/**
 * Where a subject's stdout goes, which is a measurement decision and not a detail.
 *
 * `'null'` - the default - is `/dev/null`: a real fd, so a `console.log` is a real
 * `write(2)`, but one that can never block. `'blocked'` is a pipe nobody reads,
 * which is what the harness used to do to every subject: 64 KiB in, the pipe is
 * full, and every further write parks the server until the kernel has room. That
 * is not a property of the framework, so it is opt-in and only the logging harness
 * asks for it - see `src/logging.ts`.
 */
export type StdoutSink = 'null' | 'blocked';

export const startSubject = async (
  subject: Subject,
  exec: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
  stdout: StdoutSink = 'null',
  graceful = false,
): Promise<SubjectProcess> => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = performance.now();
  const proc = Bun.spawn([...exec], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(port),
      NODE_ENV: 'production',
    },
    stdin: 'ignore',
    stdout: stdout === 'blocked' ? 'pipe' : Bun.file('/dev/null'),
    stderr: 'pipe',
  });

  const stop = async (): Promise<void> => {
    /**
     * `SIGKILL` normally: it is immediate and a subject has nothing to flush.
     *
     * When profiling it has everything to flush, and a signal with no handler
     * writes no profile - so a profiled subject gets `SIGTERM`, which
     * `servers/shared.ts` turns into a clean `process.exit(0)`. Bounded, because
     * a subject that ignores it must not hang the run.
     */
    if (graceful) {
      proc.kill('SIGTERM');
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(GRACEFUL_TIMEOUT_MS).then(() => false),
      ]);
      if (exited) return;
    }
    proc.kill('SIGKILL');
    await proc.exited;
  };

  // The poll is bounded, so the bound belongs in the loop header rather than as a
  // check buried at the bottom of the body: `for (;;)` read as "this may never
  // stop" when in fact it always stops within READY_TIMEOUT_MS. The timeout is now
  // the one thing that can follow the loop, which is also the only way out that
  // does not return or throw from inside it.
  const deadline = startedAt + READY_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `${subject.id} exited with ${proc.exitCode} before serving:\n${stderr}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/plaintext`);
      await response.text();
      if (response.ok) {
        return { baseUrl, startupMs: performance.now() - startedAt, stop };
      }
    } catch {
      // Connection refused while the process is still booting.
    }
    await Bun.sleep(1);
  }

  await stop();
  throw new Error(
    `${subject.id} did not answer on ${baseUrl} within ${READY_TIMEOUT_MS}ms`,
  );
};

const mimeOf = (contentType: string | null): string =>
  (contentType ?? '').split(';')[0]?.trim() ?? '';

/**
 * Every subject must answer every scenario with the same status, the same body
 * bytes and the same media type. Without this the comparison is between different
 * amounts of work and the numbers mean nothing.
 */
export const verifySubject = async (
  subject: Subject,
  baseUrl: string,
  list: readonly Scenario[],
): Promise<void> => {
  for (const scenario of list) {
    const response = await fetch(`${baseUrl}${scenario.path}`, {
      method: scenario.method,
      ...(scenario.body === undefined
        ? {}
        : {
            body: scenario.body,
            headers: {
              'content-type': scenario.contentType ?? 'application/json',
            },
          }),
    });
    const body = await response.text();
    const problems: string[] = [];
    if (response.status !== scenario.expectStatus) {
      problems.push(`status ${response.status} !== ${scenario.expectStatus}`);
    }
    if (body !== scenario.expectBody) {
      problems.push(
        `body ${JSON.stringify(body)} !== ${JSON.stringify(scenario.expectBody)}`,
      );
    }
    const mime = mimeOf(response.headers.get('content-type'));
    if (mime !== scenario.expectMime) {
      problems.push(
        `media type ${mime || '(none)'} !== ${scenario.expectMime}`,
      );
    }
    if (problems.length > 0) {
      throw new Error(
        `${subject.id} / ${scenario.id} does not match the contract: ${problems.join('; ')}`,
      );
    }
  }
};

import type { Subprocess } from 'bun';
import { root } from './paths.js';
import type { Scenario, Subject } from './types.js';

export interface SubjectProcess {
  readonly baseUrl: string;
  readonly startupMs: number;
  readonly stop: () => Promise<void>;
}

const READY_TIMEOUT_MS = 20_000;

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

const command = (
  subject: Subject,
  nodeBinary: string,
  nodeEntry: string | undefined,
): string[] => {
  if (subject.runtime === 'bun') {
    const preload = subject.preload.flatMap((module) => ['--preload', module]);
    return ['bun', ...preload, `${root}/${subject.entry}`];
  }
  if (nodeEntry === undefined)
    throw new Error(`No transpiled entry for ${subject.id}`);
  return [nodeBinary, nodeEntry];
};

export const startSubject = async (
  subject: Subject,
  nodeBinary: string,
  nodeEntry: string | undefined,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SubjectProcess> => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = performance.now();
  const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(
    command(subject, nodeBinary, nodeEntry),
    {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const stop = async (): Promise<void> => {
    proc.kill('SIGKILL');
    await proc.exited;
  };

  const deadline = startedAt + READY_TIMEOUT_MS;
  for (;;) {
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
    if (performance.now() > deadline) {
      await stop();
      throw new Error(
        `${subject.id} did not answer on ${baseUrl} within ${READY_TIMEOUT_MS}ms`,
      );
    }
    await Bun.sleep(1);
  }
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

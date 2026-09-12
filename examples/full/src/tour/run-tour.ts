const APP_DIR = new URL('../..', import.meta.url).pathname;

export interface TourRun {
  readonly code: number;
  readonly messages: readonly string[];
  /** Every message joined, which is what most assertions match against. */
  readonly text: string;
}

/**
 * Boots `bun src/tour.ts` in a process of its own and collects what it narrated.
 *
 * `NODE_ENV=production` selects the plain JSON formatter, so there is no ANSI to
 * strip and a message containing a comma is not broken up by the colouriser. Both
 * streams are collected: `ConsoleTransport` sends warn and above to stderr so a
 * log shipper can separate them, and the degraded-cache line is a warning.
 *
 * Here rather than in `tour.test.ts` because that file is at the 800-line cap the
 * repo enforces, and the harness is the half of it that is not an assertion.
 */
export const runTour = async (
  env: Record<string, string> = {},
): Promise<TourRun> => {
  const proc = Bun.spawn(['bun', 'src/tour.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, NODE_ENV: 'production', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const messages = `${out}\n${err}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => String((JSON.parse(line) as { message: unknown }).message));

  return { code, messages, text: messages.join('\n') };
};

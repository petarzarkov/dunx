import { describe, expect, test } from 'bun:test';

/**
 * The prompt read, spawned rather than imported, and with stdin left **open** after
 * the answer - which is what a terminal does and what a pipe closed by `printf`
 * does not.
 *
 * Reported from a real run: `bunx @dunx/create-app my-api`, answer the prompt, and
 * the app is written, the next steps print, and the process never exits. The read
 * that did it left the stdin handle referenced, so anything holding the other end
 * of stdin - a terminal, or this test - kept the event loop alive forever.
 *
 * `bun -e` rather than a fixture file: importing the module here would put it in
 * the coverage denominator as a function no in-process test can reach, since
 * `bun test` owns the runner's stdin.
 */
const MODULE = new URL('./stdin.ts', import.meta.url).pathname;

const readThrough = async (
  input: string,
): Promise<{ exited: boolean; stdout: string }> => {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `const { readLine } = await import(${JSON.stringify(MODULE)});\n` +
        `console.log(await readLine());`,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );

  void proc.stdin.write(input);
  await proc.stdin.flush();
  // Deliberately not `proc.stdin.end()`: an EOF ends the iteration on its own, so
  // closing it here would pass against the bug this guards.

  const finished = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!finished) {
    proc.kill();
    return { exited: false, stdout: '' };
  }
  return {
    exited: true,
    stdout: (await new Response(proc.stdout).text()).trim(),
  };
};

describe('readLine', () => {
  test('exits once the line is read, with stdin still open', async () => {
    const { exited, stdout } = await readThrough('notes,openapi\n');

    expect(exited).toBe(true);
    expect(stdout).toBe('notes,openapi');
  }, 10000);

  test('trims the line rather than returning the newline', async () => {
    const { exited, stdout } = await readThrough('  all  \n');

    expect(exited).toBe(true);
    expect(stdout).toBe('all');
  }, 10000);
});

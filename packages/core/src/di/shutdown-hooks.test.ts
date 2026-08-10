import { describe, expect, it } from 'bun:test';
import { ShutdownHooks } from './shutdown-hooks.js';

/**
 * Nothing here may arm the real exit timer: these run inside the test runner's own
 * process, and a `process.exit(0)` landing mid-suite truncates the run while
 * reporting success. Every unit test below passes `exitAfterMs: false`; the one that
 * proves the exit actually happens spawns a process to be exited.
 */
const NO_EXIT = { exitAfterMs: false } as const;

/** A drain that resolves and records nothing, for the cases asserting registration. */
const noop = (): Promise<void> => Promise.resolve();

describe('ShutdownHooks', () => {
  it('installs one listener per signal and is idempotent', () => {
    const hooks = new ShutdownHooks();
    const before = process.listenerCount('SIGHUP');
    try {
      expect(hooks.install(noop, ['SIGHUP'], NO_EXIT)).toBe(true);
      // Reports false rather than throwing: the three application classes call it
      // from an `enableShutdownHooks` documented as safe to call twice.
      expect(hooks.install(noop, ['SIGHUP'], NO_EXIT)).toBe(false);
      expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    } finally {
      process.removeAllListeners('SIGHUP');
    }
  });

  it('drains when a hooked signal fires', async () => {
    const hooks = new ShutdownHooks();
    let drained = false;
    try {
      hooks.install(
        async () => {
          drained = true;
        },
        ['SIGHUP'],
        NO_EXIT,
      );
      process.emit('SIGHUP');
      // The handler starts a promise chain; one turn is enough to settle it.
      await Bun.sleep(10);
      expect(drained).toBe(true);
    } finally {
      process.removeAllListeners('SIGHUP');
    }
  });

  it('reports a failed drain instead of swallowing it', async () => {
    const hooks = new ShutdownHooks();
    const written: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => written.push(args[0]);
    try {
      hooks.install(
        () => Promise.reject(new Error('teardown exploded')),
        ['SIGHUP'],
        NO_EXIT,
      );
      process.emit('SIGHUP');
      await Bun.sleep(10);
      expect(written[0]).toBe('[dunx] shutdown failed');
    } finally {
      console.error = original;
      process.removeAllListeners('SIGHUP');
    }
  });
});

/**
 * The actual contract, and it cannot be asserted in-process: the subject has to be a
 * process that gets exited.
 *
 * Each case holds the event loop open with a `Bun.serve` that nothing closes - the
 * stand-in for the handle bullmq's Bun adapter leaks against an unreachable broker,
 * which is what made a correct drain hang until `SIGKILL`.
 */
const spawnSubject = async (
  source: string,
  signalAfterReady = true,
): Promise<{ code: number; text: string; ms: number }> => {
  const file = `${process.env['TMPDIR'] ?? '/tmp'}/dunx-hooks-${Bun.randomUUIDv7()}.ts`;
  await Bun.write(file, source);
  const started = Date.now();
  const proc = Bun.spawn(['bun', file], { stdout: 'pipe', stderr: 'pipe' });

  let text = '';
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();
  const readingErr = (async () => {
    for await (const chunk of proc.stderr) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();

  if (signalAfterReady) {
    while (!text.includes('ready')) await Bun.sleep(10);
    proc.kill('SIGTERM');
  }

  const guard = setTimeout(() => proc.kill('SIGKILL'), 15_000);
  const code = await proc.exited;
  clearTimeout(guard);
  await Promise.all([reading, readingErr]);
  await Bun.file(file).delete();

  return { code, text, ms: Date.now() - started };
};

const SUBJECT = (options: string) => `
import { AppFactory, Module } from '${import.meta.dir}/../index.ts';

@Module({})
class Root {}

const app = await AppFactory.create(Root);
app.enableShutdownHooks(['SIGTERM']${options});

// Never closed: the leaked handle a drain cannot reach.
Bun.serve({ port: 0, fetch: () => new Response('x') });

app.closed.then(() => console.log('drained'));
console.log('ready');
`;

describe('a signal against a process something is holding open', () => {
  it('exits 0 once the drain is done, rather than hanging', async () => {
    const run = await spawnSubject(SUBJECT(''));

    expect(run.code).toBe(0);
    expect(run.text).toContain('drained');
    // The warning is what makes a forced exit diagnosable rather than mysterious.
    expect(run.text).toContain('still alive');
    // Well inside the SIGKILL guard: the point is that it ends on its own.
    expect(run.ms).toBeLessThan(10_000);
  }, 20_000);

  it('stays up when the caller opts out, so an embedded app cannot be killed', async () => {
    const run = await spawnSubject(
      SUBJECT(', { exitAfterMs: false }') +
        // Nothing will end this process, so it has to end itself once it has proved
        // the drain ran without an exit being armed.
        `\nsetTimeout(() => { console.log('survived'); process.exit(3); }, 1500);\n`,
    );

    expect(run.code).toBe(3);
    expect(run.text).toContain('drained');
    expect(run.text).toContain('survived');
    expect(run.text).not.toContain('still alive');
  }, 20_000);
});

describe('a signal against a process holding nothing open', () => {
  it('exits immediately, so a clean app pays no grace period', async () => {
    // No `Bun.serve` here: with nothing pending the runtime ends the process itself
    // and the unref'd timer never fires. This is why the wait is not a shutdown delay.
    const source = `
import { AppFactory, Module } from '${import.meta.dir}/../index.ts';

@Module({})
class Root {}

const app = await AppFactory.create(Root);
app.enableShutdownHooks(['SIGTERM']);
console.log('ready');
// Ref'd only until the signal lands, so the drain is the last thing pending.
const hold = setInterval(() => {}, 50);
app.closed.then(() => { console.log('drained'); clearInterval(hold); });
`;
    const run = await spawnSubject(source);

    expect(run.code).toBe(0);
    expect(run.text).toContain('drained');
    // The forced path never ran: nothing was holding the loop, so nothing warned.
    expect(run.text).not.toContain('still alive');
  }, 20_000);
});

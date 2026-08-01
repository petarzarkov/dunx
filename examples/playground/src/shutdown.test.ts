import { expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

/**
 * `bun start` is a service: it holds the process open until a signal arrives.
 * That is exactly what the tour cannot check, so it gets its own spawn.
 */
it('stays up until a signal, then drains in reverse order', async () => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: APP_DIR,
    // Port 0 so the suite cannot collide with a real `bun start` on 3000.
    env: { ...process.env, NODE_ENV: 'production', PORT: '0' },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  let text = '';
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stdout) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();

  while (!text.includes('ctrl-c to stop')) await Bun.sleep(20);

  // Still running: a service does not exit once it has finished starting.
  expect(proc.killed).toBe(false);
  expect(text).toContain('listening on http://');

  proc.kill('SIGTERM');
  const code = await proc.exited;
  await drained;

  expect(code).toBe(0);
  // Reverse dependency order: the service drains before the database it needs.
  expect(text.indexOf('users draining')).toBeLessThan(
    text.indexOf('database closed'),
  );
  // The temp dir is removed on the signal path too.
  expect(text).toContain('workspace removed:');
}, 30_000);

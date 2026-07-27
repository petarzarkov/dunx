import { expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

const start = (env: Record<string, string> = {}) => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const output = { text: '' };
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stdout)
      output.text += decoder.decode(chunk, { stream: true });
  })();

  return {
    output,
    async waitFor(marker: string): Promise<void> {
      while (!output.text.includes(marker)) await Bun.sleep(20);
    },
    async finish(): Promise<number> {
      const code = await proc.exited;
      await drained;
      return code;
    },
    kill: (signal: NodeJS.Signals) => proc.kill(signal),
  };
};

it('boots the whole graph and exits 0', async () => {
  const app = start();
  const code = await app.finish();

  expect(code).toBe(0);
  expect(app.output.text).toContain('playground: users ready');
  expect(app.output.text).toContain(
    'row from memory://playground | via select * from users',
  );
  expect(app.output.text).toContain('users draining');
  expect(app.output.text).toContain('database closed');
});

it('closes cleanly on SIGTERM', async () => {
  const app = start({ DUNX_HOLD: '1' });
  await app.waitFor('holding');
  app.kill('SIGTERM');
  const code = await app.finish();

  expect(code).toBe(0);
  // Reverse dependency order: the service drains before the database it needs.
  expect(app.output.text.indexOf('users draining')).toBeLessThan(
    app.output.text.indexOf('database closed'),
  );
});

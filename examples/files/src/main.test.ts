import { expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

/** Runs the example as a real process, so the assertions are on real stdout. */
const run = async (): Promise<{ code: number; text: string }> => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: APP_DIR,
    // Cleared, so the run proves it exits 0 with no credentials in reach.
    env: {
      ...process.env,
      S3_BUCKET: undefined,
      AWS_BUCKET: undefined,
      AWS_ACCESS_KEY_ID: undefined,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    text += decoder.decode(chunk, { stream: true });
  }

  return { code: await proc.exited, text };
};

it('exits 0 with no network and no credentials', async () => {
  const { code, text } = await run();

  expect(code).toBe(0);
  expect(text).toContain('backend LocalStorage');
  expect(text).toContain('s3 backend -> skipping');
  expect(text).toContain('shutdown complete');
});

it('round-trips, streams, globs and deletes', async () => {
  const { text } = await run();

  expect(text).toContain('write reports/2024-q1.csv -> 31 bytes');
  expect(text).toContain('"region,revenue\\nemea,120\\napac,90"');
  expect(text).toContain('stream reports/2024-q2.csv -> 6018 bytes');
  expect(text).toContain('stream back reports/2024-q2.csv -> 500 lines');
  expect(text).toContain('glob 2024-*.csv -> ["reports/2024-q1.csv"');
  expect(text).toContain('delete again -> no error');
});

it('rejects a traversal attempt and refuses to presign locally', async () => {
  const { text } = await run();

  expect(text).toContain(
    'traversal rejected -> Refusing "../../etc/passwd": it escapes the storage root',
  );
  expect(text).toContain(
    'presign on local -> LocalStorage does not support presign()',
  );
  expect(text).not.toContain('TRAVERSAL WAS NOT REJECTED');
});

it('leaves its temp directory behind cleaned up', async () => {
  const { text } = await run();

  const root = /storage root (\S+)/.exec(text)?.[1];
  expect(root).toBeDefined();
  expect(text).toContain(`cleaned up ${root}`);
  expect(await Bun.file(`${root}/reports/2024-q1.csv`).exists()).toBe(false);
});

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { assertOneCore, loadedCoreCopies } from './copies.js';

describe('the duplicate-core guard', () => {
  it('counts the one copy the suite loaded', () => {
    expect(loadedCoreCopies()).toBe(1);
  });

  it('passes on a single copy', () => {
    expect(() => assertOneCore(1)).not.toThrow();
  });

  it('names the count, the symptom and the usual cause', () => {
    expect(() => assertOneCore(2)).toThrow(
      /2 copies of @dunx\/core are loaded/,
    );
    expect(() => assertOneCore(2)).toThrow(/peerDependencies/);
    expect(() => assertOneCore(2)).toThrow(/bun why @dunx\/core/);
  });

  // The unit tests above pass the count in. This one arranges the real thing,
  // in a subprocess because the registry is process-wide.
  it('fails AppFactory.create when a second copy is loaded', async () => {
    const fixture = join(import.meta.dir, 'duplicate-core.fixture.ts');
    const proc = Bun.spawn(['bun', fixture], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(stderr).toBe('');
    expect(stdout).toContain('2 copies of @dunx/core are loaded');
  });
});

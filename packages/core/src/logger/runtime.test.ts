import { describe, expect, it } from 'bun:test';
import { runtimeInfo } from './runtime.js';

/**
 * Read once per process by whatever writes the first entry. The two paths are the
 * interesting part: under `bun test` `main` is this test file rather than an app
 * entry, and under `bun build --compile` it is a `/$bunfs/` path that names no file
 * on disk, which is why `execPath` is reported beside it.
 */
describe('runtimeInfo', () => {
  it('names the runtime and the build', () => {
    const info = runtimeInfo();

    expect(info.runtime).toBe(`bun ${Bun.version}`);
    expect(info.revision).toBe(Bun.revision.slice(0, 9));
    expect(info.revision.length).toBe(9);
  });

  it('reports both the entry and the executable', () => {
    const info = runtimeInfo();

    // Under `bun test` this is the test file, which is the documented caveat.
    expect(info.main).toBe(Bun.main);
    expect(info.main.endsWith('runtime.test.ts')).toBe(true);
    expect(info.execPath).toBe(process.execPath);
  });

  it('omits env rather than reporting the string undefined', () => {
    const info = runtimeInfo();

    if (Bun.env.NODE_ENV === undefined) {
      expect('env' in info).toBe(false);
    } else {
      expect(info.env).toBe(Bun.env.NODE_ENV);
    }
  });

  /* `ConsoleLogger` stamps both on every entry, so naming them here prints twice. */
  it('carries neither pid nor timestamp', () => {
    const keys = Object.keys(runtimeInfo());

    expect(keys).not.toContain('pid');
    expect(keys).not.toContain('timestamp');
  });
});

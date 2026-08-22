import { describe, expect, it } from 'bun:test';
import { childColourEnv } from './worker.js';

/**
 * What a sandboxed processor does with its logger, in a process whose stdout is a
 * pipe - which is the only kind bullmq gives a child.
 */
const CHILD = `
import { AppFactory, Logger } from '@dunx/core';
import { LoggerModule } from '../logger/module.js';

const app = await AppFactory.create(LoggerModule.forRoot());
app.get(Logger).info('sandboxed line');
await app.shutdown();
`;

/** The environment a fork inherits today: this one, with neither colour variable. */
const inherited = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  delete env['FORCE_COLOR'];
  delete env['NO_COLOR'];
  return env;
};

const run = async (
  env: Record<string, string | undefined>,
): Promise<string> => {
  // Beside this file rather than in a temp directory: a child elsewhere resolves
  // `@dunx/core` from its own location, ends up with a second `Logger` class, and
  // silently gets the default `ConsoleLogger` - which never colours, so the harness
  // would pass while proving nothing.
  const file = `${import.meta.dir}/.sandbox-child-${Bun.randomUUIDv7()}.ts`;
  await Bun.write(file, CHILD);
  try {
    const child = Bun.spawn(['bun', file], { stdout: 'pipe', env });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return text;
  } finally {
    await Bun.file(file).delete();
  }
};

describe('childColourEnv', () => {
  it('adds FORCE_COLOR only when this process has colour and nothing else decided', () => {
    expect(childColourEnv({ PATH: '/bin' }, false)).toBeUndefined();
    expect(childColourEnv({ NO_COLOR: '1' }, true)).toBeUndefined();
    expect(childColourEnv({ FORCE_COLOR: '0' }, true)).toBeUndefined();
    expect(childColourEnv({ PATH: '/bin' }, true)).toEqual({
      PATH: '/bin',
      FORCE_COLOR: '1',
    });
  });
});

describe('a sandboxed processor writing to a pipe', () => {
  it('loses colour that the process it prints into has', async () => {
    const text = await run(inherited());

    expect(text).toContain('sandboxed line');
    expect(Bun.stripANSI(text)).toBe(text);
  }, 20_000);

  it('keeps it when the parent hands its own answer over', async () => {
    const env = childColourEnv(inherited(), true);
    expect(env).toBeDefined();
    const text = await run(env as Record<string, string | undefined>);

    expect(text).toContain('sandboxed line');
    expect(Bun.stripANSI(text)).not.toBe(text);
  }, 20_000);
});

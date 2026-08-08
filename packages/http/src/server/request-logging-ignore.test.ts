import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';

/**
 * `ignorePrefix` in its own file: `request-logging.test.ts` is at the 500-line
 * limit, which is an error rather than a convention here.
 */
@Controller('/')
class AnythingController {
  @Get('/things')
  things(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AnythingController] })
class AnythingModule {}

/**
 * One `console.log` may carry several entries - `ConsoleLogger` batches
 * everything at `info` and below into one write per event-loop turn - so each
 * call is split back apart. Shutdown happens inside `run`, which flushes.
 */
const captured = async (
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  const record = (...args: unknown[]): void => {
    lines.push(...args.map(String).join(' ').split('\n'));
  };
  console.log = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const withApp = async (
  run: (url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> => {
  const app = await HttpFactory.create(AnythingModule, options);
  const url = await app.listen(0);
  try {
    await run(url);
  } finally {
    await app.shutdown();
  }
};

describe('ignorePrefix', () => {
  /** Request entries only: `bootLogging` writes one "Serving N route(s)" line. */
  const requests = (
    entries: readonly Record<string, unknown>[],
  ): readonly Record<string, unknown>[] =>
    entries.filter((entry) => entry['flow'] === 'http');

  it('skips a whole mount, which an exact-match list cannot', async () => {
    // The case it exists for: a dashboard polling four endpoints every five
    // seconds plus a dozen assets, none of them worth an entry - and listing
    // them exactly would be wrong the moment either grows one.
    const entries = await captured(async () => {
      await withApp(
        async (url) => {
          await fetch(new URL('_ops', url));
          await fetch(new URL('_ops/api/runtime', url));
          await fetch(new URL('_ops/queues/static/js/main.js', url));
        },
        { requestLogging: { ignorePrefix: ['/_ops'] } },
      );
    });
    expect(requests(entries)).toHaveLength(0);
  });

  it('does not skip a path that merely starts the same', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (url) => {
          await fetch(new URL('_opsimistic', url));
        },
        { requestLogging: { ignorePrefix: ['/_ops/'] } },
      );
    });
    // A prefix carrying the separator is how a caller asks for exactly the
    // subtree and nothing that shares its opening characters.
    expect(requests(entries)).toHaveLength(1);
  });

  it('logs everything when unset', async () => {
    const entries = await captured(async () => {
      await withApp(async (url) => {
        await fetch(new URL('things', url));
      });
    });
    expect(requests(entries)).toHaveLength(1);
  });
});

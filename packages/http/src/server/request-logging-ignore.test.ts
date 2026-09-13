import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';
import { serving } from './serving.fixture.js';
import { captured } from './request-logging.fixture.test.js';

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

const withApp = (
  run: (url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> =>
  serving(
    () => HttpFactory.create(AnythingModule, options),
    (_app, url) => run(url),
  );

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

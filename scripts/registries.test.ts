import { describe, expect, it } from 'bun:test';
import {
  fromFirstRegistry,
  imageRefs,
  REGISTRIES,
  type Registry,
} from './registries.js';

const named = (name: string): Registry => ({
  name,
  ref: (path) => `${name}/${path}`,
});

/** Never called: every case below settles before the first backoff, except the
 * ones that assert what it was asked to wait. */
const noSleep = async (): Promise<void> => {
  /* the backoff, not waited on */
};

/** The default `log` is `console.log`, which would print a registry failure into
 * the test run for every case that exercises one. */
const quiet = () => {
  /* the failure line, not printed */
};

describe('REGISTRIES', () => {
  const refs = (path: string) =>
    REGISTRIES.map((registry) => registry.ref(path));

  it('spells an official image for each registry', () => {
    expect(refs('library/postgres:17-alpine')).toEqual([
      'docker.io/library/postgres:17-alpine',
      // The one that is not a prefix: ECR mirrors Hub's official images under
      // `docker/library`, so dropping this case reintroduces the 404.
      'public.ecr.aws/docker/library/postgres:17-alpine',
      'mirror.gcr.io/library/postgres:17-alpine',
    ]);
  });

  it('spells a publisher image for each registry', () => {
    expect(refs('valkey/valkey:8-alpine')).toEqual([
      'docker.io/valkey/valkey:8-alpine',
      'public.ecr.aws/valkey/valkey:8-alpine',
      'mirror.gcr.io/valkey/valkey:8-alpine',
    ]);
  });

  it('reaches Docker Hub first, which measured as the one that served', () => {
    expect(REGISTRIES[0]?.name).toBe('docker.io');
  });
});

describe('imageRefs', () => {
  it('renders every variable through the one registry', () => {
    expect(
      imageRefs(REGISTRIES[1] as Registry, {
        DUNX_VALKEY_IMAGE: 'valkey/valkey:8-alpine',
        DUNX_POSTGRES_IMAGE: 'library/postgres:17-alpine',
      }),
    ).toEqual({
      DUNX_VALKEY_IMAGE: 'public.ecr.aws/valkey/valkey:8-alpine',
      DUNX_POSTGRES_IMAGE: 'public.ecr.aws/docker/library/postgres:17-alpine',
    });
  });
});

describe('fromFirstRegistry', () => {
  it('stops at the first registry that serves', async () => {
    const tried: string[] = [];
    const served = await fromFirstRegistry(
      async (registry) => {
        tried.push(registry.name);
        return true;
      },
      { registries: [named('a'), named('b')], sleep: noSleep },
    );

    expect(served.name).toBe('a');
    expect(tried).toEqual(['a']);
  });

  /** The whole point: a registry that is throttling is skipped rather than
   * retried, because the exhausted budget is that registry's. */
  it('falls through to the next one', async () => {
    const tried: string[] = [];
    const served = await fromFirstRegistry(
      async (registry) => {
        tried.push(registry.name);
        return registry.name === 'c';
      },
      {
        registries: [named('a'), named('b'), named('c')],
        log: quiet,
        sleep: noSleep,
      },
    );

    expect(served.name).toBe('c');
    expect(tried).toEqual(['a', 'b', 'c']);
  });

  /** Another provider is the faster retry, so a whole round runs before the
   * first sleep rather than a sleep between each registry. */
  it('sleeps only between rounds, doubling each time', async () => {
    const tried: string[] = [];
    const slept: number[] = [];
    let attempts = 0;

    const served = await fromFirstRegistry(
      async (registry) => {
        tried.push(registry.name);
        attempts += 1;
        // Fails both registries twice over, serves on the third round.
        return attempts > 4;
      },
      {
        registries: [named('a'), named('b')],
        log: quiet,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(served.name).toBe('a');
    expect(tried).toEqual(['a', 'b', 'a', 'b', 'a']);
    expect(slept).toEqual([2_000, 4_000]);
  });

  it('throws naming every registry it tried', async () => {
    const slept: number[] = [];
    await expect(
      fromFirstRegistry(async () => false, {
        registries: [named('a'), named('b')],
        rounds: 2,
        log: quiet,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).rejects.toThrow('after 2 round(s) of a, b');
    // No trailing sleep: the last round fails and throws rather than waiting.
    expect(slept).toEqual([2_000]);
  });

  it('reports each registry that did not serve', async () => {
    const said: string[] = [];
    await fromFirstRegistry(async (registry) => registry.name === 'b', {
      registries: [named('a'), named('b')],
      log: (message) => said.push(message),
      sleep: noSleep,
    });

    expect(said).toEqual(['a did not serve']);
  });
});

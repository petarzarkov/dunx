import { describe, expect, test } from 'bun:test';
import { IO_POOL_SIZE } from '../servers/io/contract.js';
import { root } from './paths.js';
import { scenarios } from './scenarios.js';
import { subjects } from './subjects.js';
import { NATIVE_RUNTIMES, probeToolchain } from './toolchains.js';

describe('subjects', () => {
  test('have unique ids', () => {
    expect(new Set(subjects.map((subject) => subject.id)).size).toBe(
      subjects.length,
    );
  });

  test('each point at a server file that exists', async () => {
    for (const subject of subjects) {
      expect(await Bun.file(`${root}/${subject.entry}`).exists()).toBe(true);
    }
  });

  test('include the raw Bun.serve baseline the report normalises against', () => {
    const baseline = subjects.find((subject) => subject.id === 'bun-serve');
    expect(baseline?.runtime).toBe('bun');
    expect(baseline?.preload).toEqual([]);
  });

  test('every subject records which validator it runs, so the validate scenario is readable', () => {
    for (const subject of subjects)
      expect(subject.validator.length).toBeGreaterThan(0);
  });

  /*
   * The io scenario cannot hold one client constant across seven languages the
   * way `validate` holds zod constant across the JavaScript ones. So the report
   * names the pair each row was produced with, and a subject that does not say
   * would be a row nobody can read.
   */
  test('every subject records which database and cache clients answer the io scenario', () => {
    for (const subject of subjects) {
      expect(subject.io.length).toBeGreaterThan(0);
      expect(subject.io).toMatch(/\+/);
    }
  });

  /*
   * Every client that exposes a pool is given the same size, because with 64
   * connections against one worker thread the pool is what sets how many queries
   * are in flight. A row with a different one would be measured on its
   * configuration.
   */
  test('every pooled io client is pinned to the same size', () => {
    for (const subject of subjects) {
      for (const [, size] of subject.io.matchAll(/pool (\d+)/g)) {
        expect(Number(size)).toBe(IO_POOL_SIZE);
      }
    }
  });

  test('compiled subjects sit where their toolchain looks for them', () => {
    const expected: Partial<Record<string, RegExp>> = {
      go: /^servers\/go\/cmd\/[^/]+\/main\.go$/,
      rust: /^servers\/rust\/src\/[^/]+\.rs$/,
      jvm: /^servers\/java\/src\/main\/java\/.+\.java$/,
      dotnet: /^servers\/dotnet\/[^/]+\/Program\.cs$/,
    };
    for (const subject of subjects) {
      const pattern = expected[subject.runtime];
      if (pattern === undefined) continue;
      expect(subject.entry).toMatch(pattern);
    }
  });

  test('the Go, Rust and .NET artifact names are derived from the subject id, so they must not collide', () => {
    const named: readonly string[] = ['go', 'rust', 'dotnet'];
    const compiled = subjects.filter((subject) =>
      named.includes(subject.runtime),
    );
    expect(new Set(compiled.map((subject) => subject.id)).size).toBe(
      compiled.length,
    );
  });

  /*
   * The JVM and .NET both compile in tiers, and 3 seconds warms neither.
   * Measured for `aspnet-minimal`: 40k req/s on the json scenario after a
   * 3-second warmup, still climbing 20 seconds later, plateauing near 88k. A
   * subject that JITs and does not say so here would be reported cold.
   */
  test('every tiered-JIT subject asks for a warmup long enough to be worth reporting', () => {
    const tiered: readonly string[] = ['jvm', 'dotnet'];
    for (const subject of subjects) {
      if (!tiered.includes(subject.runtime)) continue;
      expect(subject.warmupFloorSeconds ?? 0).toBeGreaterThanOrEqual(30);
    }
  });

  test('every compiled subject says in its notes that it is single-threaded', () => {
    for (const subject of subjects) {
      if (!['go', 'rust', 'jvm', 'dotnet'].includes(subject.runtime)) continue;
      const notes = subject.notes.join(' ').toLowerCase();
      expect(notes).toMatch(
        /gomaxprocs|current_thread|one worker thread|dotnet_processor_count/,
      );
    }
  });

  /*
   * .NET reads DOTNET_PROCESSOR_COUNT once as the runtime starts, so unlike
   * GOMAXPROCS and tokio's flavour it cannot be set from the subject's own
   * source. `Shared.PinToOneThread` throws without it rather than serving on 32
   * cores, and this is what stops the registry dropping the variable that keeps
   * that throw from firing.
   */
  test('every .NET subject is started with its processor count pinned', () => {
    for (const subject of subjects) {
      if (subject.runtime !== 'dotnet') continue;
      expect(subject.env?.['DOTNET_PROCESSOR_COUNT']).toBe('1');
    }
  });
});

describe('toolchains', () => {
  const OVERRIDES = [
    'BENCH_GO',
    'BENCH_CARGO',
    'BENCH_JAVA',
    'BENCH_MVN',
    'BENCH_DOTNET',
  ];

  test('report themselves absent instead of throwing, which is how CI skips them', async () => {
    const saved = OVERRIDES.map((name) => [name, process.env[name]] as const);
    for (const name of OVERRIDES) process.env[name] = '/nonexistent/toolchain';
    try {
      for (const runtime of NATIVE_RUNTIMES) {
        const status = await probeToolchain(runtime);
        expect(status.version).toBeNull();
        expect(status.hint.length).toBeGreaterThan(0);
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  /*
   * `python` sits with `bun` and `node` rather than in `NATIVE_RUNTIMES`: those
   * three are interpreters the harness probes and launches directly, while a
   * native runtime is one with an artifact to compile and a build time to keep
   * out of the startup column. Django has neither.
   */
  test('every subject has a runtime the harness can launch', () => {
    const known: readonly string[] = [
      'bun',
      'node',
      'python',
      ...NATIVE_RUNTIMES,
    ];
    for (const subject of subjects) expect(known).toContain(subject.runtime);
  });
});

describe('scenarios', () => {
  test('have unique ids', () => {
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(
      scenarios.length,
    );
  });

  /*
   * `io` is the only scenario needing a service outside the subject process, and
   * `planIo` is what drops it when Redis or Postgres does not answer. A second
   * scenario growing that need without the gate would fail a whole run on a
   * machine with neither.
   */
  test('only the io scenario needs a backing service', () => {
    const needsService = scenarios.filter((scenario) => scenario.id === 'io');
    expect(needsService).toHaveLength(1);
    expect(needsService[0]?.path).toBe('/io');
  });

  test('declare the exact response every subject must produce', () => {
    for (const scenario of scenarios) {
      expect(scenario.expectStatus).toBe(200);
      expect(scenario.expectBody.length).toBeGreaterThan(0);
      expect(scenario.expectMime).toMatch(/^[a-z]+\/[a-z]+$/);
    }
  });

  test('only the validate scenario sends a body, and it sends JSON', () => {
    for (const scenario of scenarios) {
      if (scenario.method === 'GET') {
        expect(scenario.body).toBeUndefined();
      } else {
        expect(scenario.contentType).toBe('application/json');
        expect(() => JSON.parse(scenario.body ?? '')).not.toThrow();
      }
    }
  });
});

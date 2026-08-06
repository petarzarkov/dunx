import { describe, expect, test } from 'bun:test';
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

  test('compiled subjects sit where their toolchain looks for them', () => {
    const expected: Partial<Record<string, RegExp>> = {
      go: /^servers\/go\/cmd\/[^/]+\/main\.go$/,
      rust: /^servers\/rust\/src\/[^/]+\.rs$/,
      jvm: /^servers\/java\/src\/main\/java\/.+\.java$/,
    };
    for (const subject of subjects) {
      const pattern = expected[subject.runtime];
      if (pattern === undefined) continue;
      expect(subject.entry).toMatch(pattern);
    }
  });

  test('the Go and Rust artifact names are derived from the subject id, so they must not collide', () => {
    const compiled = subjects.filter(
      (subject) => subject.runtime === 'go' || subject.runtime === 'rust',
    );
    expect(new Set(compiled.map((subject) => subject.id)).size).toBe(
      compiled.length,
    );
  });

  test('the JVM subject asks for a warmup long enough to be worth reporting', () => {
    for (const subject of subjects) {
      if (subject.runtime !== 'jvm') continue;
      expect(subject.warmupFloorSeconds ?? 0).toBeGreaterThanOrEqual(30);
    }
  });

  test('every compiled subject says in its notes that it is single-threaded', () => {
    for (const subject of subjects) {
      if (!['go', 'rust', 'jvm'].includes(subject.runtime)) continue;
      const notes = subject.notes.join(' ').toLowerCase();
      expect(notes).toMatch(/gomaxprocs|current_thread|one worker thread/);
    }
  });
});

describe('toolchains', () => {
  const OVERRIDES = ['BENCH_GO', 'BENCH_CARGO', 'BENCH_JAVA', 'BENCH_MVN'];

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

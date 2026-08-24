import { describe, expect, it } from 'bun:test';
import { PHASES } from './ci.js';

/**
 * The workflow and the script have to name the same phases, or `bun run ci`
 * stops being the thing CI runs and the gap goes unnoticed until a push fails.
 *
 * A phase is wired when some job's `run:` is `bun run ci <name>`. That is the
 * only shape allowed: a job restating `bun run lint:check` would pass CI while
 * `bun run ci` covered something else.
 */
const workflow = await Bun.file(
  new URL('../.github/workflows/ci.yml', import.meta.url),
).text();

const invoked = new Set<string>(
  [...workflow.matchAll(/bun run ci ([a-z]+)/g)].flatMap(
    (match) => match[1] ?? [],
  ),
);

describe('every phase in scripts/ci.ts', () => {
  it('has a unique name', () => {
    const names = PHASES.map((phase) => phase.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('declares at least one step, and every step a command', () => {
    for (const phase of PHASES) {
      expect(phase.steps.length).toBeGreaterThan(0);
      for (const step of phase.steps) {
        expect(step.run.length).toBeGreaterThan(1);
        expect(step.run[0]).toBe('bun');
      }
    }
  });

  it('is invoked by .github/workflows/ci.yml', () => {
    const missing = PHASES.filter((phase) => !invoked.has(phase.name));

    expect(missing.map((phase) => phase.name)).toEqual([]);
  });
});

describe('.github/workflows/ci.yml', () => {
  it('invokes no phase the script does not declare', () => {
    const declared = new Set(PHASES.map((phase) => phase.name));
    const unknown = [...invoked].filter((name) => !declared.has(name));

    expect(unknown).toEqual([]);
  });

  /**
   * Every gate goes through the script. A `run:` calling one of these directly
   * is a step `bun run ci` would not cover - which is the drift this whole file
   * exists to catch. `version` and `docs:build` are the release path, which is
   * not a gate and runs after every job has passed.
   */
  it('reaches the gates only through `bun run ci`', () => {
    const gates = [
      'lint:check',
      'format:check',
      'typecheck',
      'test',
      'test:cov',
      'gen:readme',
      'check:scaffolds',
    ];
    const direct = gates.filter((gate) =>
      new RegExp(`run:\\s+bun run ${gate}`).test(workflow),
    );

    expect(direct).toEqual([]);
  });
});

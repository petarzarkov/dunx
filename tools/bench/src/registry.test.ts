import { describe, expect, test } from 'bun:test';
import { root } from './paths.js';
import { scenarios } from './scenarios.js';
import { subjects } from './subjects.js';

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

import { describe, expect, it } from 'bun:test';
import { missingTransformMessage } from './transform-hint.js';

describe('the missing-transform diagnostic', () => {
  it('asks for the preload when the entrypoint is TypeScript', () => {
    const message = missingTransformMessage('Svc', 1, '/app/src/main.ts');
    expect(message).toContain('preload = ["@dunx/transform/preload"]');
    expect(message).not.toContain('Bun.build');
  });

  // The plugin filters on /\.tsx?$/, so a preload cannot help here. Telling
  // someone to add one they already have sends them to check the one thing that
  // is already correct.
  it('points at build time when the entrypoint is emitted JavaScript', () => {
    const message = missingTransformMessage('Svc', 1, '/app/dist/main.js');
    expect(message).toContain('depsPlugin');
    expect(message).toContain('Bun.build');
    expect(message).not.toContain('preload = ');
  });

  it('covers .mjs and .cjs, which a transpile can also emit', () => {
    for (const entry of ['/a/main.mjs', '/a/main.cjs']) {
      expect(missingTransformMessage('S', 1, entry)).toContain('depsPlugin');
    }
  });

  it('falls back to the preload advice when there is no entrypoint', () => {
    expect(missingTransformMessage('Svc', 1, undefined)).toContain('preload');
  });

  it('names the class and its parameter count either way', () => {
    for (const entry of ['/a/main.ts', '/a/main.js']) {
      const message = missingTransformMessage('Repo', 3, entry);
      expect(message).toContain('Repo declares 3 constructor parameter(s)');
    }
  });
});

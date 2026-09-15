import { describe, expect, it } from 'bun:test';
import { missingTransformMessage } from './transform-hint.js';

describe('the missing-transform diagnostic', () => {
  it('asks for the preload when the entrypoint is TypeScript', () => {
    const message = missingTransformMessage(
      'Svc',
      1,
      '/app/src/main.ts',
      false,
    );
    expect(message).toContain('preload = ["@dunx/transform/preload"]');
    expect(message).not.toContain('Bun.build');
  });

  // The app author has the preload and cannot fix this one: the class is in a
  // package whose own build skipped the plugin.
  it('blames the installed package when the plugin is registered', () => {
    const message = missingTransformMessage('Svc', 1, '/app/src/main.ts', true);
    expect(message).toContain('node_modules');
    expect(message).toContain('depsPlugin');
    expect(message).toContain('whoever publishes Svc');
    expect(message).not.toContain('preload = ');
  });

  // The entrypoint decides first: no preload reaches an emitted .js.
  it('keeps the build-time advice for a prebuilt tree either way', () => {
    for (const registered of [true, false]) {
      const message = missingTransformMessage(
        'Svc',
        1,
        '/app/dist/main.js',
        registered,
      );
      expect(message).toContain('prebuilt tree');
    }
  });

  // The plugin filters on /\.tsx?$/, so a preload cannot help here. Telling
  // someone to add one they already have sends them to check the one thing that
  // is already correct.
  it('points at build time when the entrypoint is emitted JavaScript', () => {
    const message = missingTransformMessage(
      'Svc',
      1,
      '/app/dist/main.js',
      false,
    );
    expect(message).toContain('depsPlugin');
    expect(message).toContain('Bun.build');
    expect(message).not.toContain('preload = ');
  });

  it('covers .mjs and .cjs, which a transpile can also emit', () => {
    for (const entry of ['/a/main.mjs', '/a/main.cjs']) {
      expect(missingTransformMessage('S', 1, entry, false)).toContain(
        'depsPlugin',
      );
    }
  });

  it('falls back to the preload advice when there is no entrypoint', () => {
    expect(missingTransformMessage('Svc', 1, undefined, false)).toContain(
      'preload',
    );
  });

  // Production takes the default, and the key it reads is written by a package
  // core cannot import, so the string itself is asserted here.
  it('reads registration off the global the plugin writes', () => {
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const key = Symbol.for('dunx.transform.active');
    expect(missingTransformMessage('Svc', 1, '/app/src/main.ts')).toContain(
      'preload = ',
    );

    globals[key] = true;
    try {
      expect(missingTransformMessage('Svc', 1, '/app/src/main.ts')).toContain(
        'node_modules',
      );
    } finally {
      delete globals[key];
    }
  });

  it('names the class and its parameter count either way', () => {
    for (const entry of ['/a/main.ts', '/a/main.js']) {
      const message = missingTransformMessage('Repo', 3, entry, false);
      expect(message).toContain('Repo declares 3 constructor parameter(s)');
    }
  });
});

import { expect, it } from 'bun:test';
import { SpawnedApp } from './spawn-app.js';

/**
 * `bun start` is a service: it holds the process open until a signal arrives.
 * That is exactly what the tour cannot check, so it gets its own spawn.
 */
it('stays up until a signal, then drains in reverse order', async () => {
  const app = new SpawnedApp();

  try {
    expect(await app.serving()).toContain('http://');
    // Still running: a service does not exit once it has finished starting.
    expect(app.killed).toBe(false);

    expect(await app.stop()).toBe(0);
    // Reverse dependency order: the service drains before the database it needs.
    expect(app.output.indexOf('users draining')).toBeLessThan(
      app.output.indexOf('database closed'),
    );
    // The temp dir is removed on the signal path too.
    expect(app.output).toContain('workspace removed:');
  } finally {
    app.kill();
  }
}, 30_000);

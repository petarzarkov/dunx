import { describe, expect, test } from 'bun:test';
import { AppFactory } from './app.js';
import { ConsoleLogger } from '../logger/console.js';
import { Logger } from '../logger/logger.js';
import { Module } from './module.js';
import { provide } from './provider.js';

/**
 * Scope warnings used to be surfaced on `app.warnings` and logged by nobody, on the
 * reasoning that core had no logger to write them with. It has one - `Logger` is an
 * always-bound contract - and the reasoning failed its first real test: the reference
 * app never read the property, so a shadowed binding would have been silent in
 * exactly the app most likely to hit one.
 */
class Recorder extends ConsoleLogger {
  readonly warnings: string[] = [];

  constructor() {
    super(undefined, 'info', false);
  }

  override warn(message: unknown): void {
    this.warnings.push(String(message));
  }
}

class Clock {}

describe('scope warnings', () => {
  test('are logged at warn through the app’s own Logger', async () => {
    const recorder = new Recorder();

    @Module({ providers: [Clock], exports: [Clock] })
    class ClockModule {}

    @Module({
      imports: [ClockModule],
      // Declares what an import also exports to it: legal rebinding, warned once.
      providers: [Clock, provide(Logger, { useValue: recorder })],
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(app.warnings).toHaveLength(1);
    expect(app.warnings[0]).toContain('declares Clock');
    // The property is still public, for an app that wants to fail boot instead.
    expect(recorder.warnings).toEqual([...app.warnings]);

    await app.shutdown();
  });

  test('a clean graph logs nothing', async () => {
    const recorder = new Recorder();

    @Module({ providers: [Clock], exports: [Clock] })
    class ClockModule {}

    @Module({
      imports: [ClockModule],
      providers: [provide(Logger, { useValue: recorder })],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.warnings).toEqual([]);
    expect(recorder.warnings).toEqual([]);
    await app.shutdown();
  });
});

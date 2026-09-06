import { beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppFactory } from '@dunx/core';
import { CLI_VERSION } from './config/settings.js';
import { CliModule } from './cli.module.js';
import { GreeterService } from './greeter/greeter.service.js';
import { ReportService, type Report } from './report/report.service.js';

const DIR = resolve(import.meta.dir, '..');
const BINARY = join(DIR, 'dist', 'pulse');

describe('in process', () => {
  test('greets, and counts each greeting', async () => {
    const app = await AppFactory.create(CliModule);
    const greeter = app.get(GreeterService);
    expect(greeter.greet('ada')).toEqual({ greeting: 'hello, ada', served: 1 });
    expect(greeter.greet('grace').served).toBe(2);
    await app.shutdown();
  });

  test('reports its own version and runtime', async () => {
    const app = await AppFactory.create(CliModule);
    const report = app.get(ReportService).collect();
    expect(report.version).toBe(CLI_VERSION);
    expect(report.bun).toBe(Bun.version);
    await app.shutdown();
  });
});

describe('compiled binary', () => {
  beforeAll(async () => {
    const build = Bun.spawn(['bun', 'scripts/build.ts'], {
      cwd: DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if ((await build.exited) !== 0) {
      throw new Error(
        `build failed:\n${await new Response(build.stderr).text()}`,
      );
    }
  });

  /**
   * Run from a directory without the example's `bunfig.toml`. A standalone bun
   * executable still reads `preload` from the cwd's bunfig, and would try to load
   * `@dunx/transform/preload` - which the binary no longer needs (its dependency
   * records are baked in) and cannot resolve. A deployment host has no such
   * bunfig; the temp dir stands in for one.
   */
  const runFromHost = async (
    ...args: string[]
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    const proc = Bun.spawn([BINARY, ...args], {
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  test('answers version before the container is built', async () => {
    const { stdout, code } = await runFromHost('version');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(CLI_VERSION);
  });

  test('resolves injected dependencies from records baked in at build time', async () => {
    const { stdout, stderr, code } = await runFromHost('greet', 'ada');
    expect(code).toBe(0);
    // stdout is the JSON alone: the container resolved GreeterService's Logger
    // with no plugin running at load time.
    expect(JSON.parse(stdout) as { greeting: string; served: number }).toEqual({
      greeting: 'hello, ada',
      served: 1,
    });
    // The log line went to stderr, which is what keeps stdout parseable.
    expect(stderr).toContain('greeted');
  });

  test('keeps stdout parseable for the report', async () => {
    const { stdout, code } = await runFromHost('report');
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Report;
    expect(report.name).toBe('pulse');
    expect(report.version).toBe(CLI_VERSION);
    expect(report.bun).toBe(Bun.version);
  });
});

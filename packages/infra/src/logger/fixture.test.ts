import { expect, it, spyOn } from 'bun:test';
import { ConsoleLogger } from './console.js';
import { ContextStore } from './context.js';
import { resolveLoggerOptions } from './options.js';
import { LogLevel, type LoggerConfig } from './types.js';

/**
 * `colors: true` where the original config said `isDevelopment: true`: colour is
 * now its own decision, and CI is not a TTY, so development alone no longer
 * implies escape sequences. The suites that assert colour ask for it explicitly.
 */
export const testConfig: LoggerConfig = {
  name: 'test-app',
  version: '1.0.0',
  env: 'local',
  colors: true,
  level: LogLevel.DEBUG,
  maskFields: ['password', 'token', 'apiKey', 'apiSecret', 'apiPass'],
  filterEvents: ['/health'],
  maxArrayLength: 1,
};

/** `Bun.stripANSI` is the oracle both ways: it undoes the colouring exactly. */
export const hasColor = (line: string): boolean => Bun.stripANSI(line) !== line;

export const parseLogOutput = (line: string): Record<string, unknown> =>
  JSON.parse(Bun.stripANSI(line)) as Record<string, unknown>;

export interface Capture {
  readonly lines: readonly string[];
  line(index?: number): string;
  entry(index?: number): Record<string, unknown>;
  restore(): void;
}

export const captureConsole = (): Capture => {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  const line = (index = 0): string => {
    const found = lines[index];
    if (found === undefined) {
      throw new Error(
        `no log line at index ${index} (${lines.length} written)`,
      );
    }
    return found;
  };
  return {
    lines,
    line,
    entry: (index = 0) => parseLogOutput(line(index)),
    restore: () => spy.mockRestore(),
  };
};

export const testLogger = (
  config: LoggerConfig = testConfig,
  context: ContextStore = new ContextStore(),
): ConsoleLogger => new ConsoleLogger(resolveLoggerOptions(config), context);

/** The context every ported suite ran against. */
export const withTestContext = <T>(store: ContextStore, run: () => T): T =>
  store.runWithContext(
    {
      requestId: 'test-request-id',
      userId: 'test-user-id',
      event: '/test',
    },
    run,
  );

it('round-trips a coloured line back to the entry it was built from', () => {
  const capture = captureConsole();
  try {
    testLogger().log('fixture');
    expect(hasColor(capture.line())).toBe(true);
    expect(capture.entry()).toMatchObject({ level: 'log', message: 'fixture' });
  } finally {
    capture.restore();
  }
});

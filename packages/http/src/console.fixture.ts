/**
 * Every line either stream received while `run` was in flight, unparsed.
 *
 * Both streams, because warn and above go to stderr by design. One `console.log`
 * may carry several entries - `ConsoleLogger` batches everything at `info` and
 * below into one write per event-loop turn - so each call is split back apart.
 * Shutting the app down inside `run` is what flushes what is pending.
 */
export const consoleLines = async (
  run: () => Promise<void>,
): Promise<string[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  const record = (...args: unknown[]): void => {
    lines.push(...args.map(String).join(' ').split('\n'));
  };
  console.log = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
};

/** The same, keeping only the lines that are log entries, parsed. */
export const consoleEntries = async (
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> =>
  (await consoleLines(run))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

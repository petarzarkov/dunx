/**
 * One line of stdin, with the iteration ended before the value comes back.
 *
 * `console[Symbol.asyncIterator]().next()` on its own leaves stdin referenced for
 * the life of the process: the scaffold wrote its files, printed the next steps and
 * then sat there until the user pressed Ctrl+C. Ending the iteration runs the
 * iterator's `return()`, which releases the handle, so the process exits on its own.
 * Measured on Bun 1.4.0 - docs/bun-apis.md, "One line of stdin keeps the process
 * alive".
 *
 * A function rather than a class because it is the whole module: no state, no
 * configuration, and nothing to hold between calls.
 */
export const readLine = async (): Promise<string> => {
  for await (const line of console) {
    return typeof line === 'string' ? line.trim() : '';
  }
  // Reached only on a stdin that closed with nothing buffered, which is not an
  // answer either.
  return '';
};

/**
 * The rejection a promise produced, as an `Error`.
 *
 * Written once because `await expect(p).rejects.toThrow()` is a no-op on Bun:
 * `expect(...).rejects` returns `undefined`, so the assertion never runs. This
 * throws when the promise resolved instead, which is the case worth catching.
 */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

/** The same, when only the message is asserted against. */
export const rejectionMessage = async (
  promise: Promise<unknown>,
): Promise<string> => (await rejection(promise)).message;

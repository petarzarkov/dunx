/**
 * better-auth's `emailAndPassword.password`, backed by `Bun.password`. Applied by
 * `AuthModule` when `emailAndPassword` is enabled and no hasher is given;
 * better-auth's own default is JavaScript scrypt. Bun pre-hashes the input, so
 * bcrypt's 72-byte cap is a non-issue.
 *
 * `verify` swallows Bun's `UnsupportedAlgorithm` throw, so a hash from a different
 * algorithm is a clean authentication failure rather than a 500. Those users must
 * reset; pass your own implementation if you are migrating a table and cannot.
 */
export const bunPassword = {
  hash: (password: string): Promise<string> =>
    Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 }),
  verify: async ({
    hash,
    password,
  }: {
    hash: string;
    password: string;
  }): Promise<boolean> => {
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      return false;
    }
  },
};

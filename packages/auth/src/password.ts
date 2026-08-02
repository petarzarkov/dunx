/**
 * better-auth's `emailAndPassword.password`, backed by `Bun.password`.
 *
 * Applied by `AuthModule` whenever `emailAndPassword` is enabled and no `password`
 * of your own is given. better-auth's default is a **pure-JavaScript scrypt**;
 * `Bun.password` is native bcrypt, and the rule is simple - if Bun ships it,
 * use Bun.
 *
 * Bun pre-hashes the input, so bcrypt's 72-byte cap is a non-issue even for a
 * maximum-length multibyte password.
 *
 * `verify` swallows Bun's `UnsupportedAlgorithm` throw, so a hash produced by a
 * *different* algorithm - a scrypt hash written before this was in place - is a
 * clean authentication failure rather than a 500. Those users must reset their
 * password to get a bcrypt hash; pass your own `password` implementation instead
 * if you are migrating an existing user table and cannot.
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

// A class, not a token. It is a runtime value, so a constructor parameter typed
// `Config` resolves with no token() and no provide().
export class Config {
  readonly appName = 'playground';
  /** `:memory:` needs no server and leaves nothing behind, so `bun start` repeats cleanly. */
  readonly databaseFile = process.env['DATABASE_FILE'] ?? ':memory:';
  readonly corsOrigin = 'https://example.com';
  readonly seedUsers: readonly string[] = ['ada', 'grace'];
}

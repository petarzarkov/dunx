// A class, not a token. It is a runtime value, so `inject(Config)` just works and
// it self-binds — nothing here needs token() or provide().
export class Config {
  readonly appName = 'playground';
  readonly databaseUrl = process.env['DATABASE_URL'] ?? 'memory://playground';
}

/**
 * The settings `app.set()` accepts. A key has to be declared here to be settable,
 * so the map is checked at compile time instead of being a string bag — a typo is
 * a type error, not a setting that silently never applies.
 */
export interface AppSettings {
  /**
   * Resolve the client address from `X-Forwarded-For` rather than the socket. Only
   * turn it on behind a proxy that rewrites the header: a direct client can send
   * whatever it likes.
   */
  'trust proxy': boolean;
}

export const defaultSettings = (): AppSettings => ({ 'trust proxy': false });

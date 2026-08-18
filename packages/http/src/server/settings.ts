/**
 * The settings `app.set()` accepts. A key has to be declared here to be settable,
 * so the map is checked at compile time instead of being a string bag - a typo is
 * a type error, not a setting that silently never applies.
 */
export interface AppSettings {
  /**
   * Resolve the client address from `X-Forwarded-For` rather than the socket.
   *
   * The value is how many proxies sit in front of this server: `true` means one,
   * a number means that many, `false` means read the socket. The address is taken
   * that many entries from the **right**, because a direct client can send
   * whatever it likes in the header and only a proxy under your control appends
   * to it. Setting a count higher than the number of proxies you actually run
   * hands the caller its own choice of address.
   */
  'trust proxy': boolean | number;
}

export const defaultSettings = (): AppSettings => ({ 'trust proxy': false });

/**
 * The whole wire protocol: one JSON object, an event name, and a payload. It is
 * only ever read for a gateway that declares at least one `@OnMessage(event)`
 * handler — a gateway with only a raw `@OnMessage()` never parses anything.
 */
export interface Envelope {
  readonly event: string;
  readonly data?: unknown;
}

export const encode = (event: string, data: unknown): string =>
  JSON.stringify({ event, data });

/**
 * `undefined` for anything that is not an envelope — binary frames, invalid JSON,
 * a non-object, or a missing `event`. Those fall through to the raw handler
 * instead of being rejected here.
 */
export const decode = (message: string | Buffer): Envelope | undefined => {
  if (typeof message !== 'string') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { event, data } = parsed as { event?: unknown; data?: unknown };
  return typeof event === 'string' ? { event, data } : undefined;
};

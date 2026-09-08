/**
 * The argument reading every tool's `run` shares, and the schema fragments every
 * `inputSchema` shares. Both were private to `tools.ts` until `adopt.ts` became a
 * second caller.
 *
 * Every filter is optional and omitting it means everything, so a caller that
 * knows nothing still gets a useful first answer.
 */
export const NO_ARGS: Record<string, unknown> = Object.freeze({
  type: 'object',
  properties: {},
});

export const schema = (
  properties: Record<string, unknown>,
): Record<string, unknown> => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

export const str = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});

export const bool = (description: string): Record<string, unknown> => ({
  type: 'boolean',
  description,
});

/**
 * One call's arguments. A class rather than four functions taking the same record,
 * so a filter reads as `args.like(route.path, 'path')` and the absent-means-
 * everything rule lives in one place.
 */
export class Args {
  constructor(private readonly raw: Record<string, unknown>) {}

  /** An empty string is treated as absent: a client clearing a field sends one. */
  text(key: string): string | undefined {
    const value = this.raw[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  flag(key: string): boolean {
    return this.raw[key] === true;
  }

  /** Case-insensitive substring, which is what a caller guessing a name wants. */
  like(haystack: string, key: string): boolean {
    const needle = this.text(key);
    return (
      needle === undefined ||
      haystack.toLowerCase().includes(needle.toLowerCase())
    );
  }

  eq(value: string, key: string): boolean {
    const wanted = this.text(key);
    return wanted === undefined || value.toLowerCase() === wanted.toLowerCase();
  }
}

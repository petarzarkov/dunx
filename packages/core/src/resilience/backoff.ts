/**
 * Jitter from `crypto.getRandomValues`. `Math.random` is banned repo-wide for
 * anything that matters, and decorrelating retries is what jitter is for. The
 * alternative, `@arkv/rng`, is a 64 KB WebAssembly PRNG, which is weight a
 * zero-dependency package will not carry to pick a number of milliseconds.
 */
const uniform = (): number => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  // 2**32 rather than 0xffffffff, so the result is [0, 1) and never exactly 1.
  return (buffer[0] ?? 0) / 2 ** 32;
};

/**
 * The ceiling both delays share: the computed backoff below, and a wait a failure
 * asked for through `RetryVerdict.delayMs`, which `ResiliencePolicy` caps with
 * this same number.
 */
export const DEFAULT_MAX_DELAY_MS = 30_000;

export interface BackoffOptions {
  /** Base delay, doubled each attempt. */
  readonly baseMs: number;
  /** @default 2 */
  readonly power?: number;
  /** Upper bound of the random component added to each delay. @default 1000 */
  readonly jitterMs?: number;
  /** @default 30000 */
  readonly maxMs?: number;
}

/** `base * power^attempt + jitter`, capped. `attempt` is 0 for the first retry. */
export const backoffDelay = (
  attempt: number,
  {
    baseMs,
    power = 2,
    jitterMs = 1000,
    maxMs = DEFAULT_MAX_DELAY_MS,
  }: BackoffOptions,
): number => Math.min(baseMs * power ** attempt + uniform() * jitterMs, maxMs);

import { AppError } from '@dunx/core';

/** What a completed request left behind, and all a replay needs. */
export interface StoredResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

/**
 * One key's state. `pending` is a claim held by a request still running; `done`
 * carries the response to replay. Both carry the fingerprint, so a retry with a
 * different request is told so whether or not the first has finished.
 */
export type IdempotencyRecord =
  | { readonly state: 'pending'; readonly fingerprint: string }
  | {
      readonly state: 'done';
      readonly fingerprint: string;
      readonly response: StoredResponse;
    };

/**
 * The claim a request holds while its handler runs. `token` is unique to that
 * request, so a `complete` or `release` arriving after the lease expired and a
 * retry claimed the key cannot touch the retry's claim.
 */
export interface IdempotencyClaim {
  readonly token: string;
  readonly fingerprint: string;
}

/**
 * Where keys live. An `abstract class` rather than an interface, since an interface
 * at an injection site is a boot error.
 *
 * **A throw means the store could not be reached**, and the guard answers 503 for
 * the route rather than running the handler unguarded: a route that asked for
 * idempotency asked not to run twice.
 */
export abstract class IdempotencyStore {
  constructor() {
    if (new.target === IdempotencyStore) {
      throw new AppError(
        'IdempotencyStore is a contract, not an implementation. Bind one with ' +
          'IdempotencyModule.forRoot({ store: new RedisIdempotencyStore(redis) }), ' +
          'or leave it out for the in-process MemoryIdempotencyStore.',
      );
    }
  }

  /**
   * Takes the key if nobody holds it, atomically. `false` means another request
   * holds it or finished with it; {@link read} says which.
   *
   * The claim expires after `leaseMs`, so a request that crashed mid-handler does
   * not hold its key until the record's TTL.
   */
  abstract claim(
    key: string,
    claim: IdempotencyClaim,
    leaseMs: number,
  ): Promise<boolean>;

  /** The key's state, or `undefined` when it is free. */
  abstract read(key: string): Promise<IdempotencyRecord | undefined>;

  /** Replaces this request's claim with its response, kept for `ttlMs`. */
  abstract complete(
    key: string,
    claim: IdempotencyClaim,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void>;

  /** Drops this request's claim, so a retry runs the handler again. */
  abstract release(key: string, claim: IdempotencyClaim): Promise<void>;
}

/**
 * The one command the Redis store sends, restated structurally so this package
 * keeps its zero dependencies. `@dunx/infra`'s `RedisConnection` and a bare
 * `Bun.RedisClient` both satisfy it, without either being named here.
 *
 * `send` rather than `set`, because the two clients disagree on how `set` takes
 * its `NX PX` arguments and agree on `send`.
 */
export interface IdempotencyRedis {
  send(command: string, args: string[]): Promise<unknown>;
}

interface Encoded {
  readonly f: string;
  readonly s: number;
  readonly h: readonly (readonly [string, string])[];
  readonly b: string;
}

const PENDING = 'pending:';
const DONE = 'done:';

// Compare-and-swap on the exact claim value. A claim whose lease ran out and was
// taken by a retry no longer matches, so the late request changes nothing.
const COMPLETE =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "return redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end return 0";
const RELEASE =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "return redis.call('DEL', KEYS[1]) end return 0";

const pendingValue = (claim: IdempotencyClaim): string =>
  `${PENDING}${claim.token}:${claim.fingerprint}`;

/**
 * The multi-process store: one string key per idempotency key.
 *
 * `SET key pending NX PX lease` is the claim, which Redis applies atomically, so of
 * any number of concurrent requests exactly one gets `OK`. Completion and release
 * are a compare-and-swap in one `EVAL` each. The response is JSON with a base64
 * body.
 */
export class RedisIdempotencyStore extends IdempotencyStore {
  constructor(private readonly redis: IdempotencyRedis) {
    super();
  }

  async claim(
    key: string,
    claim: IdempotencyClaim,
    leaseMs: number,
  ): Promise<boolean> {
    const reply = await this.redis.send('SET', [
      key,
      pendingValue(claim),
      'NX',
      'PX',
      String(leaseMs),
    ]);
    return reply === 'OK';
  }

  async read(key: string): Promise<IdempotencyRecord | undefined> {
    const value = await this.redis.send('GET', [key]);
    if (typeof value !== 'string') return undefined;
    if (value.startsWith(PENDING)) {
      const rest = value.slice(PENDING.length);
      return {
        state: 'pending',
        fingerprint: rest.slice(rest.indexOf(':') + 1),
      };
    }
    const encoded = JSON.parse(value.slice(DONE.length)) as Encoded;
    return {
      state: 'done',
      fingerprint: encoded.f,
      response: {
        status: encoded.s,
        headers: encoded.h,
        body: Uint8Array.fromBase64(encoded.b),
      },
    };
  }

  async complete(
    key: string,
    claim: IdempotencyClaim,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void> {
    const encoded: Encoded = {
      f: claim.fingerprint,
      s: response.status,
      h: response.headers,
      b: response.body.toBase64(),
    };
    await this.redis.send('EVAL', [
      COMPLETE,
      '1',
      key,
      pendingValue(claim),
      DONE + JSON.stringify(encoded),
      String(ttlMs),
    ]);
  }

  async release(key: string, claim: IdempotencyClaim): Promise<void> {
    await this.redis.send('EVAL', [RELEASE, '1', key, pendingValue(claim)]);
  }
}

interface Entry {
  record: IdempotencyRecord;
  token: string | undefined;
  expiresAt: number;
}

/**
 * The single-process store and the default. Per process is the caveat: two
 * replicas behind a balancer each run a retry that lands on the other, and
 * `RedisIdempotencyStore` is the answer for more than one.
 *
 * Expired entries are dropped on touch and swept past `maxKeys`. A full map of
 * live entries then evicts the oldest one, where `MemoryThrottleStore` clears
 * the map: clearing here would forget every in-flight claim and stored response
 * at once, and let each of their retries run again.
 */
export class MemoryIdempotencyStore extends IdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #maxKeys: number;

  constructor(maxKeys = 10_000) {
    super();
    this.#maxKeys = maxKeys;
  }

  claim(
    key: string,
    claim: IdempotencyClaim,
    leaseMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    if (this.#live(key, now) !== undefined) return Promise.resolve(false);
    if (this.#entries.size >= this.#maxKeys) this.#sweep(now);
    this.#entries.set(key, {
      record: { state: 'pending', fingerprint: claim.fingerprint },
      token: claim.token,
      expiresAt: now + leaseMs,
    });
    return Promise.resolve(true);
  }

  read(key: string): Promise<IdempotencyRecord | undefined> {
    return Promise.resolve(this.#live(key, Date.now())?.record);
  }

  complete(
    key: string,
    claim: IdempotencyClaim,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void> {
    if (this.#live(key, Date.now())?.token === claim.token) {
      this.#entries.set(key, {
        record: { state: 'done', fingerprint: claim.fingerprint, response },
        token: undefined,
        expiresAt: Date.now() + ttlMs,
      });
    }
    return Promise.resolve();
  }

  release(key: string, claim: IdempotencyClaim): Promise<void> {
    if (this.#live(key, Date.now())?.token === claim.token) {
      this.#entries.delete(key);
    }
    return Promise.resolve();
  }

  #live(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.expiresAt > now) return entry;
    this.#entries.delete(key);
    return undefined;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    // Insertion order is age order, so the first key is the oldest.
    const oldest = this.#entries.keys().next();
    if (this.#entries.size >= this.#maxKeys && oldest.done !== true) {
      this.#entries.delete(oldest.value);
    }
  }
}

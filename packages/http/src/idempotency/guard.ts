import { AppError, Logger } from '@dunx/core';
import type { BunRequest } from 'bun';
import { STREAMS } from '../route/metadata.js';
import type { RouteContext } from '../server/context.js';
import { HttpError } from '../server/errors.js';
import type { Middleware, Next } from '../server/middleware.js';
import { RawBody } from '../server/raw-body.js';
import { HttpStatusCode } from '../server/status.js';
import { IDEMPOTENT, IdempotencyOptions } from './options.js';
import {
  IdempotencyStore,
  type IdempotencyClaim,
  type StoredResponse,
} from './store.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Stripe's name for it; the draft defines no replay marker. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

/**
 * Visible ASCII without `"` or `\`, up to Stripe's 255. The draft makes the value
 * a Structured Field String, so a quoted one is unwrapped first; a bare one is
 * what most clients send, and is accepted too.
 */
export const IDEMPOTENCY_KEY_PATTERN = '^[\\x21\\x23-\\x5B\\x5D-\\x7E]{1,255}$';
const KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);

const keyOf = (header: string): string => {
  const quoted =
    header.length >= 2 && header.startsWith('"') && header.endsWith('"');
  const key = quoted ? header.slice(1, -1) : header;
  if (!KEY.test(key)) {
    throw new HttpError(
      HttpStatusCode.BAD_REQUEST,
      'Idempotency-Key must be 1 to 255 visible ASCII characters',
    );
  }
  return key;
};

/** Path and query, the part of the target a retry must repeat exactly. */
const targetOf = (url: string): string => {
  const start = url.indexOf('/', url.indexOf('//') + 2);
  return start === -1 ? '/' : url.slice(start);
};

const EMPTY = new Uint8Array(0);

/**
 * The key's owner can replay its response, so a cookie set for one caller would
 * be handed to whoever else shares the key space.
 */
const UNSTORED = 'set-cookie';

/**
 * `Idempotency-Key` handling for a route that opted in with `@Idempotent()`, per
 * draft-ietf-httpapi-idempotency-key-header-07.
 *
 * The first request with a key claims it, runs the handler and stores the
 * response. A retry with the same method, target and body replays it, marked
 * `Idempotent-Replayed: true`. A retry with anything else is a 422, one while the
 * first is still running a 409, and a missing key on a `required` route a 400.
 *
 * **Only a response the handler returned is stored, and only below 500.** A throw
 * or a 5xx releases the key, so the retry the header exists for runs the handler
 * again. Stripe replays a 500; a dunx handler that threw has usually rolled back.
 *
 * **An unreachable store is a 503**, not an unguarded run: the route asked not to
 * run twice, and running it without a claim is how a payment goes through twice.
 */
export class IdempotencyGuard implements Middleware {
  declare protected readonly options: IdempotencyOptions;
  declare protected readonly store: IdempotencyStore;
  declare protected readonly logger: Logger;
  #warned = false;

  /**
   * Takes nothing, so a route that names this guard in an app that never imported
   * `IdempotencyModule` self-binds it, reaches this line and gets the fix.
   * `IdempotencyModule` binds {@link BoundIdempotencyGuard} under this token.
   */
  constructor() {
    if (new.target === IdempotencyGuard) {
      throw new AppError(
        '@Idempotent() needs IdempotencyModule.forRoot({ prefix, subject }) ' +
          'imported, and no module in this app imports it.',
      );
    }
  }

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const route = ctx.get(IDEMPOTENT);
    // A controller-level `@Idempotent()` reaches its `GET`s too, which are
    // idempotent already.
    if (route === undefined || req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }

    const header = req.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (header === null) {
      if (route.required === true) {
        throw new HttpError(
          HttpStatusCode.BAD_REQUEST,
          'Idempotency-Key is missing, and this operation requires one',
        );
      }
      return next();
    }

    const key = this.#storeKey(req, ctx, keyOf(header));
    const claim: IdempotencyClaim = {
      token: crypto.randomUUID(),
      fingerprint: this.#fingerprint(req, await this.#body(req, ctx)),
    };

    const leaseMs = this.options.leaseSeconds * 1000;
    if (!(await this.#reach(() => this.store.claim(key, claim, leaseMs)))) {
      return this.#answer(key, claim);
    }

    let response: Response;
    try {
      response = await next();
    } catch (error) {
      await this.#release(key, claim);
      throw error;
    }
    return this.#keep(key, claim, response, ctx, route.ttlSeconds);
  }

  /** What a request that lost the claim is told. */
  async #answer(key: string, claim: IdempotencyClaim): Promise<Response> {
    const record = await this.#reach(() => this.store.read(key));
    if (record !== undefined && record.fingerprint !== claim.fingerprint) {
      throw new HttpError(
        HttpStatusCode.UNPROCESSABLE_ENTITY,
        'Idempotency-Key is already used with a different request',
      );
    }
    // `undefined` is a key that expired between the claim and the read. It is
    // free now, and a 409 is the answer that says "retry".
    if (record === undefined || record.state === 'pending') {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        'A request is outstanding for this Idempotency-Key',
      );
    }
    const { status, headers, body } = record.response;
    const replay = new Response(body.byteLength === 0 ? null : body, {
      status,
      headers: headers as [string, string][],
    });
    replay.headers.set(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return replay;
  }

  /**
   * Stores what the handler returned, from a clone, and returns the original -
   * whose headers the middleware outside this guard is still free to change.
   */
  async #keep(
    key: string,
    claim: IdempotencyClaim,
    response: Response,
    ctx: RouteContext,
    ttlSeconds: number | undefined,
  ): Promise<Response> {
    const stored =
      response.status < 500 && !this.#streams(response, ctx)
        ? await this.#capture(response)
        : undefined;
    if (stored === undefined) {
      await this.#release(key, claim);
      return response;
    }
    const ttl = (ttlSeconds ?? this.options.ttlSeconds) * 1000;
    try {
      await this.store.complete(key, claim, stored, ttl);
    } catch (error) {
      // The handler ran; failing its response now would invite the retry that
      // runs it twice. The claim lapses with its lease.
      this.#degraded(error);
    }
    return response;
  }

  /** A stream of unknown length is never buffered: it may never end. */
  #streams(response: Response, ctx: RouteContext): boolean {
    return (
      ctx.get(STREAMS) === true ||
      response.headers.get('content-type')?.startsWith('text/event-stream') ===
        true
    );
  }

  /** The response as stored, or `undefined` past `maxBodyBytes`. */
  async #capture(response: Response): Promise<StoredResponse | undefined> {
    const headers: [string, string][] = [];
    for (const [name, value] of response.headers) {
      if (name !== UNSTORED) headers.push([name, value]);
    }
    // A `Blob` of a `Bun.file` body knows its size without reading the file, so
    // an oversized one is never read. A `ReadableStream` is read whole first.
    const blob = await response.clone().blob();
    if (blob.size > this.options.maxBodyBytes) return undefined;
    return { status: response.status, headers, body: await blob.bytes() };
  }

  /**
   * The body, read once. A route with a body schema gets it back through
   * `RawBody`, so its reader parses these bytes rather than an empty stream; one
   * without leaves the request to its handler and reads a clone.
   */
  async #body(req: BunRequest, ctx: RouteContext): Promise<Uint8Array> {
    if (req.body === null) return EMPTY;
    if (!ctx.parsesBody) return req.clone().bytes();
    const bytes = await req.bytes();
    RawBody.buffer(req, bytes);
    return bytes;
  }

  #fingerprint(req: BunRequest, body: Uint8Array): string {
    return new Bun.CryptoHasher('sha256')
      .update(`${req.method} ${targetOf(req.url)}\n`)
      .update(body)
      .digest('hex');
  }

  #storeKey(req: BunRequest, ctx: RouteContext, key: string): string {
    const subject = this.options.subject?.(req, ctx);
    const owner = subject === undefined ? '' : encodeURIComponent(subject);
    return `${this.options.prefix}:idempotency:${owner}:${key}`;
  }

  async #reach<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.#degraded(error);
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        'The idempotency store is unreachable, so this request was not run',
        { cause: error },
      );
    }
  }

  async #release(key: string, claim: IdempotencyClaim): Promise<void> {
    try {
      await this.store.release(key, claim);
    } catch (error) {
      this.#degraded(error);
    }
  }

  #degraded(error: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    this.logger.warn('The idempotency store is unreachable.', {
      reason: (error as Error).message,
    });
  }
}

/** The guard with its dependencies, as `IdempotencyModule` builds it. */
export class BoundIdempotencyGuard extends IdempotencyGuard {
  constructor(
    protected override readonly options: IdempotencyOptions,
    protected override readonly store: IdempotencyStore,
    protected override readonly logger: Logger,
  ) {
    super();
  }
}

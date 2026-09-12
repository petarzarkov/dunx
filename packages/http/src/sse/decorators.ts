import type { BunRequest } from 'bun';
import { markRoute, type RoutePath } from '../route/marker.js';
import type { Input, RouteInput, RouteSchemas } from '../route/schema.js';
import { RequestTimeout } from '../server/request-timeout.js';
import type { SseEvent } from './event.js';
import { SseStream } from './stream.js';

/**
 * The request half of {@link RouteSchemas}. An event stream has no request body,
 * and its status is always 200.
 */
export type SseSchemas = Pick<RouteSchemas, 'params' | 'query'>;

/** What a `@Sse` handler may answer with. */
export type SseResult = SseStream | AsyncIterable<SseEvent>;

/** {@link Input} plus the one header an event stream is resumed with. */
export type SseInput<O extends SseSchemas> = Input<O> & {
  /**
   * The `id` of the last event this client saw, sent back as `Last-Event-ID` when
   * it reconnects. Absent on a first connection.
   */
  readonly lastEventId: string | undefined;
};

/** The wrapper's view of the handler: `RouteInput`, with the header added. */
type SseHandler = (
  input: RouteInput & { readonly lastEventId: string | undefined },
) => SseResult | Promise<SseResult>;

const LAST_EVENT_ID = 'last-event-id';

/**
 * The idle timeout is cleared for every stream, because idling is what an event
 * stream is for. No teardown beyond that: a client that goes away cancels the
 * response body, which is what the stream clears its heartbeat from - measured on
 * Bun 1.4.2, the request aborted before a slow handler returned its `Response`
 * included.
 */
const respond = (result: SseResult, req: BunRequest): Response => {
  RequestTimeout.clear(req);
  return (
    result instanceof SseStream ? result : SseStream.from(result)
  ).toResponse();
};

/**
 * A `GET` route answering `text/event-stream`, from a handler that returns an
 * `AsyncIterable<SseEvent>` or an {@link SseStream}.
 *
 * ```ts
 * @Sse('/progress')
 * async *progress(input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
 *   for (let step = 0; step <= 100; step += 10) {
 *     yield { data: { step }, id: String(step) };
 *     await Bun.sleep(100);
 *   }
 * }
 * ```
 *
 * The parameter has to be annotated, for the reason `@Get`'s does: a standard
 * decorator can check a parameter's type but not supply one.
 */
export const Sse =
  <const O extends SseSchemas>(path: RoutePath = '/', options?: O) =>
  <H extends (input: SseInput<O>) => SseResult | Promise<SseResult>>(
    value: H,
    _context: ClassMethodDecoratorContext,
  ): H => {
    const handler = value as unknown as SseHandler;

    function served(
      this: unknown,
      input: RouteInput,
    ): Response | Promise<Response> {
      const result = handler.call(this, {
        ...input,
        lastEventId: input.req.headers.get(LAST_EVENT_ID) ?? undefined,
      });
      return result instanceof Promise
        ? result.then((settled) => respond(settled, input.req))
        : respond(result, input.req);
    }

    markRoute(served, { method: 'GET', path, options });
    // The class gets this wrapper, which answers a `Response` where the handler
    // answered a stream. A method decorator's return type has to be assignable to
    // the method it replaces, so the cast is the only way to say so.
    return served as unknown as H;
  };

import { markRoute, type RoutePath } from '../route/marker.js';
import { meta, STREAMS } from '../route/metadata.js';
import type { Input, RouteInput, RouteSchemas } from '../route/schema.js';
import type { SseEvent } from './event.js';
import { SseStream } from './stream.js';

/** The request half of {@link RouteSchemas}: no body, and always 200. */
export type SseSchemas = Pick<RouteSchemas, 'params' | 'query'>;

/** What a `@Sse` handler may answer with. */
export type SseResult = SseStream | AsyncIterable<SseEvent>;

/** {@link Input} plus the resume header. */
export type SseInput<O extends SseSchemas> = Input<O> & {
  /** The `id` this client last saw, from `Last-Event-ID`. Absent on a first connection. */
  readonly lastEventId: string | undefined;
};

/** The wrapper's view of the handler: `RouteInput`, with the header added. */
type SseHandler = (
  input: RouteInput & { readonly lastEventId: string | undefined },
) => SseResult | Promise<SseResult>;

const LAST_EVENT_ID = 'last-event-id';

/**
 * No teardown beyond the stream's own: a departing client cancels the response
 * body, which is what clears the heartbeat. `buildRoutes` clears the idle
 * deadline, having the server.
 */
const respond = (result: SseResult): Response =>
  (result instanceof SseStream ? result : SseStream.from(result)).toResponse();

/**
 * A `GET` route answering `text/event-stream`, from a handler returning an
 * `AsyncIterable<SseEvent>` or an {@link SseStream}.
 *
 * ```ts
 * @Sse('/progress')
 * async *progress(input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
 *   yield { data: { step: 10 }, id: '10' };
 * }
 * ```
 *
 * The parameter is annotated for the reason `@Get`'s is: a standard decorator
 * can check a parameter's type but not supply one.
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
        ? result.then((settled) => respond(settled))
        : respond(result);
    }

    markRoute(served, { method: 'GET', path, options });
    // Idling is what an event stream is for, so the route declares it and
    // `buildRoutes` clears Bun's deadline using the server it is handed.
    meta(STREAMS, true)(served);
    // The wrapper answers a `Response` where the handler answered a stream, and
    // a method decorator's return has to be assignable to what it replaces.
    return served as unknown as H;
  };

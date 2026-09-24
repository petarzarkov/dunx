import {
  parseTraceparent,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  type RemoteParent,
  type RequestFields,
  type TraceIds,
} from '@dunx/core';

/**
 * The `traceparent` and `tracestate` a message carries, as AMQP headers or as
 * bullmq's telemetry metadata. The state belongs to the header it arrived with,
 * so a malformed header drops both: keeping the vendor state would attach one
 * trace's to another's ids.
 *
 * Here rather than in either subpath for the reason `withTimeout` is.
 */
export const remoteParentOf = (
  carrier: Readonly<Record<string, unknown>>,
): RemoteParent | undefined => {
  const header = carrier[TRACEPARENT_HEADER];
  const inbound = parseTraceparent(
    typeof header === 'string' ? header : undefined,
  );
  const state = carrier[TRACESTATE_HEADER];
  if (inbound === undefined || typeof state !== 'string') return inbound;
  return { ...inbound, state };
};

/**
 * The scope's `tracestate` to send beside `ids`, which is nothing when the scope
 * is on another trace: a span opened under some other active one has that
 * trace's ids, and the scope's vendor state is not its.
 */
export const traceStateFor = (
  ids: TraceIds,
  scope: Pick<RequestFields, 'traceId' | 'traceState'>,
): string | undefined =>
  scope.traceId === ids.traceId ? scope.traceState : undefined;

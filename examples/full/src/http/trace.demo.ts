import { Logger } from '@dunx/core';

interface Seen {
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly parentSpanId: string | undefined;
}

const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN = '00f067aa0ba902b7';

const ask = async (url: string, traceparent?: string): Promise<Seen> => {
  const response = await fetch(new URL('api/trace', url), {
    headers: traceparent === undefined ? {} : { traceparent },
  });
  return (await response.json()) as Seen;
};

export class TraceDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const { logger } = this;

    const fresh = await ask(url);
    logger.info(
      `no traceparent in: trace ${fresh.traceId} span ${fresh.spanId} ` +
        `(no parent - this service started the trace)`,
    );

    const continued = await ask(
      url,
      `00-${UPSTREAM_TRACE}-${UPSTREAM_SPAN}-01`,
    );
    logger.info(
      `traceparent in:    trace ${continued.traceId} span ${continued.spanId} ` +
        `parent ${continued.parentSpanId}`,
    );
    logger.info(
      `the caller's trace id survived: ${continued.traceId === UPSTREAM_TRACE}, ` +
        `and its span became this one's parent: ${continued.parentSpanId === UPSTREAM_SPAN}`,
    );

    // Discarded rather than repaired. An unparseable header means the caller's
    // trace is unknown, so this request starts one of its own.
    const broken = await ask(url, '00-not-a-trace-id-01');
    logger.info(
      `malformed traceparent in: trace ${broken.traceId} ` +
        `(a fresh one, not the caller's)`,
    );

    // Two requests are two traces, and two spans within one.
    const second = await ask(url);
    logger.info(
      `each request gets its own span: ${fresh.spanId !== second.spanId}`,
    );
  }
}

import type { BunRequest } from 'bun';
import type { RouteSchemas } from '../route/schema.js';
import { RawBody } from './raw-body.js';

/** Reuse bytes consumed by middleware, and keep body logging before validation. */
export const parseCustomBody = (
  req: BunRequest,
  parse: NonNullable<RouteSchemas['bodyParser']>,
): unknown => {
  const buffered = RawBody.buffered(req);
  const source =
    buffered === undefined
      ? req
      : (Object.assign(
          new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: buffered,
            signal: req.signal,
          }),
          { params: req.params },
        ) as BunRequest);
  if (!RawBody.wanted(req)) return parse(source);
  return source
    .clone()
    .text()
    .then((text) => {
      RawBody.record(req, text);
      return parse(source);
    });
};

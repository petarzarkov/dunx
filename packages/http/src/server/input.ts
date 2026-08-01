import type { BunRequest } from 'bun';
import type {
  RouteInput,
  RouteSchemas,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';
import {
  HttpError,
  ValidationError,
  type InputSource,
  type ValidationIssue,
} from './errors.js';
import { HttpStatusCode } from './status.js';

/**
 * Built once per route at boot. A route that declares nothing gets the identity
 * reader — no parse, no validation, not even a promise.
 *
 * A reader **returns a promise only when it has something to wait for**. A `body`
 * schema always does; `query` and `params` against a synchronous validator — which
 * zod, Valibot and ArkType all are — resolve without one.
 */
export type InputReader = (req: BunRequest) => RouteInput | Promise<RouteInput>;

interface InputDraft {
  req: BunRequest;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * One declared schema's contribution to the draft, returning the draft so the
 * steps chain without a wrapper. A bare `InputDraft` means it finished
 * synchronously, which is the common case and the reason this is not `async`:
 * Standard Schema *permits* a promise, so awaiting unconditionally costs an async
 * frame and a microtask tick per schema for a validator that never returns one.
 */
type Fill = (draft: InputDraft) => InputDraft | Promise<InputDraft>;
type BodyParser = (req: BunRequest) => Promise<unknown>;

/** What `URLSearchParams` and `FormData` both offer, and all {@link grouped} needs. */
interface Enumerable {
  forEach(visit: (value: unknown, key: string) => void): void;
}

/**
 * A repeated key becomes an array, so `?tag=a&tag=b` reaches the schema whole
 * instead of silently losing `a`. Shared by query strings, urlencoded bodies and
 * multipart form data.
 *
 * `forEach` rather than `for…of`: both collections implement it natively, and
 * destructuring an iterator allocates a two-element array per entry. Measured at
 * ~150 ns/request cheaper on a three-pair query string.
 */
const grouped = (entries: Enumerable): Record<string, unknown> => {
  const collected: Record<string, unknown> = {};

  entries.forEach((value, key) => {
    const existing = collected[key];
    if (existing === undefined) collected[key] = value;
    else if (Array.isArray(existing)) (existing as unknown[]).push(value);
    else collected[key] = [existing, value];
  });

  return collected;
};

const asJson: BodyParser = (req) => req.json();
const asUrlEncoded: BodyParser = async (req) =>
  grouped(new URLSearchParams(await req.text()));
const asMultipart: BodyParser = async (req) => grouped(await req.formData());
const asText: BodyParser = (req) => req.text();

/** `application/vnd.api+json` and friends parse as JSON; `text/csv` as text. */
const parserFor = (media: string): BodyParser | undefined => {
  if (media === 'application/json' || media.endsWith('+json')) return asJson;
  if (media === 'application/x-www-form-urlencoded') return asUrlEncoded;
  if (media === 'multipart/form-data') return asMultipart;
  if (media.startsWith('text/')) return asText;
  return undefined;
};

const JSON_MEDIA = 'application/json';

// No content-type reads as JSON: fetch omits the header for a bodyless request and
// a 415 there would be useless, since the schema is about to reject `undefined`.
const mediaTypeOf = (req: BunRequest): string => {
  const header = req.headers.get('content-type');
  // The header almost every JSON client sends, verbatim — worth not slicing,
  // trimming and lowercasing on the hot path.
  if (header === JSON_MEDIA || header === null) return JSON_MEDIA;
  const end = header.indexOf(';');
  const media = (end === -1 ? header : header.slice(0, end)).trim();
  return media === '' ? JSON_MEDIA : media.toLowerCase();
};

const flatten = (issue: StandardSchemaIssue): ValidationIssue => {
  const path = issue.path
    ?.map((segment) =>
      String(typeof segment === 'object' ? segment.key : segment),
    )
    .join('.');

  return path === undefined || path === ''
    ? { message: issue.message }
    : { message: issue.message, path };
};

/** A rejected schema is a 400 carrying every issue, path flattened to dots. */
const accept = (source: InputSource, result: StandardSchemaResult<unknown>) => {
  if (result.issues !== undefined) {
    throw new ValidationError(source, result.issues.map(flatten));
  }
  return result.value;
};

/**
 * Validates, assigns, and hands the draft back. Returning the draft rather than
 * `void` is what lets the reader be `(req) => fill({ req })`: a body route then
 * costs one promise link in total, where threading the draft back through a second
 * `then` cost two — worth ~120 ns per request, measured.
 */
const fillWith = (
  draft: InputDraft,
  source: InputSource,
  schema: StandardSchemaV1,
  value: unknown,
): InputDraft | Promise<InputDraft> => {
  const result = schema['~standard'].validate(value);

  if (result instanceof Promise) {
    return result.then((settled) => {
      draft[source] = accept(source, settled);
      return draft;
    });
  }
  draft[source] = accept(source, result);
  return draft;
};

const bodyFill =
  (schema: StandardSchemaV1): Fill =>
  (draft) => {
    const media = mediaTypeOf(draft.req);
    const parse = parserFor(media);

    if (parse === undefined) {
      throw new HttpError(
        HttpStatusCode.UNSUPPORTED_MEDIA_TYPE,
        `Unsupported content type "${media}". Declared bodies accept ` +
          'application/json, application/x-www-form-urlencoded, multipart/form-data or text/*.',
      );
    }

    // Both handlers on one `then`, so the parse costs a single promise link. A
    // `ValidationError` from the success handler is deliberately not visible to the
    // rejection handler — only an unreadable or mangled body is a parse failure.
    return parse(draft.req).then(
      (value) => fillWith(draft, 'body', schema, value),
      (error: unknown) => {
        // A body the caller mangled is a 400. Only an unreadable stream would be ours.
        throw new HttpError(
          HttpStatusCode.BAD_REQUEST,
          `Malformed ${media} body`,
          { cause: error },
        );
      },
    );
  };

/**
 * The query string, without parsing the whole URL to reach it. `new URL(req.url)`
 * resolves scheme, host, port, path and fragment to hand back a `searchParams`, and
 * measured **~1,000 ns of the ~1,500 ns** a `query` route used to cost — more than
 * the entire body reader. `RequestLoggingMiddleware` took the same slice for the
 * same reason.
 *
 * The fragment is stripped even though a client is not supposed to send one, because
 * `new URL` stripped it and a hostile request-target should not change what a schema
 * sees.
 */
const searchOf = (url: string): string => {
  const start = url.indexOf('?');
  if (start === -1) return '';
  const end = url.indexOf('#', start + 1);
  return end === -1 ? url.slice(start + 1) : url.slice(start + 1, end);
};

const queryFill =
  (schema: StandardSchemaV1): Fill =>
  (draft) => {
    const params = new URLSearchParams(searchOf(draft.req.url));
    return fillWith(draft, 'query', schema, grouped(params));
  };

const paramsFill =
  (schema: StandardSchemaV1): Fill =>
  (draft) =>
    fillWith(draft, 'params', schema, draft.req.params);

/** Sequential, and stays sequential without a promise unless one is produced. */
const then =
  (first: Fill, second: Fill): Fill =>
  (draft) => {
    const started = first(draft);
    return started instanceof Promise ? started.then(second) : second(started);
  };

/**
 * Folds the declared schemas into a single closure, the way `compose` folds
 * middleware: which parsers and validators run is decided here, at boot, so per
 * request there is no metadata to read and no branch left to take.
 */
export const buildInputReader = (
  options: RouteSchemas | undefined,
): InputReader => {
  const fills: Fill[] = [];
  if (options?.body !== undefined) fills.push(bodyFill(options.body));
  if (options?.query !== undefined) fills.push(queryFill(options.query));
  if (options?.params !== undefined) fills.push(paramsFill(options.params));

  if (fills.length === 0) return (req) => ({ req });

  const fill = fills.reduce(then);
  return (req) => fill({ req });
};

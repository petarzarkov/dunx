import type { BunRequest } from 'bun';
import type {
  RouteInput,
  RouteSchemas,
  StandardSchemaIssue,
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
 */
export type InputReader = (req: BunRequest) => RouteInput | Promise<RouteInput>;

interface InputDraft {
  req: BunRequest;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

type Fill = (draft: InputDraft) => Promise<void>;
type BodyParser = (req: BunRequest) => Promise<unknown>;

/**
 * A repeated key becomes an array, so `?tag=a&tag=b` reaches the schema whole
 * instead of silently losing `a`. Shared by query strings and urlencoded bodies.
 */
const grouped = (
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> => {
  const collected: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    const existing = collected[key];
    if (existing === undefined) collected[key] = value;
    else if (Array.isArray(existing)) (existing as unknown[]).push(value);
    else collected[key] = [existing, value];
  }

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

// No content-type reads as JSON: fetch omits the header for a bodyless request and
// a 415 there would be useless, since the schema is about to reject `undefined`.
const mediaTypeOf = (req: BunRequest): string => {
  const header = req.headers.get('content-type');
  if (header === null) return 'application/json';
  const end = header.indexOf(';');
  const media = (end === -1 ? header : header.slice(0, end)).trim();
  return media === '' ? 'application/json' : media.toLowerCase();
};

const readBody = async (req: BunRequest): Promise<unknown> => {
  const media = mediaTypeOf(req);
  const parse = parserFor(media);

  if (parse === undefined) {
    throw new HttpError(
      HttpStatusCode.UNSUPPORTED_MEDIA_TYPE,
      `Unsupported content type "${media}". Declared bodies accept ` +
        'application/json, application/x-www-form-urlencoded, multipart/form-data or text/*.',
    );
  }

  try {
    return await parse(req);
  } catch (error) {
    // A body the caller mangled is a 400. Only an unreadable stream would be ours.
    throw new HttpError(HttpStatusCode.BAD_REQUEST, `Malformed ${media} body`, {
      cause: error,
    });
  }
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

const validated = async (
  schema: StandardSchemaV1,
  source: InputSource,
  value: unknown,
): Promise<unknown> => {
  // Standard Schema allows a promise, so this await is not optional.
  const result = await schema['~standard'].validate(value);
  if (result.issues !== undefined) {
    throw new ValidationError(source, result.issues.map(flatten));
  }
  return result.value;
};

const bodyFill =
  (schema: StandardSchemaV1): Fill =>
  async (draft) => {
    draft.body = await validated(schema, 'body', await readBody(draft.req));
  };

const queryFill =
  (schema: StandardSchemaV1): Fill =>
  async (draft) => {
    const { searchParams } = new URL(draft.req.url);
    draft.query = await validated(schema, 'query', grouped(searchParams));
  };

const paramsFill =
  (schema: StandardSchemaV1): Fill =>
  async (draft) => {
    draft.params = await validated(schema, 'params', draft.req.params);
  };

const then =
  (first: Fill, second: Fill): Fill =>
  async (draft) => {
    await first(draft);
    await second(draft);
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
  return async (req) => {
    const draft: InputDraft = { req };
    await fill(draft);
    return draft;
  };
};

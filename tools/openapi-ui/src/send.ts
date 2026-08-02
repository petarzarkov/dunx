import type { AuthParts } from './auth';
import type { OperationKey, TryField } from './model';

export type FieldValues = Readonly<Record<string, string>>;

/** Two parameters may share a name in different places, so the key carries both. */
export const fieldKey = (field: TryField): string =>
  `${field.in}:${field.name}`;

export interface RequestSpec {
  readonly method: OperationKey;
  readonly path: string;
  readonly fields: readonly TryField[];
  readonly values: FieldValues;
  readonly headerLines: string;
  /** `undefined` where the operation declares no JSON body. */
  readonly body?: string;
  readonly auth: AuthParts;
}

/**
 * Path parameters are substituted into the template and query parameters are
 * appended only when filled, so an untouched optional never shows up as `?x=`.
 */
export const buildUrl = (spec: RequestSpec, origin: string): URL => {
  let path = spec.path;
  for (const field of spec.fields) {
    if (field.in !== 'path') continue;
    const value = (spec.values[fieldKey(field)] ?? '').trim();
    path = path.replace(`{${field.name}}`, encodeURIComponent(value));
  }

  const url = new URL(path, origin);
  for (const field of spec.fields) {
    if (field.in !== 'query') continue;
    const value = (spec.values[fieldKey(field)] ?? '').trim();
    if (value !== '') url.searchParams.set(field.name, value);
  }
  for (const [name, value] of Object.entries(spec.auth.query)) {
    url.searchParams.set(name, value);
  }
  return url;
};

const hasBody = (spec: RequestSpec): boolean =>
  spec.body !== undefined && spec.method !== 'get';

/**
 * Auth first, then the operation's own header parameters, then the free-text box
 * - so a line typed by hand always wins over what the dialog would have sent.
 */
export const buildHeaders = (spec: RequestSpec): Record<string, string> => {
  const headers: Record<string, string> = { ...spec.auth.headers };
  if (hasBody(spec)) headers['content-type'] = 'application/json';

  for (const field of spec.fields) {
    if (field.in !== 'header') continue;
    const value = (spec.values[fieldKey(field)] ?? '').trim();
    if (value !== '') headers[field.name] = value;
  }

  for (const line of spec.headerLines.split('\n')) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
};

export interface Outcome {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly ms: number;
  readonly bytes: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  readonly url: string;
  readonly error?: string;
}

const pretty = (body: string, contentType: string): string => {
  if (!contentType.includes('json')) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

export const sendRequest = async (
  spec: RequestSpec,
  origin: string,
): Promise<Outcome> => {
  const url = buildUrl(spec, origin);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: spec.method.toUpperCase(),
      headers: buildHeaders(spec),
      ...(hasBody(spec) ? { body: spec.body } : {}),
    });
    const ms = Math.round(performance.now() - started);
    const raw = await response.text();
    const type = response.headers.get('content-type') ?? '';

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      ms,
      bytes: raw.length,
      headers: [...response.headers].sort((a, b) => a[0].localeCompare(b[0])),
      body: pretty(raw, type),
      url: String(url),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: 'Request failed',
      ms: Math.round(performance.now() - started),
      bytes: 0,
      headers: [],
      body: String(error),
      url: String(url),
      error: String(error),
    };
  }
};

import type { SecuritySchemeObject } from './model';

/** One scheme's credentials. `user`/`pass` are only read for HTTP basic. */
export interface Credential {
  readonly value: string;
  readonly user: string;
  readonly pass: string;
}

export type AuthState = Readonly<Record<string, Credential>>;

export const EMPTY_CREDENTIAL: Credential = { value: '', user: '', pass: '' };

export interface AuthParts {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

const isFilled = (scheme: SecuritySchemeObject, held: Credential): boolean =>
  scheme.type === 'http' && scheme.scheme === 'basic'
    ? held.user !== '' || held.pass !== ''
    : held.value !== '';

/** Every scheme the reader has actually filled in. Drives the header badge. */
export const configured = (
  schemes: Readonly<Record<string, SecuritySchemeObject>>,
  state: AuthState,
): readonly string[] =>
  Object.keys(schemes).filter((name) =>
    isFilled(
      schemes[name] as SecuritySchemeObject,
      state[name] ?? EMPTY_CREDENTIAL,
    ),
  );

/**
 * Credentials are entered once and applied to every operation that asks for the
 * scheme - the whole point of the dialog, and what retyping an `Authorization`
 * header per operation used to cost.
 *
 * An `apiKey` scheme is honoured where it says it travels: `in: 'query'` becomes
 * a query parameter, everything else a header. A cookie scheme is left alone,
 * because `fetch` will not let a page set one.
 */
export const authFor = (
  schemes: Readonly<Record<string, SecuritySchemeObject>>,
  state: AuthState,
  wanted: readonly string[],
): AuthParts => {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};

  for (const name of wanted) {
    const scheme = schemes[name];
    const held = state[name] ?? EMPTY_CREDENTIAL;
    if (scheme === undefined || !isFilled(scheme, held)) continue;

    if (scheme.type === 'apiKey') {
      const key = scheme.name ?? name;
      if (scheme.in === 'query') query[key] = held.value;
      else if (scheme.in !== 'cookie') headers[key] = held.value;
      continue;
    }

    if (scheme.type === 'http' && scheme.scheme === 'basic') {
      headers['Authorization'] = `Basic ${btoa(`${held.user}:${held.pass}`)}`;
      continue;
    }

    // http/bearer, oauth2 and openIdConnect all end up as a bearer token, which
    // is what their flows hand you and what a docs page can usefully carry.
    headers['Authorization'] = held.value.toLowerCase().startsWith('bearer ')
      ? held.value
      : `Bearer ${held.value}`;
  }

  return { headers, query };
};

const KEY = 'dunx.openapi.auth';

/**
 * `sessionStorage`, not `localStorage`: a token typed into a docs page should not
 * outlive the tab. Storage can throw (private mode, a sandboxed frame), and a
 * docs page failing to boot over that would be worse than losing the value.
 */
export const loadAuth = (): AuthState => {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw === null ? {} : (JSON.parse(raw) as AuthState);
  } catch {
    return {};
  }
};

export const saveAuth = (state: AuthState): void => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Nothing to do: the credentials stay in memory for this page load.
  }
};

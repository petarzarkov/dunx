# Cookies

Read and set cookies on `req.cookies`, Bun's own `CookieMap`. Bun writes every
change onto the response the route returns, so a handler returning a plain
value sets a cookie too.

```ts
import { Controller, Delete, Get, type RouteInput } from '@dunx/http';

@Controller('session')
export class SessionController {
  @Get('')
  read({ req }: RouteInput) {
    return { theme: req.cookies.get('theme') }; // string | null
  }

  @Get('dark')
  dark({ req }: RouteInput) {
    req.cookies.set('theme', 'dark', { maxAge: 86_400 });
    return { ok: true }; // Set-Cookie: theme=dark; Path=/; Max-Age=86400; SameSite=Lax
  }

  @Delete('')
  clear({ req }: RouteInput) {
    req.cookies.delete('theme'); // theme=; Path=/; Expires=Thu, 01 Jan 1970 ...
  }
}
```

`set` takes Bun's `CookieInit`: `domain`, `path`, `expires`, `maxAge`, `secure`,
`httpOnly`, `sameSite` and `partitioned`. Bun percent-encodes the value and
decodes it on `get`. A header string you would otherwise build by hand is
`new Bun.Cookie(name, value, options).serialize()`.

## Which responses carry the change

| Response                                        | `Set-Cookie` from `req.cookies`         |
| ----------------------------------------------- | --------------------------------------- |
| A returned value, `undefined` (204), `Response` | Sent, after the `Response`'s own        |
| A thrown error, through the error mapper        | Sent: a `set` before the throw stands   |
| A 304 from `etag`                               | Sent: RFC 6265 section 3 processes it   |
| An `@Idempotent()` replay                       | None: the handler did not run           |
| A CSRF refusal                                  | None: the handler did not run           |
| Header or media-type versioning                 | The chosen version's                    |
| An unmatched path or a claimed path             | Sent: dunx gives the fallback a map too |

`req.cookies` also works on unmatched and claimed paths. Bun only provides it
for requests that match a route, so dunx adds it on the others and sends any
changes back the same way. A global guard can read a session cookie on an
unmatched path and answer 401. When nothing reads it, this adds 0.33 us to a 404.

`@Idempotent()` never stores a `Set-Cookie`, and a cookie set through
`req.cookies` never reaches its store at all: Bun adds it after the guard has
captured the response.

## Signed cookies

Bind the secrets once. The module is global.

```ts
import { SignedCookiesModule } from '@dunx/http';

@Module({
  imports: [
    SignedCookiesModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        secrets: config.get('COOKIE_SECRETS').split(','),
      }),
      inject: [AppConfigService] as const,
    }),
  ],
})
export class AppModule {}
```

Then inject `SignedCookies` and pass it the request's map.

```ts
@Controller('preferences')
export class PreferencesController {
  constructor(private readonly signed: SignedCookies) {}

  @Get('')
  read({ req }: RouteInput) {
    return { theme: this.signed.get(req.cookies, 'prefs') ?? 'system' };
  }

  @Put('', { body: Preference })
  write({ req, body }: Input<{ body: typeof Preference }>) {
    this.signed.set(req.cookies, 'prefs', body.theme, { maxAge: 31_536_000 });
    return body;
  }
}
```

| Member                                       | Does                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| `forRoot({ secrets })`                       | Binds `SignedCookies` over a list of secrets                   |
| `forRootAsync({ imports, useFactory, ... })` | The same, from a factory                                       |
| `get(cookies, name)`                         | The verified value, or `undefined` when absent or tampered     |
| `set(cookies, name, value, options?)`        | Signs with the first secret and sets under the defaults below  |
| `SIGNED_COOKIE_DEFAULTS`                     | `{ path: '/', httpOnly: true, secure: true, sameSite: 'lax' }` |

`get` never throws. A missing, unsigned, re-signed or edited cookie reads as
`undefined`, the same as an absent one. Validate what it returns as you would a
body: the signature says this server wrote it, not that it is still valid.

The wire value is `<value>.<signature>`, the signature the unpadded base64url
HMAC-SHA256 of `<name>=<value>`: 43 characters. A value signed for one cookie
does not verify under another name. `get` costs 0.46 us with the first secret.

### Rotating a secret

Put the new secret first and keep the old one after it until the cookies it
signed have expired.

```ts
SignedCookiesModule.forRoot({ secrets: [NEW_SECRET, OLD_SECRET] });
```

`set` signs with `NEW_SECRET`; `get` accepts either. A cookie signed by neither
costs one HMAC per secret to reject.

### Defaults and failures

| Attribute  | Bun's `set` | `SignedCookies.set` |
| ---------- | ----------- | ------------------- |
| `Path`     | `/`         | `/`                 |
| `SameSite` | `Lax`       | `Lax`               |
| `HttpOnly` | off         | on                  |
| `Secure`   | off         | on                  |

`Secure` stays on for `http://localhost`, where Chrome keeps it. On plain HTTP
under any other host, pass `secure: false`.

| Mistake                                                                      | Fails        |
| ---------------------------------------------------------------------------- | ------------ |
| No secrets, or one shorter than 32 characters                                | At boot      |
| A `__Secure-` name without `Secure`                                          | `set` throws |
| A `__Host-` name without `Secure`, with `Domain`, or a `Path` other than `/` | `set` throws |
| `sameSite: 'none'` without `Secure`                                          | `set` throws |

Each of the last three is a cookie a browser drops silently under
draft-ietf-httpbis-rfc6265bis-22, sections 4.1.3 and 5.7. Plain `req.cookies.set`
checks none of them.

## Cookies dunx does not touch

better-auth sets its session cookies itself, with its own attributes and
signature; see [Authentication](./17-authentication.md). `SignedCookies` is for
the app's own values. There is no session store.

## Coming from Express or Hono

| Express, Hono                          | dunx                                       |
| -------------------------------------- | ------------------------------------------ |
| `req.cookies`, `getCookie(c, name)`    | `req.cookies.get(name)`                    |
| `res.cookie()`, `setCookie(c, ...)`    | `req.cookies.set(name, value, options)`    |
| `req.signedCookies`, `getSignedCookie` | `signed.get(req.cookies, name)`            |
| `cookie-parser(secret)`                | `SignedCookiesModule.forRoot({ secrets })` |

An Express or Hono signed cookie does not verify here: both sign the value
alone, in standard base64.

## See also

- [Controllers](./05-controllers.md), for what a handler receives
- [Security](./32-security.md), for CSRF, which a `SameSite=Lax` cookie does not replace
- [Caching](./15-caching.md), for `etag` and the 304

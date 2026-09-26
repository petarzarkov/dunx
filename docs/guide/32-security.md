# Security

## Response headers

Set `securityHeaders` and every response dunx produces carries the headers
below: matched routes, the unmatched-path 404, errors the error mapper built,
static files, server-sent event streams, CORS preflights and dunx's own pages.

```ts
const app = await HttpFactory.create(AppModule, {
  securityHeaders: true,
});
```

It is off by default, because turning it on changes every response an existing
app sends.

| Field                     | Header                       | Default                               |
| ------------------------- | ---------------------------- | ------------------------------------- |
| `strictTransportSecurity` | `Strict-Transport-Security`  | `max-age=31536000; includeSubDomains` |
| `xContentTypeOptions`     | `X-Content-Type-Options`     | `nosniff`                             |
| `referrerPolicy`          | `Referrer-Policy`            | `no-referrer`                         |
| `xFrameOptions`           | `X-Frame-Options`            | `DENY`                                |
| `crossOriginOpenerPolicy` | `Cross-Origin-Opener-Policy` | `same-origin`                         |
| `xDnsPrefetchControl`     | `X-DNS-Prefetch-Control`     | `off`                                 |
| `originAgentCluster`      | `Origin-Agent-Cluster`       | `?1`                                  |
| `contentSecurityPolicy`   | `Content-Security-Policy`    | not sent                              |

Pass an object to change one header, or `false` to drop it:

```ts
import { STRICT_CSP } from '@dunx/http';

HttpFactory.create(AppModule, {
  securityHeaders: {
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: false,
    // `true` sends STRICT_CSP as it is.
    contentSecurityPolicy: `${STRICT_CSP}; img-src 'self' data:`,
  },
});
```

`STRICT_CSP` is
`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`.

`HttpOptionsProvider` has the same field as a getter, so the value can come
from validated config. An argument to `create()` still wins over it.

`Strict-Transport-Security` is sent over plain HTTP too. A browser ignores it
there, and behind a proxy that terminates TLS the app cannot tell which scheme
the browser used. Bun adds no `Server` or `X-Powered-By` header of its own.

`includeSubDomains` makes a browser that saw the header upgrade every subdomain
to HTTPS for a year. Serve every subdomain over HTTPS before turning it on, or
set `strictTransportSecurity: 'max-age=31536000'` to cover this host alone.

## One route, one header

A header the response already carries is kept. A route that must be framed, or
needs a looser policy, sets its own. Under a CSP, `frame-ancestors` is what the
browser obeys, so a route that may be framed sets that too:

```ts
@Get('/embed')
embed(): Response {
  return new Response(html, {
    headers: {
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': STRICT_CSP.replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    },
  });
}
```

## dunx's own pages

Swagger UI, Scalar, the dashboard and bull-board each send a
`Content-Security-Policy` of their own, so a strict app policy does not blank
them, whether or not `securityHeaders` is on. It admits same-origin scripts,
the origin of each `<script src>` the page loads from another host, and each
inline boot script by SHA-256 hash. Only the page's own origin may frame it,
even with `X-Frame-Options` turned off.

Styles, images, fonts and connections stay open: three of the four inject
styles at runtime, and an explorer calls whatever servers the document lists.

A page you serve yourself from inline scripts gets the same policy from
`inlineScriptPolicy(html)`. Compute it once per page, and only for HTML built
from trusted parts: a script injected through user input would be hashed and
admitted with the rest.

```ts
import { inlineScriptPolicy } from '@dunx/http';

const policy = inlineScriptPolicy(html);
return new Response(html, {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': policy,
  },
});
```

## Cross-site requests

Set `csrf` and a browser's cross-site `POST`, `PUT`, `PATCH` or `DELETE` is
refused with a 403. There is no token: the check reads the `Sec-Fetch-Site` and
`Origin` headers the browser sets, the design of Go 1.25's
`net/http.CrossOriginProtection`.

```ts
const app = await HttpFactory.create(AppModule, {
  csrf: { trustedOrigins: ['https://admin.example.com'] },
});
```

`csrf: true` trusts no other origin. It is off by default, and
`HttpOptionsProvider` has the same field as a getter.

| Request                                                | Outcome |
| ------------------------------------------------------ | ------- |
| `GET`, `HEAD`, `OPTIONS`                               | passes  |
| `Sec-Fetch-Site: same-origin` or `none`                | passes  |
| `Sec-Fetch-Site: same-site` or `cross-site`            | 403     |
| No `Sec-Fetch-Site`, `Origin` host equals `Host`       | passes  |
| No `Sec-Fetch-Site`, `Origin` names another host       | 403     |
| Neither header: `curl`, a server, a webhook sender     | passes  |
| Cross-site, but `Origin` is listed in `trustedOrigins` | passes  |

`same-site` is refused: a sibling subdomain is another origin, and may be
someone else's. A trusted origin is written `scheme://host[:port]`; anything
else is a boot error.

The refusal goes through the app's error mapper, so it has the shape every
other error has:

```json
{ "error": "CROSS_ORIGIN_REQUEST", "status": 403 }
```

The check runs before any middleware. A refused request has no body read, runs
no guard, and does not appear in request logging. The refusal still carries the
security headers when those are on. The check costs 0.5 to 0.9 microseconds on an
unsafe request, and nothing on a safe one.

A refusal writes a `warn` line through the bound `Logger`, at most one a second.
Request logging limits unmatched paths the same way
([Logging](./13-logging.md#one-entry-per-request)), but the two limits are
separate, so a flood of refusals does not hide a scan of unmatched paths. The next
line written carries `suppressed`, the number of refusals dropped since the last
one:

```ts
logger.warn('CSRF refused POST /things', {
  method: 'POST',
  path: '/things', // no query string
  secFetchSite: 'cross-site', // as received, or null
  origin: 'https://evil.test', // as received, or null
  reason: 'cross-origin', // or 'origin-mismatch' when Origin decided
  traceparent: '00-...', // only when the request carried one
  suppressed: 41, // only when refusals were dropped
});
```

| Interaction        | Behaviour                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS               | A preflight is `OPTIONS` and passes. The request after it is still refused unless its origin is in `trustedOrigins`: CORS decides who may read a response, `csrf` who may send one |
| `trustProxy`       | The `Origin` fallback compares against `X-Forwarded-Host`, counted from the right as `ClientAddress` counts `X-Forwarded-For`. Otherwise `Host`                                    |
| Bearer tokens      | Still checked. A server-side client sends neither header and passes; a page on another site calling with a token needs its origin trusted                                          |
| better-auth        | Its routes are dunx routes and are checked. better-auth runs its own origin check behind this one, which refuses a cookie-bearing request with no `Origin` as well                 |
| Websocket upgrades | A `GET`, so not checked. A gateway that serves cookies checks `Origin` in its own upgrade                                                                                          |

An origin better-auth trusts through its own `trustedOrigins` has to be listed
in both, or `csrf` refuses it first.

A browser sends `Sec-Fetch-Site` only to HTTPS and `localhost`. Over plain HTTP
the `Origin` fallback decides, and it compares hosts, not schemes: serve over
HTTPS with `Strict-Transport-Security` to close the `http://` to `https://`
case.

## What is not covered

| Response                            | Why                                                 |
| ----------------------------------- | --------------------------------------------------- |
| A gateway's upgrade, `101` or `426` | The upgrade route is not wrapped; neither is a page |
| `bunx dunx-email preview`           | A separate loopback server, not the app             |

better-auth's routes are dunx routes, so they get these headers, although
better-auth sets none itself. A response replayed by `@Idempotent()`
([Idempotency](./33-idempotency.md)) gets them too.

A cookie's own attributes, `Secure`, `HttpOnly` and `SameSite`, and signing one
are in [Cookies](./35-cookies.md).

The cost is 1.1 to 1.4 microseconds per request with the headers on, and
nothing with them off: the wrapper is not installed.

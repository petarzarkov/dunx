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

## What is not covered

| Response                            | Why                                                 |
| ----------------------------------- | --------------------------------------------------- |
| A gateway's upgrade, `101` or `426` | The upgrade route is not wrapped; neither is a page |
| `bunx dunx-email preview`           | A separate loopback server, not the app             |

better-auth sets none of these headers itself; its routes are dunx routes, so
they get them.

The cost is 1.1 to 1.4 microseconds per request with the headers on, and
nothing with them off: the wrapper is not installed.

# @dunx/http

`Bun.serve` adapter for [dunx](https://github.com/petarzarkov/dunx). Class-based
controllers, standard decorators, and no JavaScript router — Bun's native `routes`
does path params and per-method dispatch in Zig.

## Install

```bash
bun add @dunx/http @dunx/core
```

## Usage

```ts
import { inject, Module } from '@dunx/core';
import { Controller, Get, HttpFactory, Post } from '@dunx/http';
import type { BunRequest } from 'bun';

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService);

  @Get('/')
  list() {
    return this.#users.findAll(); // plain values become Response.json()
  }

  @Get('/:id')
  one(req: BunRequest<'/users/:id'>) {
    return this.#users.find(req.params.id);
  }

  @Post('/')
  async create(req: BunRequest) {
    return this.#users.create(await req.json());
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}

const app = await HttpFactory.create(AppModule, { port: 3000 });
app.enableShutdownHooks();
await app.listen();
```

## App-level configuration

`create()` boots the container and discovers routes; `listen()` is what builds the
`Bun.serve` route table. So everything between the two still gets to affect it:

```ts
const app = await HttpFactory.create(AppModule);
app.setGlobalPrefix('api');
app.use(RequestLoggerMiddleware);
app.set('trust proxy', true);
app.enableCors({ origin: 'https://example.com', credentials: true });
await app.listen(3000);
```

Calling any of them **after** `listen()` throws. The route table and the middleware
chain are folded into one closure per route when the server binds, so a late call
could only ever be a silent no-op — the failure mode worth trading for an error.

| Hook                     | Effect                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| `setGlobalPrefix(p)`     | Prefixes every discovered route. Slashes normalised; last call wins           |
| `use(...middleware)`     | Appends container-resolved `Ctor<Middleware>`, so it can inject               |
| `set(key, value)`        | Typed settings — a key must exist on `AppSettings`, so a typo is a type error |
| `setting(key)`           | Reads one back                                                                |
| `enableCors(options?)`   | Response headers plus an `OPTIONS` preflight per path. Last call wins         |
| `clientIp(req)`          | The `inject(ClientAddress)` singleton, honouring `'trust proxy'`              |
| `listen(port?)`          | Builds the table, binds. A second call throws                                 |

### Precedence

- **Middleware order**: `HttpOptions.middleware` first (outermost), then each
  `use()` call in the order it was made. Outermost sees the request first and the
  response last.
- **Port**: the `listen(port)` argument, else `HttpOptions.port`, else `3000`.
- **Error mapper**: `HttpOptions.onError`; there is no imperative equivalent.
- **Repeated calls**: `setGlobalPrefix`, `set` and `enableCors` all replace, so the
  last call wins. `use()` appends.
- **Collisions**: rejected at `create()`, and re-checked at `listen()` against the
  final prefixed paths. A uniform prefix cannot introduce a collision the
  unprefixed paths did not already have, which is why the early check is complete.

### CORS and preflight

`Bun.serve({ routes })` answers a method miss with `404`, so a preflight can never
be inferred — `enableCors()` mounts an explicit `OPTIONS` handler on every path,
built at boot from the methods that path actually declares. `origin` takes a
string, a list, or a predicate; anything not allowed gets **no** CORS headers at
all, which is what makes the browser block it. `'*'` is the default, and because a
browser rejects `*` alongside credentials, `credentials: true` reflects the
caller's origin instead. `allowedHeaders` defaults to echoing
`Access-Control-Request-Headers`. Headers are applied outside the error mapper, so
a mapped `500` still carries them.

### Client IP

`ClientAddress` needs no registration — every class is injectable, and `listen()`
hands the resolved singleton the live server:

```ts
export class AuditMiddleware implements Middleware {
  constructor(private readonly address: ClientAddress) {}

  async handle(req: BunRequest, next: Next) {
    console.log(this.address.of(req));
    return next();
  }
}
```

`of(req)` returns the first `X-Forwarded-For` entry when `'trust proxy'` is set and
the header is present, otherwise `server.requestIP(req)?.address`. Leave the
setting off unless a proxy you control rewrites the header: a direct client can
send whatever it likes.

## Status codes

`HttpStatusCode` is a frozen object, not an `enum` — one name serving as both the
value and the type, so it reads like an enum and erases like a constant:

```ts
import { HttpError, HttpStatusCode, type HttpStatusName } from '@dunx/http';

throw new HttpError(HttpStatusCode.NOT_FOUND, 'No such user');

const code: HttpStatusCode = HttpStatusCode.CONFLICT; // 200 | 201 | ... | 504
const name: HttpStatusName = 'CONFLICT'; // 'OK' | 'CREATED' | ...
```

`HttpError.status` stays `number`, so an uncommon code the table omits (451, 507)
still works.

## Notes

- Routes are discovered at boot by walking each controller's prototype chain, so an
  abstract base controller's `@Get` methods are inherited by every subclass.
- A duplicate method + path **throws at boot** naming both handlers. Bun would
  otherwise silently keep one.
- Middleware is a class with `handle(req, next)`, resolved from the container so it
  can `inject()`. Chains are folded into one closure per route at boot.
- Handlers may return a `Response`, any JSON-serialisable value, or `undefined`
  for `204`.

## License

MIT

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

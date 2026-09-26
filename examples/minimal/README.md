# @dunx/example-minimal

The smallest dunx app there is. Five files, no database, no auth, no queue - just
enough to see the shape. Read it top to bottom in two minutes, then go to
[`examples/full`](../full) for everything else.

```bash
bun install
bun run --filter '@dunx/example-minimal' start
# or, reloading on every save:
bun run --filter '@dunx/example-minimal' dev
curl localhost:3000/greetings/ada     # {"greeting":"hello, ada","served":1}
```

## The five files

| File                                                     | What it is                                  |
| -------------------------------------------------------- | --------------------------------------------- |
| [`bunfig.toml`](./bunfig.toml)                           | one preload line - the thing you must not skip |
| [`src/greetings.service.ts`](./src/greetings.service.ts) | a provider                                    |
| [`src/greetings.controller.ts`](./src/greetings.controller.ts) | routes                                  |
| [`src/app.module.ts`](./src/app.module.ts)               | what is wired together                      |
| [`src/main.ts`](./src/main.ts)                           | boot and listen                             |

## The preload you must not skip

```toml
# bunfig.toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Bun's test runner reads its own `preload`, so it appears twice. Miss the second
and the app runs but the suite does not.

Constructor injection needs no decorator and no `@Inject()`, because
`@dunx/transform` reads each class's constructor parameter types at load time and
records them for the container. The preload is how it runs.

Leave it out and boot fails with an error that names the class and tells you to
add the preload. A parameter whose type is erased (an interface, a primitive, a
union) also fails at boot, and the error names the parameter. You never get a
silent `undefined`.

## A provider

Nothing marks it. Being in a module's `providers` is the registration.

```ts
export class GreetingsService implements OnInit {
  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info('greetings ready');
  }
}
```

`Logger` resolves without anything binding it: core offers a default
`ConsoleLogger` after every module, so an app that imported no logging module
still logs. `onInit` runs once the whole graph is constructed, in dependency
order; `onShutdown` runs in reverse.

## A controller

A provider with routes on it. Return a plain object - there is no `res` to send
and no `Response.json()` to remember.

```ts
@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/:name')
  one(input: Input<RouteSchemas>) {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
  }
}
```

`Bun.serve` does the routing, natively: path params, per-method dispatch and
method-miss 404s are Bun's. dunx does not ship a JavaScript router.

Declare a `params` schema and a path param is validated and typed; without one,
it arrives as a plain string on `input.req.params`. See
[`examples/full/src/users`](../full/src/users) for that.

## A module

```ts
@Module({
  controllers: [GreetingsController],
  providers: [GreetingsService],
})
export class AppModule {}
```

## Boot

```ts
const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
await app.closed;
```

`create()` builds the container and discovers routes. `listen()` builds the
`Bun.serve` route table. Everything between the two (`setGlobalPrefix`, `use`,
`enableCors`) still gets to shape it; after it, every one of them throws.

You get request logging for free: one JSON line per request carrying the request
and the response together, at `warn` for a 4xx and `error` for a 5xx.
`HttpFactory.create(AppModule, { requestLogging: false })` turns it off.

## Testing it

```bash
bun run --filter '@dunx/example-minimal' test
```

[`src/app.test.ts`](./src/app.test.ts) puts the same `AppModule` behind a real
`Bun.serve` on port 0. No mocking framework and no fake request object - Bun binds
a socket in about a millisecond, so the thing under test is the thing that ships.

## Where to go next

| Next                                | Shows                                              |
| ----------------------------------- | ---------------------------------------------------- |
| [`examples/databases`](../databases) | drizzle over SQLite, Postgres and MySQL             |
| [`examples/testing`](../testing)     | overrides, fakes, and testing a guard               |
| [`examples/full`](../full)           | every package composing in one long-running service |
| [`examples/binary`](../binary)       | the same container compiled to one executable       |

# @dunx/example-minimal

The smallest dunx app there is. Five files, no database, no auth, no queue — just
enough to see the shape. Read it top to bottom in two minutes, then go to
[`examples/full`](../full) for everything else.

```bash
bun install
bun run --filter '@dunx/example-minimal' start
curl localhost:3000/greetings/ada     # {"greeting":"hello, ada","served":1}
```

## The five files

| File                                                     | What it is                                  |
| -------------------------------------------------------- | --------------------------------------------- |
| [`bunfig.toml`](./bunfig.toml)                           | one preload line — the thing you must not skip |
| [`src/greetings.service.ts`](./src/greetings.service.ts) | a provider                                    |
| [`src/greetings.controller.ts`](./src/greetings.controller.ts) | routes                                  |
| [`src/app.module.ts`](./src/app.module.ts)               | what is wired together                      |
| [`src/main.ts`](./src/main.ts)                           | boot and listen                             |

## The one line you must not skip

```toml
# bunfig.toml
preload = ["@dunx/compiler/preload"]
```

Constructor injection needs no decorator and no `@Inject()`, because
`@dunx/compiler` reads each class's constructor parameter types at load time and
records them for the container. That preload is how it runs.

Leave it out and boot fails with an error naming the class and telling you to add
it — never a silent `undefined`. Same for a parameter whose type is erased (an
interface, a primitive, a union): that is a boot error naming the parameter, which
is the wart `emitDecoratorMetadata` has and dunx does not.

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

A provider with routes on it. Return a plain object — there is no `res` to send
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

`Bun.serve` does the routing. dunx does not ship a JavaScript router — path
params, per-method dispatch and method-miss 404s are Bun's, natively.

Without a `params` schema a path param arrives as a string on `input.req.params`.
Declare one and it is validated and typed instead — see
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
`Bun.serve` route table — everything between the two (`setGlobalPrefix`, `use`,
`enableCors`) still gets to shape it, and after it every one of them throws.

You get request logging for free: one JSON line per request carrying the request
and the response together, at `warn` for a 4xx and `error` for a 5xx.
`HttpFactory.create(AppModule, { requestLogging: false })` turns it off.

## Testing it

```bash
bun run --filter '@dunx/example-minimal' test
```

[`src/app.test.ts`](./src/app.test.ts) puts the same `AppModule` behind a real
`Bun.serve` on port 0. No mocking framework and no fake request object — Bun binds
a socket in about a millisecond, so the thing under test is the thing that ships.

## Where to go next

| Next                                | Shows                                              |
| ----------------------------------- | ---------------------------------------------------- |
| [`examples/databases`](../databases) | drizzle over SQLite, Postgres and MySQL             |
| [`examples/testing`](../testing)     | overrides, fakes, and testing a guard               |
| [`examples/full`](../full)           | every package composing in one long-running service |

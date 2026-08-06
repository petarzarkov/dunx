import { Module, provide, token } from '@dunx/core';
import {
  Controller,
  Gateway,
  Get,
  OnMessage,
  OnOpen,
  Post,
  Public,
  Roles,
  UseGuards,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';
import type { BunRequest } from 'bun';

/**
 * A module graph for the tests to read. Deliberately covers one of each thing the
 * tools have to report: a controller with a prefix, a public route, a guarded
 * route, a route with schemas and a non-default status, a gateway, and all three
 * binding kinds.
 *
 * Not exported from the package - `files` ships only `dist`, and the build derives
 * its entrypoints from `exports`, so nothing here reaches a consumer.
 */
const schemaFor = (vendor: string) => ({
  '~standard': {
    version: 1 as const,
    vendor,
    validate: (value: unknown) => ({ value }),
  },
});

export const CONFIG = token<{ url: string }>('AppConfig');

export class Clock {
  now(): number {
    return 0;
  }
}

export class NotesRepository {
  constructor(readonly clock: Clock) {}
}

export class NotesService {
  constructor(readonly repo: NotesRepository) {}
}

/**
 * The transform is not preloaded for a package's own tests, so the records it
 * would write are set by hand. That is also the only way to produce an
 * `unresolved` entry without an erased type in this file, and `unresolved` is the
 * case most worth asserting on.
 */
const DEPS = Symbol.for('dunx.deps');

Object.defineProperty(NotesRepository, DEPS, { value: () => [Clock] });
Object.defineProperty(NotesService, DEPS, { value: () => [NotesRepository] });

export class AuthGuard implements Middleware {
  async handle(
    _req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    return next();
  }
}

const createNote = {
  body: schemaFor('zod'),
  status: 201,
  response: { 201: schemaFor('zod'), 422: schemaFor('zod') },
} as const;

@Controller('notes')
export class NotesController {
  constructor(readonly notes: NotesService) {}

  @Public()
  @Get('/')
  list(): string[] {
    return [];
  }

  @Roles('admin', 'editor')
  @UseGuards(AuthGuard)
  @Post('/', createNote)
  create(): { id: string } {
    return { id: '1' };
  }
}

Object.defineProperty(NotesController, DEPS, { value: () => [NotesService] });

/** The parameter the transform could not name, recorded the way it records one. */
@Controller('health')
export class HealthController {
  @Get('/')
  check(): { ok: boolean } {
    return { ok: true };
  }
}

Object.defineProperty(HealthController, DEPS, {
  value: () => [
    { unresolved: 'private readonly config: AppConfig', typeOnly: 'AppConfig' },
  ],
});

/** The bodies do nothing but must exist; the markers are what is being read. */
@Gateway('chat')
export class ChatGateway {
  seen = 0;

  @OnOpen()
  opened(): void {
    this.seen += 1;
  }

  @OnMessage('say')
  say(): void {
    this.seen += 1;
  }

  @OnMessage()
  raw(): void {
    this.seen += 1;
  }
}

@Module({
  controllers: [NotesController],
  providers: [
    NotesService,
    NotesRepository,
    Clock,
    ChatGateway,
    provide(CONFIG, { useValue: { url: 'https://example.test' } }),
  ],
})
export class NotesModule {}

@Module({
  imports: [NotesModule],
  controllers: [HealthController],
  providers: [
    provide(AuthGuard, { useClass: AuthGuard }),
    provide(token<string>('Greeting'), {
      useFactory: (config: { url: string }) => config.url,
      inject: [CONFIG] as const,
    }),
  ],
})
export class AppModule {}

export default AppModule;

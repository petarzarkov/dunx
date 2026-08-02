import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { inject, Module, type Ctor } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { DiscoveredRoute } from '../route/discover.js';
import {
  metaKey,
  Public,
  PUBLIC,
  Roles,
  ROLES,
  UseGuards,
} from '../route/metadata.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { buildRoutes } from './routes.js';
import { HttpStatusCode } from './status.js';

class Trail {
  readonly seen: string[] = [];
}

/**
 * The combination @Public exists for: one global guard, and the routes that opt
 * out of it. It reads the metadata the route declared - nothing else could tell
 * `/reports/health` apart from `/reports`.
 */
class AuthGuard implements Middleware {
  readonly #trail = inject(Trail);

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    this.#trail.seen.push(`auth:${ctx.handler}`);
    if (ctx.get(PUBLIC)) return next();
    if (req.headers.get('x-role') === null) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
    }
    return next();
  }
}

/** A guard is middleware that throws - there is no second concept. */
class RolesGuard implements Middleware {
  readonly #trail = inject(Trail);

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    this.#trail.seen.push(`roles:${ctx.handler}`);
    const required = ctx.get(ROLES);
    if (!required) return next();
    const role = req.headers.get('x-role');
    if (role === null || !required.includes(role)) {
      throw new HttpError(
        HttpStatusCode.FORBIDDEN,
        `Requires ${required.join(', ')}`,
      );
    }
    return next();
  }
}

class Captured {
  readonly contexts: RouteContext[] = [];
}

class Capture implements Middleware {
  readonly #captured = inject(Captured);

  handle(_req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    this.#captured.contexts.push(ctx);
    return next();
  }
}

class Tagging implements Middleware {
  readonly #trail = inject(Trail);
  protected readonly tag: string = 'tagging';

  handle(_req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    this.#trail.seen.push(this.tag);
    return next();
  }
}
class GlobalTag extends Tagging {
  protected override readonly tag = 'global';
}
class ClassTag extends Tagging {
  protected override readonly tag = 'class';
}
class MethodTag extends Tagging {
  protected override readonly tag = 'method';
}

@Roles('admin')
@Controller('reports')
class ReportsController {
  // A method-level @Public over the class-level @Roles: the pair NestJS users
  // reach for most.
  @Public()
  @Get('/health')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('/')
  list(): readonly string[] {
    return ['q1'];
  }

  // The class-level @Roles('admin') is what this method-scoped guard reads.
  @UseGuards(RolesGuard)
  @Post('/')
  create(): { created: true } {
    return { created: true };
  }

  @Roles('editor')
  @UseGuards(RolesGuard)
  @Get('/draft')
  draft(): { draft: true } {
    return { draft: true };
  }
}

@Controller('order')
@UseGuards(ClassTag)
class OrderController {
  @UseGuards(MethodTag)
  @Get('/')
  go(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ReportsController, OrderController] })
class AppModule {}

const withApp = async (
  run: (url: string, app: HttpApp) => Promise<void>,
  middleware: readonly Ctor<Middleware>[] = [AuthGuard],
): Promise<void> => {
  const app = await HttpFactory.create(AppModule, { middleware });
  const url = await app.listen(0);
  try {
    await run(url, app);
  } finally {
    await app.shutdown();
  }
};

const call = (
  url: string,
  path: string,
  role?: string,
  method = 'GET',
): Promise<Response> =>
  fetch(new URL(path, url), {
    method,
    headers: role === undefined ? {} : { 'x-role': role },
  });

describe('@Public with a global guard', () => {
  it('lets a public route through with no credentials at all', async () => {
    await withApp(async (url) => {
      const response = await call(url, 'reports/health');

      expect(response.status).toBe(HttpStatusCode.OK);
      expect(await response.json()).toEqual({ ok: true });
    });
  });

  it('still challenges a route that is not public', async () => {
    await withApp(async (url) => {
      const response = await call(url, 'reports');

      expect(response.status).toBe(HttpStatusCode.UNAUTHORIZED);
      expect(await response.json()).toEqual({
        error: 'No credentials',
        status: 401,
      });
    });
  });

  it('runs the global guard on the public route too - it chose to skip', async () => {
    await withApp(async (url, app) => {
      await call(url, 'reports/health');

      expect(app.get(Trail).seen).toEqual(['auth:health']);
    });
  });

  it('lets an authenticated request through', async () => {
    await withApp(async (url) => {
      const response = await call(url, 'reports', 'viewer');

      expect(response.status).toBe(HttpStatusCode.OK);
      expect(await response.json()).toEqual(['q1']);
    });
  });
});

describe('@Roles with a method-scoped guard', () => {
  it('answers 403 for the wrong role, from the class-level @Roles', async () => {
    await withApp(async (url) => {
      const response = await call(url, 'reports', 'viewer', 'POST');

      expect(response.status).toBe(HttpStatusCode.FORBIDDEN);
      expect(await response.json()).toEqual({
        error: 'Requires admin',
        status: 403,
      });
    });
  });

  it('succeeds for the right role', async () => {
    await withApp(async (url) => {
      const response = await call(url, 'reports', 'admin', 'POST');

      expect(response.status).toBe(HttpStatusCode.CREATED);
      expect(await response.json()).toEqual({ created: true });
    });
  });

  it('honours a method-level @Roles over the class-level one', async () => {
    await withApp(async (url) => {
      const wrong = await call(url, 'reports/draft', 'admin');
      expect(wrong.status).toBe(HttpStatusCode.FORBIDDEN);
      expect(await wrong.json()).toEqual({
        error: 'Requires editor',
        status: 403,
      });

      const right = await call(url, 'reports/draft', 'editor');
      expect(right.status).toBe(HttpStatusCode.OK);
    });
  });

  it('does not run on a route that did not declare it', async () => {
    await withApp(async (url, app) => {
      // GET /reports carries @Roles('admin') from the class, but no RolesGuard
      // reads it there. Metadata alone decides nothing.
      const response = await call(url, 'reports', 'nobody');

      expect(response.status).toBe(HttpStatusCode.OK);
      expect(app.get(Trail).seen).toEqual(['auth:list']);
    });
  });

  it('resolves the guard from the container, so it can inject', async () => {
    await withApp(async (url, app) => {
      await call(url, 'reports', 'admin', 'POST');

      expect(app.get(Trail).seen).toEqual(['auth:create', 'roles:create']);
      // The very same singleton the container would hand anyone else.
      expect(app.get(RolesGuard)).toBeInstanceOf(RolesGuard);
    });
  });
});

describe('middleware ordering', () => {
  it('runs global outermost, then class-level, then method-level', async () => {
    await withApp(
      async (url, app) => {
        await call(url, 'order');

        expect(app.get(Trail).seen).toEqual(['global', 'class', 'method']);
      },
      [GlobalTag],
    );
  });
});

describe('RouteContext', () => {
  it('is built once at boot and shared by every request to that route', async () => {
    await withApp(
      async (url, app) => {
        await call(url, 'reports/health');
        await call(url, 'reports/health');
        const { contexts } = app.get(Captured);

        expect(contexts).toHaveLength(2);
        // One object, closed over by the chain - nothing was resolved per request.
        expect(contexts[0]).toBe(contexts[1]);
        expect(Object.isFrozen(contexts[0])).toBe(true);
      },
      [Capture],
    );
  });

  it('names the route the chain was folded into', async () => {
    await withApp(
      async (url, app) => {
        await call(url, 'reports', 'viewer', 'POST');
        const ctx = app.get(Captured).contexts[0]!;

        expect(ctx.controller).toBe('ReportsController');
        expect(ctx.handler).toBe('create');
        expect(ctx.method).toBe('POST');
        expect(ctx.path).toBe('/reports');
      },
      [Capture],
    );
  });

  it('gives a distinct context per route, not one per controller', async () => {
    await withApp(
      async (url, app) => {
        await call(url, 'reports/health');
        await call(url, 'reports');
        const { contexts } = app.get(Captured);

        expect(contexts[0]).not.toBe(contexts[1]);
        expect(contexts.map((ctx) => ctx.handler)).toEqual(['health', 'list']);
      },
      [Capture],
    );
  });

  it('answers undefined for a key nothing declared', async () => {
    await withApp(
      async (url, app) => {
        await call(url, 'reports/health');
        const ctx = app.get(Captured).contexts[0]!;

        expect(ctx.get(metaKey<string>('tenant'))).toBeUndefined();
      },
      [Capture],
    );
  });
});

describe('buildRoutes() guard resolution', () => {
  const route = (over: Partial<DiscoveredRoute> = {}): DiscoveredRoute => ({
    method: 'GET',
    path: '/x',
    controller: 'XController',
    handlerName: 'handle',
    handler: () => ({ ok: true }),
    ...over,
  });

  it('constructs a guard itself when no resolver is given', async () => {
    const seen: string[] = [];
    class Standalone implements Middleware {
      handle(
        _req: BunRequest,
        ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        seen.push(ctx.handler);
        return next();
      }
    }

    const routes = buildRoutes([route({ guards: [Standalone] })]);
    const response = await routes['/x']!.GET!(
      new Request('http://test/x') as BunRequest,
    );

    expect(response.status).toBe(HttpStatusCode.OK);
    expect(seen).toEqual(['handle']);
  });

  it('builds one instance of a guard shared by every route declaring it', async () => {
    const instances = new Set<object>();
    class Standalone implements Middleware {
      handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        instances.add(this);
        return next();
      }
    }

    const routes = buildRoutes([
      route({ guards: [Standalone] }),
      route({ path: '/y', guards: [Standalone] }),
    ]);
    const request = new Request('http://test/x') as BunRequest;
    await routes['/x']!.GET!(request);
    await routes['/y']!.GET!(request);

    expect(instances.size).toBe(1);
  });
});

import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { buildContext, type RouteContext } from '../server/context.js';
import type { Middleware, Next } from '../server/middleware.js';
import { Controller, Get, Post } from './decorators.js';
import { discoverRoutes, type DiscoveredRoute } from './discover.js';
import {
  guardsOf,
  meta,
  metaKey,
  metaOf,
  Public,
  PUBLIC,
  Roles,
  ROLES,
  UseGuards,
  type MetaKey,
} from './metadata.js';

const routeOf = (instance: object, handler: string): DiscoveredRoute => {
  const found = discoverRoutes(instance).find(
    (route) => route.handlerName === handler,
  );
  if (!found) throw new Error(`no route for ${handler}()`);
  return found;
};

/** Every read goes through the public path a middleware would use. */
const read = <T>(
  instance: object,
  handler: string,
  key: MetaKey<T>,
): T | undefined => buildContext(routeOf(instance, handler)).get(key);

class GuardOne implements Middleware {
  handle(_req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    return next();
  }
}
class GuardTwo extends GuardOne {}
class GuardThree extends GuardOne {}

describe('metaKey()', () => {
  it('gives two keys of the same name distinct identities', () => {
    const first = metaKey<string>('roles');
    const second = metaKey<string>('roles');

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe('roles');
  });
});

describe('meta()', () => {
  const TENANT = metaKey<string>('tenant');

  it('reads a method-level value back through the route context', () => {
    class Reports {
      @Roles('admin')
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(read(new Reports(), 'list', ROLES)).toEqual(['admin']);
  });

  it('reads a class-level value on every route of the class', () => {
    @Roles('admin')
    @Controller('reports')
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }

      @Post('/')
      create(): number {
        return 2;
      }
    }
    const reports = new Reports();

    expect(read(reports, 'list', ROLES)).toEqual(['admin']);
    expect(read(reports, 'create', ROLES)).toEqual(['admin']);
  });

  it('resolves the handler first, so a method-level value overrides the class', () => {
    @Roles('admin')
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }

      @Roles('editor')
      @Post('/')
      create(): number {
        return 2;
      }
    }
    const reports = new Reports();

    expect(read(reports, 'list', ROLES)).toEqual(['admin']);
    expect(read(reports, 'create', ROLES)).toEqual(['editor']);
  });

  it('lets a method-level @Public override a class-level @Roles', () => {
    @Roles('admin')
    class Reports {
      @Public()
      @Get('/health')
      health(): number {
        return 1;
      }
    }

    expect(read(new Reports(), 'health', PUBLIC)).toBe(true);
    // The roles are still there - a guard that reads PUBLIC first is what makes
    // the route public, which is the whole point of the pair.
    expect(read(new Reports(), 'health', ROLES)).toEqual(['admin']);
  });

  it('lets a method-level @Roles override a class-level @Public', () => {
    @Public()
    class Reports {
      @Roles('admin')
      @Get('/')
      list(): number {
        return 1;
      }

      @Get('/health')
      health(): number {
        return 2;
      }
    }
    const reports = new Reports();

    expect(read(reports, 'list', ROLES)).toEqual(['admin']);
    expect(read(reports, 'health', ROLES)).toBeUndefined();
    expect(read(reports, 'health', PUBLIC)).toBe(true);
  });

  it('keeps two keys on one method independent', () => {
    class Reports {
      @Roles('admin')
      @Public()
      @Get('/')
      list(): number {
        return 1;
      }
    }
    const reports = new Reports();

    expect(read(reports, 'list', ROLES)).toEqual(['admin']);
    expect(read(reports, 'list', PUBLIC)).toBe(true);
  });

  it('takes the topmost decorator when one key is set twice', () => {
    class Reports {
      @Roles('top')
      @Roles('bottom')
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(read(new Reports(), 'list', ROLES)).toEqual(['top']);
  });

  it('carries an arbitrary user key, which is all @Roles is', () => {
    @meta(TENANT, 'acme')
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(read(new Reports(), 'list', TENANT)).toBe('acme');
  });

  it('is undefined for a key nothing set', () => {
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(read(new Reports(), 'list', ROLES)).toBeUndefined();
    expect(
      read(new Reports(), 'list', metaKey<string>('tenant')),
    ).toBeUndefined();
  });
});

// What sank both earlier designs. Metadata lives on the function or the class the
// decorator received, so there is nowhere for it to accumulate and leak.
describe('metadata isolation', () => {
  it('keeps an undecorated class from reaching another class', () => {
    class Left {
      @Roles('left')
      @Get('/left')
      go(): number {
        return 1;
      }
    }
    class Right {
      @Get('/right')
      go(): number {
        return 2;
      }
    }

    expect(read(new Left(), 'go', ROLES)).toEqual(['left']);
    expect(read(new Right(), 'go', ROLES)).toBeUndefined();
  });

  it('keeps two methods of one class apart', () => {
    class Reports {
      @Roles('admin')
      @Get('/')
      list(): number {
        return 1;
      }

      @Post('/')
      create(): number {
        return 2;
      }
    }
    const reports = new Reports();

    expect(read(reports, 'list', ROLES)).toEqual(['admin']);
    expect(read(reports, 'create', ROLES)).toBeUndefined();
  });

  it('gives two subclasses of one annotated base the same inherited value', () => {
    @Roles('base')
    class Base {
      @Get('/')
      list(): number {
        return 1;
      }
    }
    class First extends Base {}
    class Second extends Base {}

    expect(read(new First(), 'list', ROLES)).toEqual(['base']);
    expect(read(new Second(), 'list', ROLES)).toEqual(['base']);
  });

  it('does not leak a subclass value to its sibling or to the base', () => {
    @Roles('base')
    class Base {
      @Get('/')
      list(): number {
        return 1;
      }
    }
    @Roles('first')
    class First extends Base {}
    @Public()
    class Second extends Base {}

    expect(read(new First(), 'list', ROLES)).toEqual(['first']);
    expect(read(new First(), 'list', PUBLIC)).toBeUndefined();
    // Second saw its base's roles but never First's, and gained its own key.
    expect(read(new Second(), 'list', ROLES)).toEqual(['base']);
    expect(read(new Second(), 'list', PUBLIC)).toBe(true);
    expect(read(new Base(), 'list', ROLES)).toEqual(['base']);
    expect(read(new Base(), 'list', PUBLIC)).toBeUndefined();
  });

  it('never mutates the record a subclass copied from', () => {
    @Roles('base')
    class Base {}
    const before = metaOf(Base);
    @Roles('derived')
    class Derived extends Base {}

    expect(metaOf(Derived)).not.toBe(before);
    expect(metaOf(Base)).toBe(before);
    expect(before?.get(ROLES.id)).toEqual(['base']);
  });

  it('merges at discovery, so a later decoration cannot change a built route', () => {
    @Roles('admin')
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }
    }
    const ctx = buildContext(routeOf(new Reports(), 'list'));
    expect(ctx.get(ROLES)).toEqual(['admin']);

    Roles('changed')(Reports);

    // The context closed over a record resolved once. Only a fresh discovery sees
    // the new value - which is what makes the request path free of reflection.
    expect(ctx.get(ROLES)).toEqual(['admin']);
    expect(read(new Reports(), 'list', ROLES)).toEqual(['changed']);
  });
});

describe('@UseGuards', () => {
  it('is an empty list when nothing declared it', () => {
    class Reports {
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(routeOf(new Reports(), 'list').guards).toEqual([]);
  });

  it('orders class-level guards before method-level ones', () => {
    @UseGuards(GuardOne)
    class Reports {
      @UseGuards(GuardTwo)
      @Get('/')
      list(): number {
        return 1;
      }

      @Get('/plain')
      plain(): number {
        return 2;
      }
    }
    const reports = new Reports();

    expect(routeOf(reports, 'list').guards).toEqual([GuardOne, GuardTwo]);
    // A method-scoped guard stays scoped to its method.
    expect(routeOf(reports, 'plain').guards).toEqual([GuardOne]);
  });

  it('reads stacked @UseGuards top to bottom', () => {
    class Reports {
      @UseGuards(GuardOne)
      @UseGuards(GuardTwo, GuardThree)
      @Get('/')
      list(): number {
        return 1;
      }
    }

    expect(routeOf(new Reports(), 'list').guards).toEqual([
      GuardOne,
      GuardTwo,
      GuardThree,
    ]);
  });

  it("runs a base class's guards before a subclass's, leaving the base alone", () => {
    @UseGuards(GuardOne)
    class Base {
      @Get('/')
      list(): number {
        return 1;
      }
    }
    @UseGuards(GuardTwo)
    class Derived extends Base {}
    class Other extends Base {}

    expect(routeOf(new Derived(), 'list').guards).toEqual([GuardOne, GuardTwo]);
    expect(routeOf(new Other(), 'list').guards).toEqual([GuardOne]);
    expect(guardsOf(Base)).toEqual([GuardOne]);
  });
});

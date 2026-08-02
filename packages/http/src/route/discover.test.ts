import { describe, expect, it } from 'bun:test';
import { Controller, Delete, Get, Patch, Post, Put } from './decorators.js';
import { discoverRoutes, joinPath } from './discover.js';

@Controller('base')
abstract class BaseCrudController {
  @Get('/')
  list(): string[] {
    return ['base.list'];
  }
}

@Controller('users')
class UsersController extends BaseCrudController {
  @Get('/:id')
  one(): string {
    return 'users.one';
  }
}

@Controller('posts')
class PostsController extends BaseCrudController {}

@Controller('ov')
class OverridingController extends BaseCrudController {
  override list(): string[] {
    return ['override.list'];
  }
}

const routesOf = (instance: object) =>
  discoverRoutes(instance)
    .map((route) => `${route.method} ${route.path}`)
    .sort();

describe('joinPath()', () => {
  it('normalizes prefix and path into one slash-joined route', () => {
    expect(joinPath('users', '/')).toBe('/users');
    expect(joinPath('/users/', '/:id')).toBe('/users/:id');
    expect(joinPath('users', ':id')).toBe('/users/:id');
    expect(joinPath('', '/')).toBe('/');
    expect(joinPath('', '/health')).toBe('/health');
    expect(joinPath('a//b', '//c//')).toBe('/a/b/c');
  });
});

describe('discoverRoutes()', () => {
  it('finds own methods and joins them onto the controller prefix', () => {
    @Controller('things')
    class ThingsController {
      @Get('/')
      list(): string {
        return 'list';
      }
      @Post('/')
      create(): string {
        return 'create';
      }
      @Put('/:id')
      replace(): string {
        return 'replace';
      }
      @Patch('/:id')
      update(): string {
        return 'update';
      }
      @Delete('/:id')
      remove(): string {
        return 'remove';
      }
    }

    expect(routesOf(new ThingsController())).toEqual([
      'DELETE /things/:id',
      'GET /things',
      'PATCH /things/:id',
      'POST /things',
      'PUT /things/:id',
    ]);
  });

  it('inherits an abstract base controller into every subclass', () => {
    // The case a pending-array accumulator loses: the second subclass got nothing.
    expect(routesOf(new UsersController())).toEqual([
      'GET /users',
      'GET /users/:id',
    ]);
    expect(routesOf(new PostsController())).toEqual(['GET /posts']);
  });

  it('dispatches an undecorated override through the prototype chain', () => {
    const [route] = discoverRoutes(new OverridingController());

    expect(route?.path).toBe('/ov');
    expect(route?.controller).toBe('OverridingController');
    // Declared on the base, implemented on the subclass.
    expect(route?.handler({} as never)).toEqual(['override.list']);
  });

  it('lets a re-decorated override win over its base', () => {
    @Controller('re')
    class RedecoratedController extends BaseCrudController {
      @Get('/fresh')
      override list(): string[] {
        return ['redecorated'];
      }
    }

    expect(routesOf(new RedecoratedController())).toEqual(['GET /re/fresh']);
  });

  it('finds no routes on a class with none, and never leaks another one', () => {
    class Orphan {
      @Get('/leaked')
      leaked(): string {
        return 'leaked';
      }
    }
    class Unrelated {}

    expect(discoverRoutes(new Unrelated())).toEqual([]);
    // Orphan's own route is still its own - it is simply in nobody else's chain.
    expect(routesOf(new Orphan())).toEqual(['GET /leaked']);
  });

  it('defaults to no prefix when @Controller is omitted', () => {
    class Bare {
      @Get('/health')
      health(): string {
        return 'health';
      }
    }

    expect(routesOf(new Bare())).toEqual(['GET /health']);
  });
});

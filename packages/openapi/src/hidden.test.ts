import { expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import { ApiHidden, Controller, Get } from '@dunx/http';
import { describeRoutes } from './discover.js';

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return [];
  }

  @ApiHidden()
  @Get('internal')
  internal(): string {
    return 'ok';
  }
}

// A wildcard mount: real, routed, and not expressible as a path template.
@ApiHidden()
@Controller('auth')
class MountedAuthHandler {
  @Get('*')
  handle(): string {
    return 'ok';
  }
}

@Module({ controllers: [UsersController, MountedAuthHandler] })
class AppModule {}

test('a hidden route is left out of discovery', () => {
  expect(describeRoutes(AppModule).map((r) => r.path)).toEqual(['/users']);
});

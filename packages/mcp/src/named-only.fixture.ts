import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';

/**
 * A root module exported **only by name** - no `default`, no `root`. This is the
 * shape `@dunx/create-app`'s template and every example in this repo produce, so
 * `bunx @dunx/mcp` has to find it without a naming convention.
 */
@Controller('ping')
export class PingController {
  @Get('/')
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
export class OnlyModule {}

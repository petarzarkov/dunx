import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';

@Controller('items', { version: '1' })
export class ItemsV1Controller {
  @Get('/')
  list(): string[] {
    return [];
  }
}

@Controller('items', { version: '2' })
export class ItemsV2Controller {
  @Get('/')
  list(): string[] {
    return [];
  }
}

@Module({ controllers: [ItemsV1Controller, ItemsV2Controller] })
export class VersionedModule {}

/** The export `bunx dunx-openapi` reads, which is where the versioning is. */
export const openapi = {
  root: VersionedModule,
  versioning: { type: 'header', header: 'X-API-Version' },
} as const;

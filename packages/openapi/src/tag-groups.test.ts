import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';
import { describeRoutes } from './discover.js';
import { info, operationOf } from './document.fixture.js';
import { generateDocument, type DocumentInfo } from './generate.js';
import { ApiDoc } from './metadata.js';

@Controller('users')
class UsersController {
  @Get('/')
  list(): readonly string[] {
    return [];
  }

  @ApiDoc({ tags: ['People'] })
  @Get('/:id')
  one(): string {
    return 'ada';
  }
}

@Controller('reports')
class ReportsController {
  @Get('/')
  list(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [UsersController, ReportsController] })
class RootModule {}

const routes = describeRoutes(RootModule);

/**
 * `Audit` is in a group but on no operation, which is the case a caller cannot
 * get any other way: the group is the only thing that can declare it.
 */
const groups = [
  { name: 'Directory', tags: ['People', 'Users'] },
  { name: 'Analytics', tags: ['Reports', 'Audit'] },
] as const;

const documentFor = async (overrides: Partial<DocumentInfo>) =>
  (await generateDocument(routes, { ...info, ...overrides })).document;

describe('a document with no tag groups', () => {
  it('stays 3.1 with neither extension nor parent', async () => {
    const document = await documentFor({});
    expect(document.openapi).toBe('3.1.0');
    expect(document['x-tagGroups']).toBeUndefined();
    expect(document.tags).toEqual([
      { name: 'People' },
      { name: 'Reports' },
      { name: 'Users' },
    ]);
  });
});

describe('a 3.1 document with tag groups', () => {
  it('carries them as x-tagGroups, in the order declared', async () => {
    const document = await documentFor({ tagGroups: groups });
    expect(document.openapi).toBe('3.1.0');
    expect(document['x-tagGroups']).toEqual(groups);
  });

  it('declares every member, including one no operation carries', async () => {
    const document = await documentFor({ tagGroups: groups });
    expect(document.tags).toEqual([
      { name: 'Audit' },
      { name: 'People' },
      { name: 'Reports' },
      { name: 'Users' },
    ]);
  });

  it('keeps the group name a label rather than a tag', async () => {
    const document = await documentFor({ tagGroups: groups });
    expect(document.tags?.map((tag) => tag.name)).not.toContain('Directory');
  });

  it('puts no parent on a tag under 3.1', async () => {
    const document = await documentFor({ tagGroups: groups });
    for (const tag of document.tags ?? []) {
      expect(tag.parent).toBeUndefined();
    }
  });

  it('leaves an operation tags flat, since the hierarchy is not theirs', async () => {
    const document = await documentFor({ tagGroups: groups });
    expect(operationOf(document, '/users', 'get').tags).toEqual(['Users']);
    expect(operationOf(document, '/users/{id}', 'get').tags).toEqual([
      'People',
    ]);
  });
});

describe('a 3.2 document with tag groups', () => {
  const at32 = { tagGroups: groups, specVersion: '3.2.0' } as const;

  it('names the version and drops the 3.1 extension', async () => {
    const document = await documentFor(at32);
    expect(document.openapi).toBe('3.2.0');
    expect(document['x-tagGroups']).toBeUndefined();
  });

  it('nests each member under its group with parent', async () => {
    const document = await documentFor(at32);
    const parentOf = Object.fromEntries(
      (document.tags ?? []).map((tag) => [tag.name, tag.parent]),
    );
    expect(parentOf).toEqual({
      Analytics: undefined,
      Audit: 'Analytics',
      Directory: undefined,
      People: 'Directory',
      Reports: 'Analytics',
      Users: 'Directory',
    });
  });

  it('hoists each group name into the tags it parents', async () => {
    const document = await documentFor(at32);
    expect(document.tags).toEqual([
      { name: 'Analytics' },
      { name: 'Audit', parent: 'Analytics' },
      { name: 'Directory' },
      { name: 'People', parent: 'Directory' },
      { name: 'Reports', parent: 'Analytics' },
      { name: 'Users', parent: 'Directory' },
    ]);
  });

  it('survives a JSON round trip', async () => {
    const document = await documentFor(at32);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });
});

describe('contributed tags', () => {
  it('join a grouped document without dropping the hierarchy', async () => {
    const document = await documentFor({
      tagGroups: groups,
      contribute: [{ tags: [{ name: 'Auth' }] }],
    });
    expect(document['x-tagGroups']).toEqual(groups);
    expect(document.tags?.map((tag) => tag.name)).toContain('Auth');
  });
});

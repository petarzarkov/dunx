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

describe('a contributed tag that is also grouped', () => {
  const auth = { tags: [{ name: 'Audit', description: 'Who did what' }] };

  it('keeps the contributed description', async () => {
    const document = await documentFor({
      tagGroups: groups,
      contribute: [auth],
    });
    expect(document.tags).toContainEqual({
      name: 'Audit',
      description: 'Who did what',
    });
  });

  it('keeps its 3.2 parent as well', async () => {
    const document = await documentFor({
      tagGroups: groups,
      specVersion: '3.2.0',
      contribute: [auth],
    });
    expect(document.tags).toContainEqual({
      name: 'Audit',
      description: 'Who did what',
      parent: 'Analytics',
    });
  });
});

describe('a group description', () => {
  const described = [
    {
      name: 'Directory',
      description: 'People and accounts',
      tags: ['People', 'Users'],
    },
    { name: 'Analytics', tags: ['Reports'] },
  ];

  it('lands on the group tag under 3.2', async () => {
    const document = await documentFor({
      tagGroups: described,
      specVersion: '3.2.0',
    });
    expect(document.tags).toContainEqual({
      name: 'Directory',
      description: 'People and accounts',
    });
  });

  it('stays out of x-tagGroups, which has no field for it', async () => {
    const document = await documentFor({ tagGroups: described });
    expect(document['x-tagGroups']).toEqual([
      { name: 'Directory', tags: ['People', 'Users'] },
      { name: 'Analytics', tags: ['Reports'] },
    ]);
  });
});

describe('a tag in no group', () => {
  const partial = [{ name: 'Directory', tags: ['People', 'Users'] }];

  it('is a warning under 3.1, where the viewers hide it', async () => {
    const { warnings } = await generateDocument(routes, {
      ...info,
      tagGroups: partial,
    });
    expect(warnings).toEqual([
      'Tag(s) in no tag group, which Scalar and Redoc hide under x-tagGroups: Reports',
    ]);
  });

  it('counts a contributed tag too', async () => {
    const { warnings } = await generateDocument(routes, {
      ...info,
      tagGroups: groups,
      contribute: [{ tags: [{ name: 'Auth' }] }],
    });
    expect(warnings).toEqual([
      'Tag(s) in no tag group, which Scalar and Redoc hide under x-tagGroups: Auth',
    ]);
  });

  it('is not a warning under 3.2, where it is simply top level', async () => {
    const { warnings } = await generateDocument(routes, {
      ...info,
      tagGroups: partial,
      specVersion: '3.2.0',
    });
    expect(warnings).toEqual([]);
  });
});

describe('a hierarchy no viewer can draw', () => {
  it('rejects a tag in two groups', async () => {
    expect(
      documentFor({
        tagGroups: [
          { name: 'Directory', tags: ['Users'] },
          { name: 'Analytics', tags: ['Users'] },
        ],
      }),
    ).rejects.toThrow(
      'Tag "Users" is in both the "Directory" and "Analytics" tag groups.',
    );
  });

  it('rejects a 3.2 group listing itself', async () => {
    expect(
      documentFor({
        tagGroups: [{ name: 'Users', tags: ['Users'] }],
        specVersion: '3.2.0',
      }),
    ).rejects.toThrow('Tag group "Users" contains itself through Users.');
  });

  it('lets a 3.1 group share a name with a member, being only a label', async () => {
    const document = await documentFor({
      tagGroups: [{ name: 'Users', tags: ['Users'] }],
    });
    expect(document['x-tagGroups']).toEqual([
      { name: 'Users', tags: ['Users'] },
    ]);
  });

  it('rejects two groups listing each other', async () => {
    expect(
      documentFor({
        tagGroups: [
          { name: 'Directory', tags: ['Analytics'] },
          { name: 'Analytics', tags: ['Directory'] },
        ],
        specVersion: '3.2.0',
      }),
    ).rejects.toThrow('contains itself');
  });
});

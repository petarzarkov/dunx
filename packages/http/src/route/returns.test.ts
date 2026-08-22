import { describe, expect, it } from 'bun:test';
import { HttpStatusCode } from '../server/status.js';
import { Controller, Delete, Get, Post } from './decorators.js';
import { discoverRoutes } from './discover.js';
import type { Input, RouteSchemas, StandardSchemaV1 } from './schema.js';

const schemaOf = <T>(): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => ({ value: value as T }),
  },
});

interface Person {
  readonly id: number;
  readonly name: string;
}

const Person = schemaOf<Person>();
const People = schemaOf<Person[]>();
const Problem = schemaOf<{ error: string }>();

const onePerson = {
  response: { 200: Person, 404: Problem },
} as const satisfies RouteSchemas;
const listPeople = {
  response: { 200: People },
} as const satisfies RouteSchemas;
const createPerson = {
  response: { 201: Person },
} as const satisfies RouteSchemas;
const noContent = {
  status: HttpStatusCode.NO_CONTENT,
} as const satisfies RouteSchemas;
const jsonSchema = {
  response: { 200: Object.freeze({ $id: 'Pong', type: 'object' }) },
} as const satisfies RouteSchemas;

const ada: Person = { id: 1, name: 'Ada' };

describe('a handler held to its declared response', () => {
  @Controller('people')
  class PeopleController {
    @Get('/:id', onePerson)
    one(_input: Input<typeof onePerson>): Person {
      return ada;
    }

    @Get('/', listPeople)
    async list(_input: Input<typeof listPeople>): Promise<readonly Person[]> {
      return [ada];
    }

    @Get('/raw', onePerson)
    raw(_input: Input<typeof onePerson>): Response {
      return Response.json(ada);
    }

    @Get('/either', onePerson)
    async either(_input: Input<typeof onePerson>): Promise<Person | Response> {
      return ada;
    }

    @Post('/', createPerson)
    create(_input: Input<typeof createPerson>): Person {
      return ada;
    }

    @Delete('/:id', noContent)
    remove(_input: Input<typeof noContent>): undefined {
      return undefined;
    }

    @Get('/pong', jsonSchema)
    pong(_input: Input<typeof jsonSchema>): { anything: true } {
      return { anything: true };
    }
  }

  it('compiles, and every route still discovers', () => {
    const routes = discoverRoutes(new PeopleController());

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /people/:id',
      'GET /people',
      'GET /people/raw',
      'GET /people/either',
      'POST /people',
      'DELETE /people/:id',
      'GET /people/pong',
    ]);
  });

  it('a readonly array satisfies a schema inferring a mutable one', async () => {
    const routes = discoverRoutes(new PeopleController());
    const list = routes.find((route) => route.handlerName === 'list');

    expect(await list?.handler({ req: {} as never })).toEqual([ada]);
  });

  /**
   * Never called - `tsc --noEmit` is the assertion. Each `@ts-expect-error` fails
   * the typecheck if the line below it stops being an error, which is the only way
   * to test that a mistake is unwritable rather than merely discouraged.
   */
  const uncompilable = (): void => {
    @Controller('wrong')
    class WrongController {
      // @ts-expect-error the declared 200 body has a `name`
      @Get('/:id', onePerson)
      missingField(_input: Input<typeof onePerson>): { id: number } {
        return { id: 1 };
      }

      // @ts-expect-error 404's shape is not what a 200 answers with
      @Get('/error-shape', onePerson)
      errorShape(_input: Input<typeof onePerson>): { error: string } {
        return { error: 'nope' };
      }

      // @ts-expect-error nothing at all is a 204, not the declared 200
      @Get('/empty', onePerson)
      empty(_input: Input<typeof onePerson>): null {
        return null;
      }

      // @ts-expect-error POST documents a 201, so the 201 entry is the one checked
      @Post('/', createPerson)
      wrongCreate(_input: Input<typeof createPerson>): { error: string } {
        return { error: 'nope' };
      }

      // @ts-expect-error an awaited answer is checked the same as a direct one
      @Get('/async', onePerson)
      async wrongAsync(_input: Input<typeof onePerson>): Promise<string> {
        return 'nope';
      }
    }
    void WrongController;
  };
  void uncompilable;
});

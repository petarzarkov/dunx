import {
  ClientAddress,
  Controller,
  Get,
  HttpStatusCode,
  Post,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import {
  decodeCursor,
  encodeCursor,
  pageOf,
  PAGINATION,
  type Page,
} from '@dunx/infra/pagination/cursor';
import { ApiDoc } from '@dunx/openapi';
import { z } from 'zod';
import { NotesService } from './notes.service.js';

const CreateNote = z
  .object({ text: z.string().min(1) })
  .meta({ id: 'CreateNote', description: 'Add a note' });

// An explicit status, unlike the users controller which takes the POST default.
const createNote = {
  body: CreateNote,
  status: HttpStatusCode.CREATED,
} as const satisfies RouteSchemas;

const notePage = {
  query: z.object({
    take: z.coerce
      .number()
      .int()
      .min(PAGINATION.MIN_TAKE)
      .max(PAGINATION.MAX_TAKE)
      .default(PAGINATION.DEFAULT_TAKE),
    cursor: z.string().optional(),
  }),
} as const satisfies RouteSchemas;

/**
 * `@ApiDoc` carries what no zod schema can - prose, grouping, deprecation. It is a
 * thin wrapper over `@dunx/http`'s generic route-metadata channel (`metaKey` mints
 * a symbol, `meta` writes it), which is why documentation needs no parallel
 * registry and no second discovery pass. At class scope it names the tag every
 * route below is grouped under.
 */
@ApiDoc({
  tags: ['Notes'],
  description: 'A list in memory, for showing the prefix, middleware and CORS.',
})
@Controller('notes')
export class NotesController {
  // ClientAddress is a framework class with no registration - the container
  // self-binds it, and app.listen() hands it the live server.
  constructor(
    private readonly notes: NotesService,
    private readonly address: ClientAddress,
  ) {}

  @Get('/')
  list(): readonly string[] {
    return this.notes.rows();
  }

  // Destructuring at the parameter is the usual shape, and it is what every other
  // handler here does. The whole object has a name when a handler wants to pass it
  // on: `whoami(input: Input<RouteSchemas>)` types the same. No schemas are
  // declared on this route, so `req` is all it carries.
  @ApiDoc({
    summary: 'Echo the caller’s address',
    description:
      'Reads the socket address, honouring `x-forwarded-for` because `trust proxy` is set.',
    deprecated: true,
  })
  @Get('/whoami')
  whoami({ req }: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.address.of(req) };
  }

  /**
   * The same cursor and envelope a drizzle table gets, over an array. The import
   * is `@dunx/infra/pagination/cursor`, which carries no query builder, so this
   * route would work in an app with no drizzle installed.
   */
  @ApiDoc({
    summary: 'A page of notes',
    description: 'Keyset pagination over a list that is not a database table.',
  })
  @Get('/page', notePage)
  page({ query }: Input<typeof notePage>): Page<{ id: string; text: string }> {
    const rows = this.notes
      .rows()
      .map((text, index) => ({ id: String(index), text }));
    const from =
      query.cursor === undefined ? 0 : Number(decodeCursor(query.cursor).i) + 1;
    const slice = rows.slice(from, from + query.take);

    return pageOf(slice, {
      take: query.take,
      hasNextPage: from + slice.length < rows.length,
      hasPreviousPage: from > 0,
      cursorOf: (row) => encodeCursor(0, row.id),
    });
  }

  @Post('/', createNote)
  create({ body }: Input<typeof createNote>): readonly string[] {
    return this.notes.add(body.text);
  }
}

import {
  ClientAddress,
  Controller,
  Get,
  HttpStatusCode,
  Post,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { z } from 'zod';
import { NotesService } from './notes.service.js';

const CreateNote = z
  .object({ text: z.string().min(1) })
  .meta({ id: 'CreateNote', title: 'Add a note' });

// An explicit status, unlike the users controller which takes the POST default.
const createNote = {
  body: CreateNote,
  status: HttpStatusCode.CREATED,
} as const satisfies RouteSchemas;

/**
 * `@ApiDoc` carries what no zod schema can — prose, grouping, deprecation. It is a
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
  // ClientAddress is a framework class with no registration — the container
  // self-binds it, and app.listen() hands it the live server.
  constructor(
    private readonly notes: NotesService,
    private readonly address: ClientAddress,
  ) {}

  @Get('/')
  list(): readonly string[] {
    return this.notes.rows();
  }

  // No schemas declared, so the request is all `input` carries.
  @ApiDoc({
    summary: 'Echo the caller’s address',
    description:
      'Reads the socket address, honouring `x-forwarded-for` because `trust proxy` is set.',
    deprecated: true,
  })
  @Get('/whoami')
  whoami(input: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.address.of(input.req) };
  }

  @Post('/', createNote)
  create(input: Input<typeof createNote>): readonly string[] {
    return this.notes.add(input.body.text);
  }
}

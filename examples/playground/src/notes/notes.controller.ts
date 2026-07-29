import {
  ClientAddress,
  Controller,
  Get,
  HttpStatusCode,
  Post,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
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
  @Get('/whoami')
  whoami(input: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.address.of(input.req) };
  }

  @Post('/', createNote)
  create(input: Input<typeof createNote>): readonly string[] {
    return this.notes.add(input.body.text);
  }
}

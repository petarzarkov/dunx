import type { BunRequest } from 'bun';
import {
  ClientAddress,
  Controller,
  Get,
  HttpStatusCode,
  Post,
} from '@dunx/http';
import { NotesService } from './notes.service.js';

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

  @Get('/whoami')
  whoami(req: BunRequest): { ip: string | undefined } {
    return { ip: this.address.of(req) };
  }

  @Post('/')
  async create(req: BunRequest): Promise<Response> {
    const { text } = (await req.json()) as { text: string };
    return Response.json(this.notes.add(text), {
      status: HttpStatusCode.CREATED,
    });
  }
}

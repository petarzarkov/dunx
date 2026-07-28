import type { BunRequest } from 'bun';
import { Controller, Get, HttpError, HttpStatusCode } from '@dunx/http';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('/')
  list(): readonly string[] {
    return this.users.rows();
  }

  @Get('/:id')
  one(req: BunRequest<'/users/:id'>): string {
    const row = this.users.rows()[Number(req.params.id)];
    if (row === undefined) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No user ${req.params.id}`);
    }
    return row;
  }
}

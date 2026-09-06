import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  Post,
  type Input,
} from '@dunx/http';
import type { User } from './users.repository.js';
import { createUser, listUsers, oneUser } from './users.schemas.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // `Input<typeof listUsers>` has to be written out - a standard method decorator
  // can check a parameter's type but cannot contextually type an unannotated one.
  // Every field type still comes from the schema, so nothing is declared twice.
  //
  // The return type is checked too, against `listUsers.response[200]`: a handler
  // that answers with a shape the document does not describe is a TS1241 here
  // rather than a surprise for whoever read the document. `readonly User[]` is
  // accepted against a schema inferring `User[]` - mutability does not survive
  // serialisation.
  @Get('/', listUsers)
  list({ query }: Input<typeof listUsers>): Promise<readonly User[]> {
    return this.users.findAll(query.limit, query.q);
  }

  // Only the success status is checked - the 404 in `oneUser.response` leaves via
  // a thrown HttpError, which no return type can describe.
  @Get('/:id', oneUser)
  async one({ params }: Input<typeof oneUser>): Promise<User> {
    // Already a number: the params schema coerced it before this ran.
    const user = await this.users.find(params.id);
    if (user === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No user ${params.id}`);
    }
    return user;
  }

  // No req.json(), no Response.json(), no status - the body arrives validated and
  // typed, and 201 is the POST default.
  @Post('/', createUser)
  create({ body }: Input<typeof createUser>): Promise<User> {
    return this.users.create(
      body.name,
      body.tags.map((tag) => tag.label),
    );
  }
}

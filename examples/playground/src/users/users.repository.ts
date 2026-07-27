import { inject } from '@dunx/core';
import { Database } from '../infra/database.js';

export class UsersRepository {
  // Resolved synchronously in a field initializer, even though Database is bound
  // to an async factory.
  readonly #db = inject(Database);

  findAll(): readonly string[] {
    return this.#db.query('select * from users');
  }
}

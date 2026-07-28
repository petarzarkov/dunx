import { Database } from '../infra/database.js';

export class UsersRepository {
  // Injected from the parameter's type. Database is bound to an async factory and
  // is already settled by the time the container calls this.
  constructor(private readonly db: Database) {}

  findAll(): readonly string[] {
    return this.db.query('select * from users');
  }
}

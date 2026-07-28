import { Database } from '../infra/database.js';

export class UsersRepository {
  constructor(private readonly db: Database) {}

  findAll(): readonly string[] {
    return this.db.query('select * from users');
  }
}

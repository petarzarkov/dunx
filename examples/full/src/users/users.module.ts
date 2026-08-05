import { Module } from '@dunx/core';
import { DatabaseModule } from '../database/database.module.js';
import { UsersController } from './users.controller.js';
import { UsersDemo } from './users.demo.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  // The drizzle handle comes from here: `UsersRepository` injects it, and a module
  // only sees what it imports.
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, UsersDemo],
  exports: [UsersService, UsersRepository, UsersDemo],
})
export class UsersModule {}

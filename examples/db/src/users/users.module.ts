import { Module } from '@dunx/core';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  providers: [UsersService, UsersRepository],
})
export class UsersModule {}

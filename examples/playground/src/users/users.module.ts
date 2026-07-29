import { Module } from '@dunx/core';
import { UsersController } from './users.controller.js';
import { UsersDemo } from './users.demo.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, UsersDemo],
})
export class UsersModule {}

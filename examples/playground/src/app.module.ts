import { Module } from '@dunx/core';
import { InfraModule } from './infra/infra.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [InfraModule, UsersModule],
})
export class AppModule {}

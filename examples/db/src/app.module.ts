import { Module } from '@dunx/core';
import { DbModule } from '@dunx/db';
import { Config } from './config.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    /**
     * `forRootAsync` is `forRoot` with the options produced by a factory that may
     * await and may inject. dunx resolves eagerly and settles every async factory
     * before it constructs anything, so the connection is open before
     * `UsersRepository` exists — which is why nothing here needs a `ready()`.
     */
    DbModule.forRootAsync({
      useFactory: (config: Config) => config.options(),
      inject: [Config],
    }),
    UsersModule,
  ],
  providers: [Config],
})
export class AppModule {}

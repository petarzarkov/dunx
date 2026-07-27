import { Module, provide } from '@dunx/core';
import { Config } from '../config.js';
import { connect, Database } from './database.js';

@Module({
  providers: [
    Config,
    // `connect`'s parameter is inferred from `inject: [Config]`. DunxFactory.create
    // awaits this before any constructor runs, which is what keeps inject() sync.
    provide(Database, { useFactory: connect, inject: [Config] }),
  ],
})
export class InfraModule {}

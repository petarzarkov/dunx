import { Module } from '@dunx/core';
import { CacheModule } from '../cache/cache.module.js';
import { ChatDemo } from './chat.demo.js';
import { PostgresRelayDemo } from './postgres-relay.demo.js';
import { ChatGateway } from './chat.gateway.js';
import { Lobby } from './lobby.service.js';

// A gateway is declared in `providers`, next to the services it injects - there is
// no separate list for it, and no second module to configure.
@Module({
  // `RedisConnection`, for cross-process fan-out.
  imports: [CacheModule],
  providers: [ChatGateway, Lobby, ChatDemo, PostgresRelayDemo],
  exports: [Lobby, ChatDemo, PostgresRelayDemo],
})
export class ChatModule {}

import { Module } from '@dunx/core';
import { CacheModule } from '../cache/cache.module.js';
import { ChatDemo } from './chat.demo.js';
import { ChatGateway } from './chat.gateway.js';
import { Lobby } from './lobby.service.js';

// A gateway is declared in `providers`, next to the services it injects - there is
// no separate list for it, and no second module to configure.
@Module({
  // `RedisConnection`, for cross-process fan-out.
  imports: [CacheModule],
  providers: [ChatGateway, Lobby, ChatDemo],
  exports: [Lobby, ChatDemo],
})
export class ChatModule {}

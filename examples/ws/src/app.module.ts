import { Module } from '@dunx/core';
import { WsModule } from '@dunx/ws';
import { ChatGateway } from './chat.gateway.js';
import { Rooms } from './rooms.service.js';

@Module({
  imports: [
    WsModule.forRoot({
      gateways: [ChatGateway],
      // Port 0 so concurrent runs never collide.
      port: Number(process.env['PORT'] ?? 0),
      idleTimeout: 30,
    }),
  ],
  providers: [Rooms],
})
export class AppModule {}

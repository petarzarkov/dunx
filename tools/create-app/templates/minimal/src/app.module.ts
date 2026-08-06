import { Module } from '@dunx/core';
import { GreetingsController } from './greetings.controller.js';
import { GreetingsService } from './greetings.service.js';

/**
 * The root module. `controllers` are discovered for routes, `providers` are
 * everything else. Import order is construction order, and shutdown runs in
 * reverse - which matters once there is a database to close.
 */
@Module({
  controllers: [GreetingsController],
  providers: [GreetingsService],
})
export class AppModule {}

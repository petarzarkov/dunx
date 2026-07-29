import { Module } from '@dunx/core';
import { CacheModule } from './cache/cache.module.js';
import { ChatModule } from './chat/chat.module.js';
import { Config } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { DocsModule } from './docs/docs.module.js';
import { HttpModule } from './http/http.module.js';
import { NotesModule } from './notes/notes.module.js';
import { PicturesModule } from './pictures/pictures.module.js';
import { StorageModule } from './storage/storage.module.js';
import { Tour } from './tour/tour.service.js';
import { UsersModule } from './users/users.module.js';

/**
 * Import order is construction order, and shutdown runs in reverse — so the
 * database and the workspace outlive every feature that uses them.
 */
@Module({
  imports: [
    DatabaseModule,
    StorageModule,
    PicturesModule,
    CacheModule,
    HttpModule,
    UsersModule,
    NotesModule,
    ChatModule,
    DocsModule,
  ],
  providers: [Config, Tour],
})
export class AppModule {}

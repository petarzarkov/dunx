import { Module } from '@dunx/core';
import { NotesModule } from './notes/notes.module.js';
import { RequestLog } from './request-log.js';

@Module({
  imports: [NotesModule],
  providers: [RequestLog],
})
export class AppModule {}

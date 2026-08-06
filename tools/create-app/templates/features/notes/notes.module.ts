import { Module } from '@dunx/core';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

@Module({
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}

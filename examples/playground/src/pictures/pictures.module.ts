import { Module } from '@dunx/core';
import { ImagesModule } from '@dunx/infra/images';
import { Thumbnails } from './thumbnails.service.js';

@Module({
  // No forRootAsync here and none needed: pass a function instead of an object
  // and it is awaited, because factories settle before any constructor runs.
  imports: [ImagesModule.forRoot({ quality: 82, maxWidth: 1024 })],
  providers: [Thumbnails],
})
export class PicturesModule {}

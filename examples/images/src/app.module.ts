import { Module } from '@dunx/core';
import { ImagesModule } from '@dunx/images';
import { Thumbnails } from './thumbnails.service.js';

@Module({
  imports: [
    ImagesModule.forRoot({
      quality: 82,
      // Every resize is clamped to this box, however large the request.
      maxWidth: 256,
      maxHeight: 256,
      allowedFormats: ['png', 'jpeg', 'webp'],
    }),
  ],
  providers: [Thumbnails],
})
export class AppModule {}

import { Module } from '@dunx/core';
import { Images, ImagesModule } from '@dunx/infra/images';
import { AppConfigService } from '../config.js';
import { ImagesController } from './images.controller.js';
import { Thumbnails } from './thumbnails.service.js';

@Module({
  imports: [
    // `forRootAsync` is what a factory needs in order to *inject*; asynchrony is
    // free either way, since every factory settles before the first constructor.
    ImagesModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        quality: config.get('images').quality,
        maxWidth: 1024,
      }),
      inject: [AppConfigService],
    }),
  ],
  controllers: [ImagesController],
  providers: [Thumbnails],
  // `Thumbnails` is what the jobs feature resizes with, and `Images` is re-exported
  // so an importer needs no direct knowledge of @dunx/infra/images.
  exports: [Thumbnails, Images],
})
export class PicturesModule {}

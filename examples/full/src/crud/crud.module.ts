import { Module } from '@dunx/core';
import { ColorsController, ColorsStore } from './colors.controller.js';
import {
  SwatchesV1Controller,
  SwatchesV2Controller,
} from './swatches.controller.js';
import { VersioningDemo } from './versioning.demo.js';

@Module({
  controllers: [ColorsController, SwatchesV1Controller, SwatchesV2Controller],
  providers: [ColorsStore, VersioningDemo],
  exports: [VersioningDemo],
})
export class CrudModule {}

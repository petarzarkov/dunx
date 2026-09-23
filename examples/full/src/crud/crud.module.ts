import { Module } from '@dunx/core';
import { ColorsController, ColorsStore } from './colors.controller.js';

@Module({
  controllers: [ColorsController],
  providers: [ColorsStore],
})
export class CrudModule {}

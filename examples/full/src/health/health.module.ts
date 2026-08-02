import { Module } from '@dunx/core';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController] })
export class HealthModule {}

import { Module } from '@dunx/core';
import { ReportsModule } from './reports/reports.module.js';
import { WeatherModule } from './weather/weather.module.js';

@Module({ imports: [WeatherModule, ReportsModule] })
export class AppModule {}

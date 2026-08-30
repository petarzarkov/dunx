import { Module } from '@dunx/core';
import { HttpModule } from './http/http.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { WeatherModule } from './weather/weather.module.js';

@Module({ imports: [HttpModule, WeatherModule, ReportsModule] })
export class AppModule {}

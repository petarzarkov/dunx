import { Module } from '@dunx/core';
import { ForecastClient } from './forecast.client.js';
import { WeatherController } from './weather.controller.js';
import { WeatherService } from './weather.service.js';

@Module({
  controllers: [WeatherController],
  providers: [ForecastClient, WeatherService],
})
export class WeatherModule {}

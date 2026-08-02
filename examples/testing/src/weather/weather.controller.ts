import { Controller, Get, type Input } from '@dunx/http';
import { z } from 'zod';
import { WeatherService, type Reading } from './weather.service.js';

const oneCity = { params: z.object({ city: z.string().min(1) }) } as const;

@Controller('weather')
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}

  @Get('/:city', oneCity)
  read(input: Input<typeof oneCity>): Promise<Reading> {
    return this.weather.read(input.params.city);
  }
}

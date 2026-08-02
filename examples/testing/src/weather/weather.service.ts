import { Logger, type OnInit } from '@dunx/core';
import { ForecastClient } from './forecast.client.js';

export interface Reading {
  readonly city: string;
  readonly celsius: number;
  readonly advice: string;
}

/** The unit under test: real logic, one injected collaborator, no I/O of its own. */
export class WeatherService implements OnInit {
  constructor(
    private readonly forecast: ForecastClient,
    private readonly logger: Logger,
  ) {}

  onInit(): void {
    this.logger.info('weather ready');
  }

  async read(city: string): Promise<Reading> {
    const celsius = await this.forecast.temperatureAt(city);
    if (celsius < -80 || celsius > 60) {
      this.logger.error(`implausible reading for ${city}: ${celsius}`);
    }
    return {
      city,
      celsius,
      advice: celsius > 25 ? 'take water' : 'take a coat',
    };
  }
}

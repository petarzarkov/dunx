import { describe, expect, test } from 'bun:test';
import { Logger, LogLevel, Module, provide } from '@dunx/core';
import { createTestApp, RecordingLogger } from '@dunx/testing';
import { ForecastClient } from './weather/forecast.client.js';
import { WeatherModule } from './weather/weather.module.js';
import { WeatherService } from './weather/weather.service.js';

/** The fake. A class the test wrote — no mocking framework, no interface. */
class FixedForecast extends ForecastClient {
  constructor(private readonly celsius: number) {
    super();
  }

  override async temperatureAt(): Promise<number> {
    return this.celsius;
  }
}

/**
 * `createTestApp` builds the container and nothing else — no server, no port. Use
 * it when the thing under test is a service, which is most of the time.
 */
describe('createTestApp', () => {
  test('an override replaces the real collaborator everywhere', async () => {
    const app = await createTestApp({
      modules: [WeatherModule],
      overrides: [provide(ForecastClient, { useValue: new FixedForecast(31) })],
    });

    // The real ForecastClient would have hit the network. If this passes, the
    // substitution reached the service's constructor.
    expect(await app.get(WeatherService).read('lisbon')).toEqual({
      city: 'lisbon',
      celsius: 31,
      advice: 'take water',
    });

    await app.shutdown();
  });

  test('the discarded provider is never constructed', async () => {
    class Exploding extends ForecastClient {
      constructor() {
        super();
        throw new Error('the real client was constructed');
      }
    }

    @Module({
      providers: [
        provide(ForecastClient, { useClass: Exploding }),
        WeatherService,
      ],
    })
    class ExplodingWeather {}

    // Overrides *replace*; they are not an extra binding appended at the end that
    // wins. So the discarded provider is never instantiated — its constructor never
    // runs, its `onInit` never fires and, when it is a database, no connection is
    // opened. That last one is the guarantee a hand-rolled fixture usually misses.
    const app = await createTestApp({
      modules: [ExplodingWeather],
      overrides: [provide(ForecastClient, { useValue: new FixedForecast(5) })],
    });

    expect((await app.get(WeatherService).read('oslo')).celsius).toBe(5);
    await app.shutdown();
  });

  test('an override naming a token nobody binds is an error', async () => {
    class NotBoundAnywhere {}

    // Not a silent no-op — which is what would otherwise leave a suite asserting
    // against the real provider it thought it had swapped.
    const message = await createTestApp({
      modules: [WeatherModule],
      overrides: [provide(NotBoundAnywhere, { useValue: {} })],
    }).then(
      () => 'it resolved',
      (error: unknown) => (error as Error).message,
    );

    expect(message).toContain('Nothing to override for NotBoundAnywhere');
  });

  test('RecordingLogger keeps entries instead of writing them', async () => {
    const logger = new RecordingLogger();
    const app = await createTestApp({
      modules: [WeatherModule],
      overrides: [
        provide(ForecastClient, { useValue: new FixedForecast(400) }),
        // `Logger` is overridable even though no module binds it: core offers a
        // default after every module, and the substitution applies there too.
        provide(Logger, { useValue: logger }),
      ],
    });

    await app.get(WeatherService).read('venus');

    expect(logger.at(LogLevel.ERROR).map((entry) => entry.message)).toEqual([
      'implausible reading for venus: 400',
    ]);
    await app.shutdown();
  });
});

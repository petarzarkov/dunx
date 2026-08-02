/**
 * The external service - the one thing a test must not actually call.
 *
 * A plain class with no interface in front of it. dunx resolves by class, so the
 * class *is* the seam: a test binds a different one to the same token and every
 * consumer gets it, with no `IForecastClient`, no factory indirection and no
 * mocking framework.
 *
 * `fetch` here would hit the network, which is the point - if an override is
 * wrong, the suite tells you by timing out or by 500ing, not by quietly passing.
 */
export class ForecastClient {
  async temperatureAt(city: string): Promise<number> {
    const response = await fetch(
      `https://api.example.invalid/forecast?city=${encodeURIComponent(city)}`,
    );
    const body = (await response.json()) as { temperature: number };
    return body.temperature;
  }
}

/**
 * The external service, and the one thing a test must not call. A plain class with
 * no interface: dunx resolves by class, so the class is the seam.
 *
 * `fetch` here would hit the network, which is the point - a wrong override fails
 * the suite rather than passing quietly.
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

import { Gateway, OnMessage, type Socket } from '@dunx/http';

/**
 * Binary frames rather than JSON, so `binaryType` has something to select for.
 * `main.ts` sets it once and every socket on every gateway gets it.
 */
@Gateway('/telemetry')
export class TelemetryGateway {
  readonly readings: number[] = [];

  @OnMessage()
  async record(message: string | Buffer, socket: Socket): Promise<string> {
    if (typeof message === 'string') {
      return `expected a binary frame, got ${message.length} chars of text`;
    }

    // Bun types `message` as the default binaryType's, so a gateway that
    // configured one narrows it here. A Blob is the one that needs an await.
    const blob = message as unknown as Blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    this.readings.push(...bytes);

    return (
      `${blob.constructor.name}(${blob.size}) -> ` +
      `[${[...bytes].join(', ')}], ${this.readings.length} recorded on ` +
      `socket ${socket.data.id.slice(0, 8)}`
    );
  }
}

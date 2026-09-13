import { describe, expect, it } from 'bun:test';
import { decodeRelay, WsRelay } from './relay.js';
import { RelayPublisher } from './relay-publisher.js';

interface Sent {
  readonly channel: string;
  readonly message: string;
}

class Recording extends WsRelay {
  readonly sent: Sent[] = [];
  #answer: unknown = 1;

  answerWith(answer: unknown): void {
    this.#answer = answer;
  }

  override publish(channel: string, message: string): unknown {
    this.sent.push({ channel, message });
    if (this.#answer instanceof Error) throw this.#answer;
    return this.#answer;
  }

  override subscribe(): void {
    this.sent.length = 0;
  }

  override close(): void {
    this.sent.length = 0;
  }
}

const only = (relay: Recording): ReturnType<typeof decodeRelay> =>
  decodeRelay(relay.sent[0]?.message ?? '');

describe('RelayPublisher', () => {
  it('publishes the envelope a gateway reads, on the default channel', () => {
    const relay = new Recording();
    new RelayPublisher(relay).publishEvent('lobby', 'round.started', { id: 7 });

    expect(relay.sent[0]?.channel).toBe('dunx:ws');
    const frame = only(relay);
    expect(frame?.topic).toBe('lobby');
    expect(JSON.parse(String(frame?.data))).toEqual({
      event: 'round.started',
      data: { id: 7 },
    });
  });

  it('takes the channel it is given', () => {
    const relay = new Recording();
    new RelayPublisher(relay, { channel: 'game:ws' }).publishEvent('a', 'b');

    expect(relay.sent[0]?.channel).toBe('game:ws');
  });

  it('carries an origin no server shares, so every node fans the frame out', () => {
    const relay = new Recording();
    const publisher = new RelayPublisher(relay);
    publisher.publishEvent('lobby', 'tick');

    expect(publisher.origin).toStartWith('worker:');
    expect(only(relay)?.origin).toBe(publisher.origin);
    expect(publisher.channel).toBe('dunx:ws');
  });

  it('reports a synchronous throw rather than raising it', () => {
    const relay = new Recording();
    relay.answerWith(new Error('no broker'));
    const seen: unknown[] = [];

    expect(() => {
      new RelayPublisher(relay, {
        onError: (error) => seen.push(error),
      }).publishEvent('lobby', 'tick');
    }).not.toThrow();

    expect((seen[0] as Error).message).toBe('no broker');
  });

  it('reports a rejection rather than leaving it unhandled', async () => {
    const relay = new Recording();
    relay.answerWith(Promise.reject(new Error('refused')));
    const seen: unknown[] = [];

    new RelayPublisher(relay, {
      onError: (error) => seen.push(error),
    }).publishEvent('lobby', 'tick');

    await Bun.sleep(1);
    expect((seen[0] as Error).message).toBe('refused');
  });

  it('publishes a raw frame too, base64 for anything not a string', () => {
    const relay = new Recording();
    new RelayPublisher(relay).publish('lobby', new Uint8Array([1, 2, 3]));

    expect(only(relay)?.data).toEqual(Buffer.from([1, 2, 3]));
  });
});

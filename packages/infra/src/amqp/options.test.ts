import { describe, expect, it } from 'bun:test';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { describeMessage } from './message.js';
import {
  AmqpOptions,
  assertAmqpUrl,
  defaultAmqpUrl,
  withDefaultCredentials,
} from './options.js';

describe('the broker url', () => {
  it('reads $RABBITMQ_URL before $AMQP_URL', () => {
    const before = { ...process.env };
    try {
      process.env['RABBITMQ_URL'] = 'amqp://one:5672';
      process.env['AMQP_URL'] = 'amqp://two:5672';
      expect(defaultAmqpUrl()).toBe('amqp://one:5672');

      delete process.env['RABBITMQ_URL'];
      expect(defaultAmqpUrl()).toBe('amqp://two:5672');

      delete process.env['AMQP_URL'];
      expect(defaultAmqpUrl()).toBe('amqp://guest:guest@localhost:5672');
    } finally {
      Object.assign(process.env, before);
      if (before['RABBITMQ_URL'] === undefined)
        delete process.env['RABBITMQ_URL'];
      if (before['AMQP_URL'] === undefined) delete process.env['AMQP_URL'];
    }
  });

  it('accepts amqp and amqps', () => {
    expect(assertAmqpUrl('amqp://localhost:5672')).toBe(
      'amqp://localhost:5672',
    );
    expect(assertAmqpUrl('amqps://broker:5671')).toBe('amqps://broker:5671');
  });

  /**
   * `rabbitmq-client` reads the credentials out of a url string unconditionally,
   * with no fallback of its own: `amqp://host` authenticates as user '' with a
   * blank password, which RabbitMQ refuses outright. Naming a host is not
   * supposed to be a different case from naming none, so the AMQP URI spec's
   * defaults are filled in here.
   */
  describe('credentials', () => {
    it('fills in the spec default when the url names none', () => {
      expect(withDefaultCredentials('amqp://localhost:5672')).toBe(
        'amqp://guest:guest@localhost:5672',
      );
      expect(withDefaultCredentials('amqps://broker:5671/prod')).toBe(
        'amqps://guest:guest@broker:5671/prod',
      );
    });

    it('leaves a url that names them alone, byte for byte', () => {
      for (const url of [
        'amqp://app:hunter2@broker:5672',
        // A username with no password is a deliberate choice, not an omission:
        // filling in `guest` as the password of some other user would be worse
        // than the blank one the caller asked for.
        'amqp://app@broker:5672',
        'amqp://app:p%40ss@broker:5672/vhost',
      ]) {
        expect(withDefaultCredentials(url)).toBe(url);
      }
    });

    it('is what AmqpOptions stores, so the connection never sees a blank user', () => {
      expect(new AmqpOptions({ url: 'amqp://localhost:5672' }).url).toBe(
        'amqp://guest:guest@localhost:5672',
      );
    });

    it('keeps the filled-in password out of the redacted url', () => {
      const options = new AmqpOptions({ url: 'amqp://localhost:5672' });
      expect(options.redactedUrl).not.toContain('guest:guest');
    });
  });

  /**
   * Checked up front rather than at connect time. `rabbitmq-client` retries a
   * failed connection forever, so a typo would otherwise surface as a publish
   * that never settles.
   */
  it('rejects an unparseable url, naming where to look rather than the value', () => {
    expect(() => assertAmqpUrl('not a url')).toThrow(AmqpError);
    try {
      assertAmqpUrl('not a url');
    } catch (error) {
      expect((error as AmqpError).code).toBe(AmqpErrorCode.INVALID_URL);
      expect((error as AmqpError).message).toContain('$RABBITMQ_URL');
    }
  });

  it('rejects a url whose protocol is not AMQP', () => {
    expect(() => assertAmqpUrl('redis://localhost:6379')).toThrow(
      /Unsupported protocol "redis:"/,
    );
  });

  /**
   * An AMQP url almost always holds credentials and a boot error is written by
   * whatever logger is bound, so neither message carries the url as given.
   */
  it('keeps the password out of both failures', () => {
    const secret = 'hunter2';
    expect(() => assertAmqpUrl(`redis://app:${secret}@broker:5672`)).toThrow(
      AmqpError,
    );
    for (const url of [`redis://app:${secret}@broker:5672`, `::${secret}::`]) {
      try {
        assertAmqpUrl(url);
        expect.unreachable();
      } catch (error) {
        expect((error as AmqpError).message).not.toContain(secret);
      }
    }
  });
});

describe('AmqpOptions', () => {
  it('defaults the consumer to a prefetch of twice its concurrency', () => {
    const options = new AmqpOptions({ url: 'amqp://localhost:5672' });
    expect(options.consumer.concurrency).toBe(8);
    expect(options.consumer.qos?.prefetchCount).toBe(16);
  });

  /**
   * RabbitMQ 4 refuses a `transient_nonexcl_queue`, so a non-durable default
   * would fail the channel with `INTERNAL_ERROR` at the first declare.
   */
  it('declares durable queues by default', () => {
    expect(new AmqpOptions().consumer.queueOptions?.durable).toBe(true);
  });

  it('confirms publishes by default', () => {
    expect(new AmqpOptions().publisher.confirm).toBe(true);
    expect(
      new AmqpOptions({ publisher: { confirm: false } }).publisher.confirm,
    ).toBe(false);
  });

  /**
   * A single spread replaced these wholesale, so `queueOptions: { arguments }`
   * dropped `durable: true` and RabbitMQ 4 refuses the declare with
   * `INTERNAL_ERROR`, and `qos: { global: true }` reset the prefetch to 0.
   */
  it('merges qos and queueOptions key by key', () => {
    const options = new AmqpOptions({
      consumer: {
        qos: { global: true },
        queueOptions: { arguments: { 'x-dead-letter-exchange': 'dlx' } },
      },
    });

    expect(options.consumer.qos).toEqual({ prefetchCount: 16, global: true });
    expect(options.consumer.queueOptions).toEqual({
      durable: true,
      arguments: { 'x-dead-letter-exchange': 'dlx' },
    });
  });

  it('keeps the defaults under an empty nested override', () => {
    const options = new AmqpOptions({
      consumer: { qos: {}, queueOptions: {} },
    });
    expect(options.consumer.qos?.prefetchCount).toBe(16);
    expect(options.consumer.queueOptions?.durable).toBe(true);
  });

  it('overrides a consumer default per key rather than wholesale', () => {
    const options = new AmqpOptions({
      consumer: { concurrency: 1, qos: { prefetchCount: 1 } },
    });
    expect(options.consumer.concurrency).toBe(1);
    expect(options.consumer.qos?.prefetchCount).toBe(1);
    // Still durable: overriding concurrency should not silently produce a queue
    // RabbitMQ 4 refuses to declare.
    expect(options.consumer.queueOptions?.durable).toBe(true);
  });

  it('does not consume unless asked', () => {
    expect(new AmqpOptions().consume).toBe(false);
    expect(new AmqpOptions({ consume: 'if-any' }).consume).toBe('if-any');
  });

  it('names the connection dunx unless told otherwise', () => {
    expect(new AmqpOptions().connectionName).toBe('dunx');
    expect(new AmqpOptions({ connectionName: 'billing' }).connectionName).toBe(
      'billing',
    );
  });

  it('redacts the password, which is what a boot log prints', () => {
    const options = new AmqpOptions({
      url: 'amqps://app:s3cret@broker.internal:5671',
    });
    expect(options.redactedUrl).toContain('app:***@');
    expect(options.redactedUrl).not.toContain('s3cret');
  });

  it('carries the connection and handler timeouts through', () => {
    const options = new AmqpOptions({
      connection: { heartbeat: 5 },
      handlerTimeoutMs: 250,
    });
    expect(options.connection.heartbeat).toBe(5);
    expect(options.handlerTimeoutMs).toBe(250);
    expect(new AmqpOptions().handlerTimeoutMs).toBeUndefined();
  });
});

describe('describeMessage', () => {
  it('prefers the publisher id, which identifies the message rather than the delivery', () => {
    expect(
      describeMessage('orders', {
        messageId: 'm-1',
        deliveryTag: 9,
        routingKey: 'order.created',
      }),
    ).toBe('m-1 orders[order.created]');
  });

  it('falls back to the delivery tag when nobody stamped an id', () => {
    expect(
      describeMessage('orders', {
        deliveryTag: 9,
        routingKey: 'order.created',
      }),
    ).toBe('#9 orders[order.created]');
  });
});

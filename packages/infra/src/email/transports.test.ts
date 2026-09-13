import { describe, expect, it } from 'bun:test';
import { Quiet } from '../quiet.fixture.js';
import { EmailError, EmailSendError } from './errors.js';
import { LogTransport } from './log.js';
import { MemoryTransport } from './memory.js';
import { outbound } from './outbound.fixture.js';
import { UnconfiguredRenderer } from './renderer.js';

describe('LogTransport', () => {
  it('writes instead of sending, and accepts every recipient', async () => {
    const logger = new Quiet();

    const result = await new LogTransport(logger).send(
      outbound({ cc: [{ address: 'b@example.com' }] }),
    );

    expect(result.transport).toBe('log');
    expect(result.id).toBeUndefined();
    expect(result.accepted).toEqual(['a@example.com', 'b@example.com']);
    expect(logger.lines).toHaveLength(2);
  });
});

describe('MemoryTransport', () => {
  it('keeps every message in send order', async () => {
    const transport = new MemoryTransport();

    await transport.send(outbound({ subject: 'One' }));
    await transport.send(outbound({ subject: 'Two' }));

    expect(transport.sent.map((m) => m.subject)).toEqual(['One', 'Two']);
    expect(transport.last?.subject).toBe('Two');
  });

  it('gives each message a distinct id', async () => {
    const transport = new MemoryTransport();

    const first = await transport.send(outbound());
    const second = await transport.send(outbound());

    expect(first.id).not.toBe(second.id);
  });

  it('finds messages by any recipient field', async () => {
    const transport = new MemoryTransport();
    await transport.send(outbound({ bcc: [{ address: 'audit@example.com' }] }));

    expect(transport.to('audit@example.com')).toHaveLength(1);
    expect(transport.to('nobody@example.com')).toHaveLength(0);
  });

  it('clears', async () => {
    const transport = new MemoryTransport();
    await transport.send(outbound());

    transport.clear();

    expect(transport.sent).toHaveLength(0);
    expect(transport.last).toBeUndefined();
  });
});

describe('UnconfiguredRenderer', () => {
  it('rejects with the fix rather than a type error', async () => {
    await expect(new UnconfiguredRenderer().render()).rejects.toThrow(
      EmailError,
    );
  });

  it('has no preview props', () => {
    expect(new UnconfiguredRenderer().previewProps(undefined)).toEqual({});
  });
});

describe('EmailSendError', () => {
  it('carries a 502 and names the transport', () => {
    const error = new EmailSendError('resend', 'rate_limit: slow down');

    expect(error.status).toBe(502);
    expect(error.name).toBe('EmailSendError');
    expect(error.message).toContain('resend refused the message');
  });
});

import { describe, expect, it } from 'bun:test';
import {
  handle,
  PROTOCOL_VERSION,
  serve,
  type ToolDefinition,
} from './protocol.js';

const INFO = { name: '@dunx/mcp', version: '0.0.0' };

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'echo',
    description: 'Returns what it was given.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    run: (args) => ({ echoed: args['value'] }),
  },
  {
    name: 'boom',
    description: 'Always throws.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      throw new Error('exploded');
    },
  },
];

const ask = async (
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1,
): Promise<Record<string, unknown>> => {
  const line = await handle(
    { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
    TOOLS,
    INFO,
  );
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
};

describe('the protocol subset', () => {
  it('answers initialize with a version and the tools capability', async () => {
    const result = (await ask('initialize'))['result'] as Record<
      string,
      unknown
    >;
    expect(result['protocolVersion']).toBe(PROTOCOL_VERSION);
    expect(result['capabilities']).toEqual({ tools: {} });
    expect(result['serverInfo']).toEqual(INFO);
  });

  it('lists tools without their implementations', async () => {
    const result = (await ask('tools/list'))['result'] as {
      tools: Record<string, unknown>[];
    };
    expect(result.tools.map((tool) => tool['name'])).toEqual(['echo', 'boom']);
    // `run` is not serialisable and is not part of the wire shape.
    for (const tool of result.tools) expect(tool).not.toHaveProperty('run');
  });

  it('calls a tool and returns its output as text content', async () => {
    const result = (
      await ask('tools/call', {
        name: 'echo',
        arguments: { value: 'hi' },
      })
    )['result'] as { content: { type: string; text: string }[] };

    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      echoed: 'hi',
    });
  });

  /*
   * A tool that throws is a result the model should see and can act on, not a
   * transport fault - so it comes back as `isError` content rather than a JSON-RPC
   * error, which a client would surface as a broken server.
   */
  it('reports a throwing tool as an error result, not an RPC error', async () => {
    const answer = await ask('tools/call', { name: 'boom' });
    expect(answer).not.toHaveProperty('error');
    const result = answer['result'] as { isError: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
  });

  it('rejects an unknown tool with invalid params', async () => {
    const error = (await ask('tools/call', { name: 'nope' }))['error'] as {
      code: number;
      message: string;
    };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('nope');
  });

  it('rejects an unsupported method', async () => {
    const error = (await ask('resources/list'))['error'] as { code: number };
    expect(error.code).toBe(-32601);
  });

  /*
   * A request with no `id` is a notification, and the spec says not to answer one.
   * `notifications/initialized` is the one every client sends right after
   * initialize; replying to it puts a response with `id: null` on the wire, which
   * some clients read as a protocol error.
   */
  it('stays silent on a notification', async () => {
    expect(
      await handle(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        TOOLS,
        INFO,
      ),
    ).toBeNull();
  });
});

describe('the stdio framing', () => {
  const streamOf = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

  it('answers each line of a batch in order', async () => {
    const written: string[] = [];
    await serve(
      streamOf(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n` +
          `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
      ),
      (line) => written.push(line),
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(2);
    expect(written.every((line) => line.endsWith('\n'))).toBe(true);
    expect(JSON.parse(written[1] ?? '{}')['id']).toBe(2);
  });

  /*
   * The reason the reader buffers instead of decoding per chunk: a chunk boundary
   * can land mid-message, and a half-parsed request cannot be recovered.
   */
  it('reassembles a message split across chunks', async () => {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
    });
    const written: string[] = [];

    await serve(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(message.slice(0, 12)));
          controller.enqueue(encoder.encode(`${message.slice(12)}\n`));
          controller.close();
        },
      }),
      (line) => written.push(line),
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(1);
    expect(JSON.parse(written[0] ?? '{}')['id']).toBe(7);
  });

  it('ignores an unparseable line rather than dying', async () => {
    const written: string[] = [];
    await serve(
      streamOf(
        `not json\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`,
      ),
      (line) => written.push(line),
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(1);
    expect(JSON.parse(written[0] ?? '{}')['id']).toBe(3);
  });
});

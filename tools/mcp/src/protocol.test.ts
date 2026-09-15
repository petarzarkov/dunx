import { describe, expect, it } from 'bun:test';
import {
  handle,
  PROTOCOL_VERSION,
  type ResourceDefinition,
  RpcError,
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
  it('answers initialize with a version and only the capabilities it serves', async () => {
    const result = (await ask('initialize'))['result'] as Record<
      string,
      unknown
    >;
    expect(result['protocolVersion']).toBe(PROTOCOL_VERSION);
    // No resources were given to this caller, so none are advertised. Claiming
    // them made a client expect documents that `resources/read` then refused.
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
    // `prompts/list` rather than `resources/list`, which this used to use and
    // which is now answered.
    const error = (await ask('prompts/list'))['error'] as { code: number };
    expect(error.code).toBe(-32601);
  });

  /*
   * `ping` is base protocol rather than part of any capability, so a server that
   * declares only `tools` still has to answer it - a client sends it to check the
   * connection is alive and reads a `-32601` as a dead server.
   */
  it('answers a ping with an empty result', async () => {
    const answer = await ask('ping');
    expect(answer['result']).toEqual({});
    expect(answer).not.toHaveProperty('error');
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
      (line) => {
        written.push(line);
      },
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
      (line) => {
        written.push(line);
      },
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(1);
    expect(JSON.parse(written[0] ?? '{}')['id']).toBe(7);
  });

  /*
   * A client that writes its last message and closes without a trailing newline
   * has still sent a complete request. Dropping it left the client waiting on an
   * answer that was never coming.
   */
  it('answers a final message with no trailing newline', async () => {
    const written: string[] = [];
    await serve(
      streamOf(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })),
      (line) => {
        written.push(line);
      },
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(1);
    expect(JSON.parse(written[0] ?? '{}')['id']).toBe(9);
  });

  it('answers an unparseable line and keeps reading the stream', async () => {
    const written: string[] = [];
    await serve(
      streamOf(
        `not json\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`,
      ),
      (line) => {
        written.push(line);
      },
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(2);
    const parseError = JSON.parse(written[0] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(parseError['id']).toBeNull();
    expect((parseError['error'] as Record<string, unknown>)['code']).toBe(
      RpcError.PARSE_ERROR,
    );
    // The line after the bad one is still answered.
    expect(JSON.parse(written[1] ?? '{}')['id']).toBe(3);
  });
});

/**
 * MCP 2025-06-18 removes JSON-RPC batching, its first listed major change, so an
 * array is not a request this server can answer. It used to fall through the
 * notification check, because an array has no `id`, and the client was left
 * waiting for a reply that was never coming.
 *
 * The other half is the two reserved codes that were never declared. A malformed
 * request has to be answered, and JSON-RPC 2.0 puts `id: null` on an answer whose
 * request had no readable id.
 */
describe('malformed input', () => {
  const answer = async (request: unknown): Promise<Record<string, unknown>> => {
    const line = await handle(request, TOOLS, INFO);
    return JSON.parse(line ?? 'null') as Record<string, unknown>;
  };

  const errorOf = (
    response: Record<string, unknown>,
  ): Record<string, unknown> => response['error'] as Record<string, unknown>;

  it('rejects a batch instead of dropping it', async () => {
    const response = await answer([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);

    expect(response).not.toBeNull();
    expect(response['id']).toBeNull();
    expect(errorOf(response)['code']).toBe(RpcError.INVALID_REQUEST);
    expect(String(errorOf(response)['message'])).toMatch(/batch/i);
  });

  it('rejects an empty batch', async () => {
    expect(errorOf(await answer([]))['code']).toBe(RpcError.INVALID_REQUEST);
  });

  it('rejects a request that is not an object', async () => {
    for (const value of [42, 'ping', null, true]) {
      const response = await answer(value);
      expect(response['id']).toBeNull();
      expect(errorOf(response)['code']).toBe(RpcError.INVALID_REQUEST);
    }
  });

  it('rejects a request with no method, keeping a readable id', async () => {
    const response = await answer({ jsonrpc: '2.0', id: 4 });
    expect(response['id']).toBe(4);
    expect(errorOf(response)['code']).toBe(RpcError.INVALID_REQUEST);
  });

  it('still answers nothing to a notification', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'ping' }, TOOLS, INFO)).toBe(
      null,
    );
  });

  it('answers an unparseable line with a parse error', async () => {
    const written: string[] = [];
    await serve(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('not json\n'));
          controller.close();
        },
      }),
      (line) => {
        written.push(line);
      },
      TOOLS,
      INFO,
    );

    expect(written.length).toBe(1);
    const response = JSON.parse(written[0] ?? '{}') as Record<string, unknown>;
    expect(response['id']).toBeNull();
    expect(errorOf(response)['code']).toBe(RpcError.PARSE_ERROR);
  });
});

const RESOURCES: readonly ResourceDefinition[] = [
  {
    uri: 'dunx://guide/01-introduction',
    name: 'Introduction',
    description: 'What dunx is.',
    mimeType: 'text/markdown',
    read: () => '# Introduction\n',
  },
];

/**
 * Resources are the half `handle` takes as an optional argument, so a caller that
 * serves none - and every caller before this existed - keeps working unchanged.
 */
describe('resources', () => {
  const askFor = async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const line = await handle(
      { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
      TOOLS,
      INFO,
      RESOURCES,
    );
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  };

  it('is advertised at initialize once resources are served', async () => {
    const line = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      TOOLS,
      INFO,
      RESOURCES,
    );
    const parsed = JSON.parse(line ?? '{}') as {
      result: { capabilities: unknown };
    };
    expect(parsed.result.capabilities).toEqual({ tools: {}, resources: {} });
  });

  it('lists them without their readers', async () => {
    const { resources } = (await askFor('resources/list'))['result'] as {
      resources: Record<string, unknown>[];
    };
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({
      uri: 'dunx://guide/01-introduction',
      name: 'Introduction',
      description: 'What dunx is.',
      mimeType: 'text/markdown',
    });
    expect(resources[0]).not.toHaveProperty('read');
  });

  it('lists none when the caller serves none', async () => {
    const line = await handle(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      TOOLS,
      INFO,
    );
    const parsed = JSON.parse(line ?? '{}') as {
      result: { resources: unknown[] };
    };
    expect(parsed.result.resources).toEqual([]);
  });

  it('reads one by uri', async () => {
    const { contents } = (
      await askFor('resources/read', { uri: 'dunx://guide/01-introduction' })
    )['result'] as { contents: Record<string, unknown>[] };
    expect(contents[0]).toEqual({
      uri: 'dunx://guide/01-introduction',
      mimeType: 'text/markdown',
      text: '# Introduction\n',
    });
  });

  /**
   * The guide's own chapter links carry `#section`, and an exact-match-only
   * lookup answered `Unknown resource` for every one of them.
   */
  it('reads one by a uri carrying a fragment', async () => {
    const { contents } = (
      await askFor('resources/read', {
        uri: 'dunx://guide/01-introduction#what-it-is-built-on',
      })
    )['result'] as { contents: Record<string, unknown>[] };
    // The canonical uri comes back, not the one with the fragment on it.
    expect(contents[0]?.['uri']).toBe('dunx://guide/01-introduction');
    expect(contents[0]?.['text']).toBe('# Introduction\n');
  });

  it('still rejects a fragment on a uri that names no resource', async () => {
    const error = (
      await askFor('resources/read', { uri: 'dunx://guide/nope#anything' })
    )['error'] as { code: number };
    expect(error.code).toBe(RpcError.INVALID_PARAMS);
  });

  it('rejects an unknown uri as invalid params, naming it', async () => {
    const error = (
      await askFor('resources/read', { uri: 'dunx://guide/nope' })
    )['error'] as { code: number; message: string };
    expect(error.code).toBe(RpcError.INVALID_PARAMS);
    expect(error.message).toContain('dunx://guide/nope');
  });

  /**
   * Declaring the `resources` capability is what makes a client ask. Left to
   * `-32601`, several log the method-not-found as a broken server.
   */
  it('answers the template listing with an empty one', async () => {
    expect((await askFor('resources/templates/list'))['result']).toEqual({
      resourceTemplates: [],
    });
  });
});

/**
 * The server declares `additionalProperties: false` on every tool `schema()`
 * builds, and used to read the keys it recognised and drop the rest. So a caller
 * that guessed a name got an answer to a question it had not asked: the fourteen
 * descriptions naming a "chapter" make `{ chapter: '06-validation' }` the obvious
 * call, `dunx_guide`'s parameter is `topic`, and the unrecognised key fell through
 * to the no-argument branch and returned the whole 17 KB index.
 *
 * That is the silent `undefined` `@dunx/transform` refuses to ship for an erased
 * constructor parameter, living in the server that documents the rule.
 */
describe('arguments the tool did not declare', () => {
  const STRICT: readonly ToolDefinition[] = [
    {
      name: 'chapter',
      description: 'Takes one optional string.',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' }, full: { type: 'boolean' } },
        additionalProperties: false,
      },
      run: (args) => ({ topic: args['topic'] ?? null }),
    },
    {
      name: 'open',
      description: 'Declares no properties and no ban on extras.',
      inputSchema: { type: 'object', properties: {} },
      run: () => ({ ok: true }),
    },
  ];

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const line = await handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      STRICT,
      INFO,
    );
    return (JSON.parse(line ?? '{}') as { result: Record<string, unknown> })
      .result;
  };

  const textOf = (result: Record<string, unknown>): string =>
    (result['content'] as { text: string }[])[0]?.text ?? '';

  it('refuses a key it never declared, and names the ones it did', async () => {
    const result = await call('chapter', { chapter: '06-validation' });
    expect(result['isError']).toBe(true);
    expect(textOf(result)).toContain('chapter');
    expect(textOf(result)).toContain('topic');
    expect(textOf(result)).toContain('full');
  });

  it('refuses a declared key carrying the wrong type', async () => {
    const result = await call('chapter', { topic: 42 });
    expect(result['isError']).toBe(true);
    expect(textOf(result)).toContain('topic');
    expect(textOf(result)).toContain('string');
  });

  it('still answers a call that uses the declared keys', async () => {
    const result = await call('chapter', { topic: '06-validation' });
    expect(result['isError']).toBeUndefined();
    expect(textOf(result)).toContain('06-validation');
  });

  /**
   * JSON has no `undefined`, so a client serialising an omitted optional filter
   * sends `null` and means "no filter". `Args.text` already read that as absent;
   * refusing it here would have failed calls that worked before this check.
   */
  it('reads an explicit null as the absent filter it means', async () => {
    const result = await call('chapter', { topic: null });
    expect(result['isError']).toBeUndefined();
    expect(textOf(result)).toContain('null');
  });

  /**
   * Absent to `run` as well, not merely read as absent. `args['topic'] ?? null`
   * cannot tell the two apart, so this asks the tool which keys it was handed.
   */
  it('hands run a record with the null key gone, not present and null', async () => {
    const keysSeen: string[][] = [];
    const line = await handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'keys', arguments: { topic: null } },
      },
      [
        {
          name: 'keys',
          description: 'Reports the argument keys it was handed.',
          inputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            additionalProperties: false,
          },
          run: (args) => {
            keysSeen.push(Object.keys(args));
            return { keys: Object.keys(args) };
          },
        },
      ],
      INFO,
    );

    expect(line).toBeTruthy();
    expect(keysSeen[0]).toEqual([]);
  });

  /** The ban is the schema's to declare, so a tool that does not ban stays open. */
  it('leaves a tool that declared no ban permissive', async () => {
    const result = await call('open', { whatever: 1 });
    expect(result['isError']).toBeUndefined();
  });

  /**
   * JSON Schema separates `integer` from `number` and JSON does not. `schema()`
   * builds neither today, but `inputSchema` is a free-form record, and comparing
   * `typeof` against the declared name alone refused every valid call to a tool
   * that declared one.
   */
  describe('a declared integer', () => {
    const WITH_INTEGER: readonly ToolDefinition[] = [
      {
        name: 'page',
        description: 'Takes a whole number.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer' } },
          additionalProperties: false,
        },
        run: (args) => ({ limit: args['limit'] }),
      },
    ];

    const ask = async (args: Record<string, unknown>) => {
      const line = await handle(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'page', arguments: args },
        },
        WITH_INTEGER,
        INFO,
      );
      return (JSON.parse(line ?? '{}') as { result: Record<string, unknown> })
        .result;
    };

    it('accepts a whole number', async () => {
      expect((await ask({ limit: 25 }))['isError']).toBeUndefined();
    });

    it('refuses a fractional one, and says which type it wanted', async () => {
      const result = await ask({ limit: 2.5 });
      expect(result['isError']).toBe(true);
      expect(
        (result['content'] as { text: string }[])[0]?.text ?? '',
      ).toContain('integer');
    });

    it('refuses a string', async () => {
      expect((await ask({ limit: '25' }))['isError']).toBe(true);
    });
  });
});

/**
 * `arguments` is whatever the client put on the wire. A number, a boolean and an
 * array all survive `?? {}`, and `run` would then read keys off a value its
 * `Record<string, unknown>` contract says it never receives: every key is
 * `undefined`, so the call quietly becomes the no-argument one. That is the miss
 * the schema check exists to stop, arriving one level higher up.
 */
describe('arguments that are not an object at all', () => {
  const TOOL: readonly ToolDefinition[] = [
    {
      name: 'echo',
      description: 'Takes one optional string.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
      run: (args) => ({ value: args['value'] ?? null }),
    },
  ];

  const send = async (args: unknown): Promise<Record<string, unknown>> => {
    const line = await handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: args } as Record<string, unknown>,
      },
      TOOL,
      INFO,
    );
    return (JSON.parse(line ?? '{}') as { result: Record<string, unknown> })
      .result;
  };

  for (const [label, value] of [
    ['a number', 7],
    ['a boolean', true],
    ['an array', ['value']],
    ['a string', 'value'],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const result = await send(value);
      expect(result['isError']).toBe(true);
      expect(
        (result['content'] as { text: string }[])[0]?.text ?? '',
      ).toContain('must be an object');
    });
  }

  /** Absent and null both mean the tool was called with nothing, which is allowed. */
  for (const [label, value] of [
    ['omitted', undefined],
    ['null', null],
  ] as const) {
    it(`treats ${label} arguments as none`, async () => {
      const result = await send(value);
      expect(result['isError']).toBeUndefined();
    });
  }
});

/**
 * `structuredContent` arrived in 2025-06-18, the version this server speaks. Every
 * tool here already returns an object and then serialises it, so a client was made
 * to parse a string back into the object the server had in hand. The text block
 * stays beside it: the spec keeps it for backwards compatibility, and a client that
 * only renders text is still the common case.
 */
describe('structured tool results', () => {
  const resultOf = async (
    tools: readonly ToolDefinition[],
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const line = await handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      tools,
      INFO,
    );
    return (JSON.parse(line ?? '{}') as { result: Record<string, unknown> })
      .result;
  };

  it('returns the object alongside the text, not instead of it', async () => {
    const result = await resultOf(TOOLS, 'echo', { value: 'hi' });
    expect(result['structuredContent']).toEqual({ echoed: 'hi' });
    expect(result['content']).toEqual([
      { type: 'text', text: JSON.stringify({ echoed: 'hi' }, null, 2) },
    ]);
  });

  /** A tool answering with something other than an object has nothing to put there. */
  it('omits it when the tool did not return an object', async () => {
    const result = await resultOf(
      [
        {
          name: 'scalar',
          description: 'Answers with a string.',
          inputSchema: { type: 'object', properties: {} },
          run: () => 'just text',
        },
      ],
      'scalar',
    );
    expect(result['structuredContent']).toBeUndefined();
    expect(result['content']).toEqual([{ type: 'text', text: '"just text"' }]);
  });
});

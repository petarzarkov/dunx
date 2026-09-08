/**
 * The slice of the Model Context Protocol a read-only server needs: `initialize`,
 * `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, and the
 * notification after initialize.
 *
 * Hand-written rather than `@modelcontextprotocol/sdk`: this is newline-delimited
 * JSON-RPC 2.0 with a handful of methods, and staying dependency-free is what lets
 * `bunx @dunx/mcp` resolve nothing.
 *
 * Resources were the case the earlier note here said to take the SDK for. They cost
 * two more methods of the same shape, so they did not pay for a dependency. What
 * still would: sampling, elicitation, progress, or a transport that is not stdio -
 * each of those is a session and a lifetime rather than another request/response.
 */
export const PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Sync or async - `unknown` covers a promise, and the caller awaits either. */
  readonly run: (args: Record<string, unknown>) => unknown;
}

/**
 * A document a client can attach without calling a tool. Everything served this way
 * is also reachable through a tool, because a client that supports only tools is
 * still the common case.
 */
export interface ResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  readonly read: () => string;
}

/** JSON-RPC error codes this server can raise. */
export const RpcError = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const);
export type RpcError = (typeof RpcError)[keyof typeof RpcError];

const reply = (id: JsonRpcRequest['id'], result: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;

const fail = (
  id: JsonRpcRequest['id'],
  code: RpcError,
  message: string,
): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`;

/** An id is echoed back only if it is one JSON-RPC allows; otherwise `null`. */
const readableId = (value: unknown): JsonRpcRequest['id'] =>
  typeof value === 'string' || typeof value === 'number' ? value : null;

/**
 * The answer to something that is not a request, or `null` when it is one worth
 * attempting.
 *
 * MCP removed JSON-RPC batching in 2025-06-18, its first listed major change, so
 * an array is rejected rather than answered. It used to reach the notification
 * check below, which an array passes because it has no `id`, so the client was
 * left waiting on a reply that was never sent.
 */
const rejection = (request: unknown): string | null => {
  if (Array.isArray(request)) {
    return fail(
      null,
      RpcError.INVALID_REQUEST,
      `Batch requests are not supported: MCP removed JSON-RPC batching in ${PROTOCOL_VERSION}. Send one request per line.`,
    );
  }

  if (typeof request !== 'object' || request === null) {
    return fail(
      null,
      RpcError.INVALID_REQUEST,
      `Request must be a JSON object, received ${typeof request}.`,
    );
  }

  if (typeof (request as { method?: unknown }).method !== 'string') {
    return fail(
      readableId((request as { id?: unknown }).id),
      RpcError.INVALID_REQUEST,
      'Request has no method.',
    );
  }

  return null;
};

/**
 * One request in, one line of response out, or `null` for a notification.
 *
 * A notification is a request with no `id`, and the spec says not to answer one -
 * `notifications/initialized` is the one this server sees. Answering it puts a
 * response with `id: null` on the wire, which some clients treat as a protocol
 * error.
 *
 * Anything that is not a request at all is answered rather than dropped, because
 * a client with an outstanding id waits indefinitely for silence. See
 * {@link rejection}.
 */
export const handle = async (
  request: unknown,
  tools: readonly ToolDefinition[],
  serverInfo: { name: string; version: string },
  resources: readonly ResourceDefinition[] = [],
): Promise<string | null> => {
  const rejected = rejection(request);
  if (rejected !== null) return rejected;

  const call = request as JsonRpcRequest;
  if (call.id === undefined) return null;

  if (call.method === 'initialize') {
    return reply(call.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo,
    });
  }

  /**
   * Part of the base protocol, not of any capability, so a server that declares
   * only `tools` still has to answer it - a client uses it to check the connection
   * is alive and reads `-32601` as a dead server. The result is defined as an empty
   * object.
   */
  if (call.method === 'ping') return reply(call.id, {});

  if (call.method === 'tools/list') {
    return reply(call.id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }

  if (call.method === 'resources/list') {
    return reply(call.id, {
      resources: resources.map(({ uri, name, description, mimeType }) => ({
        uri,
        name,
        description,
        mimeType,
      })),
    });
  }

  /**
   * Answered rather than left to `-32601`, because declaring the `resources`
   * capability is what makes a client ask: several call this immediately after
   * `resources/list` and log the method-not-found as a broken server.
   */
  if (call.method === 'resources/templates/list') {
    return reply(call.id, { resourceTemplates: [] });
  }

  if (call.method === 'resources/read') {
    const uri = call.params?.['uri'];
    const resource = resources.find((candidate) => candidate.uri === uri);
    if (!resource) {
      return fail(
        call.id,
        RpcError.INVALID_PARAMS,
        `Unknown resource: ${String(uri)}`,
      );
    }
    return reply(call.id, {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.read(),
        },
      ],
    });
  }

  if (call.method === 'tools/call') {
    const name = call.params?.['name'];
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return fail(
        call.id,
        RpcError.INVALID_PARAMS,
        `Unknown tool: ${String(name)}`,
      );
    }

    try {
      const args = (call.params?.['arguments'] ?? {}) as Record<
        string,
        unknown
      >;
      const output = await tool.run(args);
      // Text content holding JSON, which is what a client can both show and parse.
      return reply(call.id, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      });
    } catch (error) {
      // Reported as a tool result rather than an RPC error: the call reached the
      // tool and the tool failed, which is something the model should see and can
      // act on, not a transport fault.
      return reply(call.id, {
        isError: true,
        content: [{ type: 'text', text: String(error) }],
      });
    }
  }

  return fail(
    call.id,
    RpcError.METHOD_NOT_FOUND,
    `Unsupported method: ${call.method}`,
  );
};

/**
 * Reads newline-delimited JSON-RPC from a stream and writes the answers back.
 *
 * Buffered rather than read line by line, because a chunk boundary can land in
 * the middle of a message and a half-parsed request is not recoverable.
 */
export const serve = async (
  input: ReadableStream<Uint8Array>,
  /**
   * Allowed to be async, and awaited, because a real sink's flush is: Bun's
   * `FileSink.flush()` can return a promise, and not awaiting it risks the last
   * answer sitting in this process while the client waits for it.
   */
  write: (line: string) => void | Promise<void>,
  tools: readonly ToolDefinition[],
  serverInfo: { name: string; version: string },
  resources: readonly ResourceDefinition[] = [],
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = async (line: string): Promise<void> => {
    if (line === '') return;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      // No id is readable, so JSON-RPC 2.0 puts `null` on the answer. Writing one
      // at all is the point: staying silent left a client that had sent an id
      // waiting on a reply forever, and stdout is the protocol channel so there
      // is nowhere else to report it.
      await write(
        fail(null, RpcError.PARSE_ERROR, 'Request line is not valid JSON.'),
      );
      return;
    }
    const answer = await handle(request, tools, serverInfo, resources);
    if (answer !== null) await write(answer);
  };

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      await dispatch(line);
    }
  }

  // A client that writes a final message and closes without a trailing newline
  // has still sent a complete request. Without this it is silently dropped and
  // the client waits for an answer that is never coming; an incomplete fragment
  // fails to parse and is discarded exactly as it would be mid-stream.
  await dispatch(buffer.trim());
};

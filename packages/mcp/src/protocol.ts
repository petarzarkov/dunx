/**
 * The slice of the Model Context Protocol a read-only tool server needs:
 * `initialize`, `tools/list`, `tools/call`, and the notification that follows
 * initialize.
 *
 * Hand-written rather than taken from `@modelcontextprotocol/sdk`, which is the
 * one place in dunx where "never invent what a mature library solves" does not
 * apply: this is newline-delimited JSON-RPC 2.0 with three methods, fully
 * specified, and about sixty lines. The rule exists for ORMs, validators, auth
 * flows and job queues - years of edge cases - not for a framing loop. Keeping it
 * dependency-free is also what lets `bunx @dunx/mcp` resolve nothing at all.
 *
 * If this server ever grows resources, prompts, sampling or progress
 * notifications, take the SDK: at that point the protocol surface stops being
 * something worth hand-holding.
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
  readonly run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** JSON-RPC error codes this server can raise. */
export const RpcError = Object.freeze({
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

/**
 * One request in, one line of response out, or `null` for a notification.
 *
 * A notification is a request with no `id`, and the spec says not to answer one -
 * `notifications/initialized` is the one this server sees. Answering it puts a
 * response with `id: null` on the wire, which some clients treat as a protocol
 * error.
 */
export const handle = async (
  request: JsonRpcRequest,
  tools: readonly ToolDefinition[],
  serverInfo: { name: string; version: string },
): Promise<string | null> => {
  if (request.id === undefined) return null;

  if (request.method === 'initialize') {
    return reply(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo,
    });
  }

  if (request.method === 'tools/list') {
    return reply(request.id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }

  if (request.method === 'tools/call') {
    const name = request.params?.['name'];
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return fail(
        request.id,
        RpcError.INVALID_PARAMS,
        `Unknown tool: ${String(name)}`,
      );
    }

    try {
      const args = (request.params?.['arguments'] ?? {}) as Record<
        string,
        unknown
      >;
      const output = await tool.run(args);
      // Text content holding JSON, which is what a client can both show and parse.
      return reply(request.id, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      });
    } catch (error) {
      // Reported as a tool result rather than an RPC error: the call reached the
      // tool and the tool failed, which is something the model should see and can
      // act on, not a transport fault.
      return reply(request.id, {
        isError: true,
        content: [{ type: 'text', text: String(error) }],
      });
    }
  }

  return fail(
    request.id,
    RpcError.METHOD_NOT_FOUND,
    `Unsupported method: ${request.method}`,
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
  write: (line: string) => void,
  tools: readonly ToolDefinition[],
  serverInfo: { name: string; version: string },
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line === '') continue;
      try {
        const answer = await handle(
          JSON.parse(line) as JsonRpcRequest,
          tools,
          serverInfo,
        );
        if (answer !== null) write(answer);
      } catch {
        // Unparseable input has no id to answer against, so there is nothing to
        // reply to and nowhere to log: stdout is the protocol channel.
      }
    }
  }
};

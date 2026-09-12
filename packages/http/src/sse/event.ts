/**
 * One server-sent event. Every field is optional: a frame carrying only `retry`
 * changes the client's reconnection delay, and one carrying only `event` fires a
 * named event with no payload.
 */
export interface SseEvent {
  /**
   * Sent as it is when it is a string, and through `JSON.stringify` otherwise. A
   * value spanning several lines becomes one `data:` line each.
   */
  readonly data?: unknown;
  /** The `event:` name the client listens for. Absent dispatches `message`. */
  readonly event?: string;
  /** Sent back as `Last-Event-ID` on the client's next connection. */
  readonly id?: string;
  /** Milliseconds the client waits before reconnecting, truncated to an integer. */
  readonly retry?: number;
}

// `\r\n` and a bare `\r` end a line for an SSE parser as much as `\n` does, so
// splitting on `\n` alone leaves a `\r` inside the value.
const lines = (value: string): readonly string[] => value.split(/\r\n|\r|\n/);

// A line break in an `event` name or an `id` would end the field and let the rest
// be read as another one, so a field that cannot repeat keeps its first line.
const oneLine = (value: string): string => lines(value)[0] ?? '';

/** `event`, framed, ending with the blank line that dispatches it. */
export const frameEvent = (event: SseEvent): string => {
  const fields: string[] = [];
  if (event.event !== undefined) fields.push(`event: ${oneLine(event.event)}`);
  if (event.id !== undefined) fields.push(`id: ${oneLine(event.id)}`);
  if (event.retry !== undefined) {
    fields.push(`retry: ${Math.trunc(event.retry)}`);
  }
  if (event.data !== undefined) {
    const data =
      typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    for (const line of lines(data ?? '')) fields.push(`data: ${line}`);
  }
  return `${fields.join('\n')}\n\n`;
};

/** A comment line: bytes on the wire that dispatch nothing, which is a heartbeat. */
export const frameComment = (text: string): string =>
  `${lines(text)
    .map((line) => `:${line}`)
    .join('\n')}\n\n`;

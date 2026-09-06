/**
 * A real `new WebSocket()` against the chat gateway, with a deadline so a stall
 * fails instead of hanging.
 *
 * Shared rather than copied: both relay demos and the soak workload open sockets
 * the same way, and a second copy of the frame-queue handling is where the two
 * would drift.
 */
export interface Client {
  next(): Promise<string>;
  send(event: string, data: unknown): void;
  close(): void;
  /** Every frame this socket ever received, so a *second* delivery is visible. */
  readonly received: readonly string[];
}

/** A real `new WebSocket()`, with a deadline so a stall fails instead of hanging. */
export const connect = async (base: string): Promise<Client> => {
  const socket = new WebSocket(
    new URL('chat', base).href.replace('http', 'ws'),
  );
  const frames: string[] = [];
  const received: string[] = [];
  const waiting: ((frame: string) => void)[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = String(event.data);
    received.push(frame);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    setTimeout(() => reject(new Error('the socket never opened')), 2000);
  });

  return {
    next: () =>
      new Promise<string>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('no frame arrived')),
          2000,
        );
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    send: (event, data) => socket.send(JSON.stringify({ event, data })),
    close: () => socket.close(),
    received,
  };
};

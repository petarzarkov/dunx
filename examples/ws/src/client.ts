export interface Client {
  readonly name: string;
  send(frame: string): void;
  event(event: string, data?: unknown): void;
  /** Rejects rather than blocking forever, so a broken run fails instead of hanging. */
  next(ms?: number): Promise<string>;
  close(): void;
}

/** A real `new WebSocket()`, with a queue so no frame is missed between awaits. */
export const connect = async (
  url: string,
  name: string,
  ms = 3000,
): Promise<Client> => {
  const socket = new WebSocket(url);
  const frames: string[] = [];
  const waiting: ((frame: string) => void)[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = String(event.data);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} never connected to ${url}`)),
      ms,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`${name} failed to connect to ${url}`));
      },
      { once: true },
    );
  });

  return {
    name,
    send: (frame) => socket.send(frame),
    event: (event, data) => socket.send(JSON.stringify({ event, data })),
    next: (timeout = ms) =>
      new Promise<string>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`${name} waited ${timeout}ms for a frame`)),
          timeout,
        );
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    close: () => socket.close(),
  };
};

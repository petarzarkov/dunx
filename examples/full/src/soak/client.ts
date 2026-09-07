/** What an op hands the client. A subset of `RequestInit`, so the spread stays typed. */
export interface CallInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Every call gets this long before the client gives up and reports the route. */
const DEADLINE_MS = 10_000;

/**
 * One virtual user against the app under load, with its own api key so the
 * throttle counts it apart. `call` returns the status rather than throwing on
 * one: an unexpected status is a result to classify, not a transport failure.
 * See docs/architecture/tooling.md, "The load run measured the rate limiter".
 */
export class OpClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  async call(path: string, init: CallInit = {}): Promise<number> {
    // Without a deadline a hung route parks its worker for the whole run, so the
    // load quietly loses concurrency instead of reporting what stopped answering.
    const res = await fetch(new URL(path, this.base), {
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: { ...init.headers, 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    // The body must be drained or the socket is held until GC.
    await res.arrayBuffer();
    return res.status;
  }

  /** A JSON body, which is three lines at every call site otherwise. */
  json(path: string, body: unknown, method = 'POST'): Promise<number> {
    return this.call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Opens, exchanges a frame and closes. `abort` sends no close frame, which is
   * the half a clean-close-only cleanup path misses.
   */
  async socket(path: string, abort: boolean): Promise<number> {
    const url = new URL(path, this.base).href.replace('http', 'ws');
    const socket = new WebSocket(url);
    await OpClient.#opened(socket);
    if (abort) {
      socket.terminate?.();
      socket.close();
      return 200;
    }
    socket.send(JSON.stringify({ event: 'say', data: 'soak' }));
    await Bun.sleep(5);
    socket.close();
    return 200;
  }

  static #opened(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('socket never opened')),
        4000,
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
          reject(new Error('socket errored'));
        },
        { once: true },
      );
    });
  }
}

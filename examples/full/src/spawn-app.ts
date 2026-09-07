/** What `main.ts` prints once every listener is bound. */
const READY = 'ctrl-c to stop';
const APP_DIR = new URL('..', import.meta.url).pathname;

const spawn = (env: Record<string, string>) =>
  Bun.spawn(['bun', 'src/main.ts'], {
    cwd: APP_DIR,
    // Port 0 so a suite cannot collide with a real `bun start` on 3000.
    env: { ...process.env, NODE_ENV: 'production', PORT: '0', ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });

/**
 * `bun src/main.ts` in a process of its own, for the two things an in-process
 * `createApp()` cannot show: that a service stays up until a signal, and that
 * a library reads the real `NODE_ENV` rather than the one `bun test` set.
 */
export class SpawnedApp {
  readonly #proc: ReturnType<typeof spawn>;
  readonly #reading: Promise<void>;
  #text = '';

  constructor(env: Record<string, string> = {}) {
    const proc = spawn(env);
    this.#proc = proc;
    const decoder = new TextDecoder();
    this.#reading = (async () => {
      for await (const chunk of proc.stdout) {
        this.#text += decoder.decode(chunk, { stream: true });
      }
    })();
  }

  /** Everything the app has written so far. */
  get output(): string {
    return this.#text;
  }

  get killed(): boolean {
    return this.#proc.killed;
  }

  /**
   * The url it is serving on, once it is. A boot that dies first throws rather
   * than waiting for a readiness line that is never coming: 271 ms, against the
   * suite's own timeout. Its error is on inherited stderr, beside this one.
   */
  async serving(): Promise<string> {
    while (!this.#text.includes(READY)) {
      const code = await Promise.race([
        this.#proc.exited,
        Bun.sleep(20).then(() => undefined),
      ]);
      if (code !== undefined) {
        await this.#reading;
        throw new Error(
          `the app exited with ${code} before serving:\n${this.#text}`,
        );
      }
    }
    const url = /listening on (http:\/\/[^\s"]+)/.exec(this.#text)?.[1];
    if (url === undefined) {
      throw new Error(`the app is serving but printed no url:\n${this.#text}`);
    }
    return url;
  }

  /** SIGTERM, then the exit code once the output has drained. */
  async stop(): Promise<number> {
    this.#proc.kill('SIGTERM');
    const code = await this.#proc.exited;
    await this.#reading;
    return code;
  }

  kill(): void {
    if (!this.#proc.killed) this.#proc.kill('SIGKILL');
  }
}

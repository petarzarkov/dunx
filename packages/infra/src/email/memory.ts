import {
  everyRecipient,
  type EmailResult,
  type OutboundEmail,
} from './message.js';
import { EmailTransport } from './transport.js';

/**
 * Keeps every message instead of sending it, so a suite can assert what would
 * have gone out.
 *
 * It lives here rather than in `@dunx/testing` because that package's peers are
 * `@dunx/core` and `@dunx/http`, and a transport has to extend
 * {@link EmailTransport}: shipping it there would make `@dunx/infra` a peer of
 * the test harness for one class. The same reasoning already put
 * `MemoryCacheStore` and `LocalStorage` in the package that owns the contract.
 *
 * ```ts
 * const transport = new MemoryTransport();
 * const app = await createTestApp({
 *   modules: [EmailModule.forRoot({ transport, from: 'ops@example.com' })],
 * });
 * expect(transport.last?.subject).toBe('Welcome');
 * ```
 */
export class MemoryTransport extends EmailTransport {
  readonly name = 'memory';
  readonly #sent: OutboundEmail[] = [];
  #nextId = 0;

  /** In send order. */
  get sent(): readonly OutboundEmail[] {
    return this.#sent;
  }

  get last(): OutboundEmail | undefined {
    return this.#sent.at(-1);
  }

  /** Every message addressed to `address`, on any of `to`, `cc` or `bcc`. */
  to(address: string): readonly OutboundEmail[] {
    return this.#sent.filter((m) => everyRecipient(m).includes(address));
  }

  clear(): void {
    this.#sent.length = 0;
  }

  /** Nothing to reach, so a suite's readiness probe answers up. */
  override verify(): Promise<void> {
    return Promise.resolve();
  }

  send(message: OutboundEmail): Promise<EmailResult> {
    this.#sent.push(message);
    this.#nextId += 1;
    return Promise.resolve({
      id: `memory-${this.#nextId}`,
      accepted: everyRecipient(message),
      rejected: [],
      transport: this.name,
    });
  }
}

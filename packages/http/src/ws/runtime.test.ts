import { describe, expect, it } from 'bun:test';
import { Gateway, OnMessage, OnOpen } from './decorators.js';
import { discoverGateway } from './discover.js';
import { buildGateways, buildRuntime } from './runtime.js';

const runtimeOf = (instance: object) => buildRuntime(discoverGateway(instance));

describe('buildRuntime()', () => {
  it('indexes named events and keeps the raw handler apart', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnMessage('send') send(): string {
        return 'send';
      }
      @OnMessage('typing') typing(): string {
        return 'typing';
      }
      @OnMessage() raw(): string {
        return 'raw';
      }
      @OnOpen() opened(): string {
        return 'opened';
      }
    }

    const runtime = runtimeOf(new ChatGateway());

    expect([...runtime.events.keys()].sort()).toEqual(['send', 'typing']);
    expect(runtime.raw?.()).toBe('raw');
    expect(runtime.open?.()).toBe('opened');
    expect(runtime.close).toBeUndefined();
    expect(runtime.drain).toBeUndefined();
  });

  it('throws on two handlers claiming one event, naming both', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnMessage('send') send(): string {
        return 'send';
      }
      @OnMessage('send') sendAgain(): string {
        return 'again';
      }
    }

    expect(() => runtimeOf(new ChatGateway())).toThrow(
      'Handler collision in ChatGateway: message "send" is claimed by send() and by sendAgain()',
    );
  });

  it('throws on two handlers claiming one lifecycle slot', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnOpen() first(): string {
        return 'first';
      }
      @OnOpen() second(): string {
        return 'second';
      }
    }

    expect(() => runtimeOf(new ChatGateway())).toThrow(
      'Handler collision in ChatGateway: open is claimed by first() and by second()',
    );
  });

  it('lets a subclass claim a base event under a different method name only once', () => {
    @Gateway('/base')
    abstract class BaseGateway {
      @OnMessage('send') send(): string {
        return 'base';
      }
    }

    @Gateway('/chat')
    class ChatGateway extends BaseGateway {
      @OnMessage('send') sendOverride(): string {
        return 'override';
      }
    }

    expect(() => runtimeOf(new ChatGateway())).toThrow(
      'message "send" is claimed by sendOverride() and by send()',
    );
  });

  it('throws for a gateway with no handlers at all', () => {
    @Gateway('/empty')
    class EmptyGateway {}

    expect(() => runtimeOf(new EmptyGateway())).toThrow(
      'EmptyGateway is registered as a gateway but declares no handlers',
    );
  });
});

describe('buildGateways()', () => {
  it('throws when two gateways share a path, naming both', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnMessage() raw(): string {
        return 'raw';
      }
    }

    @Gateway('chat/')
    class OtherGateway {
      @OnMessage() raw(): string {
        return 'raw';
      }
    }

    expect(() =>
      buildGateways([
        discoverGateway(new ChatGateway()),
        discoverGateway(new OtherGateway()),
      ]),
    ).toThrow(
      'Gateway path collision: /chat is served by ChatGateway and by OtherGateway',
    );
  });

  it('keeps two gateways on different paths apart', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnMessage() raw(): string {
        return 'raw';
      }
    }

    @Gateway('/feed')
    class FeedGateway {
      @OnMessage() raw(): string {
        return 'raw';
      }
    }

    const byPath = buildGateways([
      discoverGateway(new ChatGateway()),
      discoverGateway(new FeedGateway()),
    ]);

    expect([...byPath.keys()]).toEqual(['/chat', '/feed']);
  });

  // An app with only controllers is the common case, so no gateways is not an
  // error — it is what makes `listen()` skip the websocket half entirely.
  it('accepts an app with no gateways at all', () => {
    expect(buildGateways([]).size).toBe(0);
  });
});

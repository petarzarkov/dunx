import { describe, expect, it } from 'bun:test';
import {
  Gateway,
  OnClose,
  OnDrain,
  OnMessage,
  OnOpen,
  OnPing,
  OnPong,
  OnUpgrade,
} from './decorators.js';
import { discoverGateway, normalizePath } from './discover.js';

@Gateway('base')
abstract class BaseGateway {
  @OnMessage('base.ping')
  ping(): string {
    return 'base.ping';
  }

  @OnOpen()
  opened(): string {
    return 'base.opened';
  }
}

@Gateway('chat')
class ChatGateway extends BaseGateway {
  @OnMessage('chat.send')
  send(): string {
    return 'chat.send';
  }
}

class InheritedPathGateway extends BaseGateway {}

@Gateway('ov')
class OverridingGateway extends BaseGateway {
  override opened(): string {
    return 'override.opened';
  }
}

const slotsOf = (instance: object): string[] =>
  discoverGateway(instance)
    .handlers.map((handler) =>
      handler.event === undefined
        ? handler.kind
        : `${handler.kind} ${handler.event}`,
    )
    .sort();

describe('normalizePath()', () => {
  it('normalizes into one leading-slash path', () => {
    expect(normalizePath('chat')).toBe('/chat');
    expect(normalizePath('/chat/')).toBe('/chat');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('a//b//')).toBe('/a/b');
  });
});

describe('discoverGateway()', () => {
  it('finds every kind of handler on the instance', () => {
    @Gateway('/all')
    class AllGateway {
      @OnUpgrade() upgrade(): string {
        return 'upgrade';
      }
      @OnOpen() opened(): string {
        return 'open';
      }
      @OnMessage() raw(): string {
        return 'raw';
      }
      @OnMessage('named') named(): string {
        return 'named';
      }
      @OnClose() closed(): string {
        return 'close';
      }
      @OnDrain() drained(): string {
        return 'drain';
      }
      @OnPing() pinged(): string {
        return 'ping';
      }
      @OnPong() ponged(): string {
        return 'pong';
      }
    }

    expect(slotsOf(new AllGateway())).toEqual([
      'close',
      'drain',
      'message',
      'message named',
      'open',
      'ping',
      'pong',
      'upgrade',
    ]);
  });

  it("inherits an abstract base gateway's handlers", () => {
    expect(slotsOf(new ChatGateway())).toEqual([
      'message base.ping',
      'message chat.send',
      'open',
    ]);
  });

  it('reads the path through the prototype chain, so a subclass inherits it', () => {
    expect(discoverGateway(new ChatGateway()).path).toBe('/chat');
    expect(discoverGateway(new InheritedPathGateway()).path).toBe('/base');
  });

  it('defaults to / when the class is not decorated at all', () => {
    class BareGateway {
      @OnMessage()
      raw(): string {
        return 'raw';
      }
    }

    const discovered = discoverGateway(new BareGateway());
    expect(discovered.path).toBe('/');
    expect(discovered.name).toBe('BareGateway');
  });

  it('keeps an undecorated override discovered, and dispatches to the override', () => {
    const discovered = discoverGateway(new OverridingGateway());
    const open = discovered.handlers.find(
      (handler) => handler.kind === 'open',
    )!;

    expect(open.method).toBe('opened');
    expect(open.invoke()).toBe('override.opened');
  });

  it('binds handlers to the instance', () => {
    @Gateway()
    class StatefulGateway {
      readonly greeting = 'hi';

      @OnMessage('greet')
      greet(): string {
        return this.greeting;
      }
    }

    const [handler] = discoverGateway(new StatefulGateway()).handlers;
    expect(handler?.invoke()).toBe('hi');
  });

  it('finds nothing on a class with no decorated methods', () => {
    class PlainService {
      work(): string {
        return 'work';
      }
    }

    expect(discoverGateway(new PlainService()).handlers).toEqual([]);
  });
});

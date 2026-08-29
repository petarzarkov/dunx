import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

abstract class Settings {
  abstract readonly name: string;
}

class DefaultSettings extends Settings {
  override readonly name = 'default';
}

class AppSettings extends Settings {
  override readonly name = 'from the app';
}

/** Something only a leaf module exports, to prove the promoted binding reaches it. */
const Marker = token<string>('Marker');

@Module({
  providers: [provide(Marker, { useValue: 'leaf' })],
  exports: [Marker],
})
class LeafModule {}

const settingsOf = async (
  root: object,
): Promise<{ name: string; warnings: readonly string[] }> => {
  const app = await AppFactory.create(root as never, {
    promote: [provide(Settings, { useClass: DefaultSettings })],
  });
  const name = app.get(Settings).name;
  const warnings = app.warnings;
  await app.shutdown();
  return { name, warnings };
};

describe('AppOptions.promote', () => {
  it('binds the default when no module declares the token', async () => {
    @Module({ imports: [LeafModule] })
    class Root {}

    expect((await settingsOf(Root)).name).toBe('default');
  });

  it('lets a module declaring the token win', async () => {
    @Module({
      imports: [LeafModule],
      providers: [provide(Settings, { useClass: AppSettings })],
    })
    class Root {}

    expect((await settingsOf(Root)).name).toBe('from the app');
  });

  it('does not warn about shadowing when a module wins', async () => {
    @Module({
      imports: [LeafModule],
      providers: [provide(Settings, { useClass: AppSettings })],
    })
    class Root {}

    // A promoted contract is meant to be replaced. Warning about it would put a
    // line in every boot log of every app that configured the thing properly,
    // which is how a warning stops being read.
    const { warnings } = await settingsOf(Root);
    expect(warnings.filter((line) => line.includes('Settings'))).toEqual([]);
  });

  it('reaches a module that imports nothing of the declaring module', async () => {
    @Module({
      imports: [LeafModule],
      providers: [provide(Settings, { useClass: AppSettings })],
    })
    class Root {}

    // `LeafModule` imports nothing, so ordinary scoping would leave it with no
    // view of `Settings` at all. This is the property that makes a promoted
    // contract worth having over a `global: true` module.
    const app = await AppFactory.create(Root, {
      promote: [provide(Settings, { useClass: DefaultSettings })],
    });
    expect(app.get(Settings, LeafModule).name).toBe('from the app');
    await app.shutdown();
  });
});

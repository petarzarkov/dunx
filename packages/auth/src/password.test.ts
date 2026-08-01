import { describe, expect, it } from 'bun:test';
import { bunPassword } from './password.js';

describe('bunPassword', () => {
  it('hashes with bcrypt and verifies its own hash', async () => {
    const hash = await bunPassword.hash('password123');
    expect(hash).toStartWith('$2b$');
    expect(await bunPassword.verify({ hash, password: 'password123' })).toBe(
      true,
    );
    expect(await bunPassword.verify({ hash, password: 'wrong' })).toBe(false);
  });

  it('survives a multibyte password past bcrypt’s 72-byte cap', async () => {
    const password = '🔐'.repeat(64);
    const hash = await bunPassword.hash(password);
    expect(await bunPassword.verify({ hash, password })).toBe(true);
    expect(await bunPassword.verify({ hash, password: `${password}x` })).toBe(
      false,
    );
  });

  it('reads a hash from another algorithm as a failure, not a throw', async () => {
    const scrypt = await Bun.password.hash('password123', {
      algorithm: 'argon2id',
    });
    expect(
      await bunPassword.verify({ hash: scrypt, password: 'password123' }),
    ).toBe(true);
    expect(
      await bunPassword.verify({ hash: 'not-a-hash', password: 'x' }),
    ).toBe(false);
  });
});

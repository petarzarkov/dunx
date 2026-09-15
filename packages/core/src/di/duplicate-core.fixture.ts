import { AppFactory } from './app.js';
import { Module } from './module.js';

// A query suffix is a different specifier, so Bun evaluates the module twice -
// a second copy of @dunx/core without an install to arrange one. In a variable
// because tsc resolves a literal and there is nothing on disk to resolve to.
const secondCopy = './copies.js?second-copy';
await import(secondCopy);

@Module({})
class AppModule {}

try {
  await AppFactory.create(AppModule);
  console.log('NO ERROR');
} catch (error) {
  console.log((error as Error).message);
}

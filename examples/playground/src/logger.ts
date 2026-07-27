// Never registered in a module. Every class is injectable by default, so
// inject(Logger) self-binds it.
export class Logger {
  info(message: string): void {
    console.log(`[dunx] ${message}`);
  }
}

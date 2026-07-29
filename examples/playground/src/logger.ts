// Never registered in a module. Every class is injectable by default, so a
// constructor parameter typed `Logger` self-binds.
export class Logger {
  info(message: string): void {
    console.log(`[dunx] ${message}`);
  }

  /** A group header, so a reader can tell which area is talking. */
  group(title: string): void {
    console.log(`[dunx] --- ${title}`);
  }
}

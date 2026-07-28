// Never registered in a module. Every class is injectable by default, so a
// constructor parameter of this type self-binds it.
export class Logger {
  info(message: string): void {
    console.log(`[dunx] ${message}`);
  }

  row(label: string, value: string): void {
    console.log(`[dunx]   ${label.padEnd(26)} ${value}`);
  }
}

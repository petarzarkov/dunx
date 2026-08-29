import { z } from 'zod';

export const PLAINTEXT = 'Hello, World!';

export const jsonPayload = (): { message: string } => ({ message: PLAINTEXT });

export const personSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0),
  email: z.email(),
});

export type Person = z.infer<typeof personSchema>;

export const echo = (person: Person): { name: string; age: number } => ({
  name: person.name,
  age: person.age,
});

export const invalid = { error: 'Invalid body' };

export const port = (): number => Number(process.env['PORT'] ?? 0);

/**
 * Exit cleanly on `SIGTERM`, which is what makes `--profile` produce anything.
 *
 * Bun writes a `--cpu-prof` / `--heap-prof` profile **on exit**, and a signal with
 * no handler is not one: measured on 1.4.0, a `Bun.serve` process killed with
 * `SIGKILL`, `SIGTERM` or `SIGINT` writes no profile at all, while the same
 * process reaching `process.exit(0)` writes both the `.cpuprofile` and the
 * markdown. The harness kills a subject with `SIGKILL` normally, and sends
 * `SIGTERM` first when profiling - this is the other half of that.
 *
 * At module scope because every Bun and Node subject imports this file, and a
 * subject that forgot the call would be a profile silently missing from the run.
 */
process.on('SIGTERM', () => {
  process.exit(0);
});

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

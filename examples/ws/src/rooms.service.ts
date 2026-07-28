/** Plain injectable state, so the gateway has a real dependency to receive. */
export class Rooms {
  readonly #members = new Map<string, Set<string>>();
  #closed = 0;

  join(room: string, user: string): number {
    const members = this.#members.get(room) ?? new Set<string>();
    members.add(user);
    this.#members.set(room, members);
    return members.size;
  }

  members(room: string): readonly string[] {
    return [...(this.#members.get(room) ?? [])];
  }

  leave(user: string): void {
    this.#closed += 1;
    for (const members of this.#members.values()) members.delete(user);
  }

  get closed(): number {
    return this.#closed;
  }
}

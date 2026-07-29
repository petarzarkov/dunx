import { HttpError, HttpStatusCode } from '@dunx/http';

export class ReportsService {
  readonly #rows = ['q1 revenue'];

  titles(): readonly string[] {
    return this.#rows;
  }

  add(title: string): readonly string[] {
    this.#rows.push(title);
    return this.#rows;
  }

  rename(id: number, title: string): readonly string[] {
    if (id < 1 || id > this.#rows.length) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No report ${id}`);
    }
    this.#rows[id - 1] = title;
    return this.#rows;
  }
}

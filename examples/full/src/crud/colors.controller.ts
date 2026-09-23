import { Controller } from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { CrudController, CrudStore } from './crud.controller.js';

export interface Color {
  readonly id: string;
  readonly hex: string;
}

export class ColorsStore extends CrudStore<Color> {
  constructor() {
    super([
      { id: 'ember', hex: '#e8590c' },
      { id: 'moss', hex: '#5c940d' },
      { id: 'slate', hex: '#495057' },
    ]);
  }
}

// The public demo is shared, so the inherited DELETE is not served.
@ApiDoc({
  tags: ['Crud'],
  description: 'A generic CrudController base, served here without remove.',
})
@Controller('colors', { exclude: ['remove'] })
export class ColorsController extends CrudController<Color> {
  constructor(store: ColorsStore) {
    super(store);
  }
}

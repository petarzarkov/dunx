import { provide, type DynamicModule } from '@dunx/core';
import { DbConnection, DbModule } from '@dunx/infra/db';
import { MysqlConnection, MysqlOptions } from './driver.js';
import { MysqlWidgets } from './widgets.service.js';

/**
 * The same `DbModule.forRoot` shape as the other two dialects, over the backend
 * assembled in `driver.ts`. Nothing in `@dunx/infra` had to change to accept it.
 *
 * The one extra binding: `DbModule` registers the connection under the abstract
 * `DbConnection` token, and `MysqlWidgets` needs the concrete class for its
 * `transaction()` helper. Rebinding the class to the *same instance* through a
 * factory is how a service annotates the narrower type — no cast, and no second
 * connection opened, because the factory returns what `DbConnection` already
 * resolved to.
 */
export class MysqlModule {
  static forUrl(url: string): DynamicModule {
    return {
      module: MysqlModule,
      imports: [DbModule.forRoot(new MysqlOptions(url))],
      providers: [
        provide(MysqlConnection, {
          useFactory: (connection: DbConnection) => {
            if (!(connection instanceof MysqlConnection)) {
              throw new Error('DbModule did not open the MySQL backend');
            }
            return connection;
          },
          inject: [DbConnection],
        }),
        MysqlWidgets,
      ],
    };
  }
}

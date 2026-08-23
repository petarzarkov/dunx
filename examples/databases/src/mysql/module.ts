import { provide, type DynamicModule } from '@dunx/core';
import { DbConnection, DbModule } from '@dunx/infra/db';
import { MysqlConnection, MysqlOptions } from './driver.js';
import { MysqlWidgets } from './widgets.service.js';

/**
 * The same `DbModule.forRoot` shape as the other dialects, over the backend in
 * `driver.ts`. The extra binding rebinds the concrete class to the same instance
 * `DbConnection` resolved to, so `MysqlWidgets` can annotate the narrower type
 * without a cast and without a second connection.
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

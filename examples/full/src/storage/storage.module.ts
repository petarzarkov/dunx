import { Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions, Storage } from '@dunx/infra/files';
import { FilesController } from './files.controller.js';
import { Uploads } from './uploads.service.js';
import { Workspace } from './workspace.js';

/**
 * `Workspace` lives in its own module because the factory below needs it.
 *
 * `FilesModule.forRootAsync` registers its provider in `FilesModule`'s scope, so a
 * factory injecting `Workspace` is asking that module to resolve a token - which means
 * naming the module it comes from. Declaring `Workspace` in `StorageModule` and
 * pointing the factory back at `StorageModule` would work too, but a one-provider
 * module reads better than a cycle.
 */
@Module({ providers: [Workspace], exports: [Workspace] })
export class WorkspaceModule {}

@Module({
  imports: [
    WorkspaceModule,
    // The root has to exist before `LocalStorageOptions` names it, and creating
    // it is async - which is the whole reason `forRootAsync` takes a factory that
    // may await and may inject.
    FilesModule.forRootAsync({
      imports: [WorkspaceModule],
      useFactory: async (workspace: Workspace) =>
        new LocalStorageOptions(await workspace.create()),
      inject: [Workspace],
    }),
  ],
  controllers: [FilesController],
  providers: [Uploads],
  exports: [Storage, Workspace, Uploads],
})
export class StorageModule {}

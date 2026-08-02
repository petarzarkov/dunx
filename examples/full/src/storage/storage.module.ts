import { Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions } from '@dunx/infra/files';
import { FilesController } from './files.controller.js';
import { Uploads } from './uploads.service.js';
import { Workspace } from './workspace.js';

@Module({
  imports: [
    // The root has to exist before `LocalStorageOptions` names it, and creating
    // it is async — which is the whole reason `forRootAsync` takes a factory that
    // may await and may inject.
    FilesModule.forRootAsync({
      useFactory: async (workspace: Workspace) =>
        new LocalStorageOptions(await workspace.create()),
      inject: [Workspace],
    }),
  ],
  controllers: [FilesController],
  providers: [Workspace, Uploads],
})
export class StorageModule {}

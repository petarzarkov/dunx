import { Module } from '@dunx/core';
import { ProtocolsDemo } from './protocols.demo.js';
import { TelemetryGateway } from './telemetry.gateway.js';

@Module({
  providers: [TelemetryGateway, ProtocolsDemo],
  exports: [ProtocolsDemo],
})
export class ProtocolsModule {}

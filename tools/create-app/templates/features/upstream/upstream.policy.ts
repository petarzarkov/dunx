import { ResiliencePolicy } from '@dunx/core';

/** A policy bound to a subclass, so it is an ordinary constructor parameter. */
export class UpstreamPolicy extends ResiliencePolicy {}

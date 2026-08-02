import { Controller, Get, Public, Roles, UseGuards } from '@dunx/http';
import { SessionGuard } from '@dunx/auth';
import { Audit } from './audit.service.js';

/**
 * `@UseGuards(SessionGuard)` at class scope rather than global middleware, exactly as
 * `ReportsController` does with its hand-rolled guard: every other route in this app
 * is meant to be reachable without credentials.
 *
 * Nothing here is handed a user. `Audit` reads the caller out of `AuthContext`, which
 * is `AsyncLocalStorage` - so a service two hops from the request sees the principal
 * without it being threaded through a signature.
 */
@UseGuards(SessionGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly audit: Audit) {}

  @Get('/')
  me(): { email: string; roles: readonly string[]; sessionId: string } {
    return this.audit.whoami();
  }

  /** The class guard reads this and 403s unless the caller holds `admin`. */
  @Roles('admin')
  @Get('/audit')
  entries(): { caller: string; entries: readonly string[] } {
    return this.audit.report();
  }

  /** The class guard reads this and skips: no session looked up, no rejection. */
  @Public()
  @Get('/anonymous')
  anonymous(): { caller: string | null } {
    return { caller: this.audit.caller() };
  }
}

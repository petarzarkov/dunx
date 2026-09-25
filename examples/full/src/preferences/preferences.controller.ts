import {
  Controller,
  Delete,
  Get,
  Put,
  SignedCookies,
  type Input,
  type RouteInput,
  type RouteSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { z } from 'zod';

export const PREFERENCE_COOKIE = 'prefs';
const Theme = z.enum(['light', 'dark', 'system']);
const Preference = z.object({ theme: Theme });
type Preference = z.infer<typeof Preference>;

const readPreference = {
  response: { 200: Preference },
} as const satisfies RouteSchemas;
const writePreference = {
  body: Preference,
  response: { 200: Preference },
} as const satisfies RouteSchemas;

/**
 * A theme kept in a signed cookie, so it survives without an account and a
 * visitor who edits it reads back the default. The value is checked twice: the
 * signature says this server wrote it, the schema that it is still a theme.
 */
@ApiDoc({
  tags: ['Cookies'],
  description: 'A signed preference cookie: HttpOnly, Secure, SameSite=Lax.',
})
@Controller('preferences')
export class PreferencesController {
  constructor(private readonly signed: SignedCookies) {}

  @Get('/', readPreference)
  read({ req }: RouteInput): Preference {
    const theme = Theme.safeParse(
      this.signed.get(req.cookies, PREFERENCE_COOKIE),
    );
    return { theme: theme.success ? theme.data : 'system' };
  }

  @Put('/', writePreference)
  write({ req, body }: Input<typeof writePreference>): Preference {
    this.signed.set(req.cookies, PREFERENCE_COOKIE, body.theme, {
      maxAge: 60 * 60 * 24 * 365,
    });
    return body;
  }

  @Delete('/')
  clear({ req }: RouteInput): undefined {
    req.cookies.delete(PREFERENCE_COOKIE);
    return undefined;
  }
}

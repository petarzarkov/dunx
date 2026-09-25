import { Logger } from '@dunx/core';

const PATH = 'api/preferences';

/** `PUT /api/preferences` signs a cookie, and an edited one reads as unset. */
export class PreferencesDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const put = await fetch(new URL(PATH, url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    await put.body?.cancel();
    const [header = ''] = put.headers.getSetCookie();
    this.logger.info(`PUT /${PATH} {"theme":"dark"} -> ${put.status}`);
    this.logger.info(`  Set-Cookie: ${header}`);

    const cookie = header.slice(0, header.indexOf(';'));
    const read = await fetch(new URL(PATH, url), { headers: { cookie } });
    this.logger.info(
      `GET /${PATH} with it -> ${JSON.stringify(await read.json())}`,
    );

    const edited = cookie.replace('dark', 'light');
    const forged = await fetch(new URL(PATH, url), {
      headers: { cookie: edited },
    });
    this.logger.info(
      `GET /${PATH} with "dark" edited to "light" -> ` +
        JSON.stringify(await forged.json()),
    );
  }
}

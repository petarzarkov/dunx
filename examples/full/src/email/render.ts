import { ReactEmailRenderer } from '@dunx/infra/email/react';

/**
 * What `dunx-email --renderer ./src/email/render.ts` loads, and the same class
 * `MailModule` hands `EmailModule`, so the preview cannot drift from what a send
 * produces. Pointing the flag at a module of your own is how an app previewing
 * MJML never installs `@react-email/components`.
 */
export default new ReactEmailRenderer();

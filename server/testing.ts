// Helpers for the server tests: a mailbox that captures outgoing mail, and sign-up that completes email
// verification so a test gets a signed-in cookie in one call.
import type { FastifyInstance } from 'fastify';
import type { Mail } from './mail.ts';

export interface Mailbox {
  sent: Mail[];
  send: (mail: Mail) => Promise<void>;
  /** The token in the most recent `/<page>?token=...` link sent to this address. */
  tokenFor(to: string, page: 'verify' | 'reset'): string;
}

export function mailbox(): Mailbox {
  const sent: Mail[] = [];
  return {
    sent,
    send: async (mail) => void sent.push(mail),
    tokenFor(to, page) {
      const mail = [...sent].reverse().find((m) => m.to === to.trim().toLowerCase());
      const match = mail && new RegExp(`/${page}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
      if (!match) throw new Error(`no ${page} link was emailed to ${to}`);
      return match[1];
    },
  };
}

/** Register, open the emailed verification link, and return the session cookie and user. */
export async function signUp(app: FastifyInstance, box: Mailbox, email: string, password = 'password123') {
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`register ${email} failed: ${res.statusCode} ${res.body}`);
  res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor(email, 'verify') } });
  if (res.statusCode !== 200) throw new Error(`verify ${email} failed: ${res.statusCode} ${res.body}`);
  const sc = res.headers['set-cookie'];
  const cookie = (Array.isArray(sc) ? sc[0] : String(sc)).split(';')[0];
  return { cookie, user: (res.json() as { user: { id: string; email: string } }).user };
}

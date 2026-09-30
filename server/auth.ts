import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface User {
  id: string;
  email: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateCredentials(email: unknown, password: unknown): string | null {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Please enter a valid email address.';
  if (email.length > 254) return 'Email address is too long.';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export class AuthService {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  async register(email: string, password: string): Promise<User | 'exists'> {
    const norm = normalizeEmail(email);
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(norm);
    if (existing) return 'exists';
    const user: User = { id: randomUUID(), email: norm };
    const hash = await hashPassword(password);
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, hash, new Date().toISOString());
    return user;
  }

  async login(email: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(normalizeEmail(email)) as
      | { id: string; email: string; password_hash: string }
      | undefined;
    if (!row) {
      // Spend comparable time so response timing doesn't reveal whether the account exists.
      await hashPassword(password);
      return null;
    }
    if (!(await verifyPassword(password, row.password_hash))) return null;
    return { id: row.id, email: row.email };
  }

  createSession(userId: string): { token: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, now.toISOString(), expires.toISOString());
    return { token, expires };
  }

  userForSession(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as { id: string; email: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.destroySession(token);
      return null;
    }
    return { id: row.id, email: row.email };
  }

  destroySession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  }
}

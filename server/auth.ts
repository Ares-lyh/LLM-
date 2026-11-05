import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, id, nowIso } from './db.js';
import type { Role, UserDto } from '../src/shared/contracts.js';

const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS ?? 24);

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function userDto(row: Record<string, unknown>): UserDto {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role as Role,
  };
}

export function createSession(userId: string) {
  const token = createHash('sha256').update(`${userId}:${crypto.randomUUID()}`).digest('hex');
  const expiresAt = new Date(Date.now() + sessionTtlHours * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function clearSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getSessionUser(req: IncomingMessage) {
  const cookies = req.headers.cookie ?? '';
  const token = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith('session='))?.slice(8);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, nowIso()) as Record<string, unknown> | undefined;
  return row ? { ...userDto(row), token } : null;
}

export function setSessionCookie(res: ServerResponse, token: string, expiresAt: string) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/${secure}; Expires=${new Date(expiresAt).toUTCString()}`);
}

export function clearSessionCookie(res: ServerResponse) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

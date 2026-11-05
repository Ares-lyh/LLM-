import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const dataPath = resolve(process.cwd(), process.env.DB_PATH ?? 'data/student-management.db');
mkdirSync(dirname(dataPath), { recursive: true });

export const db = new DatabaseSync(dataPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      guardian_name TEXT NOT NULL,
      guardian_phone TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('lead', 'trial', 'active', 'lost')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      channel TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('new', 'contacted', 'trial_scheduled', 'converted', 'lost')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trial_lessons (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      inquiry_id TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      outcome TEXT CHECK (outcome IN ('interested', 'undecided', 'not_interested')),
      notes TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_scheduled_trial_per_student
      ON trial_lessons(student_id) WHERE status = 'scheduled';

    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      inquiry_id TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'skipped')),
      note TEXT NOT NULL,
      ai_summary TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follow_up_results (
      follow_up_id TEXT PRIMARY KEY REFERENCES follow_ups(id) ON DELETE CASCADE,
      notes TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('continue', 'converted', 'lost')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_students_owner ON students(owner_id);
    CREATE INDEX IF NOT EXISTS idx_follow_ups_status_due ON follow_ups(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_trials_scheduled_at ON trial_lessons(scheduled_at);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

export function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

migrate();

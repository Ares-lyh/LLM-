import { db, id, nowIso } from './db.js';

type Result = { status: number; body: Record<string, unknown> };
const failure = (status: number, code: string, error: string): Result => ({ status, body: { code, error } });

export function teacherExists(teacherId: string) {
  return !!db.prepare("SELECT id FROM users WHERE id = ? AND role = 'teacher'").get(teacherId);
}

export function currentTeacher(studentId: string): string | null {
  const row = db.prepare('SELECT teacher_id FROM teacher_assignments WHERE student_id = ? AND ended_at IS NULL').get(studentId) as { teacher_id: string } | undefined;
  return row?.teacher_id ?? null;
}

// Caller owns the transaction, including any accompanying trial creation.
export function setTeacher(studentId: string, teacherId: string, userId: string, key: string | null = null, body: string | null = null) {
  const now = nowIso();
  db.prepare('UPDATE teacher_assignments SET ended_at = ? WHERE student_id = ? AND ended_at IS NULL').run(now, studentId);
  db.prepare('INSERT INTO teacher_assignments (id, student_id, teacher_id, assigned_by, assigned_at, request_key, request_body) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id('tas'), studentId, teacherId, userId, now, key, body);
}

function replay(table: 'teacher_assignments' | 'trial_reschedules' | 'trial_cancellations', userId: string, key: string, body: string): Result | null {
  const actor = table === 'teacher_assignments' ? 'assigned_by' : table === 'trial_reschedules' ? 'changed_by' : 'cancelled_by';
  const row = db.prepare(`SELECT request_body FROM ${table} WHERE ${actor} = ? AND request_key = ?`).get(userId, key) as { request_body: string } | undefined;
  if (!row) return null;
  return row.request_body === body ? { status: 200, body: { ok: true } } : failure(409, 'IDEMPOTENCY_CONFLICT', '该请求标识已用于其他操作');
}

export function cancelTrial(trialId: string, userId: string, key: string, expected: string, reason: string): Result {
  const trial = db.prepare('SELECT t.student_id, t.inquiry_id, s.owner_id FROM trial_lessons t JOIN students s ON s.id = t.student_id WHERE t.id = ?').get(trialId) as { student_id: string; inquiry_id: string; owner_id: string } | undefined;
  if (!trial) return failure(404, 'TRIAL_NOT_FOUND', '试听记录不存在');
  if (trial.owner_id !== userId) return failure(403, 'FORBIDDEN', '只能操作自己负责的学生');
  const body = JSON.stringify({ trialId, expected, reason });
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = replay('trial_cancellations', userId, key, body);
    if (existing) { db.exec('COMMIT'); return existing; }
    const updated = db.prepare("UPDATE trial_lessons SET status = 'cancelled' WHERE id = ? AND status = 'scheduled' AND scheduled_at = ?").run(trialId, expected);
    if (Number(updated.changes) !== 1) { db.exec('ROLLBACK'); return failure(409, 'TRIAL_CHANGED', '试听已变更或处理，请刷新后重试'); }
    const now = nowIso();
    db.prepare('INSERT INTO trial_cancellations (trial_id, reason, cancelled_by, cancelled_at, request_key, request_body) VALUES (?, ?, ?, ?, ?, ?)').run(trialId, reason, userId, now, key, body);
    db.prepare("UPDATE inquiries SET status = 'contacted', updated_at = ? WHERE id = ? AND status = 'trial_scheduled'").run(now, trial.inquiry_id);
    const completed = db.prepare("SELECT 1 FROM trial_lessons WHERE student_id = ? AND status = 'completed' LIMIT 1").get(trial.student_id);
    db.prepare("UPDATE students SET status = ? WHERE id = ? AND status = 'trial'").run(completed ? 'trial' : 'lead', trial.student_id);
    db.exec('COMMIT');
    return { status: 200, body: { ok: true } };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function assignTeacher(studentId: string, userId: string, key: string, teacherId: string, expected: string | null): Result {
  const student = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(studentId) as { owner_id: string } | undefined;
  if (!student) return failure(404, 'STUDENT_NOT_FOUND', '学生不存在');
  if (student.owner_id !== userId) return failure(403, 'FORBIDDEN', '只能操作自己负责的学生');
  const body = JSON.stringify({ studentId, teacherId, expected });
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = replay('teacher_assignments', userId, key, body);
    if (existing) { db.exec('COMMIT'); return existing; }
    if (!teacherExists(teacherId)) { db.exec('ROLLBACK'); return failure(400, 'INVALID_TEACHER', '请选择有效的老师'); }
    if (currentTeacher(studentId) !== expected) { db.exec('ROLLBACK'); return failure(409, 'TEACHER_CHANGED', '老师已变更，请刷新后重试'); }
    if (expected === teacherId) { db.exec('ROLLBACK'); return failure(409, 'TEACHER_UNCHANGED', '该老师已经负责此学生'); }
    setTeacher(studentId, teacherId, userId, key, body);
    db.exec('COMMIT');
    return { status: 200, body: { ok: true } };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function rescheduleTrial(trialId: string, userId: string, key: string, scheduledAt: string, expected: string, reason: string): Result {
  const trial = db.prepare('SELECT t.status, s.owner_id FROM trial_lessons t JOIN students s ON s.id = t.student_id WHERE t.id = ?').get(trialId) as { status: string; owner_id: string } | undefined;
  if (!trial) return failure(404, 'TRIAL_NOT_FOUND', '试听记录不存在');
  if (trial.owner_id !== userId) return failure(403, 'FORBIDDEN', '只能操作自己负责的学生');
  const body = JSON.stringify({ trialId, scheduledAt, expected, reason });
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = replay('trial_reschedules', userId, key, body);
    if (existing) { db.exec('COMMIT'); return existing; }
    if (scheduledAt <= nowIso() || scheduledAt === expected) { db.exec('ROLLBACK'); return failure(400, 'INVALID_TIME', '请选择不同的未来时间'); }
    const updated = db.prepare("UPDATE trial_lessons SET scheduled_at = ? WHERE id = ? AND status = 'scheduled' AND scheduled_at = ?").run(scheduledAt, trialId, expected);
    if (Number(updated.changes) !== 1) { db.exec('ROLLBACK'); return failure(409, 'TRIAL_CHANGED', '试听已变更或已处理，请刷新后重试'); }
    db.prepare('INSERT INTO trial_reschedules (id, trial_id, previous_scheduled_at, scheduled_at, reason, changed_by, changed_at, request_key, request_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id('rsc'), trialId, expected, scheduledAt, reason, userId, nowIso(), key, body);
    db.exec('COMMIT');
    return { status: 200, body: { ok: true } };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

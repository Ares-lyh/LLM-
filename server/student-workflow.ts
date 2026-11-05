import { db, id, nowIso } from './db.js';

export function createReturningInquiry(studentId: string, userId: string, key: string, channel: string, summary: string) {
  const student = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(studentId) as { owner_id: string } | undefined;
  if (!student) return { status: 404, body: { code: 'STUDENT_NOT_FOUND', error: '学生不存在' } };
  if (student.owner_id !== userId) return { status: 403, body: { code: 'FORBIDDEN', error: '只能操作自己负责的学生' } };
  const requestBody = JSON.stringify({ studentId, channel, summary });
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT request_body, inquiry_id FROM inquiry_requests WHERE user_id = ? AND request_key = ?').get(userId, key) as { request_body: string; inquiry_id: string } | undefined;
    if (existing) {
      db.exec('COMMIT');
      return existing.request_body === requestBody
        ? { status: 201, body: { inquiryId: existing.inquiry_id } }
        : { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', error: '该请求标识已用于其他操作' } };
    }
    const open = db.prepare("SELECT 1 FROM inquiries WHERE student_id = ? AND status IN ('new', 'contacted', 'trial_scheduled') LIMIT 1").get(studentId);
    const task = db.prepare("SELECT 1 FROM follow_ups WHERE student_id = ? AND status = 'pending' LIMIT 1").get(studentId);
    const trial = db.prepare("SELECT 1 FROM trial_lessons WHERE student_id = ? AND status = 'scheduled' LIMIT 1").get(studentId);
    if (open || task || trial) {
      db.exec('ROLLBACK');
      return { status: 409, body: { code: 'OPEN_INQUIRY_EXISTS', error: '该学生仍有未结束的咨询或待办，请先完成现有流程' } };
    }
    const inquiryId = id('inq');
    const now = nowIso();
    db.prepare("INSERT INTO inquiries (id, student_id, owner_id, channel, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)").run(inquiryId, studentId, userId, channel, summary, now, now);
    db.prepare("UPDATE students SET status = 'lead' WHERE id = ?").run(studentId);
    db.prepare('INSERT INTO inquiry_requests (user_id, request_key, request_body, inquiry_id) VALUES (?, ?, ?, ?)').run(userId, key, requestBody, inquiryId);
    db.exec('COMMIT');
    return { status: 201, body: { inquiryId } };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

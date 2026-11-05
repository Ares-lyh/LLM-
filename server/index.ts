import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { Temporal } from '@js-temporal/polyfill';
import { clearSession, clearSessionCookie, createSession, getSessionUser, hashPassword, setSessionCookie, userDto, verifyPassword } from './auth.js';
import { db, id, nowIso } from './db.js';
import { assignTeacher, cancelTrial, currentTeacher, rescheduleTrial, setTeacher, teacherExists } from './scheduling.js';
import { createReturningInquiry } from './student-workflow.js';
import type { CompleteFollowUpInput, CompleteTrialInput, CreateLeadInput, DashboardDto, FollowUpOutcome, FollowUpStatus, InquiryDto, InquiryStatus, ScheduleTrialInput, TrialDto, TrialOutcome, TrialStatus } from '../src/shared/contracts.js';

const port = Number(process.env.PORT ?? 3001);
const MELBOURNE_TZ = 'Australia/Melbourne';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean));
const loginAttempts = new Map<string, { count: number; until: number }>();
let llmFailures = 0;
let llmUnavailableUntil = 0;

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, code: string, error: string) {
  sendJson(res, status, { code, error });
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Error('INVALID_CONTENT_TYPE');
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024) throw new Error('INVALID_BODY_SIZE');
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON');
    return value as Record<string, unknown>;
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function requireAuth(req: IncomingMessage, res: ServerResponse) {
  const user = getSessionUser(req);
  if (!user) {
    sendError(res, 401, 'AUTH_REQUIRED', '请先登录');
    return null;
  }
  return user;
}

function requireAdmin(req: IncomingMessage, res: ServerResponse) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(res, 403, 'FORBIDDEN', '当前角色没有执行此操作的权限');
    return null;
  }
  return user;
}

function asNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value.trim();
}

function asDate(value: unknown, field: string) {
  const text = asNonEmptyString(value, field);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(text)) throw new Error(`INVALID_${field.toUpperCase()}`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`INVALID_${field.toUpperCase()}`);
  return date.toISOString();
}

function mapInquiry(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    studentName: String(row.student_name),
    channel: String(row.channel),
    summary: String(row.summary),
    status: String(row.status) as InquiryStatus,
    createdAt: String(row.created_at),
  };
}

function mapTrial(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    inquiryId: String(row.inquiry_id),
    studentId: String(row.student_id),
    studentName: String(row.student_name),
    scheduledAt: String(row.scheduled_at),
    status: String(row.status) as TrialStatus,
    outcome: row.outcome ? String(row.outcome) as TrialOutcome : null,
    notes: row.notes ? String(row.notes) : null,
    teacherName: row.teacher_name ? String(row.teacher_name) : null,
  };
}

function mapFollowUp(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    inquiryId: String(row.inquiry_id),
    studentId: String(row.student_id),
    studentName: String(row.student_name),
    dueAt: String(row.due_at),
    status: String(row.status) as FollowUpStatus,
    note: String(row.note),
    aiSummary: row.ai_summary ? String(row.ai_summary) : null,
    resultNote: row.result_note ? String(row.result_note) : null,
    resultOutcome: row.result_outcome ? String(row.result_outcome) as FollowUpOutcome : null,
  };
}

function mapDuplicateStudent(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    guardianName: String(row.guardian_name),
    guardianPhone: String(row.guardian_phone),
    status: row.status === 'active' ? 'enrollment_intent' : String(row.status),
    createdAt: String(row.created_at),
  };
}

function dashboard(userId: string): DashboardDto {
  const studentCount = db.prepare(`SELECT COUNT(*) as count FROM students s WHERE s.owner_id = ?`).get(userId) as { count: number };
  const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM follow_ups f JOIN students s ON s.id = f.student_id WHERE s.owner_id = ? AND f.status = 'pending'`).get(userId) as { count: number };
  const today = Temporal.Now.zonedDateTimeISO(MELBOURNE_TZ).toPlainDate();
  const todayStart = new Date(today.toZonedDateTime(MELBOURNE_TZ).epochMilliseconds).toISOString();
  const tomorrowStart = new Date(today.add({ days: 1 }).toZonedDateTime(MELBOURNE_TZ).epochMilliseconds).toISOString();
  const todayTrials = db.prepare(`SELECT COUNT(*) as count FROM trial_lessons t JOIN students s ON s.id = t.student_id WHERE s.owner_id = ? AND t.status = 'scheduled' AND t.scheduled_at >= ? AND t.scheduled_at < ?`).get(userId, todayStart, tomorrowStart) as { count: number };
  const overdue = db.prepare(`SELECT COUNT(*) as count FROM follow_ups f JOIN students s ON s.id = f.student_id WHERE s.owner_id = ? AND f.status = 'pending' AND f.due_at < ?`).get(userId, nowIso()) as { count: number };

  const inquiries: InquiryDto[] = db.prepare(`
    SELECT i.*, s.name AS student_name FROM inquiries i JOIN students s ON s.id = i.student_id
    WHERE s.owner_id = ? ORDER BY i.updated_at DESC LIMIT 50
  `).all(userId).map((row) => mapInquiry(row as Record<string, unknown>));
  const trials: TrialDto[] = db.prepare(`
    SELECT t.*, s.name AS student_name, u.name AS teacher_name FROM trial_lessons t JOIN students s ON s.id = t.student_id
    LEFT JOIN trial_teachers tt ON tt.trial_id = t.id LEFT JOIN users u ON u.id = tt.teacher_id
    WHERE s.owner_id = ? AND t.status = 'scheduled' ORDER BY t.scheduled_at ASC
  `).all(userId).map((row) => mapTrial(row as Record<string, unknown>));
  const followUps = db.prepare(`
    SELECT f.*, s.name AS student_name FROM follow_ups f JOIN students s ON s.id = f.student_id
    WHERE s.owner_id = ? AND f.status = 'pending' ORDER BY f.due_at ASC
  `).all(userId).map((row) => mapFollowUp(row as Record<string, unknown>));

  return {
    counts: {
      students: Number(studentCount.count),
      pendingFollowUps: Number(pendingCount.count),
      todayTrials: Number(todayTrials.count),
      overdueFollowUps: Number(overdue.count),
    },
    inquiries,
    trials,
    followUps,
  };
}

async function generateAiSummary(input: { outcome: TrialOutcome; notes: string }) {
  const fallback = input.outcome === 'interested'
    ? '建议在 2 天内联系家长，确认课程目标、可上课时间和报名意向。'
    : '建议在 3 天内回访，补充了解顾虑并提供合适的课程方案。';
  const apiUrl = process.env.LLM_API_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!apiUrl || !apiKey || Date.now() < llmUnavailableUntil) return fallback;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_schema', json_schema: { name: 'follow_up_advice', strict: true, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } },
            messages: [{ role: 'user', content: `请根据试听结果和备注生成不超过80字的下一步建议。结果：${input.outcome}。备注：${input.notes}` }],
          }),
        });
        if ((response.status === 429 || response.status >= 500) && attempt === 0) continue;
        if (!response.ok) break;
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (!content) break;
        const parsed = JSON.parse(content) as { summary?: unknown };
        if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.summary !== 'string' || !parsed.summary.trim() || parsed.summary.length > 160) break;
        llmFailures = 0;
        return parsed.summary.trim();
      } catch {
        if (controller.signal.aborted || attempt > 0) break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  llmFailures++;
  if (llmFailures >= 3) { llmUnavailableUntil = Date.now() + 30_000; llmFailures = 0; }
  return fallback;
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (req.method !== 'GET' && req.headers.origin && !allowedOrigins.has(req.headers.origin)) return sendError(res, 403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任');

  if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, time: nowIso() });

  if (req.method === 'POST' && path === '/api/auth/login') {
    const address = req.socket.remoteAddress ?? 'unknown';
    const current = Date.now();
    const previous = loginAttempts.get(address);
    const attempt = !previous || previous.until <= current ? { count: 0, until: current + 15 * 60_000 } : previous;
    if (attempt.count >= 10) return sendError(res, 429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请稍后再试');
    attempt.count++;
    loginAttempts.set(address, attempt);
    try {
      const body = await readJson(req);
      const email = asNonEmptyString(body.email, 'email').toLowerCase();
      const password = asNonEmptyString(body.password, 'password');
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
      if (!row || !verifyPassword(password, String(row.password_hash))) return sendError(res, 401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
      const session = createSession(String(row.id));
      loginAttempts.delete(address);
      setSessionCookie(res, session.token, session.expiresAt);
      return sendJson(res, 200, { user: userDto(row) });
    } catch (error) {
      return sendError(res, 400, 'INVALID_REQUEST', error instanceof Error && error.message.startsWith('INVALID_') ? '登录信息不完整' : '请求格式错误');
    }
  }

  if (req.method === 'POST' && path === '/api/auth/logout') {
    const user = getSessionUser(req);
    if (user?.token) clearSession(user.token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/auth/me') {
    const user = getSessionUser(req);
    return user ? sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } }) : sendError(res, 401, 'AUTH_REQUIRED', '请先登录');
  }

  if (req.method === 'GET' && path === '/api/dashboard') {
    const user = requireAdmin(req, res);
    return user ? sendJson(res, 200, dashboard(user.id)) : undefined;
  }

  if (req.method === 'GET' && path === '/api/students') {
    const user = requireAdmin(req, res);
    if (!user) return;
    const rawPage = url.searchParams.get('page') ?? '1';
    const rawPageSize = url.searchParams.get('pageSize') ?? '10';
    const page = Number(rawPage);
    const pageSize = Number(rawPageSize);
    const search = (url.searchParams.get('search') ?? '').trim();
    const status = url.searchParams.get('status') ?? 'all';
    if (!Number.isInteger(page) || page < 1 || page > 10_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || search.length > 100 || !['all', 'new', 'contacted', 'trial_scheduled', 'converted', 'lost'].includes(status)) {
      return sendError(res, 400, 'INVALID_REQUEST', '分页、搜索或状态筛选参数无效');
    }
    const searchPattern = `%${search.toLowerCase()}%`;
    const filterParams = [user.id, searchPattern, searchPattern, searchPattern, status, status];
    const latestCte = `
      WITH latest AS (
        SELECT i.id, i.student_id, s.name AS student_name, i.channel, i.summary, i.status, i.created_at,
          ROW_NUMBER() OVER (PARTITION BY i.student_id ORDER BY i.updated_at DESC, i.created_at DESC, i.id DESC) AS row_number
        FROM inquiries i
        JOIN students s ON s.id = i.student_id
        WHERE s.owner_id = ?
      )
    `;
    const filterSql = `row_number = 1
      AND (LOWER(student_name) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(channel) LIKE ?)
      AND (? = 'all' OR status = ?)`;
    const totalRow = db.prepare(`${latestCte} SELECT COUNT(*) AS total FROM latest WHERE ${filterSql}`).get(...filterParams) as { total: number };
    const total = Number(totalRow.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const items = page > totalPages ? [] : db.prepare(`${latestCte} SELECT id, student_id, student_name, channel, summary, status, created_at FROM latest WHERE ${filterSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...filterParams, pageSize, offset).map((row) => mapInquiry(row as Record<string, unknown>));
    return sendJson(res, 200, { items, page, pageSize, total, totalPages });
  }

  if (req.method === 'GET' && path === '/api/teachers') {
    const user = requireAdmin(req, res);
    if (!user) return;
    const teachers = db.prepare("SELECT id, name FROM users WHERE role = 'teacher' ORDER BY name, id").all();
    return sendJson(res, 200, { teachers });
  }

  if (req.method === 'POST' && path === '/api/teachers') {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const body = await readJson(req);
      const name = asNonEmptyString(body.name, 'name');
      const email = asNonEmptyString(body.email, 'email').toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) throw new Error('INVALID_TEACHER');
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return sendError(res, 409, 'EMAIL_EXISTS', '该邮箱已被使用');
      const teacherId = id('usr');
      db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'teacher', ?, ?)").run(teacherId, email, name, hashPassword(password), nowIso());
      return sendJson(res, 201, { id: teacherId, name });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效姓名、邮箱和至少 12 位的密码');
      throw error;
    }
  }

  const studentMatch = path.match(/^\/api\/students\/([^/]+)$/);
  if (req.method === 'PATCH' && studentMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    const student = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(studentMatch[1]) as { owner_id: string } | undefined;
    if (!student) return sendError(res, 404, 'STUDENT_NOT_FOUND', '学生不存在');
    if (student.owner_id !== user.id) return sendError(res, 403, 'FORBIDDEN', '只能操作自己负责的学生');
    try {
      const body = await readJson(req);
      const expected = body.expected;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('INVALID_EXPECTED');
      const before = expected as Record<string, unknown>;
      const name = asNonEmptyString(body.name, 'name');
      const guardianName = asNonEmptyString(body.guardianName, 'guardianName');
      const guardianPhone = asNonEmptyString(body.guardianPhone, 'guardianPhone');
      const oldName = asNonEmptyString(before.name, 'name');
      const oldGuardian = asNonEmptyString(before.guardianName, 'guardianName');
      const oldPhone = asNonEmptyString(before.guardianPhone, 'guardianPhone');
      if (name.length > 100 || guardianName.length > 100 || guardianPhone.length > 50) throw new Error('INVALID_LENGTH');
      const result = db.prepare('UPDATE students SET name = ?, guardian_name = ?, guardian_phone = ? WHERE id = ? AND owner_id = ? AND name = ? AND guardian_name = ? AND guardian_phone = ?').run(name, guardianName, guardianPhone, studentMatch[1], user.id, oldName, oldGuardian, oldPhone);
      if (Number(result.changes) !== 1) return sendError(res, 409, 'STUDENT_CHANGED', '学生资料已变更，请刷新后重试');
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效的学生和家长资料');
      throw error;
    }
  }
  if (req.method === 'GET' && studentMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    const student = db.prepare('SELECT s.*, u.name AS owner_name FROM students s JOIN users u ON u.id = s.owner_id WHERE s.id = ?').get(studentMatch[1]) as Record<string, unknown> | undefined;
    if (!student) return sendError(res, 404, 'STUDENT_NOT_FOUND', '学生不存在');
    if (String(student.owner_id) !== user.id) return sendError(res, 403, 'FORBIDDEN', '只能查看自己负责的学生详情');
    const inquiries = db.prepare('SELECT i.*, s.name AS student_name FROM inquiries i JOIN students s ON s.id = i.student_id WHERE s.id = ? ORDER BY i.created_at DESC').all(studentMatch[1]).map((row) => mapInquiry(row as Record<string, unknown>));
    const trials = db.prepare('SELECT t.*, s.name AS student_name, u.name AS teacher_name FROM trial_lessons t JOIN students s ON s.id = t.student_id LEFT JOIN trial_teachers tt ON tt.trial_id = t.id LEFT JOIN users u ON u.id = tt.teacher_id WHERE s.id = ? ORDER BY t.scheduled_at DESC').all(studentMatch[1]).map((row) => mapTrial(row as Record<string, unknown>));
    const followUps = db.prepare('SELECT f.*, s.name AS student_name, r.notes AS result_note, r.outcome AS result_outcome FROM follow_ups f JOIN students s ON s.id = f.student_id LEFT JOIN follow_up_results r ON r.follow_up_id = f.id WHERE s.id = ? ORDER BY f.created_at DESC').all(studentMatch[1]).map((row) => mapFollowUp(row as Record<string, unknown>));
    const teacherHistory = db.prepare('SELECT a.teacher_id AS teacherId, t.name AS teacherName, a.assigned_at AS assignedAt, u.name AS assignedByName FROM teacher_assignments a JOIN users t ON t.id = a.teacher_id JOIN users u ON u.id = a.assigned_by WHERE a.student_id = ? ORDER BY a.rowid').all(studentMatch[1]);
    const trialReschedules = db.prepare('SELECT r.trial_id AS trialId, r.previous_scheduled_at AS previousScheduledAt, r.scheduled_at AS scheduledAt, r.reason, r.changed_at AS changedAt, u.name AS changedByName FROM trial_reschedules r JOIN trial_lessons t ON t.id = r.trial_id JOIN users u ON u.id = r.changed_by WHERE t.student_id = ? ORDER BY r.rowid').all(studentMatch[1]);
    const trialCancellations = db.prepare('SELECT c.trial_id AS trialId, c.reason, c.cancelled_at AS cancelledAt, u.name AS cancelledByName FROM trial_cancellations c JOIN trial_lessons t ON t.id = c.trial_id JOIN users u ON u.id = c.cancelled_by WHERE t.student_id = ? ORDER BY c.rowid').all(studentMatch[1]);
    const teacher = teacherHistory.at(-1);
    return sendJson(res, 200, { student: { id: String(student.id), name: String(student.name), guardianName: String(student.guardian_name), guardianPhone: String(student.guardian_phone), ownerId: String(student.owner_id), ownerName: String(student.owner_name), teacherId: teacher?.teacherId ?? null, teacherName: teacher?.teacherName ?? null, status: student.status === 'active' ? 'enrollment_intent' : String(student.status), createdAt: String(student.created_at) }, inquiries, trials, followUps, teacherHistory, trialReschedules, trialCancellations });
  }

  const returningInquiryMatch = path.match(/^\/api\/students\/([^/]+)\/inquiries$/);
  if (req.method === 'POST' && returningInquiryMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const key = asNonEmptyString(req.headers['x-idempotency-key'], 'key');
      const body = await readJson(req);
      const channel = asNonEmptyString(body.channel, 'channel');
      const summary = asNonEmptyString(body.summary, 'summary');
      if (key.length > 128 || channel.length > 100 || summary.length > 2000) throw new Error('INVALID_LENGTH');
      const result = createReturningInquiry(returningInquiryMatch[1], user.id, key, channel, summary);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效的咨询信息');
      throw error;
    }
  }

  const teacherMatch = path.match(/^\/api\/students\/([^/]+)\/teacher$/);
  const rescheduleMatch = path.match(/^\/api\/trials\/([^/]+)\/reschedule$/);
  const cancelMatch = path.match(/^\/api\/trials\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && (teacherMatch || rescheduleMatch || cancelMatch)) {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const key = asNonEmptyString(req.headers['x-idempotency-key'], 'key');
      if (key.length > 128) throw new Error('INVALID_KEY');
      const body = await readJson(req);
      if (teacherMatch) {
        const teacherId = asNonEmptyString(body.teacherId, 'teacherId');
        if (body.expectedTeacherId !== null && typeof body.expectedTeacherId !== 'string') throw new Error('INVALID_TEACHER');
        const result = assignTeacher(teacherMatch[1], user.id, key, teacherId, body.expectedTeacherId as string | null);
        return sendJson(res, result.status, result.body);
      }
      const expected = asDate(body.expectedScheduledAt, 'expectedScheduledAt');
      const reason = asNonEmptyString(body.reason, 'reason');
      if (reason.length > 500) throw new Error('INVALID_REASON');
      if (cancelMatch) {
        const result = cancelTrial(cancelMatch[1], user.id, key, expected, reason);
        return sendJson(res, result.status, result.body);
      }
      const scheduledAt = asDate(body.scheduledAt, 'scheduledAt');
      const result = rescheduleTrial(rescheduleMatch![1], user.id, key, scheduledAt, expected, reason);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效的请求信息');
      throw error;
    }
  }

  if (req.method === 'POST' && path === '/api/leads') {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const body = await readJson(req) as Partial<CreateLeadInput>;
      const studentName = asNonEmptyString(body.studentName, 'studentName');
      const guardianName = asNonEmptyString(body.guardianName, 'guardianName');
      const guardianPhone = asNonEmptyString(body.guardianPhone, 'guardianPhone');
      const channel = asNonEmptyString(body.channel, 'channel');
      const summary = asNonEmptyString(body.summary, 'summary');
      const allowDuplicate = body.allowDuplicate === undefined ? false : body.allowDuplicate;
      if (typeof allowDuplicate !== 'boolean') throw new Error('INVALID_ALLOW_DUPLICATE');
      if (studentName.length > 100 || guardianName.length > 100 || guardianPhone.length > 50 || channel.length > 100 || summary.length > 2000) throw new Error('INVALID_LENGTH');
      if (!allowDuplicate) {
        const matches = db.prepare(`
          SELECT id, name, guardian_name, guardian_phone, status, created_at
          FROM students
          WHERE owner_id = ?
            AND (
              guardian_phone = ?
              OR (LOWER(TRIM(name)) = LOWER(TRIM(?)) AND LOWER(TRIM(guardian_name)) = LOWER(TRIM(?)))
            )
          ORDER BY created_at DESC
          LIMIT 5
        `).all(user.id, guardianPhone, studentName, guardianName).map((row) => mapDuplicateStudent(row as Record<string, unknown>));
        if (matches.length > 0) return sendJson(res, 409, { code: 'DUPLICATE_STUDENT', error: '发现可能重复的学生记录', matches });
      }
      const studentId = id('stu');
      const inquiryId = id('inq');
      const now = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO students (id, name, guardian_name, guardian_phone, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(studentId, studentName, guardianName, guardianPhone, user.id, 'lead', now);
        db.prepare('INSERT INTO inquiries (id, student_id, owner_id, channel, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(inquiryId, studentId, user.id, channel, summary, 'new', now, now);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, 201, { studentId, inquiryId });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写完整且有效的咨询信息');
      throw error;
    }
  }

  const trialScheduleMatch = path.match(/^\/api\/inquiries\/([^/]+)\/trial$/);
  if (req.method === 'POST' && trialScheduleMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const inquiryId = trialScheduleMatch[1];
      const body = await readJson(req) as Partial<ScheduleTrialInput>;
      const scheduledAt = asDate(body.scheduledAt, 'scheduledAt');
      if (scheduledAt <= nowIso()) throw new Error('INVALID_SCHEDULED_AT');
      const teacherId = body.teacherId === undefined ? null : asNonEmptyString(body.teacherId, 'teacherId');
      if (teacherId && !teacherExists(teacherId)) throw new Error('INVALID_TEACHER');
      const inquiry = db.prepare('SELECT i.*, s.owner_id FROM inquiries i JOIN students s ON s.id = i.student_id WHERE i.id = ?').get(inquiryId) as Record<string, unknown> | undefined;
      if (!inquiry) return sendError(res, 404, 'INQUIRY_NOT_FOUND', '咨询记录不存在');
      if (String(inquiry.owner_id) !== user.id) return sendError(res, 403, 'FORBIDDEN', '只能操作自己负责的学生');
      if (!['new', 'contacted'].includes(String(inquiry.status))) return sendError(res, 409, 'INVALID_INQUIRY_STATE', '当前咨询状态不能安排试听');
      const conflict = db.prepare("SELECT id FROM trial_lessons WHERE student_id = ? AND status = 'scheduled'").get(String(inquiry.student_id));
      if (conflict) return sendError(res, 409, 'TRIAL_ALREADY_SCHEDULED', '该学生已有一条待完成试听');
      const trialTeacher = teacherId ?? currentTeacher(String(inquiry.student_id));
      if (trialTeacher) {
        const teacherConflict = db.prepare("SELECT t.id FROM trial_lessons t JOIN trial_teachers tt ON tt.trial_id = t.id WHERE t.status = 'scheduled' AND tt.teacher_id = ? AND t.scheduled_at = ?").get(trialTeacher, scheduledAt);
        if (teacherConflict) return sendError(res, 409, 'TEACHER_BUSY', '该老师在这个时间已有另一场试听，请选择其他时间');
      }
      const trialId = id('trl');
      const now = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO trial_lessons (id, student_id, inquiry_id, scheduled_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(trialId, String(inquiry.student_id), inquiryId, scheduledAt, 'scheduled', user.id, now);
        if (teacherId && currentTeacher(String(inquiry.student_id)) !== teacherId) setTeacher(String(inquiry.student_id), teacherId, user.id);
        if (trialTeacher) db.prepare('INSERT INTO trial_teachers (trial_id, teacher_id) VALUES (?, ?)').run(trialId, trialTeacher);
        db.prepare("UPDATE inquiries SET status = 'trial_scheduled', updated_at = ? WHERE id = ?").run(now, inquiryId);
        db.prepare("UPDATE students SET status = 'trial' WHERE id = ?").run(String(inquiry.student_id));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, 201, { trialId });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请输入有效的试听时间');
      throw error;
    }
  }

  const trialCompleteMatch = path.match(/^\/api\/trials\/([^/]+)\/complete$/);
  if (req.method === 'POST' && trialCompleteMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const trialId = trialCompleteMatch[1];
      const body = await readJson(req) as Partial<CompleteTrialInput>;
      const outcome = body.outcome;
      if (!['interested', 'undecided', 'not_interested'].includes(String(outcome))) throw new Error('INVALID_OUTCOME');
      const selectedOutcome = outcome as TrialOutcome;
      const notes = asNonEmptyString(body.notes, 'notes');
      const trial = db.prepare('SELECT t.*, s.owner_id FROM trial_lessons t JOIN students s ON s.id = t.student_id WHERE t.id = ?').get(trialId) as Record<string, unknown> | undefined;
      if (!trial) return sendError(res, 404, 'TRIAL_NOT_FOUND', '试听记录不存在');
      if (String(trial.owner_id) !== user.id) return sendError(res, 403, 'FORBIDDEN', '只能操作自己负责的学生');
      if (String(trial.status) !== 'scheduled') return sendError(res, 409, 'TRIAL_ALREADY_COMPLETED', '该试听已处理');
      const aiSummary = selectedOutcome === 'not_interested' ? '' : await generateAiSummary({ outcome: selectedOutcome, notes });
      const now = nowIso();
      const dueAt = body.followUpDueAt ? asDate(body.followUpDueAt, 'followUpDueAt') : new Date(Date.now() + (selectedOutcome === 'interested' ? 2 : 3) * 86_400_000).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db.prepare("UPDATE trial_lessons SET status = ?, outcome = ?, notes = ? WHERE id = ? AND status = 'scheduled' AND scheduled_at = ?").run('completed', selectedOutcome, notes, trialId, String(trial.scheduled_at));
        if (Number(updated.changes) !== 1) {
          db.exec('ROLLBACK');
          return sendError(res, 409, 'TRIAL_CHANGED', '试听已改期或处理，请刷新后重试');
        }
        db.prepare("UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?").run(selectedOutcome === 'not_interested' ? 'lost' : 'contacted', now, String(trial.inquiry_id));
        db.prepare('UPDATE students SET status = ? WHERE id = ?').run(selectedOutcome === 'not_interested' ? 'lost' : 'trial', String(trial.student_id));
        if (selectedOutcome === 'not_interested') {
          db.prepare("UPDATE follow_ups SET status = 'skipped', completed_at = ? WHERE student_id = ? AND status = 'pending'").run(now, String(trial.student_id));
        }
        if (selectedOutcome === 'interested' || selectedOutcome === 'undecided') {
          db.prepare('INSERT INTO follow_ups (id, student_id, inquiry_id, due_at, status, note, ai_summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id('fup'), String(trial.student_id), String(trial.inquiry_id), dueAt, 'pending', selectedOutcome === 'interested' ? '确认报名意向与课程安排' : '回访并了解家长顾虑', aiSummary, user.id, now);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, 200, { aiSummary });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效的试听结果');
      throw error;
    }
  }

  const followUpMatch = path.match(/^\/api\/follow-ups\/([^/]+)\/complete$/);
  if (req.method === 'POST' && followUpMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;
    const followUp = db.prepare('SELECT f.*, s.owner_id FROM follow_ups f JOIN students s ON s.id = f.student_id WHERE f.id = ?').get(followUpMatch[1]) as Record<string, unknown> | undefined;
    if (!followUp) return sendError(res, 404, 'FOLLOW_UP_NOT_FOUND', '跟进任务不存在');
    if (String(followUp.owner_id) !== user.id) return sendError(res, 403, 'FORBIDDEN', '只能操作自己负责的学生');
    if (String(followUp.status) !== 'pending') return sendError(res, 409, 'FOLLOW_UP_ALREADY_COMPLETED', '该跟进已处理');
    try {
      const body = await readJson(req) as Partial<CompleteFollowUpInput>;
      const notes = asNonEmptyString(body.notes, 'notes');
      const outcome = body.outcome;
      if (outcome !== 'continue' && outcome !== 'converted' && outcome !== 'lost') throw new Error('INVALID_OUTCOME');
      const dueAt = outcome === 'continue' ? asDate(body.nextDueAt, 'nextDueAt') : null;
      if (dueAt && dueAt <= nowIso()) throw new Error('INVALID_NEXTDUEDATE');
      const now = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db.prepare("UPDATE follow_ups SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'").run(now, followUpMatch[1]);
        if (Number(updated.changes) !== 1) {
          db.exec('ROLLBACK');
          return sendError(res, 409, 'FOLLOW_UP_ALREADY_COMPLETED', '该跟进已处理');
        }
        db.prepare('INSERT INTO follow_up_results (follow_up_id, notes, outcome, created_at) VALUES (?, ?, ?, ?)').run(followUpMatch[1], notes, outcome, now);
        if (outcome === 'continue' && dueAt) {
          db.prepare("INSERT INTO follow_ups (id, student_id, inquiry_id, due_at, status, note, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)").run(id('fup'), String(followUp.student_id), String(followUp.inquiry_id), dueAt, '再次联系家长', user.id, now);
        } else {
          db.prepare("UPDATE follow_ups SET status = 'skipped', completed_at = ? WHERE student_id = ? AND status = 'pending'").run(now, String(followUp.student_id));
          db.prepare("UPDATE trial_lessons SET status = 'cancelled' WHERE student_id = ? AND status = 'scheduled'").run(String(followUp.student_id));
          db.prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?').run(outcome, now, String(followUp.inquiry_id));
          db.prepare('UPDATE students SET status = ? WHERE id = ?').run(outcome === 'converted' ? 'active' : 'lost', String(followUp.student_id));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_')) return sendError(res, 400, 'INVALID_REQUEST', '请填写有效的跟进结果和下次联系时间');
      throw error;
    }
  }

  return sendError(res, 404, 'NOT_FOUND', '接口不存在');
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[api-error]', error);
    if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', '服务暂时不可用');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Student management API listening on http://127.0.0.1:${port}`);
});

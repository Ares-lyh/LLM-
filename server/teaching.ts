import { Temporal } from '@js-temporal/polyfill';
import { db, nowIso } from './db.js';
import type { TeacherDashboardDto, TeacherStudentDetailDto, TeacherStudentDto, TeacherTrialDto, TrialOutcome, TrialStatus } from '../src/shared/contracts.js';

type Result = { status: number; body: unknown };
const badQuery = (): Result => ({ status: 400, body: { code: 'INVALID_REQUEST', error: '分页、搜索或筛选参数无效' } });

function listQuery(url: URL) {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
  const search = (url.searchParams.get('search') ?? '').trim();
  if (!Number.isInteger(page) || page < 1 || page > 10_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || search.length > 100) return null;
  return { page, pageSize, search: `%${search.toLowerCase()}%` };
}

function todayBounds() {
  const today = Temporal.Now.zonedDateTimeISO('Australia/Melbourne').toPlainDate();
  return {
    start: new Date(today.toZonedDateTime('Australia/Melbourne').epochMilliseconds).toISOString(),
    end: new Date(today.add({ days: 1 }).toZonedDateTime('Australia/Melbourne').epochMilliseconds).toISOString(),
  };
}

const trialSelect = `SELECT t.*, s.name AS student_name, owner.name AS owner_name,
  teacher.name AS teacher_name, i.summary AS learning_goal,
  actor.name AS completed_by_name, f.completed_at
  FROM trial_lessons t JOIN trial_teachers tt ON tt.trial_id = t.id
  JOIN students s ON s.id = t.student_id JOIN users owner ON owner.id = s.owner_id
  JOIN users teacher ON teacher.id = tt.teacher_id JOIN inquiries i ON i.id = t.inquiry_id
  LEFT JOIN trial_feedback f ON f.trial_id = t.id LEFT JOIN users actor ON actor.id = f.completed_by`;

function trialDto(row: Record<string, unknown>): TeacherTrialDto {
  return {
    id: String(row.id), inquiryId: String(row.inquiry_id), studentId: String(row.student_id),
    studentName: String(row.student_name), scheduledAt: String(row.scheduled_at),
    status: String(row.status) as TrialStatus, outcome: row.outcome as TrialOutcome | null,
    notes: row.notes as string | null, teacherName: String(row.teacher_name), ownerName: String(row.owner_name),
    learningGoal: String(row.learning_goal), completedByName: row.completed_by_name as string | null,
    completedAt: row.completed_at as string | null,
  };
}

export function teacherDashboard(teacherId: string): TeacherDashboardDto {
  const { start, end } = todayBounds();
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN t.status = 'scheduled' AND t.scheduled_at >= ? AND t.scheduled_at < ? THEN 1 ELSE 0 END) AS today,
    SUM(CASE WHEN t.status = 'scheduled' AND t.scheduled_at <= ? THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM trial_lessons t JOIN trial_teachers tt ON tt.trial_id = t.id WHERE tt.teacher_id = ?`).get(start, end, nowIso(), teacherId) as Record<string, number | null>;
  const students = db.prepare('SELECT COUNT(*) AS total FROM teacher_assignments WHERE teacher_id = ? AND ended_at IS NULL').get(teacherId) as { total: number };
  const nextTrials = db.prepare(`${trialSelect} WHERE tt.teacher_id = ? AND t.status = 'scheduled' ORDER BY t.scheduled_at, t.id LIMIT 6`).all(teacherId).map((row) => trialDto(row as Record<string, unknown>));
  return { counts: { students: students.total, todayTrials: Number(counts.today ?? 0), pendingFeedback: Number(counts.pending ?? 0), completedTrials: Number(counts.completed ?? 0) }, nextTrials };
}

export function teacherTrials(teacherId: string, url: URL): Result {
  const query = listQuery(url);
  const filter = url.searchParams.get('filter') ?? 'all';
  if (!query || !['all', 'today', 'upcoming', 'pending', 'completed', 'cancelled'].includes(filter)) return badQuery();
  const { start, end } = todayBounds();
  const time = nowIso();
  const filters: Record<string, { sql: string; params: string[] }> = {
    all: { sql: '1 = 1', params: [] },
    today: { sql: "t.status = 'scheduled' AND t.scheduled_at >= ? AND t.scheduled_at < ?", params: [start, end] },
    upcoming: { sql: "t.status = 'scheduled' AND t.scheduled_at > ?", params: [time] },
    pending: { sql: "t.status = 'scheduled' AND t.scheduled_at <= ?", params: [time] },
    completed: { sql: "t.status = 'completed'", params: [] },
    cancelled: { sql: "t.status = 'cancelled'", params: [] },
  };
  const selected = filters[filter];
  const where = `tt.teacher_id = ? AND (LOWER(s.name) LIKE ? OR LOWER(i.summary) LIKE ?) AND (${selected.sql})`;
  const params = [teacherId, query.search, query.search, ...selected.params];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM (${trialSelect} WHERE ${where})`).get(...params) as { total: number }).total;
  const order = filter === 'completed' || filter === 'cancelled' ? 'DESC' : 'ASC';
  const items = db.prepare(`${trialSelect} WHERE ${where} ORDER BY t.scheduled_at ${order}, t.id LIMIT ? OFFSET ?`).all(...params, query.pageSize, (query.page - 1) * query.pageSize).map((row) => trialDto(row as Record<string, unknown>));
  return { status: 200, body: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) } };
}

const studentSelect = `SELECT s.id, s.name, owner.name AS owner_name,
  COALESCE((SELECT summary FROM inquiries WHERE student_id = s.id ORDER BY created_at DESC, rowid DESC LIMIT 1), '') AS learning_goal
  FROM students s JOIN users owner ON owner.id = s.owner_id`;

function studentDto(row: Record<string, unknown>): TeacherStudentDto {
  return { id: String(row.id), name: String(row.name), ownerName: String(row.owner_name), learningGoal: String(row.learning_goal) };
}

export function teacherStudents(teacherId: string, url: URL): Result {
  const query = listQuery(url);
  if (!query) return badQuery();
  const where = `EXISTS (SELECT 1 FROM teacher_assignments a WHERE a.student_id = s.id AND a.teacher_id = ? AND a.ended_at IS NULL) AND LOWER(s.name) LIKE ?`;
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM students s WHERE ${where}`).get(teacherId, query.search) as { total: number }).total;
  const items = db.prepare(`${studentSelect} WHERE ${where} ORDER BY s.name, s.id LIMIT ? OFFSET ?`).all(teacherId, query.search, query.pageSize, (query.page - 1) * query.pageSize).map((row) => studentDto(row as Record<string, unknown>));
  return { status: 200, body: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) } };
}

export function teacherStudentDetail(teacherId: string, studentId: string): Result {
  const current = db.prepare('SELECT 1 FROM teacher_assignments WHERE teacher_id = ? AND student_id = ? AND ended_at IS NULL').get(teacherId, studentId);
  const ownTrial = db.prepare('SELECT 1 FROM trial_teachers tt JOIN trial_lessons t ON t.id = tt.trial_id WHERE tt.teacher_id = ? AND t.student_id = ? LIMIT 1').get(teacherId, studentId);
  if (!current && !ownTrial) return { status: 404, body: { code: 'STUDENT_NOT_FOUND', error: '学生不存在或未分配给你' } };
  const row = db.prepare(`${studentSelect} WHERE s.id = ?`).get(studentId) as Record<string, unknown>;
  const trials = db.prepare(`${trialSelect} WHERE tt.teacher_id = ? AND t.student_id = ? ORDER BY t.scheduled_at DESC, t.id`).all(teacherId, studentId).map((trial) => trialDto(trial as Record<string, unknown>));
  const student = studentDto(row);
  // Historical teachers see only the requirement attached to their own latest trial.
  if (!current) student.learningGoal = trials[0]?.learningGoal ?? '';
  const body: TeacherStudentDetailDto = { student, trials };
  return { status: 200, body };
}

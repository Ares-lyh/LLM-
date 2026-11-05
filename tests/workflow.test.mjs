import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { melbourneLocalToInstant } from '../dist-server/src/shared/time.js';

let child;
let tempDir;
let dbPath;
let base;
let cookie;
let llmServer;
let raceModelStarted;
const modelRequests = [];
let leadSequence = 0;

async function request(path, method = 'GET', body, session = cookie, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(session ? { Cookie: session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function createLead(name, guardianPhone = `0400${String(++leadSequence).padStart(6, '0')}`) {
  const result = await request('/api/leads', 'POST', { studentName: name, guardianName: 'Test parent', guardianPhone, channel: '电话', summary: 'Test inquiry' });
  assert.equal(result.status, 201);
  return result.body;
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'student-workflow-'));
  dbPath = join(tempDir, 'test.db');
  llmServer = createHttpServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const input = JSON.parse(Buffer.concat(parts).toString());
    modelRequests.push(input);
    const prompt = input.messages[0].content;
    if (prompt.includes('reschedule race')) { raceModelStarted?.(); await new Promise((resolve) => setTimeout(resolve, 300)); }
    if (prompt.includes('model timeout')) await new Promise((resolve) => setTimeout(resolve, 4200));
    if (prompt.includes('model error')) { res.writeHead(503).end(); return; }
    const content = prompt.includes('invalid model') ? '{broken' : JSON.stringify({ summary: '测试建议：联系家长确认课程时间。' });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  const environment = { ...process.env, DB_PATH: dbPath, LLM_API_URL: `http://127.0.0.1:${llmServer.address().port}`, LLM_API_KEY: 'test-only', LLM_MODEL: 'test-model' };
  const seed = spawnSync(process.execPath, ['dist-server/server/seed.js'], { env: environment, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['dist-server/server/index.js'], { env: { ...environment, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
    child.stdout.on('data', (data) => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`API exited: ${code}`)); });
  });
  const login = await request('/api/auth/login', 'POST', { email: 'amy@austin.edu', password: 'demo123' }, '');
  assert.equal(login.status, 200);
  cookie = login.cookie;
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (llmServer) await new Promise((resolve) => llmServer.close(resolve));
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('fresh seed provides a realistic owner workload', async () => {
  const dashboard = await request('/api/dashboard');
  assert.ok(dashboard.body.counts.students >= 25);
  assert.ok(dashboard.body.trials.length > 1);
  assert.ok(dashboard.body.followUps.length > 1);
  const repeated = spawnSync(process.execPath, ['dist-server/server/seed.js'], { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /seed skipped/);
  assert.equal((await request('/api/dashboard')).body.counts.students, dashboard.body.counts.students);
});

test('existing databases gain history tables without changing their students', () => {
  const legacyPath = join(tempDir, 'legacy.db');
  const env = { ...process.env, DB_PATH: legacyPath };
  assert.equal(spawnSync(process.execPath, ['dist-server/server/seed.js'], { env, encoding: 'utf8' }).status, 0);
  const old = new DatabaseSync(legacyPath);
  const count = old.prepare('SELECT COUNT(*) AS count FROM students').get().count;
  old.exec('DROP TABLE inquiry_requests; DROP TABLE trial_cancellations; DROP TABLE trial_reschedules; DROP TABLE trial_teachers; DROP TABLE teacher_assignments;');
  old.close();
  const upgraded = spawnSync(process.execPath, ['dist-server/server/seed.js'], { env, encoding: 'utf8' });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /seed skipped/);
  const check = new DatabaseSync(legacyPath);
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM students').get().count, count);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('teacher_assignments', 'trial_teachers', 'trial_reschedules')").get().count, 3);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '20261105_teacher_and_trial_history'").get().count, 1);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('trial_cancellations', 'inquiry_requests')").get().count, 2);
  check.close();
});

test('teacher assignment and trial rescheduling preserve history and reject stale changes', async () => {
  const db = new DatabaseSync(dbPath);
  const passwordHash = db.prepare("SELECT password_hash FROM users WHERE role = 'admin' LIMIT 1").get().password_hash;
  const insert = db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'teacher', ?, ?)");
  insert.run('teacher-test-1', 'teacher1@example.test', 'Teacher One', passwordHash, new Date().toISOString());
  insert.run('teacher-test-2', 'teacher2@example.test', 'Teacher Two', passwordHash, new Date().toISOString());
  db.close();
  const lead = await createLead('Assignment history');
  assert.equal((await request(`/api/students/${lead.studentId}`)).body.student.teacherId, null);
  const teachers = await request('/api/teachers');
  assert.ok(teachers.body.teachers.some((teacher) => teacher.id === 'teacher-test-1'));
  const scheduled = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-04-01T00:00:00.000Z', teacherId: 'teacher-test-1' });
  assert.equal(scheduled.status, 201);
  const key = { 'X-Idempotency-Key': 'assignment-history-1' };
  const assignment = { teacherId: 'teacher-test-2', expectedTeacherId: 'teacher-test-1' };
  assert.equal((await request(`/api/students/${lead.studentId}/teacher`, 'POST', assignment, cookie, key)).status, 200);
  assert.equal((await request(`/api/students/${lead.studentId}/teacher`, 'POST', assignment, cookie, key)).status, 200);
  assert.equal((await request(`/api/students/${lead.studentId}/teacher`, 'POST', { teacherId: 'teacher-test-1', expectedTeacherId: null }, cookie, { 'X-Idempotency-Key': 'stale-assignment' })).status, 409);
  const change = { scheduledAt: '2030-04-02T00:00:00.000Z', expectedScheduledAt: '2030-04-01T00:00:00.000Z', reason: '家长调整时间' };
  const changeKey = { 'X-Idempotency-Key': 'trial-change-1' };
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', change, cookie, changeKey)).status, 200);
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', change, cookie, changeKey)).status, 200);
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', { ...change, reason: 'another reason' }, cookie, changeKey)).status, 409);
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', change)).status, 400);
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', { ...change, scheduledAt: '2030-04-03T00:00:00.000Z' }, cookie, { 'X-Idempotency-Key': 'trial-change-stale' })).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.student.teacherId, 'teacher-test-2');
  assert.deepEqual(detail.body.teacherHistory.map((item) => item.teacherName), ['Teacher One', 'Teacher Two']);
  assert.equal(detail.body.trials[0].teacherName, 'Teacher One');
  assert.equal(detail.body.trialReschedules.length, 1);
  assert.equal(detail.body.trialReschedules[0].previousScheduledAt, change.expectedScheduledAt);
  assert.equal(detail.body.trialReschedules[0].scheduledAt, change.scheduledAt);
  assert.equal(detail.body.trialReschedules[0].reason, change.reason);
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', change, other.cookie, { 'X-Idempotency-Key': 'other-owner' })).status, 403);
});

test('only admins may create teachers, and teacher input is validated', async () => {
  const input = { name: 'New Teacher', email: 'new-teacher@example.test', password: 'long-test-password' };
  assert.equal((await request('/api/teachers', 'POST', input, '')).status, 401);
  assert.equal((await request('/api/teachers', 'POST', { ...input, password: 'short' })).status, 400);
  assert.equal((await request('/api/teachers', 'POST', input)).status, 201);
  assert.equal((await request('/api/teachers', 'POST', input)).status, 409);
  const login = await request('/api/auth/login', 'POST', { email: input.email, password: input.password }, '');
  assert.equal(login.status, 200);
  assert.equal((await request('/api/teachers', 'POST', { ...input, email: 'other@example.test' }, login.cookie)).status, 403);
  assert.equal((await request('/api/teachers', 'GET', undefined, login.cookie)).status, 403);
});

test('a teacher cannot be double-booked for the same trial time', async () => {
  const db = new DatabaseSync(dbPath);
  const passwordHash = db.prepare("SELECT password_hash FROM users WHERE role = 'admin' LIMIT 1").get().password_hash;
  db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'teacher', ?, ?)").run('teacher-busy', 'busy-teacher@example.test', 'Busy Teacher', passwordHash, new Date().toISOString());
  db.close();
  const first = await createLead('Teacher busy first');
  const second = await createLead('Teacher busy second');
  const scheduledAt = '2030-07-01T09:00:00.000Z';
  assert.equal((await request(`/api/inquiries/${first.inquiryId}/trial`, 'POST', { scheduledAt, teacherId: 'teacher-busy' })).status, 201);
  const conflict = await request(`/api/inquiries/${second.inquiryId}/trial`, 'POST', { scheduledAt, teacherId: 'teacher-busy' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'TEACHER_BUSY');
});

test('new lead warns about duplicate phone and allows explicit override', async () => {
  const first = await createLead('Duplicate student', '0400123456');
  const duplicate = await request('/api/leads', 'POST', {
    studentName: 'Duplicate student copy',
    guardianName: 'Test parent',
    guardianPhone: '0400123456',
    channel: '电话',
    summary: '重复电话测试',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_STUDENT');
  assert.ok(duplicate.body.matches.some((item) => item.id === first.studentId));

  const sameNames = await request('/api/leads', 'POST', {
    studentName: 'Duplicate student',
    guardianName: 'Test parent',
    guardianPhone: '0400123457',
    channel: '微信',
    summary: '重复姓名测试',
  });
  assert.equal(sameNames.status, 409);
  assert.equal(sameNames.body.code, 'DUPLICATE_STUDENT');

  const override = await request('/api/leads', 'POST', {
    studentName: 'Duplicate student copy',
    guardianName: 'Test parent',
    guardianPhone: '0400123456',
    channel: '电话',
    summary: '确认仍然创建',
    allowDuplicate: true,
  });
  assert.equal(override.status, 201);
});

test('trial cancellation preserves its reason and allows a new booking', async () => {
  const lead = await createLead('Cancelled trial');
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-06-01T00:00:00.000Z' });
  const change = { expectedScheduledAt: '2030-06-01T00:00:00.000Z', reason: '家长时间冲突' };
  const key = { 'X-Idempotency-Key': 'cancel-trial-1' };
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', { ...change, reason: ' ' }, cookie, key)).status, 400);
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', { ...change, expectedScheduledAt: '2030-06-02T00:00:00.000Z' }, cookie, key)).status, 409);
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', change, other.cookie, key)).status, 403);
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', change, cookie, key)).status, 200);
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', change, cookie, key)).status, 200);
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', { ...change, reason: '其他原因' }, cookie, key)).status, 409);
  assert.equal((await request(`/api/trials/${trial.body.trialId}/cancel`, 'POST', change, cookie, { 'X-Idempotency-Key': 'cancel-trial-2' })).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.trials[0].status, 'cancelled');
  assert.equal(detail.body.trialCancellations[0].reason, change.reason);
  assert.equal(detail.body.inquiries[0].status, 'contacted');
  const next = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-06-02T00:00:00.000Z' });
  assert.equal(next.status, 201);
});

test('student contact edits preserve ownership and reject stale changes', async () => {
  const lead = await createLead('Original name', '0400000000');
  const update = { name: 'Updated name', guardianName: 'Updated parent', guardianPhone: '0411111111', expected: { name: 'Original name', guardianName: 'Test parent', guardianPhone: '0400000000' } };
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/students/${lead.studentId}`, 'PATCH', update, other.cookie)).status, 403);
  assert.equal((await request(`/api/students/${lead.studentId}`, 'PATCH', update)).status, 200);
  assert.equal((await request(`/api/students/${lead.studentId}`, 'PATCH', update)).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.student.name, 'Updated name');
  assert.equal(detail.body.student.guardianName, 'Updated parent');
  assert.equal(detail.body.student.guardianPhone, '0411111111');
  assert.equal(detail.body.inquiries[0].studentName, 'Updated name');
});

test('new inquiries reopen closed students without erasing historical decisions', async () => {
  const lead = await createLead('Returning student');
  const input = { channel: '电话', summary: '再次咨询周末课程' };
  const key = { 'X-Idempotency-Key': 'returning-inquiry-1' };
  assert.equal((await request(`/api/students/${lead.studentId}/inquiries`, 'POST', input, cookie, key)).status, 409);
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-06-03T00:00:00.000Z' });
  assert.equal((await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'not_interested', notes: '原先不考虑' })).status, 200);
  const reopened = await request(`/api/students/${lead.studentId}/inquiries`, 'POST', input, cookie, key);
  assert.equal(reopened.status, 201);
  const retry = await request(`/api/students/${lead.studentId}/inquiries`, 'POST', input, cookie, key);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.inquiryId, reopened.body.inquiryId);
  assert.equal((await request(`/api/students/${lead.studentId}/inquiries`, 'POST', { ...input, summary: '不同内容' }, cookie, key)).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.student.status, 'lead');
  assert.ok(detail.body.inquiries.some((inquiry) => inquiry.id === lead.inquiryId && inquiry.status === 'lost'));
  assert.ok(detail.body.inquiries.some((inquiry) => inquiry.id === reopened.body.inquiryId && inquiry.status === 'new'));
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/students/${lead.studentId}/inquiries`, 'POST', input, other.cookie, { 'X-Idempotency-Key': 'other-inquiry' })).status, 403);
});

test('completion cannot overwrite a trial rescheduled while AI is running', async () => {
  const lead = await createLead('Reschedule race');
  const scheduled = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-05-01T00:00:00.000Z' });
  const modelStarted = new Promise((resolve) => { raceModelStarted = resolve; });
  const completion = request(`/api/trials/${scheduled.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'reschedule race' });
  await modelStarted;
  const changed = await request(`/api/trials/${scheduled.body.trialId}/reschedule`, 'POST', { expectedScheduledAt: '2030-05-01T00:00:00.000Z', scheduledAt: '2030-05-02T00:00:00.000Z', reason: '改期' }, cookie, { 'X-Idempotency-Key': 'reschedule-race' });
  assert.equal(changed.status, 200);
  assert.equal((await completion).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.trials[0].status, 'scheduled');
  assert.equal(detail.body.trials[0].scheduledAt, '2030-05-02T00:00:00.000Z');
  assert.equal(detail.body.followUps.length, 0);
  raceModelStarted = undefined;
});

test('completion cannot overwrite a trial cancelled while AI is running', async () => {
  const lead = await createLead('Cancellation race');
  const scheduled = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-05-01T00:00:00.000Z' });
  const modelStarted = new Promise((resolve) => { raceModelStarted = resolve; });
  const completion = request(`/api/trials/${scheduled.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'reschedule race' });
  await modelStarted;
  const cancelled = await request(`/api/trials/${scheduled.body.trialId}/cancel`, 'POST', { expectedScheduledAt: '2030-05-01T00:00:00.000Z', reason: '临时取消' }, cookie, { 'X-Idempotency-Key': 'cancel-race' });
  assert.equal(cancelled.status, 200);
  assert.equal((await completion).status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.trials[0].status, 'cancelled');
  assert.equal(detail.body.trialCancellations[0].reason, '临时取消');
  assert.equal(detail.body.followUps.length, 0);
  raceModelStarted = undefined;
});

test('scheduled trials remain visible after many historical trials', async () => {
  const lead = await createLead('Future trial');
  const scheduled = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-02-01T00:00:00.000Z' });
  assert.equal(scheduled.status, 201);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(lead.studentId);
  const insert = db.prepare("INSERT INTO trial_lessons (id, student_id, inquiry_id, scheduled_at, status, created_by, created_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)");
  for (let i = 0; i < 51; i++) insert.run(`history-${i}`, lead.studentId, lead.inquiryId, '2020-01-01T00:00:00.000Z', row.owner_id, '2020-01-01T00:00:00.000Z');
  db.close();
  const dashboard = await request('/api/dashboard');
  assert.ok(dashboard.body.trials.some((trial) => trial.id === scheduled.body.trialId), 'scheduled trial must be visible');
});

test('marking a student lost closes pending follow-ups', async () => {
  const lead = await createLead('Lost student');
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-02-01T00:00:00.000Z' });
  assert.equal(trial.status, 201);
  const db = new DatabaseSync(dbPath);
  const owner = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(lead.studentId);
  db.prepare("INSERT INTO follow_ups (id, student_id, inquiry_id, due_at, status, note, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
    .run('old-followup', lead.studentId, lead.inquiryId, '2030-02-01T00:00:00.000Z', 'Previous call', owner.owner_id, '2020-01-01T00:00:00.000Z');
  db.close();
  const result = await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'not_interested', notes: 'Family declined' });
  assert.equal(result.status, 200);
  const dashboard = await request('/api/dashboard');
  assert.ok(!dashboard.body.followUps.some((item) => item.studentId === lead.studentId && item.status === 'pending'));
});

test('follow-up notes and the next action are persisted and ownership is enforced', async () => {
  const lead = await createLead('Follow-up student', '0400000000');
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00.000Z' });
  const completed = await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'Trial went well' });
  assert.equal(completed.status, 200);
  const dashboard = await request('/api/dashboard');
  const task = dashboard.body.followUps.find((item) => item.studentId === lead.studentId && item.status === 'pending');
  assert.ok(task);
  const invalid = await request(`/api/follow-ups/${task.id}/complete`, 'POST', { notes: '', outcome: 'continue' });
  assert.equal(invalid.status, 400);
  const saved = await request(`/api/follow-ups/${task.id}/complete`, 'POST', { notes: 'Parent asked to call next week', outcome: 'continue', nextDueAt: '2030-03-08T00:00:00.000Z' });
  assert.equal(saved.status, 200);
  const again = await request(`/api/follow-ups/${task.id}/complete`, 'POST', { notes: 'duplicate', outcome: 'lost' });
  assert.equal(again.status, 409);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.student.guardianName, 'Test parent');
  assert.equal(detail.body.student.guardianPhone, '0400000000');
  assert.ok(detail.body.followUps.some((item) => item.resultNote === 'Parent asked to call next week' && item.resultOutcome === 'continue'));
  assert.ok(detail.body.followUps.some((item) => item.status === 'pending' && item.dueAt === '2030-03-08T00:00:00.000Z'));
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/students/${lead.studentId}`, 'GET', undefined, other.cookie)).status, 403);
});

test('authentication, ownership, invalid time and duplicate trial completion are rejected', async () => {
  assert.equal((await request('/api/dashboard', 'GET', undefined, '')).status, 401);
  const lead = await createLead('Permission test');
  assert.equal((await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-01-01T10:00' })).status, 400);
  assert.equal((await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2020-01-01T10:00:00Z' })).status, 400);
  const other = await request('/api/auth/login', 'POST', { email: 'ben@austin.edu', password: 'demo123' }, '');
  assert.equal((await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00Z' }, other.cookie)).status, 403);
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00Z' });
  assert.equal(trial.status, 201);
  const duplicate = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-02T00:00:00Z' });
  assert.equal(duplicate.status, 409);
  const requests = await Promise.all([1, 2].map(() => request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'concurrent completion' })));
  assert.deepEqual(requests.map((r) => r.status).sort(), [200, 409]);
  const dashboard = await request('/api/dashboard');
  assert.equal(dashboard.body.followUps.filter((item) => item.studentId === lead.studentId && item.status === 'pending').length, 1);
});

test('model response is validated and malformed or failed responses fall back', async () => {
  for (const [notes, expected] of [['model success', '测试建议：联系家长确认课程时间。'], ['invalid model', '建议在 2 天内联系家长，确认课程目标、可上课时间和报名意向。'], ['model error', '建议在 2 天内联系家长，确认课程目标、可上课时间和报名意向。'], ['model timeout', '建议在 2 天内联系家长，确认课程目标、可上课时间和报名意向。']]) {
    const lead = await createLead(`AI ${notes}`);
    const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00Z' });
    const result = await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'interested', notes });
    assert.equal(result.status, 200);
    assert.equal(result.body.aiSummary, expected);
  }
  assert.equal(modelRequests[0].response_format.type, 'json_schema');
  assert.equal(modelRequests[0].response_format.json_schema.strict, true);
  const countBefore = modelRequests.length;
  const lead = await createLead('Open circuit');
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00Z' });
  const result = await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'circuit should be open' });
  assert.equal(result.status, 200);
  assert.equal(result.body.aiSummary, '建议在 2 天内联系家长，确认课程目标、可上课时间和报名意向。');
  assert.equal(modelRequests.length, countBefore);
});

test('Melbourne wall times handle daylight saving transitions', () => {
  assert.equal(melbourneLocalToInstant('2026-07-01T10:00'), '2026-07-01T00:00:00Z');
  assert.equal(melbourneLocalToInstant('2026-12-01T10:00'), '2026-11-30T23:00:00Z');
  assert.throws(() => melbourneLocalToInstant('2026-10-04T02:30'), RangeError);
  assert.throws(() => melbourneLocalToInstant('2026-04-05T02:30'), RangeError);
});

test('untrusted browser origins cannot mutate state', async () => {
  const response = await fetch(`${base}/api/leads`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal((await request('/api/leads', 'POST', null)).status, 400);
});

test('enrollment intent closes remaining work and records the decision', async () => {
  const lead = await createLead('Enrollment test');
  const trial = await request(`/api/inquiries/${lead.inquiryId}/trial`, 'POST', { scheduledAt: '2030-03-01T00:00:00Z' });
  await request(`/api/trials/${trial.body.trialId}/complete`, 'POST', { outcome: 'interested', notes: 'Good trial' });
  const dashboard = await request('/api/dashboard');
  const task = dashboard.body.followUps.find((item) => item.studentId === lead.studentId && item.status === 'pending');
  const response = await request(`/api/follow-ups/${task.id}/complete`, 'POST', { outcome: 'converted', notes: 'Family confirmed enrollment' });
  assert.equal(response.status, 200);
  const detail = await request(`/api/students/${lead.studentId}`);
  assert.equal(detail.body.student.status, 'enrollment_intent');
  assert.equal(detail.body.inquiries[0].status, 'converted');
  assert.ok(detail.body.followUps.some((item) => item.resultOutcome === 'converted'));
  assert.ok(!detail.body.followUps.some((item) => item.status === 'pending'));
  const reopened = await request(`/api/students/${lead.studentId}/inquiries`, 'POST', { channel: '电话', summary: '重新咨询' }, cookie, { 'X-Idempotency-Key': 'intent-return' });
  assert.equal(reopened.status, 201);
  const returned = await request(`/api/students/${lead.studentId}`);
  assert.equal(returned.body.student.status, 'lead');
  assert.ok(returned.body.inquiries.some((inquiry) => inquiry.id === lead.inquiryId && inquiry.status === 'converted'));
  assert.ok(returned.body.inquiries.some((inquiry) => inquiry.id === reopened.body.inquiryId && inquiry.status === 'new'));
});

test('repeated failed logins are rate-limited', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/login', 'POST', { email: 'wrong@example.test', password: 'incorrect' }, '')).status, 401);
  assert.equal((await request('/api/auth/login', 'POST', { email: 'wrong@example.test', password: 'incorrect' }, '')).status, 429);
});

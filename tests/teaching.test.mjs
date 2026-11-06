import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

let child, folder, dbPath, base, admin, teacher, other, teacherId, otherId, model;
let sequence = 0;
let modelStarted;
let releaseModel;
async function request(path, method = 'GET', body, session = teacher) {
  const response = await fetch(`${base}${path}`, { method, headers: { Cookie: session ?? '', 'Content-Type': 'application/json', 'X-Idempotency-Key': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function fixture(name, assignedTeacher = teacherId) {
  const lead = await request('/api/leads', 'POST', { studentName: name, guardianName: 'Private parent', guardianPhone: `0499${String(++sequence).padStart(6, '0')}`, channel: '电话', summary: `学习目标 ${name}` }, admin);
  assert.equal(lead.status, 201);
  const scheduledAt = new Date(Date.now() + (sequence + 1) * 86400000).toISOString();
  const trial = await request(`/api/inquiries/${lead.body.inquiryId}/trial`, 'POST', { scheduledAt, teacherId: assignedTeacher }, admin);
  assert.equal(trial.status, 201);
  return { ...lead.body, trialId: trial.body.trialId, scheduledAt };
}
function past(trial) {
  const scheduledAt = new Date(Date.now() - (sequence + 1) * 60000).toISOString();
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE trial_lessons SET scheduled_at = ? WHERE id = ?').run(scheduledAt, trial.trialId);
  db.close();
  return { ...trial, scheduledAt };
}
const feedback = (trial, extra = {}) => ({ outcome: 'interested', notes: '课堂参与积极，建议巩固基础。', expectedScheduledAt: trial.scheduledAt, ...extra });

before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'student-teaching-'));
  dbPath = join(folder, 'teaching.db');
  model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (body.includes('teacher race')) { modelStarted?.(); await new Promise((resolve) => { releaseModel = resolve; }); }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '联系家长确认适合的课程。' }) } }] }));
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DB_PATH: dbPath, PORT: String(port), LLM_API_KEY: 'local-test', LLM_API_URL: `http://127.0.0.1:${model.address().port}`, LLM_MODEL: 'local' };
  const seeded = spawnSync(process.execPath, ['dist-server/server/seed.js'], { env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  child = spawn(process.execPath, ['dist-server/server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
    child.stdout.on('data', (data) => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`API exited ${code}`)); });
  });
  admin = (await request('/api/auth/login', 'POST', { email: 'amy@austin.edu', password: 'demo123' }, '')).cookie;
  const login = await request('/api/auth/login', 'POST', { email: 'teacher@austin.edu', password: 'teacher-demo123' }, '');
  assert.equal(login.status, 200); teacher = login.cookie; teacherId = login.body.user.id;
  const created = await request('/api/teachers', 'POST', { name: 'Other Teacher', email: 'other-teacher@example.test', password: 'other-teacher123' }, admin);
  assert.equal(created.status, 201);
  const otherLogin = await request('/api/auth/login', 'POST', { email: 'other-teacher@example.test', password: 'other-teacher123' }, '');
  other = otherLogin.cookie; otherId = otherLogin.body.user.id;
});
after(async () => {
  releaseModel?.();
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  if (model) await new Promise((resolve) => model.close(resolve));
  if (folder) rmSync(folder, { recursive: true, force: true });
});

test('teacher entry requires teacher role and supports an empty workspace', async () => {
  assert.equal((await request('/api/teacher/dashboard', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/api/teacher/dashboard', 'GET', undefined, admin)).status, 403);
  const empty = await request('/api/teacher/dashboard', 'GET', undefined, other);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.counts, { students: 0, todayTrials: 0, pendingFeedback: 0, completedTrials: 0 });
  assert.deepEqual(empty.body.nextTrials, []);
});

test('teacher lists are scoped, paginated, searchable and omit guardian and sales data', async () => {
  const own = await fixture('Teacher scoped alpha');
  const hidden = await fixture('Other private beta', otherId);
  const roster = await request('/api/teacher/students?search=Teacher%20scoped&pageSize=1');
  assert.equal(roster.body.total, 1); assert.equal(roster.body.items[0].id, own.studentId);
  const detail = await request(`/api/teacher/students/${own.studentId}`);
  assert.equal(detail.status, 200); assert.equal(detail.body.trials[0].id, own.trialId);
  assert.ok(!JSON.stringify(detail.body).includes('Private parent'));
  assert.ok(!JSON.stringify(detail.body).includes('guardianPhone'));
  assert.ok(!('followUps' in detail.body));
  assert.equal((await request(`/api/teacher/students/${hidden.studentId}`)).status, 404);
  const searched = await request('/api/teacher/trials?search=Teacher%20scoped&filter=upcoming&pageSize=1');
  assert.equal(searched.body.total, 1); assert.equal(searched.body.items[0].id, own.trialId);
  const pages = await request('/api/teacher/trials?pageSize=1');
  assert.ok(pages.body.totalPages > 1); assert.equal(pages.body.items.length, 1);
  const page2 = await request('/api/teacher/trials?pageSize=1&page=2');
  assert.notEqual(page2.body.items[0].id, pages.body.items[0].id);
  for (const path of ['/api/teacher/trials?page=0', '/api/teacher/students?pageSize=51', '/api/teacher/trials?filter=invalid', `/api/teacher/students?search=${'a'.repeat(101)}`]) assert.equal((await request(path)).status, 400);
});

test('teachers cannot access admin reads or mutations', async () => {
  const own = await fixture('Admin boundaries');
  for (const path of ['/api/dashboard', '/api/students', '/api/teachers', `/api/students/${own.studentId}`]) assert.equal((await request(path)).status, 403);
  for (const [path, method] of [['/api/leads', 'POST'], ['/api/teachers', 'POST'], [`/api/students/${own.studentId}`, 'PATCH'], [`/api/students/${own.studentId}/teacher`, 'POST'], [`/api/inquiries/${own.inquiryId}/trial`, 'POST'], [`/api/trials/${own.trialId}/reschedule`, 'POST'], [`/api/trials/${own.trialId}/cancel`, 'POST'], ['/api/follow-ups/missing/complete', 'POST']]) assert.equal((await request(path, method, {})).status, 403, path);
});

test('today and pending filters agree with dashboard counts in Melbourne time', async () => {
  past(await fixture('Melbourne today lesson'));
  const dashboard = await request('/api/teacher/dashboard');
  const today = await request('/api/teacher/trials?filter=today&pageSize=50');
  const pending = await request('/api/teacher/trials?filter=pending&pageSize=50');
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(today.body.total, dashboard.body.counts.todayTrials);
  assert.ok(today.body.items.every((trial) => localDate.format(new Date(trial.scheduledAt)) === localDate.format(new Date()) && trial.status === 'scheduled'));
  assert.equal(pending.body.total, dashboard.body.counts.pendingFeedback);
  assert.ok(pending.body.items.every((trial) => new Date(trial.scheduledAt).getTime() <= Date.now() && trial.status === 'scheduled'));
});

test('reassigning a student preserves trial snapshot authority and restricts historical learning goals', async () => {
  let own = await fixture('Historical teacher');
  const assigned = await request(`/api/students/${own.studentId}/teacher`, 'POST', { teacherId: otherId, expectedTeacherId: teacherId }, admin);
  assert.equal(assigned.status, 200);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO inquiries(id, student_id, owner_id, channel, summary, status, created_at, updated_at) VALUES ('private-new-inquiry', ?, (SELECT owner_id FROM students WHERE id = ?), '电话', 'NEW PRIVATE GOAL', 'new', ?, ?)").run(own.studentId, own.studentId, new Date(Date.now() + 1000).toISOString(), new Date().toISOString());
  db.close();
  assert.equal((await request('/api/teacher/students?search=Historical%20teacher')).body.total, 0);
  const historical = await request(`/api/teacher/students/${own.studentId}`);
  assert.equal(historical.status, 200);
  assert.equal(historical.body.student.learningGoal, '学习目标 Historical teacher');
  assert.equal((await request(`/api/teacher/students/${own.studentId}`, 'GET', undefined, other)).body.trials.length, 0);
  own = past(own);
  assert.equal((await request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own), other)).status, 403);
  assert.equal((await request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own))).status, 200);
});

test('feedback validates start time, expected schedule, notes and permissions then records one audited follow-up', async () => {
  let own = await fixture('Audited teacher feedback');
  assert.equal((await request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own))).body.code, 'TRIAL_NOT_STARTED');
  own = past(own);
  const endpoint = `/api/trials/${own.trialId}/complete`;
  assert.equal((await request(endpoint, 'POST', feedback(own, { expectedScheduledAt: undefined }))).status, 400);
  assert.equal((await request(endpoint, 'POST', feedback(own, { expectedScheduledAt: '2020-01-01T00:00:00Z' }))).status, 409);
  assert.equal((await request(endpoint, 'POST', feedback(own, { followUpDueAt: '2030-01-01T00:00:00Z' }))).status, 400);
  assert.equal((await request(endpoint, 'POST', feedback(own, { notes: ' ' }))).status, 400);
  assert.equal((await request(endpoint, 'POST', feedback(own, { notes: 'a'.repeat(2001) }))).status, 400);
  const before = await request('/api/teacher/dashboard');
  assert.ok(before.body.counts.pendingFeedback >= 1);
  const pending = await request('/api/teacher/trials?filter=pending&search=Audited');
  assert.equal(pending.body.total, 1);
  const responses = await Promise.all([request(endpoint, 'POST', feedback(own)), request(endpoint, 'POST', feedback(own), admin)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const detail = await request(`/api/students/${own.studentId}`, 'GET', undefined, admin);
  assert.equal(detail.body.followUps.length, 1);
  assert.ok(detail.body.trials[0].completedAt);
  assert.ok(['Emma Li', 'Amy Chen'].includes(detail.body.trials[0].completedByName));
  assert.equal(detail.body.trials[0].notes, feedback(own).notes);
  assert.equal((await request(endpoint, 'POST', feedback(own))).status, 409);
  assert.equal((await request('/api/teacher/trials?filter=completed&search=Audited')).body.total, 1);
  const after = await request('/api/teacher/dashboard');
  assert.equal(after.body.counts.completedTrials, before.body.counts.completedTrials + 1);
});

test('teacher feedback cannot overwrite a reschedule or cancellation during model generation', async () => {
  for (const operation of ['reschedule', 'cancel']) {
    const own = past(await fixture(`Teacher race ${operation}`));
    const started = new Promise((resolve) => { modelStarted = resolve; });
    const completion = request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own, { notes: `teacher race ${operation}` }));
    await started;
    const change = await request(`/api/trials/${own.trialId}/${operation}`, 'POST', { expectedScheduledAt: own.scheduledAt, scheduledAt: '2030-12-01T00:00:00Z', reason: '家长要求变更' }, admin);
    releaseModel();
    const result = await completion;
    assert.equal(change.status, 200);
    assert.equal(result.status, 409);
    const detail = await request(`/api/students/${own.studentId}`, 'GET', undefined, admin);
    assert.equal(detail.body.followUps.length, 0);
    assert.equal(detail.body.trials[0].completedAt, null);
    if (operation === 'cancel') assert.equal((await request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own))).status, 409);
  }
});

test('negative teacher feedback closes the lead and pending follow-ups', async () => {
  const own = past(await fixture('Negative teacher feedback'));
  assert.equal((await request(`/api/trials/${own.trialId}/complete`, 'POST', feedback(own, { outcome: 'not_interested' }))).status, 200);
  const detail = await request(`/api/students/${own.studentId}`, 'GET', undefined, admin);
  assert.equal(detail.body.student.status, 'lost');
  assert.ok(detail.body.followUps.every((item) => item.status !== 'pending'));
  assert.equal(detail.body.trials[0].completedByName, 'Emma Li');
});

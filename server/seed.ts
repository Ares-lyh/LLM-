import { db, id, nowIso } from './db.js';
import { hashPassword } from './auth.js';
import { setTeacher } from './scheduling.js';

const existing = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
if (Number(existing.count) === 0) {
  const adminA = id('usr');
  const adminB = id('usr');
  const teacher = id('usr');
  const createdAt = nowIso();
  const insertUser = db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insertUser.run(adminA, 'amy@austin.edu', 'Amy Chen', 'admin', hashPassword('demo123'), createdAt);
  insertUser.run(adminB, 'ben@austin.edu', 'Ben Wu', 'admin', hashPassword('demo123'), createdAt);
  insertUser.run(teacher, 'teacher@austin.edu', 'Emma Li', 'teacher', hashPassword('teacher-demo123'), createdAt);

  const insertStudent = db.prepare('INSERT INTO students (id, name, guardian_name, guardian_phone, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertInquiry = db.prepare('INSERT INTO inquiries (id, student_id, owner_id, channel, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertFollowUp = db.prepare('INSERT INTO follow_ups (id, student_id, inquiry_id, due_at, status, note, ai_summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTrial = db.prepare('INSERT INTO trial_lessons (id, student_id, inquiry_id, scheduled_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const samples = [
    ['Liam', 'Grace Liu', '0400 123 456', adminA, '微信', '对数学和科学感兴趣，家长希望周末上课', 'contacted'],
    ['Olivia', 'Henry Zhang', '0400 222 345', adminA, '电话', '五年级，想先体验编程课程', 'trial_scheduled'],
    ['Noah', 'Emma Wang', '0400 555 789', adminB, '官网', '朋友推荐，近期考虑转入系统课程', 'new'],
  ] as const;

  for (const [name, guardian, phone, ownerId, channel, summary, inquiryStatus] of samples) {
    const studentId = id('stu');
    const inquiryId = id('inq');
    insertStudent.run(studentId, name, guardian, phone, ownerId, inquiryStatus === 'trial_scheduled' ? 'trial' : 'lead', createdAt);
    insertInquiry.run(inquiryId, studentId, ownerId, channel, summary, inquiryStatus, createdAt, createdAt);
    if (inquiryStatus === 'contacted') {
      insertFollowUp.run(id('fup'), studentId, inquiryId, new Date(Date.now() - 86_400_000).toISOString(), 'pending', '电话确认课程目标并推荐试听时间', null, ownerId, createdAt);
    }
    if (inquiryStatus === 'trial_scheduled') {
      const trialId = id('trl');
      insertTrial.run(trialId, studentId, inquiryId, new Date(Date.now() - 3600_000).toISOString(), 'scheduled', ownerId, createdAt);
      setTeacher(studentId, teacher, ownerId);
      db.prepare('INSERT INTO trial_teachers (trial_id, teacher_id) VALUES (?, ?)').run(trialId, teacher);
    }
  }
  const names = ['Ava', 'Mason', 'Isla', 'Ethan', 'Charlotte', 'Leo', 'Amelia', 'Lucas', 'Chloe', 'Oliver', 'Sophie', 'Oscar', 'Ella', 'Jack', 'Grace', 'Henry', 'Ruby', 'James', 'Mia', 'Alexander', 'Zoe', 'William', 'Hannah', 'Daniel', 'Lily', 'Thomas', 'Evie', 'Benjamin', 'Mila', 'Samuel', 'Lucy', 'Jacob', 'Alice', 'Joshua', 'Matilda', 'Charlie'];
  const topics = ['希望了解周末数学课程', '对编程体验课感兴趣', '家长询问英语课程安排', '希望提升科学课程基础'];
  for (let index = 0; index < names.length; index++) {
    const ownerId = index < 28 ? adminA : adminB;
    const studentId = id('stu');
    const inquiryId = id('inq');
    const inquiryStatus = index % 3 === 0 ? 'trial_scheduled' : index % 3 === 1 ? 'contacted' : 'new';
    const created = new Date(Date.now() - index * 3600_000).toISOString();
    insertStudent.run(studentId, names[index], `Parent ${index + 1}`, `0400 ${String(index + 101).padStart(3, '0')} 123`, ownerId, inquiryStatus === 'trial_scheduled' ? 'trial' : 'lead', created);
    insertInquiry.run(inquiryId, studentId, ownerId, index % 2 ? '电话' : '官网', topics[index % topics.length], inquiryStatus, created, created);
    if (inquiryStatus === 'contacted') insertFollowUp.run(id('fup'), studentId, inquiryId, new Date(Date.now() + (index % 5 - 2) * 86_400_000).toISOString(), 'pending', '联系家长确认课程需求', null, ownerId, created);
    if (inquiryStatus === 'trial_scheduled') {
      const trialId = id('trl');
      insertTrial.run(trialId, studentId, inquiryId, new Date(Date.now() + (index + 1) * 86_400_000).toISOString(), 'scheduled', ownerId, created);
      if (index < 12) {
        setTeacher(studentId, teacher, ownerId);
        db.prepare('INSERT INTO trial_teachers (trial_id, teacher_id) VALUES (?, ?)').run(trialId, teacher);
      }
    }
  }
  console.log('Seeded demo users and students. Password for both admins: demo123');
  console.log('Demo teacher: teacher@austin.edu / teacher-demo123');
} else {
  console.log('Database already contains users; seed skipped.');
}

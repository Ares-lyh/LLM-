import { useEffect, useState, type FormEvent } from 'react';
import type { StudentDetailDto, TeacherDto, TrialDto } from './shared/contracts';
import { melbourneLocalToInstant } from './shared/time';

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export function TeacherSelector({ api, value, onChange, placeholder = '暂不分配' }: { api: Api; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const [teachers, setTeachers] = useState<TeacherDto[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    api<{ teachers: TeacherDto[] }>('/api/teachers').then((result) => { if (active) setTeachers(result.teachers); }).catch(() => { if (active) setError('老师列表加载失败'); });
    return () => { active = false; };
  }, [api, attempt]);
  if (error) return <div className="form-error" role="alert">{error} <button type="button" className="text-button" onClick={() => setAttempt(attempt + 1)}>重试</button></div>;
  if (!teachers) return <p>正在加载老师…</p>;
  return <label>负责老师<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{placeholder}</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select>{teachers.length === 0 && <small>暂无老师，请先创建老师账号。</small>}</label>;
}

export function TeacherAssignment({ api, detail, onSaved }: { api: Api; detail: StudentDetailDto; onSaved: () => void }) {
  const [teacherId, setTeacherId] = useState(detail.student.teacherId ?? '');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api(`/api/students/${detail.student.id}/teacher`, { method: 'POST', headers: { 'X-Idempotency-Key': key }, body: JSON.stringify({ teacherId, expectedTeacherId: detail.student.teacherId }) });
      setKey(crypto.randomUUID()); onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form teacher-assignment" onSubmit={submit}><TeacherSelector api={api} value={teacherId} onChange={setTeacherId} />{error && <div className="form-error" role="alert">{error}</div>}<button className="small-action" disabled={saving || !teacherId || teacherId === detail.student.teacherId}>{saving ? '保存中…' : '保存负责老师'}</button></form>;
}

export function RescheduleForm({ api, trial, onSaved, onClose }: { api: Api; trial: TrialDto; onSaved: () => void; onClose: () => void }) {
  const [scheduledAt, setScheduledAt] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api(`/api/trials/${trial.id}/reschedule`, { method: 'POST', headers: { 'X-Idempotency-Key': key }, body: JSON.stringify({ scheduledAt: melbourneLocalToInstant(scheduledAt), expectedScheduledAt: trial.scheduledAt, reason }) });
      onSaved();
    } catch (err) { setError(err instanceof RangeError ? '该时间因夏令时不存在或有歧义，请选择其他时间' : err instanceof Error ? err.message : '改期失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form" onSubmit={submit}><label>新试听时间（墨尔本）<input required type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /></label><label>改期原因<textarea required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '确认改期'}</button></div></form>;
}

export function CreateTeacherForm({ api, onSaved, onClose }: { api: Api; onSaved: () => void; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try { await api('/api/teachers', { method: 'POST', body: JSON.stringify(form) }); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : '创建失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form" onSubmit={submit}><label>姓名<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>邮箱<input required type="email" maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>初始密码<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建老师'}</button></div></form>;
}

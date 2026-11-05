import { useState, type FormEvent } from 'react';
import type { StudentDto, TrialDto } from './shared/contracts';

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export function CancelTrialForm({ api, trial, onSaved, onClose }: { api: Api; trial: TrialDto; onSaved: () => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api(`/api/trials/${trial.id}/cancel`, { method: 'POST', headers: { 'X-Idempotency-Key': key }, body: JSON.stringify({ expectedScheduledAt: trial.scheduledAt, reason }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : '取消失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form" onSubmit={submit}><label>取消原因<textarea required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>返回</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '确认取消试听'}</button></div></form>;
}

export function StudentEditForm({ api, student, onSaved, onClose }: { api: Api; student: StudentDto; onSaved: () => void; onClose: () => void }) {
  const [form, setForm] = useState({ name: student.name, guardianName: student.guardianName, guardianPhone: student.guardianPhone });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api(`/api/students/${student.id}`, { method: 'PATCH', body: JSON.stringify({ ...form, expected: { name: student.name, guardianName: student.guardianName, guardianPhone: student.guardianPhone } }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form" onSubmit={submit}><label>学生姓名<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>家长姓名<input required maxLength={100} value={form.guardianName} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} /></label><label>家长电话<input required maxLength={50} value={form.guardianPhone} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存资料'}</button></div></form>;
}

export function ReturningInquiryForm({ api, studentId, onSaved, onClose }: { api: Api; studentId: string; onSaved: () => void; onClose: () => void }) {
  const [form, setForm] = useState({ channel: '微信', summary: '' });
  const [key] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try { await api(`/api/students/${studentId}/inquiries`, { method: 'POST', headers: { 'X-Idempotency-Key': key }, body: JSON.stringify(form) }); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : '创建失败'); } finally { setSaving(false); }
  }
  return <form className="dialog-form" onSubmit={submit}><label>来源<select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}><option>微信</option><option>电话</option><option>官网</option><option>朋友推荐</option></select></label><label>咨询摘要<textarea required maxLength={2000} rows={4} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '创建咨询'}</button></div></form>;
}

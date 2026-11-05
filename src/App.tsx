import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { melbourneLocalToInstant } from './shared/time';
import type { CompleteTrialInput, DashboardDto, FollowUpDto, FollowUpOutcome, InquiryDto, StudentDetailDto, TrialDto, UserDto } from './shared/contracts';

type LoginState = { email: string; password: string };
type Dialog = 'lead' | 'trial' | 'result' | 'followup' | 'student' | null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? '请求失败');
  return body as T;
}

const initialLogin: LoginState = { email: 'amy@austin.edu', password: 'demo123' };

export function App() {
  const [user, setUser] = useState<UserDto | null>(null);
  const [dashboard, setDashboard] = useState<DashboardDto | null>(null);
  const [login, setLogin] = useState(initialLogin);
  const [loginError, setLoginError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedTrial, setSelectedTrial] = useState<TrialDto | null>(null);
  const [selectedFollowUp, setSelectedFollowUp] = useState<FollowUpDto | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [loadError, setLoadError] = useState('');

  async function loadDashboard() {
    setRefreshing(true);
    setLoadError('');
    try {
      const next = await api<DashboardDto>('/api/dashboard');
      setDashboard(next);
    } catch (error) {
      if (error instanceof Error && error.message === '请先登录') setUser(null);
      else setLoadError(error instanceof Error ? error.message : '加载失败');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    api<{ user: UserDto }>('/api/auth/me').then(({ user: me }) => {
      setUser(me);
      return loadDashboard();
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setLoginError('');
    try {
      const result = await api<{ user: UserDto }>('/api/auth/login', { method: 'POST', body: JSON.stringify(login) });
      setUser(result.user);
      await loadDashboard();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败');
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setDashboard(null);
  }

  if (loading) return <div className="center-state"><div className="loader" /><span>正在打开工作台…</span></div>;
  if (!user) return <LoginPage login={login} setLogin={setLogin} error={loginError} onSubmit={submitLogin} />;
  if (!dashboard) return <div className="center-state"><strong>工作台暂时无法加载</strong><span>{loadError}</span><button className="secondary-button" onClick={loadDashboard}>重试</button></div>;

  const pending = dashboard?.followUps.filter((item) => item.status === 'pending') ?? [];
  const trials = dashboard?.trials.filter((item) => item.status === 'scheduled') ?? [];
  const inquiries = dashboard?.inquiries ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">N</span><div><strong>northstar</strong><small>student ops</small></div></div>
        <div className="sidebar-label">工作台</div>
        <nav><div className="nav-item active"><span>⌂</span>今日概览</div></nav>
        <div className="sidebar-bottom"><div className="tip-card"><span className="tip-icon">✦</span><strong>今天先处理最重要的事</strong><p>优先跟进已试听、还没有下一步的学生。</p></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">{new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())}</p><h1>你好，{user.name.split(' ')[0]} <span className="wave">✦</span></h1><p className="subtitle">这里是你今天需要关注的学生动态。</p></div><div className="top-actions"><div className="avatar">{user.name.slice(0, 1)}</div><div className="user-meta"><strong>{user.name}</strong><span>Admin · Melbourne</span></div><button className="logout" onClick={logout}>退出</button></div></header>
        {toast && <div className="toast">{toast}<button onClick={() => setToast('')}>×</button></div>}
        <section className="hero-row"><div><p className="section-kicker">OVERVIEW</p><h2>今天的工作台</h2></div><div className="hero-actions"><button className="secondary-button" onClick={() => loadDashboard()} disabled={refreshing}>↻ {refreshing ? '刷新中' : '刷新'}</button><button className="primary-button" onClick={() => setDialog('lead')}>＋ 新建咨询</button></div></section>{loadError && <div className="form-error">{loadError} <button className="text-button" onClick={loadDashboard}>重试</button></div>}
        <section className="metrics-grid"><Metric label="待跟进" value={dashboard.counts.pendingFollowUps} detail={dashboard.counts.overdueFollowUps ? `${dashboard.counts.overdueFollowUps} 条已逾期` : '全部按时'} tone="amber" icon="↗" /><Metric label="今日试听" value={dashboard.counts.todayTrials} detail="Melbourne 时间" tone="blue" icon="◷" /><Metric label="我的学生" value={dashboard.counts.students} detail="持续跟进中" tone="green" icon="♙" /></section>
        <div className="content-grid"><section className="panel focus-panel"><div className="panel-heading"><div><p className="section-kicker">ACTION QUEUE</p><h3>优先处理</h3></div><span className="count-pill">{pending.length + trials.length} 件</span></div><div className="queue-list">{pending.length === 0 && trials.length === 0 ? <EmptyState title="今天没有待办" text="新建一条咨询，开始你的第一条跟进。" action="新建咨询" onClick={() => setDialog('lead')} /> : <>{pending.map((item) => <FollowUpCard key={item.id} item={item} onComplete={() => { setSelectedFollowUp(item); setDialog('followup'); }} onDetail={() => { setSelectedStudent(item.studentId); setDialog('student'); }} />)}{trials.map((item) => <TrialCard key={item.id} trial={item} onSchedule={() => { setSelectedTrial(item); setDialog('result'); }} />)}</>}</div></section><InquiryList inquiries={inquiries} onDetail={(id) => { setSelectedStudent(id); setDialog('student'); }} onSchedule={(item) => { setSelectedTrial({ id: '', inquiryId: item.id, studentId: item.studentId, studentName: item.studentName, scheduledAt: '', status: 'scheduled', outcome: null, notes: null }); setDialog('trial'); }} /></div>
        <section className="insight-banner"><div className="insight-icon">✦</div><div><strong>工作提醒</strong><p>有 {dashboard.counts.overdueFollowUps} 条逾期任务。先完成逾期跟进，再安排今天的试听。</p></div></section>
      </main>
      {dialog === 'lead' && <LeadDialog onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('咨询已创建'); loadDashboard(); }} />}
      {dialog === 'trial' && selectedTrial && <TrialDialog trial={selectedTrial} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('试听已安排'); loadDashboard(); }} />}
      {dialog === 'result' && selectedTrial && <ResultDialog trial={selectedTrial} onClose={() => setDialog(null)} onCreated={(message) => { setDialog(null); setToast(message); loadDashboard(); }} />}
      {dialog === 'followup' && selectedFollowUp && <FollowUpDialog item={selectedFollowUp} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('跟进记录已保存'); loadDashboard(); }} />}
      {dialog === 'student' && selectedStudent && <StudentDialog id={selectedStudent} onClose={() => setDialog(null)} />}
    </div>
  );
}

function LoginPage({ login, setLogin, error, onSubmit }: { login: LoginState; setLogin: (state: LoginState) => void; error: string; onSubmit: (event: FormEvent) => void }) {
  return <div className="login-shell"><div className="login-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-copy"><span className="brand-mark">N</span><p>Make every student<br /><strong>move forward.</strong></p><small>Student operations, with a clearer next step.</small></div><div className="art-note note-one">01 <span>咨询</span></div><div className="art-note note-two">02 <span>试听</span></div><div className="art-note note-three">03 <span>跟进</span></div></div><div className="login-card"><div className="login-brand"><span className="brand-mark">N</span><strong>northstar</strong></div><div className="login-heading"><p className="section-kicker">WELCOME BACK</p><h1>进入你的工作台</h1><p>把每一个学生的下一步，照亮。</p></div><form onSubmit={onSubmit}><label>工作邮箱<input type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} autoComplete="email" /></label><label>密码<input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoComplete="current-password" /></label>{error && <div className="form-error">{error}</div>}<button className="primary-button full" type="submit">进入工作台 <span>→</span></button></form><p className="login-hint">演示账号：amy@austin.edu · demo123</p></div></div>;
}

function Metric({ label, value, detail, tone, icon }: { label: string; value: number | string; detail: string; tone: string; icon: string }) { return <div className={`metric-card tone-${tone}`}><div className="metric-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></div>; }

function InquiryList({ inquiries, onDetail, onSchedule }: { inquiries: InquiryDto[]; onDetail: (id: string) => void; onSchedule: (item: InquiryDto) => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filtered = inquiries.filter((item) => item.studentName.toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages - 1);
  return <section className="panel timeline-panel"><div className="panel-heading"><div><p className="section-kicker">RECENT ACTIVITY</p><h3>最近咨询</h3></div></div>
    <input className="inquiry-search" type="search" aria-label="搜索学生" placeholder="搜索学生姓名" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
    <div className="activity-list">{filtered.slice(current * 8, current * 8 + 8).map((item, index) => <div className="activity-row" key={item.id}><div className={`activity-dot dot-${index % 3}`} /><div className="activity-copy"><button className="student-link" onClick={() => onDetail(item.studentId)}>{item.studentName}</button><span>{item.summary}</span></div>{item.status === 'new' || item.status === 'contacted' ? <button className="small-action" onClick={() => onSchedule(item)}>安排试听</button> : <StatusChip value={item.status} />}</div>)}{filtered.length === 0 && <EmptyState title={search ? '没有匹配的学生' : '还没有咨询'} text={search ? '试试其他姓名。' : '登记第一位学生后，活动会显示在这里。'} />}</div>
    {pages > 1 && <div className="pagination"><button className="small-action" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {pages}</span><button className="small-action" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button></div>}
  </section>;
}

function FollowUpCard({ item, onComplete, onDetail }: { item: FollowUpDto; onComplete: () => void; onDetail: () => void }) { return <article className="queue-card follow-card"><div className="queue-icon amber">↗</div><div className="queue-main"><div className="queue-title"><button className="student-link" onClick={onDetail}>{item.studentName}</button><span className={new Date(item.dueAt) < new Date() ? 'overdue' : ''}>{new Date(item.dueAt) < new Date() ? '已逾期' : '待跟进'} · {formatDate(item.dueAt)}</span></div><p>{item.note}</p>{item.aiSummary && <div className="ai-note"><span>✦</span>{item.aiSummary}</div>}</div><button className="small-action" onClick={onComplete}>记录跟进</button></article>; }
function TrialCard({ trial, onSchedule }: { trial: TrialDto; onSchedule: () => void }) { return <article className="queue-card"><div className="queue-icon blue">◷</div><div className="queue-main"><div className="queue-title"><strong>{trial.studentName}</strong><span>试听已安排</span></div><p>{formatDate(trial.scheduledAt)} · 等待记录结果</p></div><button className="small-action primary-small" onClick={onSchedule}>记结果</button></article>; }
function StatusChip({ value }: { value: string }) { const map: Record<string, string> = { new: '新咨询', contacted: '已联系', trial_scheduled: '已安排试听', converted: '已转化', lost: '已流失' }; return <span className={`status-chip status-${value}`}>{map[value] ?? value}</span>; }
function EmptyState({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><div className="empty-symbol">○</div><strong>{title}</strong><p>{text}</p>{action && <button className="text-button" onClick={onClick}>{action} →</button>}</div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Australia/Melbourne', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

function LeadDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) { const [form, setForm] = useState({ studentName: '', guardianName: '', guardianPhone: '', channel: '微信', summary: '' }); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(''); try { await api('/api/leads', { method: 'POST', body: JSON.stringify(form) }); onCreated(); } catch (error) { setError(error instanceof Error ? error.message : '创建失败'); } finally { setSaving(false); } } return <Dialog title="新建咨询" eyebrow="NEW INQUIRY" onClose={onClose}><form className="dialog-form" onSubmit={submit}><div className="form-grid"><label>学生姓名<input required value={form.studentName} onChange={(e) => setForm({ ...form, studentName: e.target.value })} placeholder="例如：Liam" /></label><label>家长姓名<input required value={form.guardianName} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} placeholder="例如：Grace Liu" /></label></div><div className="form-grid"><label>家长电话<input required value={form.guardianPhone} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} placeholder="0400 123 456" /></label><label>来源<select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}><option>微信</option><option>电话</option><option>官网</option><option>朋友推荐</option></select></label></div><label>咨询摘要<textarea required value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="学生年级、目标、家长最关心的问题…" rows={4} /></label>{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '创建咨询'}</button></div></form></Dialog>; }
function TrialDialog({ trial, onClose, onCreated }: { trial: TrialDto; onClose: () => void; onCreated: () => void }) { const [scheduledAt, setScheduledAt] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const instant = melbourneLocalToInstant(scheduledAt); await api(`/api/inquiries/${trial.inquiryId}/trial`, { method: 'POST', body: JSON.stringify({ scheduledAt: instant }) }); onCreated(); } catch (error) { setError(error instanceof RangeError ? '该时间因夏令时不存在或有歧义，请选择其他时间' : error instanceof Error ? error.message : '安排失败'); } finally { setSaving(false); } } return <Dialog title={`为 ${trial.studentName} 安排试听`} eyebrow="SCHEDULE TRIAL" onClose={onClose}><form className="dialog-form" onSubmit={submit}><label>试听时间（墨尔本）<input required type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /></label>{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '确认安排'}</button></div></form></Dialog>; }
function ResultDialog({ trial, onClose, onCreated }: { trial: TrialDto; onClose: () => void; onCreated: (message: string) => void }) { const [form, setForm] = useState<CompleteTrialInput>({ outcome: 'interested', notes: '' }); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const result = await api<{ aiSummary: string }>(`/api/trials/${trial.id}/complete`, { method: 'POST', body: JSON.stringify(form) }); onCreated(`试听结果已保存 · ${result.aiSummary}`); } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); } } return <Dialog title={`记录 ${trial.studentName} 的试听结果`} eyebrow="TRIAL OUTCOME" onClose={onClose}><form className="dialog-form" onSubmit={submit}><fieldset><legend>学生意向</legend><div className="choice-grid">{([['interested', '有兴趣', '适合进入报名跟进'], ['undecided', '再考虑', '需要一次回访'], ['not_interested', '暂不考虑', '结束当前线索']] as const).map(([value, label, hint]) => <label className={`choice ${form.outcome === value ? 'selected' : ''}`} key={value}><input type="radio" name="outcome" checked={form.outcome === value} onChange={() => setForm({ ...form, outcome: value })} /><strong>{label}</strong><small>{hint}</small></label>)}</div></fieldset><label>课堂备注<textarea required value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="学生的表现、家长反馈、下一步建议…" rows={5} /></label><p className="ai-hint">✦ 保存后会生成一条结构化跟进建议，AI 不可用时会自动使用规则化建议。</p>{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '分析中…' : '保存试听结果'}</button></div></form></Dialog>; }
function FollowUpDialog({ item, onClose, onCreated }: { item: FollowUpDto; onClose: () => void; onCreated: () => void }) {
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState<FollowUpOutcome>('continue');
  const [nextDue, setNextDue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const nextDueAt = outcome === 'continue' ? melbourneLocalToInstant(nextDue) : undefined;
      await api(`/api/follow-ups/${item.id}/complete`, { method: 'POST', body: JSON.stringify({ notes, outcome, nextDueAt }) });
      onCreated();
    } catch (err) {
      setError(err instanceof RangeError ? '该时间因夏令时不存在或有歧义，请选择其他时间' : err instanceof Error ? err.message : '保存失败');
    } finally { setSaving(false); }
  }
  return <Dialog title={`记录 ${item.studentName} 的跟进`} eyebrow="FOLLOW-UP" onClose={onClose}><form className="dialog-form" onSubmit={submit}>
    <label>沟通记录<textarea required maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="记录家长反馈和沟通结果" /></label>
    <label>跟进结果<select value={outcome} onChange={(e) => setOutcome(e.target.value as FollowUpOutcome)}><option value="continue">继续跟进</option><option value="converted">已报名</option><option value="lost">暂不报名</option></select></label>
    {outcome === 'continue' ? <label>下次联系时间（墨尔本）<input required type="datetime-local" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></label> : <p className="ai-hint">确认后会关闭该学生其余待办，并取消未完成的试听安排。</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存记录'}</button></div>
  </form></Dialog>;
}

function StudentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<StudentDetailDto | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    api<StudentDetailDto>(`/api/students/${id}`).then((data) => { if (active) setDetail(data); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '加载失败'); });
    return () => { active = false; };
  }, [id, attempt]);
  return <Dialog title={detail?.student.name ?? '学生详情'} eyebrow="STUDENT" onClose={onClose}>
    {error ? <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div> : !detail ? <p>正在加载…</p> : <div className="student-detail">
      <div className="contact-row"><span>家长</span><strong>{detail.student.guardianName}</strong><a href={`tel:${detail.student.guardianPhone}`}>{detail.student.guardianPhone}</a></div>
      <h3>咨询记录</h3>{detail.inquiries.length ? detail.inquiries.map((inquiry) => <div className="history-row" key={inquiry.id}><strong>{inquiry.channel} · {formatDate(inquiry.createdAt)}</strong><p>{inquiry.summary}</p></div>) : <p>暂无咨询记录</p>}
      <h3>试听记录</h3>{detail.trials.length ? detail.trials.map((trial) => <div className="history-row" key={trial.id}><strong>{formatDate(trial.scheduledAt)} · {trial.status === 'completed' ? '已完成' : trial.status === 'scheduled' ? '已安排' : '已取消'}</strong>{trial.notes && <p>{trial.notes}</p>}</div>) : <p>暂无试听记录</p>}
      <h3>跟进记录</h3>{detail.followUps.length ? detail.followUps.map((followUp) => <div className="history-row" key={followUp.id}><strong>{formatDate(followUp.dueAt)} · {followUp.status === 'pending' ? '待跟进' : followUp.status === 'completed' ? '已完成' : '已关闭'}</strong><p>{followUp.resultNote ?? followUp.note}</p>{followUp.resultOutcome && <small>{({ continue: '继续跟进', converted: '已报名', lost: '暂不报名' })[followUp.resultOutcome]}</small>}</div>) : <p>暂无跟进记录</p>}
    </div>}
  </Dialog>;
}

function Dialog({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="dialog" role="dialog" aria-modal="true" aria-label={title}><div className="dialog-heading"><div><p className="section-kicker">{eyebrow}</p><h2>{title}</h2></div><button className="close-button" aria-label="关闭" onClick={onClose}>×</button></div>{children}</div></div>; }

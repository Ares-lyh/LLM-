import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import type { TeacherDashboardDto, TeacherPageDto, TeacherStudentDetailDto, TeacherStudentDto, TeacherTrialDto, TeacherTrialFilter, TrialOutcome, UserDto } from './shared/contracts';

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type View = 'overview' | 'trials' | 'students';
const views: [View, string, string][] = [['overview', '教学概览', '◈'], ['trials', '我的试听', '◷'], ['students', '我的学生', '⊞']];
const filters: [TeacherTrialFilter, string][] = [['all', '全部'], ['today', '今天'], ['upcoming', '即将开始'], ['pending', '待反馈'], ['completed', '已完成'], ['cancelled', '已取消']];
const outcomes = { interested: '有兴趣', undecided: '再考虑', not_interested: '暂不考虑' };
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Australia/Melbourne', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

function readNavigation() {
  const p = new URLSearchParams(window.location.search);
  const v = p.get('teacherView');
  const f = p.get('teacherFilter');
  const page = Number(p.get('teacherPage') ?? 1);
  return { view: (views.some(([key]) => key === v) ? v : 'overview') as View, filter: (filters.some(([key]) => key === f) ? f : 'all') as TeacherTrialFilter, page: Number.isInteger(page) && page > 0 && page <= 10000 ? page : 1, search: (p.get('teacherSearch') ?? '').slice(0, 100) };
}

function useResource<T>(api: Api, path: string | null, version: number, onExpired: () => void) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string }>({ data: null, loading: !!path, error: '' });
  const [attempt, setAttempt] = useState(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let active = true;
    setState((old) => ({ ...old, loading: true, error: '' }));
    api<T>(path, { signal: controller.signal }).then((data) => {
      if (active) setState({ data, loading: false, error: '' });
    }).catch((error: Error) => {
      if (!active) return;
      if (error.message === '请先登录') expired.current();
      setState((old) => ({ ...old, loading: false, error: error.message }));
    });
    return () => { active = false; controller.abort(); };
  }, [api, path, version, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

export function TeacherWorkspace({ api, user, onLogout, onSessionExpired }: { api: Api; user: UserDto; onLogout: () => Promise<void>; onSessionExpired: () => void }) {
  const [nav, setNav] = useState(readNavigation);
  const [search, setSearch] = useState(nav.search);
  const [version, setVersion] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<TeacherTrialDto | null>(null);
  const [toast, setToast] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [now, setNow] = useState(Date.now());
  const lastRefresh = useRef(0);
  const navigate = useCallback((changes: Partial<ReturnType<typeof readNavigation>>, replace = false) => {
    const next = { ...readNavigation(), ...changes };
    const url = new URL(window.location.href);
    url.searchParams.set('teacherView', next.view);
    url.searchParams.set('teacherFilter', next.filter);
    url.searchParams.set('teacherPage', String(next.page));
    if (next.search) url.searchParams.set('teacherSearch', next.search); else url.searchParams.delete('teacherSearch');
    if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    setNav(next);
  }, []);
  useEffect(() => {
    const pop = () => { const next = readNavigation(); setNav(next); setSearch(next.search); setDetailId(null); setFeedback(null); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { if (search !== nav.search) navigate({ search, page: 1 }, true); }, 220);
    return () => window.clearTimeout(timer);
  }, [search, nav.search, navigate]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 6500); return () => window.clearTimeout(timer); }, [toast]);
  const dashboard = useResource<TeacherDashboardDto>(api, '/api/teacher/dashboard', version, onSessionExpired);
  const query = `page=${nav.page}&pageSize=10&search=${encodeURIComponent(nav.search)}`;
  const trials = useResource<TeacherPageDto<TeacherTrialDto>>(api, nav.view === 'trials' ? `/api/teacher/trials?${query}&filter=${nav.filter}` : null, version, onSessionExpired);
  const students = useResource<TeacherPageDto<TeacherStudentDto>>(api, nav.view === 'students' ? `/api/teacher/students?${query}` : null, version, onSessionExpired);
  const list = nav.view === 'trials' ? trials : students;
  useEffect(() => {
    if (nav.view !== 'overview' && list.data && !list.loading && !list.error && nav.page > list.data.totalPages) navigate({ page: list.data.totalPages }, true);
  }, [list.data, list.loading, list.error, nav.page, nav.view, navigate]);
  function changeView(view: View) { setSearch(''); navigate({ view, page: 1, search: '' }); }
  function refresh() { if (Date.now() - lastRefresh.current < 800) return; lastRefresh.current = Date.now(); setVersion((value) => value + 1); setNow(Date.now()); }
  const navItems = views.map(([key, label, icon]) => <button key={key} className={`nav-item ${nav.view === key ? 'active' : ''}`} aria-current={nav.view === key ? 'page' : undefined} onClick={() => changeView(key)}><span aria-hidden="true">{icon}</span>{label}</button>);
  const renderTrial = (trial: TeacherTrialDto) => <TeachingTrial key={trial.id} trial={trial} now={now} onDetail={() => setDetailId(trial.studentId)} onFeedback={() => setFeedback(trial)} />;
  return <div className="app-shell teacher-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">N</span><div><strong>northstar</strong><small>teaching workspace</small></div></div><div className="sidebar-label">教师工作台</div><nav aria-label="教师导航">{navItems}</nav><div className="sidebar-bottom"><div className="tip-card"><span className="tip-icon">✦</span><strong>让课堂反馈有后续</strong><p>课后记录表现和意向，负责顾问会收到跟进任务。</p></div></div></aside>
    <main className="main-content"><header className="topbar"><div><p className="eyebrow">TEACHING WORKSPACE</p><h1>{user.name}，你好</h1><p className="subtitle">专注每一次课堂 · 时间均为墨尔本时间</p></div><div className="top-actions"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</span><div className="user-meta"><strong>{user.name}</strong><span>教师</span></div><button className="logout" onClick={() => { setLogoutError(''); void onLogout().catch((error: Error) => setLogoutError(error.message)); }}>退出</button></div></header>
      {logoutError && <p role="alert" className="form-error">{logoutError}</p>}
      <div className="hero-row"><div><p className="section-kicker">MY CLASSROOM</p><h2>{views.find(([key]) => key === nav.view)?.[1]}</h2></div><button className="secondary-button" disabled={dashboard.loading || (nav.view !== 'overview' && list.loading)} onClick={refresh}>刷新数据</button></div>
      {nav.view === 'overview' ? <ResourceState resource={dashboard}>
        {dashboard.data && <><div className="metrics-grid teacher-metrics">{([
          ['负责学生', dashboard.data.counts.students, 'students', 'all'], ['今日试听', dashboard.data.counts.todayTrials, 'trials', 'today'], ['待提交反馈', dashboard.data.counts.pendingFeedback, 'trials', 'pending'], ['已完成试听', dashboard.data.counts.completedTrials, 'trials', 'completed'],
        ] as const).map(([label, count, view, filter]) => <button className="metric-card teacher-metric" key={label} onClick={() => { setSearch(''); navigate({ view, filter, search: '', page: 1 }); }}><div className="metric-top">{label}<span>↗</span></div><strong>{count}</strong><small>查看详情</small></button>)}</div><section className="panel teacher-panel"><div className="teacher-section-heading"><div><h3>近期试听与待反馈</h3><p className="panel-help">优先显示尚未反馈的课程，最多展示 6 节</p></div><button className="small-action" onClick={() => changeView('trials')}>查看全部 →</button></div>{dashboard.data.nextTrials.length ? dashboard.data.nextTrials.map(renderTrial) : <Empty>暂无待上课或待反馈的试听，顾问安排后会显示在这里。</Empty>}</section></>}
      </ResourceState> : <section className="panel teacher-panel"><label className="teacher-search-label">{nav.view === 'trials' ? '搜索学生或课程目标' : '搜索学生姓名'}<input className="inquiry-search" type="search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={nav.view === 'trials' ? '输入姓名或学习目标…' : '输入学生姓名…'} /></label>
        {nav.view === 'trials' && <div className="task-filters" aria-label="试听状态">{filters.map(([key, label]) => <button key={key} className={`filter-chip ${nav.filter === key ? 'selected' : ''}`} aria-pressed={nav.filter === key} onClick={() => navigate({ filter: key, page: 1 })}>{label}</button>)}</div>}
        <ResourceState resource={list}>{nav.view === 'trials' ? trials.data?.items.map(renderTrial) : students.data?.items.map((student) => <article className="teacher-student" key={student.id}><div><button className="student-link" onClick={() => setDetailId(student.id)}>{student.name}</button><p>{student.learningGoal || '暂未记录学习目标'}</p><small>负责顾问：{student.ownerName}</small></div><button className="small-action" onClick={() => setDetailId(student.id)}>查看学习档案 →</button></article>)}{list.data?.items.length === 0 && <Empty>{nav.search ? '没有匹配的学生或课程，请调整关键词。' : nav.view === 'students' ? '暂无负责的学生，请联系顾问分配。' : '当前筛选下暂无试听记录。'}</Empty>}</ResourceState>
        {list.data && <div className="directory-footer"><span>共 {list.data.total} 条记录</span><div className="pagination"><button className="secondary-button" disabled={list.loading || nav.page <= 1} onClick={() => navigate({ page: nav.page - 1 })}>上一页</button><span>{nav.page} / {list.data.totalPages}</span><button className="secondary-button" disabled={list.loading || nav.page >= list.data.totalPages} onClick={() => navigate({ page: nav.page + 1 })}>下一页</button></div></div>}
      </section>}
    </main><nav className="mobile-nav" aria-label="教师移动导航">{navItems}</nav>
    {detailId && <TeacherDetail key={detailId} api={api} studentId={detailId} version={version} onExpired={onSessionExpired} onClose={() => setDetailId(null)} />}
    {feedback && <FeedbackForm api={api} trial={feedback} onClose={() => setFeedback(null)} onExpired={onSessionExpired} onSaved={(message) => { setFeedback(null); setToast(message); setVersion((value) => value + 1); setNow(Date.now()); }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">○</div><strong>暂无记录</strong><p>{children}</p></div>; }
function ResourceState({ resource, children }: { resource: { data: unknown; loading: boolean; error: string; retry: () => void }; children: ReactNode }) {
  return <div aria-busy={resource.loading}>{resource.error && <div className="teacher-error" role="alert"><span>{resource.error}</span><button className="secondary-button" onClick={resource.retry}>重试</button></div>}{resource.loading && !resource.data ? <div className="teacher-skeleton" role="status" aria-label="正在加载教学数据">{[1, 2, 3].map((key) => <div className="skeleton-block" key={key} />)}</div> : <>{resource.loading && <p className="panel-help" role="status">正在更新…</p>}{children}</>}</div>;
}
function TeachingTrial({ trial, now, onDetail, onFeedback }: { trial: TeacherTrialDto; now: number; onDetail?: () => void; onFeedback?: () => void }) {
  const pending = trial.status === 'scheduled' && new Date(trial.scheduledAt).getTime() <= now;
  return <article className="teaching-trial"><div className="teacher-trial-heading"><div>{onDetail ? <button className="student-link" onClick={onDetail}>{trial.studentName}</button> : <strong>{trial.studentName}</strong>}<p className="teacher-time">{date(trial.scheduledAt)}</p></div><span className={`status-chip ${pending ? 'status-contacted' : ''}`}>{trial.status === 'completed' ? '已完成' : trial.status === 'cancelled' ? '已取消' : pending ? '待反馈' : '尚未开始'}</span></div><p className="teacher-goal">{trial.learningGoal}</p><div className="teacher-trial-meta"><span>负责顾问：{trial.ownerName}</span>{onFeedback && pending && <button className="small-action primary-small" onClick={onFeedback}>填写课后反馈</button>}</div>{trial.status === 'completed' && <div className="teacher-feedback"><strong>学生意向：{trial.outcome ? outcomes[trial.outcome] : '未记录'}</strong><p>{trial.notes}</p>{trial.completedAt && <small>{trial.completedByName} · 提交于 {date(trial.completedAt)}</small>}</div>}</article>;
}
function TeacherDetail({ api, studentId, version, onExpired, onClose }: { api: Api; studentId: string; version: number; onExpired: () => void; onClose: () => void }) {
  const resource = useResource<TeacherStudentDetailDto>(api, `/api/teacher/students/${encodeURIComponent(studentId)}`, version, onExpired);
  return <Dialog title={resource.data ? `${resource.data.student.name} 的学习档案` : '学习档案'} eyebrow="STUDENT LEARNING" onClose={onClose}><ResourceState resource={resource}>{resource.data && <div className="student-detail"><p>负责顾问：{resource.data.student.ownerName}</p><h3>学习目标</h3><p className="teacher-goal">{resource.data.student.learningGoal || '暂无学习目标'}</p><h3>我的试听记录</h3><p className="panel-help">仅展示分配给你的试听；学生换老师后，历史授课记录仍可查看。</p>{resource.data.trials.length ? resource.data.trials.map((trial) => <TeachingTrial key={trial.id} trial={trial} now={Date.now()} />) : <Empty>还没有分配给你的试听记录。</Empty>}</div>}</ResourceState></Dialog>;
}
function FeedbackForm({ api, trial, onClose, onSaved, onExpired }: { api: Api; trial: TeacherTrialDto; onClose: () => void; onSaved: (message: string) => void; onExpired: () => void }) {
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState<TrialOutcome>('interested');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setSaving(true); setError('');
    try {
      const result = await api<{ aiSummary: string }>(`/api/trials/${trial.id}/complete`, { method: 'POST', body: JSON.stringify({ notes: notes.trim(), outcome, expectedScheduledAt: trial.scheduledAt }) });
      onSaved(outcome === 'not_interested' ? '反馈已保存，顾问可查看；当前线索已结束。' : `反馈已保存，已为负责顾问创建跟进任务。${result.aiSummary}`);
    } catch (error) {
      if (error instanceof Error && error.message === '请先登录') onExpired();
      setError(error instanceof Error ? error.message : '提交失败，请重试');
    } finally { locked.current = false; setSaving(false); }
  }
  const close = () => { if (!locked.current) onClose(); };
  return <Dialog title={`${trial.studentName} · 课后反馈`} eyebrow="TRIAL FEEDBACK" onClose={close}><form className="dialog-form" onSubmit={submit}><p className="panel-help">{date(trial.scheduledAt)} · 负责顾问：{trial.ownerName}</p><label>学生意向<select value={outcome} disabled={saving} onChange={(event) => setOutcome(event.target.value as TrialOutcome)}>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>课堂表现与下一步建议<textarea required maxLength={2000} disabled={saving} value={notes} onChange={(event) => setNotes(event.target.value)} rows={6} placeholder="记录课堂参与度、掌握情况、需要巩固的内容及建议…" /><span>{notes.length} / 2000</span></label><p className="ai-hint">{outcome === 'not_interested' ? '提交后会结束当前线索并关闭待跟进任务，请确认学生意向。' : '提交后自动为负责顾问创建回访任务。AI 不可用时会采用规则建议。'} 反馈提交后不可修改，请核对后保存。</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" disabled={saving || !notes.trim()}>{saving ? '正在保存…' : '提交课后反馈'}</button></div></form></Dialog>;
}

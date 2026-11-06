import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { melbourneLocalToInstant } from './shared/time';
import { CreateTeacherForm, RescheduleForm, TeacherAssignment, TeacherSelector } from './Scheduling';
import { CancelTrialForm, ReturningInquiryForm, StudentEditForm } from './StudentOperations';
import { Dialog } from './Dialog';
import { TeacherWorkspace } from './TeacherWorkspace';
import { buildWorkspaceUrl, readWorkspaceNavigation, type StudentDirectoryStatus, type TaskFilter, type WorkspaceNavigation, type WorkspaceView } from './shared/navigation';
import type { CompleteTrialInput, DashboardDto, DuplicateStudentDto, FollowUpDto, FollowUpOutcome, InquiryDto, StudentDetailDto, StudentDirectoryDto, TrialDto, UserDto } from './shared/contracts';

type LoginState = { email: string; password: string };
type Dialog = 'lead' | 'trial' | 'result' | 'followup' | 'student' | 'reschedule' | 'cancel-trial' | 'teacher' | null;
type ApiRequestError = Error & { code?: string; details?: unknown };
type ApiClient = <T>(path: string, init?: RequestInit) => Promise<T>;

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function useThrottledCallback<T extends (...args: never[]) => void>(callback: T, wait: number) {
  const callbackRef = useRef(callback);
  const lastCallRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  useEffect(() => { callbackRef.current = callback; }, [callback]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  return useCallback(((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = wait - (now - lastCallRef.current);
    if (remaining <= 0) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      lastCallRef.current = now;
      callbackRef.current(...args);
      return;
    }
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        lastCallRef.current = Date.now();
        callbackRef.current(...args);
      }, remaining);
    }
  }) as (...args: Parameters<T>) => void, [wait]);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? '请求失败') as ApiRequestError;
    error.code = typeof body.code === 'string' ? body.code : undefined;
    error.details = body.matches;
    throw error;
  }
  return body as T;
}

const initialLogin: LoginState = { email: 'amy@austin.edu', password: 'demo123' };

export function App() {
  const [user, setUser] = useState<UserDto | null>(null);
  const [dashboard, setDashboard] = useState<DashboardDto | null>(null);
  const [login, setLogin] = useState(initialLogin);
  const [loginError, setLoginError] = useState('');
  const [loginSaving, setLoginSaving] = useState(false);
  const loginPending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedTrial, setSelectedTrial] = useState<TrialDto | null>(null);
  const [selectedFollowUp, setSelectedFollowUp] = useState<FollowUpDto | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [loadError, setLoadError] = useState('');
  const [navigation, setNavigation] = useState(() => readWorkspaceNavigation(window.location.search));
  const [dataVersion, setDataVersion] = useState(0);
  const view = navigation.view;
  const dashboardRequestRef = useRef<Promise<void> | null>(null);

  const navigate = useCallback((changes: Partial<WorkspaceNavigation>, replace = false) => {
    const nextUrl = buildWorkspaceUrl(window.location.href, changes);
    if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', nextUrl);
      setNavigation(readWorkspaceNavigation(window.location.search));
    }
  }, []);

  const setView = (next: WorkspaceView) => navigate({ view: next });

  useEffect(() => {
    const handlePopState = () => {
      setNavigation(readWorkspaceNavigation(window.location.search));
      setDialog(null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  async function loadDashboard() {
    setDataVersion((value) => value + 1);
    if (dashboardRequestRef.current) return dashboardRequestRef.current;
    const request = (async () => {
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
    })();
    dashboardRequestRef.current = request;
    try {
      await request;
    } finally {
      if (dashboardRequestRef.current === request) dashboardRequestRef.current = null;
    }
  }

  const refreshDashboard = useThrottledCallback(() => { void loadDashboard(); }, 700);

  useEffect(() => {
    api<{ user: UserDto }>('/api/auth/me').then(({ user: me }) => {
      setUser(me);
      if (me.role === 'admin') return loadDashboard();
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (loginPending.current) return;
    loginPending.current = true;
    setLoginSaving(true);
    setLoginError('');
    try {
      const result = await api<{ user: UserDto }>('/api/auth/login', { method: 'POST', body: JSON.stringify(login) });
      setUser(result.user);
      if (result.user.role === 'admin') await loadDashboard();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败');
    } finally {
      loginPending.current = false;
      setLoginSaving(false);
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setDashboard(null);
    setDialog(null);
    setToast('');
  }

  if (loading) return <DashboardSkeleton />;
  if (!user) return <LoginPage login={login} setLogin={setLogin} error={loginError} saving={loginSaving} onSubmit={submitLogin} />;
  if (user.role === 'teacher') return <TeacherWorkspace api={api} user={user} onLogout={logout} onSessionExpired={() => setUser(null)} />;
  if (!dashboard) return <div className="center-state"><strong>工作台暂时无法加载</strong><span>{loadError}</span><button className="secondary-button" onClick={refreshDashboard}>重试</button></div>;

  const pending = dashboard?.followUps.filter((item) => item.status === 'pending') ?? [];
  const trials = dashboard?.trials.filter((item) => item.status === 'scheduled') ?? [];
  const inquiries = dashboard?.inquiries ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">N</span><div><strong>northstar</strong><small>student ops</small></div></div>
        <div className="sidebar-label">工作台</div>
        <nav className="sidebar-nav" aria-label="主导航">
          <NavItem active={view === 'overview'} icon="⌂" label="今日概览" onClick={() => setView('overview')} />
          <NavItem active={view === 'students'} icon="♙" label="学生与咨询" onClick={() => setView('students')} />
          <NavItem active={view === 'tasks'} icon="✓" label="任务中心" onClick={() => setView('tasks')} />
        </nav>
        <div className="sidebar-bottom"><div className="tip-card"><span className="tip-icon">✦</span><strong>今天先处理最重要的事</strong><p>优先跟进已试听、还没有下一步的学生。</p></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">{new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())}</p><h1>你好，{user.name.split(' ')[0]} <span className="wave">✦</span></h1><p className="subtitle">这里是你今天需要关注的学生动态。</p></div><div className="top-actions"><div className="avatar">{user.name.slice(0, 1)}</div><div className="user-meta"><strong>{user.name}</strong><span>Admin · Melbourne</span></div><button className="logout" onClick={logout}>退出</button></div></header>
        {toast && <div className="toast" role="status" aria-live="polite">{toast}<button aria-label="关闭提示" onClick={() => setToast('')}>×</button></div>}
        <section className="hero-row"><div><p className="section-kicker">{view === 'overview' ? 'OVERVIEW' : view === 'students' ? 'STUDENTS & INQUIRIES' : 'TASK CENTER'}</p><h2>{view === 'overview' ? '今天的工作台' : view === 'students' ? '学生与咨询' : '任务中心'}</h2></div><div className="hero-actions"><button className="secondary-button" onClick={() => setDialog('teacher')}>＋ 新建老师</button><button className="secondary-button" onClick={refreshDashboard} disabled={refreshing}>↻ {refreshing ? '刷新中' : '刷新'}</button><button className="primary-button" onClick={() => setDialog('lead')}>＋ 新建咨询</button></div></section>{loadError && <div className="form-error">{loadError} <button className="text-button" onClick={refreshDashboard}>重试</button></div>}
        {view === 'overview' && <>
          <section className="metrics-grid"><Metric label="待跟进" value={dashboard.counts.pendingFollowUps} detail={dashboard.counts.overdueFollowUps ? `${dashboard.counts.overdueFollowUps} 条已逾期` : '全部按时'} tone="amber" icon="↗" /><Metric label="今日试听" value={dashboard.counts.todayTrials} detail="Melbourne 时间" tone="blue" icon="◷" /><Metric label="我的学生" value={dashboard.counts.students} detail="持续跟进中" tone="green" icon="♙" /></section>
          <div className="content-grid"><section className="panel focus-panel"><div className="panel-heading"><div><p className="section-kicker">ACTION QUEUE</p><h3>优先处理</h3></div><span className="count-pill">{pending.length + trials.length} 件</span></div><div className="queue-list">{pending.length === 0 && trials.length === 0 ? <EmptyState title="今天没有待办" text="新建一条咨询，开始你的第一条跟进。" action="新建咨询" onClick={() => setDialog('lead')} /> : <>{pending.map((item) => <FollowUpCard key={item.id} item={item} onComplete={() => { setSelectedFollowUp(item); setDialog('followup'); }} onDetail={() => { setSelectedStudent(item.studentId); setDialog('student'); }} />)}{trials.map((item) => <TrialCard key={item.id} trial={item} onSchedule={() => { setSelectedTrial(item); setDialog('result'); }} onReschedule={() => { setSelectedTrial(item); setDialog('reschedule'); }} onCancel={() => { setSelectedTrial(item); setDialog('cancel-trial'); }} />)}</>}</div></section><InquiryList inquiries={inquiries} onDetail={(id) => { setSelectedStudent(id); setDialog('student'); }} onSchedule={(item) => { setSelectedTrial({ id: '', inquiryId: item.id, studentId: item.studentId, studentName: item.studentName, scheduledAt: '', status: 'scheduled', outcome: null, notes: null, teacherName: null }); setDialog('trial'); }} /></div>
          <section className="insight-banner"><div className="insight-icon">✦</div><div><strong>工作提醒</strong><p>有 {dashboard.counts.overdueFollowUps} 条逾期任务。先完成逾期跟进，再安排今天的试听。</p></div><button className="banner-action" onClick={() => setView('tasks')}>立即处理 →</button></section>
        </>}
        {view === 'students' && <StudentDirectory api={api} query={navigation} onQueryChange={navigate} dataVersion={dataVersion} onDetail={(id) => { setSelectedStudent(id); setDialog('student'); }} onSchedule={(item) => { setSelectedTrial({ id: '', inquiryId: item.id, studentId: item.studentId, studentName: item.studentName, scheduledAt: '', status: 'scheduled', outcome: null, notes: null, teacherName: null }); setDialog('trial'); }} />}
        {view === 'tasks' && <TaskCenter filter={navigation.taskFilter} onFilterChange={(taskFilter) => navigate({ taskFilter })} followUps={pending} trials={trials} onComplete={(item) => { setSelectedFollowUp(item); setDialog('followup'); }} onDetail={(id) => { setSelectedStudent(id); setDialog('student'); }} onResult={(item) => { setSelectedTrial(item); setDialog('result'); }} onReschedule={(item) => { setSelectedTrial(item); setDialog('reschedule'); }} onCancel={(item) => { setSelectedTrial(item); setDialog('cancel-trial'); }} />}
      </main>
      <nav className="mobile-nav" aria-label="移动端主导航"><NavItem active={view === 'overview'} icon="⌂" label="概览" onClick={() => setView('overview')} /><NavItem active={view === 'students'} icon="♙" label="学生" onClick={() => setView('students')} /><NavItem active={view === 'tasks'} icon="✓" label="任务" onClick={() => setView('tasks')} /></nav>
      {dialog === 'lead' && <LeadDialog onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('咨询已创建'); loadDashboard(); }} />}
      {dialog === 'trial' && selectedTrial && <TrialDialog trial={selectedTrial} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('试听已安排'); loadDashboard(); }} />}
      {dialog === 'result' && selectedTrial && <ResultDialog trial={selectedTrial} onClose={() => setDialog(null)} onCreated={(message) => { setDialog(null); setToast(message); loadDashboard(); }} />}
      {dialog === 'followup' && selectedFollowUp && <FollowUpDialog item={selectedFollowUp} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setToast('跟进记录已保存'); loadDashboard(); }} />}
      {dialog === 'student' && selectedStudent && <StudentDialog id={selectedStudent} onClose={() => setDialog(null)} onChanged={() => { loadDashboard(); }} />}
      {dialog === 'reschedule' && selectedTrial && <Dialog title={`为 ${selectedTrial.studentName} 改期`} eyebrow="RESCHEDULE" onClose={() => setDialog(null)}><RescheduleForm api={api} trial={selectedTrial} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setToast('试听已改期'); loadDashboard(); }} /></Dialog>}
      {dialog === 'cancel-trial' && selectedTrial && <Dialog title={`取消 ${selectedTrial.studentName} 的试听`} eyebrow="CANCEL TRIAL" onClose={() => setDialog(null)}><CancelTrialForm api={api} trial={selectedTrial} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setToast('试听已取消'); loadDashboard(); }} /></Dialog>}
      {dialog === 'teacher' && <Dialog title="新建老师" eyebrow="TEACHER" onClose={() => setDialog(null)}><CreateTeacherForm api={api} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setToast('老师账号已创建'); }} /></Dialog>}
    </div>
  );
}

function NavItem({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return <button type="button" className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}><span aria-hidden="true">{icon}</span>{label}</button>;
}

function DashboardSkeleton() {
  return <div className="skeleton-shell" role="status" aria-live="polite" aria-label="正在加载工作台">
    <aside className="skeleton-sidebar"><div className="skeleton-brand"><span className="skeleton-block skeleton-brand-mark" /><span className="skeleton-block skeleton-brand-name" /></div><span className="skeleton-block skeleton-nav-label" /><div className="skeleton-nav-list"><span className="skeleton-block skeleton-nav-item" /><span className="skeleton-block skeleton-nav-item" /><span className="skeleton-block skeleton-nav-item" /></div><span className="skeleton-block skeleton-tip" /></aside>
    <main className="skeleton-main"><div className="skeleton-topbar"><div><span className="skeleton-block skeleton-eyebrow" /><span className="skeleton-block skeleton-title" /><span className="skeleton-block skeleton-subtitle" /></div><div className="skeleton-user"><span className="skeleton-block skeleton-avatar" /><span className="skeleton-block skeleton-user-name" /></div></div><div className="skeleton-hero"><div><span className="skeleton-block skeleton-eyebrow" /><span className="skeleton-block skeleton-heading" /></div><div className="skeleton-actions"><span className="skeleton-block skeleton-action" /><span className="skeleton-block skeleton-action" /></div></div><div className="skeleton-metrics"><span className="skeleton-block skeleton-metric" /><span className="skeleton-block skeleton-metric" /><span className="skeleton-block skeleton-metric" /></div><div className="skeleton-grid"><div className="skeleton-panel"><span className="skeleton-block skeleton-panel-heading" /><span className="skeleton-block skeleton-row" /><span className="skeleton-block skeleton-row" /><span className="skeleton-block skeleton-row" /></div><div className="skeleton-panel"><span className="skeleton-block skeleton-panel-heading" /><span className="skeleton-block skeleton-row" /><span className="skeleton-block skeleton-row" /><span className="skeleton-block skeleton-row" /></div></div></main>
  </div>;
}

function DirectoryTableSkeleton() {
  return <div className="student-table-skeleton" role="status" aria-label="正在加载学生目录">{Array.from({ length: 5 }, (_, index) => <div className="student-table-skeleton-row" key={index}><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /></div>)}</div>;
}

function StudentDirectory({ api, query, onQueryChange, dataVersion, onDetail, onSchedule }: { api: ApiClient; query: WorkspaceNavigation; onQueryChange: (changes: Partial<WorkspaceNavigation>, replace?: boolean) => void; dataVersion: number; onDetail: (id: string) => void; onSchedule: (item: InquiryDto) => void }) {
  const { search, status, page } = query;
  const [draftSearch, setDraftSearch] = useState(search);
  const searchTimerRef = useRef<number | null>(null);
  const [result, setResult] = useState<StudentDirectoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  function cancelPendingSearch() {
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }

  useEffect(() => {
    cancelPendingSearch();
    setDraftSearch(search);
    return cancelPendingSearch;
  }, [query]);

  function changeSearch(value: string) {
    setDraftSearch(value);
    cancelPendingSearch();
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      onQueryChange({ search: value.trim(), page: 1 });
    }, 220);
  }

  function changeFilters(nextStatus: StudentDirectoryStatus, nextSearch = draftSearch) {
    cancelPendingSearch();
    setDraftSearch(nextSearch);
    onQueryChange({ search: nextSearch.trim(), status: nextStatus, page: 1 });
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: '10', search, status });
    api<StudentDirectoryDto>(`/api/students?${params.toString()}`, { signal: controller.signal }).then((next) => {
      if (!active) return;
      if (page > next.totalPages) {
        onQueryChange({ page: next.totalPages }, true);
        return;
      }
      setResult(next);
    }).catch((caught: unknown) => {
      if (active && !(caught instanceof Error && caught.name === 'AbortError')) setError(caught instanceof Error ? caught.message : '学生目录加载失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [api, search, status, page, attempt, dataVersion, onQueryChange]);

  const currentRows = result?.items ?? [];
  const total = result?.total ?? 0;
  const pages = result?.totalPages ?? 1;
  const busy = loading || draftSearch.trim() !== search;
  const hasFilters = draftSearch.trim().length > 0 || status !== 'all';
  const retry = useThrottledCallback(() => setAttempt((value) => value + 1), 700);

  const exportCsv = useThrottledCallback(() => {
    if (busy || error || currentRows.length === 0) return;
    const header = ['学生姓名', '最近咨询', '来源', '状态', '咨询创建时间'];
    const rows = currentRows.map((item) => [item.studentName, item.summary, item.channel, statusLabel(item.status), formatDate(item.createdAt)]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `学生咨询-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, 900);

  return <section className="panel directory-panel">
    <div className="panel-heading directory-heading"><div><p className="section-kicker">STUDENT DIRECTORY</p><h3>学生与咨询</h3><p className="panel-help">按学生汇总最近一条咨询，打开详情查看完整历史。</p></div><button className="secondary-button" type="button" onClick={exportCsv} disabled={busy || !!error || currentRows.length === 0}>导出当前页</button></div>
    <div className="directory-filters"><input className="inquiry-search" type="search" maxLength={100} aria-label="搜索学生、咨询内容或来源" placeholder="搜索学生、咨询内容或来源" value={draftSearch} onChange={(event) => changeSearch(event.target.value)} /><select aria-label="按状态筛选" value={status} onChange={(event) => changeFilters(event.target.value as StudentDirectoryStatus)}><option value="all">全部状态</option><option value="new">新咨询</option><option value="contacted">已联系</option><option value="trial_scheduled">已安排试听</option><option value="converted">有报名意向</option><option value="lost">已流失</option></select>{hasFilters && <button className="directory-filter-reset" type="button" onClick={() => changeFilters('all', '')}>清除筛选</button>}</div>
    {error && <div className="form-error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={retry}>重试</button></div>}
    {loading && !result ? <DirectoryTableSkeleton /> : result && <div className="student-table" role="table" aria-busy={busy} aria-label="学生与咨询列表"><div className="student-table-row student-table-head" role="row"><span role="columnheader">学生</span><span role="columnheader">最近咨询</span><span role="columnheader">来源</span><span role="columnheader">状态</span><span role="columnheader">操作</span></div>{currentRows.map((item) => <div className="student-table-row" role="row" key={item.studentId}><span className="table-student" role="cell"><button className="student-link" onClick={() => onDetail(item.studentId)}>{item.studentName}</button></span><span className="table-summary" role="cell">{item.summary}</span><span className="table-muted" role="cell">{item.channel}</span><span className="table-status" role="cell"><StatusChip value={item.status} /></span><div className="table-actions" role="cell">{item.status === 'new' || item.status === 'contacted' ? <button className="small-action" onClick={() => onSchedule(item)}>安排试听</button> : <button className="small-action" onClick={() => onDetail(item.studentId)}>查看详情</button>}</div></div>)}{currentRows.length === 0 && <EmptyState title="没有匹配的学生" text={search || status !== 'all' ? '请调整搜索词或筛选条件。' : '登记第一位学生后，列表会显示在这里。'} />}</div>}
    <div className="directory-footer"><span role="status" aria-live="polite">{result ? `共 ${total} 名学生` : error ? '学生目录加载失败，请重试' : '正在加载学生…'}{busy && result ? ' · 更新中…' : error && result ? ' · 更新失败' : ''}</span>{pages > 1 && <div className="pagination"><button className="small-action" disabled={page === 1 || busy || !!error} onClick={() => onQueryChange({ page: page - 1 })}>上一页</button><span>{page} / {pages}</span><button className="small-action" disabled={page >= pages || busy || !!error} onClick={() => onQueryChange({ page: page + 1 })}>下一页</button></div>}</div>
  </section>;
}

function TaskCenter({ filter, onFilterChange: setFilter, followUps, trials, onComplete, onDetail, onResult, onReschedule, onCancel }: { filter: TaskFilter; onFilterChange: (filter: TaskFilter) => void; followUps: FollowUpDto[]; trials: TrialDto[]; onComplete: (item: FollowUpDto) => void; onDetail: (id: string) => void; onResult: (item: TrialDto) => void; onReschedule: (item: TrialDto) => void; onCancel: (item: TrialDto) => void }) {
  const now = Date.now();
  const todayKey = melbourneDateKey(new Date(now));
  const matches = (value: string) => {
    const date = new Date(value);
    if (filter === 'overdue') return date.getTime() < now;
    if (filter === 'today') return melbourneDateKey(date) === todayKey;
    if (filter === 'upcoming') return date.getTime() >= now && melbourneDateKey(date) !== todayKey;
    return true;
  };
  const filteredFollowUps = followUps.filter((item) => matches(item.dueAt));
  const filteredTrials = trials.filter((item) => matches(item.scheduledAt));
  const taskDates = [...followUps.map((item) => item.dueAt), ...trials.map((item) => item.scheduledAt)];
  const counts = { all: taskDates.length, overdue: taskDates.filter((value) => new Date(value).getTime() < now).length, today: taskDates.filter((value) => melbourneDateKey(new Date(value)) === todayKey).length, upcoming: taskDates.filter((value) => new Date(value).getTime() >= now && melbourneDateKey(new Date(value)) !== todayKey).length };
  const filters: Array<[TaskFilter, string]> = [['all', `全部 ${counts.all}`], ['overdue', `已逾期 ${counts.overdue}`], ['today', `今天 ${counts.today}`], ['upcoming', `即将到期 ${counts.upcoming}`]];
  return <section className="panel task-panel"><div className="panel-heading"><div><p className="section-kicker">ACTION QUEUE</p><h3>任务中心</h3><p className="panel-help">按时间筛选待跟进和试听，处理完一项就会从队列中移除。</p></div></div><div className="task-filters" role="tablist" aria-label="任务筛选">{filters.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={filter === value} className={`filter-chip ${filter === value ? 'selected' : ''}`} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="queue-list task-list">{filteredFollowUps.map((item) => <FollowUpCard key={item.id} item={item} onComplete={() => onComplete(item)} onDetail={() => onDetail(item.studentId)} />)}{filteredTrials.map((item) => <TrialCard key={item.id} trial={item} onSchedule={() => onResult(item)} onReschedule={() => onReschedule(item)} onCancel={() => onCancel(item)} />)}{filteredFollowUps.length === 0 && filteredTrials.length === 0 && <EmptyState title="当前筛选没有任务" text="切换筛选条件，或创建一条新的咨询。" />}</div></section>;
}

function melbourneDateKey(value: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function statusLabel(value: InquiryDto['status']) {
  return ({ new: '新咨询', contacted: '已联系', trial_scheduled: '已安排试听', converted: '有报名意向', lost: '已流失' } as Record<InquiryDto['status'], string>)[value];
}

function LoginPage({ login, setLogin, error, saving, onSubmit }: { login: LoginState; setLogin: (state: LoginState) => void; error: string; saving: boolean; onSubmit: (event: FormEvent) => void }) {
  return <div className="login-shell"><div className="login-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-copy"><span className="brand-mark">N</span><p>Make every student<br /><strong>move forward.</strong></p><small>Student operations, with a clearer next step.</small></div><div className="art-note note-one">01 <span>咨询</span></div><div className="art-note note-two">02 <span>试听</span></div><div className="art-note note-three">03 <span>跟进</span></div></div><div className="login-card"><div className="login-brand"><span className="brand-mark">N</span><strong>northstar</strong></div><div className="login-heading"><p className="section-kicker">WELCOME BACK</p><h1>进入你的工作台</h1><p>把每一个学生的下一步，照亮。</p></div><form onSubmit={onSubmit}><label>工作邮箱<input type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} autoComplete="email" /></label><label>密码<input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoComplete="current-password" /></label>{error && <div className="form-error">{error}</div>}<button className="primary-button full" type="submit" disabled={saving}>{saving ? '登录中…' : '进入工作台'} <span>→</span></button></form><p className="login-hint">演示账号按角色进入对应工作台（仅供本机演示）</p><div className="login-demo-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setLogin(initialLogin)}>填入管理员账号</button><button type="button" className="secondary-button" disabled={saving} onClick={() => setLogin({ email: 'teacher@austin.edu', password: 'teacher-demo123' })}>填入教师账号</button></div></div></div>;
}

function Metric({ label, value, detail, tone, icon }: { label: string; value: number | string; detail: string; tone: string; icon: string }) { return <div className={`metric-card tone-${tone}`}><div className="metric-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></div>; }

function InquiryList({ inquiries, onDetail, onSchedule }: { inquiries: InquiryDto[]; onDetail: (id: string) => void; onSchedule: (item: InquiryDto) => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 220);
  const filtered = inquiries.filter((item) => item.studentName.toLowerCase().includes(debouncedSearch.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages - 1);
  return <section className="panel timeline-panel"><div className="panel-heading"><div><p className="section-kicker">RECENT ACTIVITY</p><h3>最近咨询</h3></div></div>
    <input className="inquiry-search" type="search" aria-label="搜索学生" placeholder="搜索学生姓名" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
    <div className="activity-list" aria-busy={search !== debouncedSearch}>{filtered.slice(current * 8, current * 8 + 8).map((item, index) => <div className="activity-row" key={item.id}><div className={`activity-dot dot-${index % 3}`} /><div className="activity-copy"><button className="student-link" onClick={() => onDetail(item.studentId)}>{item.studentName}</button><span>{item.summary}</span></div>{item.status === 'new' || item.status === 'contacted' ? <button className="small-action" onClick={() => onSchedule(item)}>安排试听</button> : <StatusChip value={item.status} />}</div>)}{filtered.length === 0 && <EmptyState title={search ? '没有匹配的学生' : '还没有咨询'} text={search ? '试试其他姓名。' : '登记第一位学生后，活动会显示在这里。'} />}</div>
    {pages > 1 && <div className="pagination"><button className="small-action" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {pages}</span><button className="small-action" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button></div>}
  </section>;
}

function FollowUpCard({ item, onComplete, onDetail }: { item: FollowUpDto; onComplete: () => void; onDetail: () => void }) { return <article className="queue-card follow-card"><div className="queue-icon amber">↗</div><div className="queue-main"><div className="queue-title"><button className="student-link" onClick={onDetail}>{item.studentName}</button><span className={new Date(item.dueAt) < new Date() ? 'overdue' : ''}>{new Date(item.dueAt) < new Date() ? '已逾期' : '待跟进'} · {formatDate(item.dueAt)}</span></div><p>{item.note}</p>{item.aiSummary && <div className="ai-note"><span>✦</span>{item.aiSummary}</div>}</div><button className="small-action" onClick={onComplete}>记录跟进</button></article>; }
function TrialCard({ trial, onSchedule, onReschedule, onCancel }: { trial: TrialDto; onSchedule: () => void; onReschedule: () => void; onCancel: () => void }) { return <article className="queue-card"><div className="queue-icon blue">◷</div><div className="queue-main"><div className="queue-title"><strong>{trial.studentName}</strong><span>试听已安排</span></div><p>{formatDate(trial.scheduledAt)} · {trial.teacherName ?? '老师待分配'}</p></div><div className="trial-actions"><button className="small-action" onClick={onCancel}>取消试听</button><button className="small-action" onClick={onReschedule}>改期</button><button className="small-action primary-small" onClick={onSchedule}>记结果</button></div></article>; }
function StatusChip({ value }: { value: string }) { const map: Record<string, string> = { new: '新咨询', contacted: '已联系', trial_scheduled: '已安排试听', converted: '有报名意向', lost: '已流失' }; return <span className={`status-chip status-${value}`}>{map[value] ?? value}</span>; }
function EmptyState({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><div className="empty-symbol">○</div><strong>{title}</strong><p>{text}</p>{action && <button className="text-button" onClick={onClick}>{action} →</button>}</div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Australia/Melbourne', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

function StudentDetailSkeleton() {
  return <div className="student-detail-skeleton" role="status" aria-live="polite" aria-label="正在加载学生详情"><span className="skeleton-block skeleton-contact" /><span className="skeleton-block skeleton-detail-heading" /><span className="skeleton-block skeleton-detail-line" /><span className="skeleton-block skeleton-detail-line short" /><span className="skeleton-block skeleton-detail-heading" /><span className="skeleton-block skeleton-history" /><span className="skeleton-block skeleton-history" /></div>;
}

function LeadDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ studentName: '', guardianName: '', guardianPhone: '', channel: '微信', summary: '' });
  const [duplicates, setDuplicates] = useState<DuplicateStudentDto[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function updateForm(next: typeof form) {
    setForm(next);
    setDuplicates([]);
    setError('');
  }

  async function save(allowDuplicate = false) {
    setSaving(true);
    setError('');
    try {
      await api('/api/leads', { method: 'POST', body: JSON.stringify({ ...form, ...(allowDuplicate ? { allowDuplicate: true } : {}) }) });
      onCreated();
    } catch (caught) {
      const requestError = caught as ApiRequestError;
      if (requestError.code === 'DUPLICATE_STUDENT' && Array.isArray(requestError.details)) {
        setDuplicates(requestError.details as DuplicateStudentDto[]);
        return;
      }
      setError(caught instanceof Error ? caught.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  const statusLabels: Record<string, string> = { lead: '新线索', trial: '试听中', enrollment_intent: '有报名意向', lost: '已流失' };
  return <Dialog title="新建咨询" eyebrow="NEW INQUIRY" onClose={onClose}>
    <form className="dialog-form" onSubmit={submit}>
      <div className="form-grid">
        <label>学生姓名<input required value={form.studentName} onChange={(e) => updateForm({ ...form, studentName: e.target.value })} placeholder="例如：Liam" /></label>
        <label>家长姓名<input required value={form.guardianName} onChange={(e) => updateForm({ ...form, guardianName: e.target.value })} placeholder="例如：Grace Liu" /></label>
      </div>
      <div className="form-grid">
        <label>家长电话<input required value={form.guardianPhone} onChange={(e) => updateForm({ ...form, guardianPhone: e.target.value })} placeholder="0400 123 456" /></label>
        <label>来源<select value={form.channel} onChange={(e) => updateForm({ ...form, channel: e.target.value })}><option>微信</option><option>电话</option><option>官网</option><option>朋友推荐</option></select></label>
      </div>
      <label>咨询摘要<textarea required value={form.summary} onChange={(e) => updateForm({ ...form, summary: e.target.value })} placeholder="学生年级、目标、家长最关心的问题…" rows={4} /></label>
      {duplicates.length > 0 && <div className="duplicate-warning" role="alert">
        <strong>发现可能重复的学生</strong>
        <p>系统根据家长电话或姓名匹配到了已有记录。请确认是否应继续创建一条独立咨询。</p>
        <div className="duplicate-list">{duplicates.map((student) => <div className="duplicate-row" key={student.id}><div><strong>{student.name}</strong><span>{student.guardianName} · {student.guardianPhone}</span><span>创建于 {formatDate(student.createdAt)}</span></div><span className="status-chip status-duplicate">{statusLabels[student.status] ?? student.status}</span></div>)}</div>
        <div className="duplicate-actions"><button type="button" className="secondary-button" onClick={() => setDuplicates([])}>返回修改</button><button type="button" className="primary-button" onClick={() => void save(true)} disabled={saving}>{saving ? '保存中…' : '仍然创建新咨询'}</button></div>
      </div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '创建咨询'}</button></div>
    </form>
  </Dialog>;
}
function TrialDialog({ trial, onClose, onCreated }: { trial: TrialDto; onClose: () => void; onCreated: () => void }) { const [scheduledAt, setScheduledAt] = useState(''); const [teacherId, setTeacherId] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const instant = melbourneLocalToInstant(scheduledAt); await api(`/api/inquiries/${trial.inquiryId}/trial`, { method: 'POST', body: JSON.stringify({ scheduledAt: instant, ...(teacherId ? { teacherId } : {}) }) }); onCreated(); } catch (error) { setError(error instanceof RangeError ? '该时间因夏令时不存在或有歧义，请选择其他时间' : error instanceof Error ? error.message : '安排失败'); } finally { setSaving(false); } } return <Dialog title={`为 ${trial.studentName} 安排试听`} eyebrow="SCHEDULE TRIAL" onClose={onClose}><form className="dialog-form" onSubmit={submit}><label>试听时间（墨尔本）<input required type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /></label><TeacherSelector api={api} value={teacherId} onChange={setTeacherId} placeholder="沿用已分配老师（若有）" />{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '确认安排'}</button></div></form></Dialog>; }
function ResultDialog({ trial, onClose, onCreated }: { trial: TrialDto; onClose: () => void; onCreated: (message: string) => void }) { const [form, setForm] = useState<CompleteTrialInput>({ outcome: 'interested', notes: '', expectedScheduledAt: trial.scheduledAt }); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const result = await api<{ aiSummary: string }>(`/api/trials/${trial.id}/complete`, { method: 'POST', body: JSON.stringify(form) }); onCreated(`试听结果已保存 · ${result.aiSummary}`); } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); } } return <Dialog title={`记录 ${trial.studentName} 的试听结果`} eyebrow="TRIAL OUTCOME" onClose={onClose}><form className="dialog-form" onSubmit={submit}><fieldset><legend>学生意向</legend><div className="choice-grid">{([['interested', '有兴趣', '适合进入报名跟进'], ['undecided', '再考虑', '需要一次回访'], ['not_interested', '暂不考虑', '结束当前线索']] as const).map(([value, label, hint]) => <label className={`choice ${form.outcome === value ? 'selected' : ''}`} key={value}><input type="radio" name="outcome" checked={form.outcome === value} onChange={() => setForm({ ...form, outcome: value })} /><strong>{label}</strong><small>{hint}</small></label>)}</div></fieldset><label>课堂备注<textarea required maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="学生的表现、家长反馈、下一步建议…" rows={5} /></label><p className="ai-hint">✦ 保存后会生成一条结构化跟进建议，AI 不可用时会自动使用规则化建议。</p>{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '分析中…' : '保存试听结果'}</button></div></form></Dialog>; }
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
    if (outcome !== 'continue' && !window.confirm(outcome === 'converted' ? '确认将该学生标记为“有报名意向”？这会关闭其他待办。' : '确认将该学生标记为“暂不报名”？这会关闭其他待办并取消未完成的试听。')) {
      setSaving(false);
      return;
    }
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
    <label>跟进结果<select value={outcome} onChange={(e) => setOutcome(e.target.value as FollowUpOutcome)}><option value="continue">继续跟进</option><option value="converted">有报名意向</option><option value="lost">暂不报名</option></select></label>
    {outcome === 'continue' ? <label>下次联系时间（墨尔本）<input required type="datetime-local" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></label> : <p className="ai-hint">确认后会关闭该学生其余待办，并取消未完成的试听安排。</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存记录'}</button></div>
  </form></Dialog>;
}

function StudentDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<StudentDetailDto | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<'edit' | 'inquiry' | null>(null);
  const refresh = () => { setAction(null); setAttempt((n) => n + 1); onChanged(); };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError('');
    api<StudentDetailDto>(`/api/students/${id}`, { signal: controller.signal }).then((data) => { if (active) setDetail(data); }).catch((err: unknown) => { if (active && !(err instanceof Error && err.name === 'AbortError')) setError(err instanceof Error ? err.message : '加载失败'); });
    return () => { active = false; controller.abort(); };
  }, [id, attempt]);
  return <Dialog title={detail?.student.name ?? '学生详情'} eyebrow="STUDENT" onClose={onClose}>
    {error ? <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div> : !detail ? <StudentDetailSkeleton /> : <div className="student-detail">
      <div className="contact-row"><span>家长</span><strong>{detail.student.guardianName}</strong><a href={`tel:${detail.student.guardianPhone}`}>{detail.student.guardianPhone}</a></div>
      <div className="student-actions"><button className="small-action" onClick={() => setAction(action === 'edit' ? null : 'edit')}>编辑资料</button><button className="small-action" onClick={() => setAction(action === 'inquiry' ? null : 'inquiry')}>新增咨询</button></div>
      {action === 'edit' && <StudentEditForm api={api} student={detail.student} onSaved={refresh} onClose={() => setAction(null)} />}
      {action === 'inquiry' && <ReturningInquiryForm api={api} studentId={id} onSaved={refresh} onClose={() => setAction(null)} />}
      <h3>负责老师：{detail.student.teacherName ?? '暂未分配'}</h3><TeacherAssignment key={`${id}-${detail.student.teacherId ?? ''}`} api={api} detail={detail} onSaved={() => setAttempt((n) => n + 1)} />
      {detail.teacherHistory.map((item, index) => <div className="history-row" key={`${item.teacherId}-${index}`}><strong>{item.teacherName}</strong><small>{formatDate(item.assignedAt)} · {item.assignedByName} 分配</small></div>)}
      <h3>咨询记录</h3>{detail.inquiries.length ? detail.inquiries.map((inquiry) => <div className="history-row" key={inquiry.id}><strong>{inquiry.channel} · {formatDate(inquiry.createdAt)}</strong><p>{inquiry.summary}</p></div>) : <p>暂无咨询记录</p>}
      <h3>试听记录</h3>{detail.trials.length ? detail.trials.map((trial) => <div className="history-row" key={trial.id}><strong>{formatDate(trial.scheduledAt)} · {trial.status === 'completed' ? '已完成' : trial.status === 'scheduled' ? '已安排' : '已取消'}</strong><small>试听老师：{trial.teacherName ?? '未记录'}</small>{trial.notes && <p>{trial.notes}</p>}{trial.completedAt && <small>反馈提交：{trial.completedByName} · {formatDate(trial.completedAt)}</small>}{detail.trialReschedules.filter((change) => change.trialId === trial.id).map((change, index) => <p key={index}>改期：{formatDate(change.previousScheduledAt)} → {formatDate(change.scheduledAt)} · {change.reason}<small>{formatDate(change.changedAt)} · {change.changedByName}</small></p>)}{detail.trialCancellations.filter((item) => item.trialId === trial.id).map((item) => <p key={item.trialId}>取消原因：{item.reason}<small>{formatDate(item.cancelledAt)} · {item.cancelledByName}</small></p>)}</div>) : <p>暂无试听记录</p>}
      <h3>跟进记录</h3>{detail.followUps.length ? detail.followUps.map((followUp) => <div className="history-row" key={followUp.id}><strong>{formatDate(followUp.dueAt)} · {followUp.status === 'pending' ? '待跟进' : followUp.status === 'completed' ? '已完成' : '已关闭'}</strong><p>{followUp.resultNote ?? followUp.note}</p>{followUp.resultOutcome && <small>{({ continue: '继续跟进', converted: '有报名意向', lost: '暂不报名' })[followUp.resultOutcome]}</small>}</div>) : <p>暂无跟进记录</p>}
    </div>}
  </Dialog>;
}

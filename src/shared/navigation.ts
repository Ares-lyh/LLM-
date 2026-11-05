import type { InquiryStatus } from './contracts.js';

export type WorkspaceView = 'overview' | 'students' | 'tasks';
export type StudentDirectoryStatus = 'all' | InquiryStatus;
export type TaskFilter = 'all' | 'overdue' | 'today' | 'upcoming';

export interface WorkspaceNavigation {
  view: WorkspaceView;
  search: string;
  status: StudentDirectoryStatus;
  page: number;
  taskFilter: TaskFilter;
}

export function readWorkspaceNavigation(search: string): WorkspaceNavigation {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const status = params.get('studentsStatus');
  const taskFilter = params.get('taskFilter');
  const page = Number(params.get('studentsPage'));
  return {
    view: view === 'students' || view === 'tasks' ? view : 'overview',
    search: (params.get('studentsSearch') ?? '').trim().slice(0, 100),
    status: status === 'new' || status === 'contacted' || status === 'trial_scheduled' || status === 'converted' || status === 'lost' ? status : 'all',
    page: Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
    taskFilter: taskFilter === 'overdue' || taskFilter === 'today' || taskFilter === 'upcoming' ? taskFilter : 'all',
  };
}

export function buildWorkspaceUrl(href: string, changes: Partial<WorkspaceNavigation>): string {
  const url = new URL(href);
  const next = { ...readWorkspaceNavigation(url.search), ...changes };
  const params = url.searchParams;
  const values = {
    view: next.view === 'overview' ? '' : next.view,
    studentsSearch: next.search.trim(),
    studentsStatus: next.status === 'all' ? '' : next.status,
    studentsPage: next.page > 1 ? String(next.page) : '',
    taskFilter: next.taskFilter === 'all' ? '' : next.taskFilter,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value); else params.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

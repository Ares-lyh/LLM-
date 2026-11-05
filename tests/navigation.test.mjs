import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceUrl, readWorkspaceNavigation } from '../dist-server/src/shared/navigation.js';

test('workspace links restore the selected view, directory and task filters', () => {
  const navigation = readWorkspaceNavigation('?view=students&studentsSearch=%E6%9D%8E%20%E5%90%8C%E5%AD%A6&studentsStatus=contacted&studentsPage=3&taskFilter=overdue');
  assert.deepEqual(navigation, { view: 'students', search: '李 同学', status: 'contacted', page: 3, taskFilter: 'overdue' });
  const href = 'https://example.test/app?view=students&studentsStatus=contacted&studentsPage=3&taskFilter=overdue&source=bookmark#directory';
  const tasksUrl = buildWorkspaceUrl(href, { view: 'tasks' });
  const restored = buildWorkspaceUrl(new URL(tasksUrl, href).href, { view: 'students' });
  assert.equal(readWorkspaceNavigation(new URL(tasksUrl, href).search).view, 'tasks');
  assert.equal(readWorkspaceNavigation(new URL(restored, href).search).page, 3);
  assert.equal(new URL(restored, href).searchParams.get('source'), 'bookmark');
  assert.equal(new URL(restored, href).hash, '#directory');
});

test('invalid link values use supported defaults and bounded search and pages', () => {
  const defaults = { view: 'overview', search: '', status: 'all', page: 1, taskFilter: 'all' };
  assert.deepEqual(readWorkspaceNavigation(''), defaults);
  assert.deepEqual(readWorkspaceNavigation('?view=unknown&studentsStatus=unknown&studentsPage=-1&taskFilter=unknown'), defaults);
  for (const page of ['0', '1.5', 'NaN', 'Infinity', '']) {
    assert.equal(readWorkspaceNavigation(`?studentsPage=${page}`).page, 1);
  }
  assert.equal(readWorkspaceNavigation('?studentsPage=10001').page, 10_000);
  assert.equal(readWorkspaceNavigation(`?studentsSearch=${'x'.repeat(110)}`).search.length, 100);
});

test('search and clearing filters reset pagination without erasing other navigation state', () => {
  const href = 'https://example.test/app?view=students&studentsSearch=old&studentsStatus=contacted&studentsPage=3&taskFilter=today&source=bookmark#directory';
  const searched = new URL(buildWorkspaceUrl(href, { search: '  Amy & 李  ', page: 1 }), href);
  assert.deepEqual(readWorkspaceNavigation(searched.search), { view: 'students', search: 'Amy & 李', status: 'contacted', page: 1, taskFilter: 'today' });
  assert.equal(searched.searchParams.has('studentsPage'), false);
  const cleared = new URL(buildWorkspaceUrl(searched.href, { search: '', status: 'all', page: 1 }), href);
  for (const key of ['studentsSearch', 'studentsStatus', 'studentsPage']) assert.equal(cleared.searchParams.has(key), false);
  assert.equal(cleared.searchParams.get('source'), 'bookmark');
  assert.equal(cleared.searchParams.get('taskFilter'), 'today');
  assert.equal(cleared.hash, '#directory');
});

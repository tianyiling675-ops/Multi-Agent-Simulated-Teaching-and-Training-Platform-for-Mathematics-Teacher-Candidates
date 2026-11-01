import { test, expect } from '@playwright/test';

test('historical records stay read-only and retain their confirmed material version', async ({
  page,
  browser,
}) => {
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post('/api/teacher-training/' + path, { data });
    expect(r.ok()).toBe(true);
    return (await r.json()).data;
  };
  const key = () => crypto.randomUUID();
  const project = await post('projects', {
    title: '历史材料验收',
    grade: '高二',
    scope: '方向',
    clientRequestId: key(),
  });
  const content = {
    objectives: '',
    priorKnowledge: '',
    keyPoints: '',
    process: 'V1 原始讲解',
    exercises: '',
    notes: '',
    segments: [],
    sources: [],
  };
  await page.request.patch('/api/teacher-training/drafts/' + project.id, {
    data: { expectedRevision: 0, content },
  });
  const material = await post('drafts/' + project.id + '/confirm', { expectedRevision: 1 });
  const config = await post('class-configs', {
    projectId: project.id,
    template: 'mixed',
    students: [
      {
        id: 'lin',
        name: '小林',
        priorKnowledge: '基础',
        expression: 'responsive',
        misconceptions: ['隐藏误解'],
      },
    ],
    clientRequestId: key(),
  });
  const session = await post('sessions', {
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'text',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: key(),
  });
  await post('sessions/' + session.id + '/commands', {
    command: 'start',
    expectedRevision: 0,
    clientEventId: key(),
  });
  await post('sessions/' + session.id + '/events', {
    type: 'teacher_text',
    text: '原始公开讲解',
    expectedRevision: 1,
    clientEventId: key(),
  });
  await post('sessions/' + session.id + '/commands', {
    command: 'end',
    confirmed: true,
    expectedRevision: 2,
    clientEventId: key(),
  });
  await page.request.patch('/api/teacher-training/drafts/' + project.id, {
    data: { expectedRevision: 1, content: { ...content, process: 'V2 修改讲解' } },
  });
  await post('drafts/' + project.id + '/confirm', { expectedRevision: 2 });
  const url = '/teacher-training?project=' + project.id + '&tab=records&session=' + session.id;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '课堂记录', exact: true })).toBeVisible();
  await expect(page.getByLabel('课堂事件记录')).toContainText('原始公开讲解');
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toHaveCount(0);
  const read = async () =>
    (await (await page.request.get('/api/teacher-training/sessions/' + session.id)).json()).data;
  const before = await read();
  expect(before.material.content.process).toBe('V1 原始讲解');
  expect(before.session.totalScore).toBeNull();
  expect(JSON.stringify(before)).not.toContain('隐藏误解');
  await page.reload();
  expect((await read()).events).toEqual(before.events);
  const otherProject = await post('projects', {
    title: '另一课题',
    grade: '高中',
    scope: '函数',
    clientRequestId: key(),
  });
  await page.goto(
    '/teacher-training?project=' + otherProject.id + '&tab=records&session=' + session.id,
  );
  await expect(page.getByRole('alert').filter({ hasText: '课堂记录不属于此课题' })).toBeVisible();
  await expect(page.getByLabel('课堂事件记录')).toHaveCount(0);
  const other = await browser.newContext();
  try {
    expect(
      (
        await other.request.get(
          new URL('/api/teacher-training/sessions/' + session.id, page.url()).href,
        )
      ).status(),
    ).toBe(404);
  } finally {
    await other.close();
  }
});

import { expect, test } from '@playwright/test';
import { blankSlide } from '../../lib/teacher-training/slides';

test('configuration drafts, real overview continuation and tablet conversation remain usable', async ({
  page,
}) => {
  const errors: string[] = [];
  let probes = 0;
  let connectionOk = true;
  await page.route('**/api/verify-model', (route) => {
    probes++;
    return route.fulfill({
      status: connectionOk ? 200 : 503,
      json: connectionOk
        ? { success: true, data: { message: 'Connection successful' } }
        : { message: '受控失败' },
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/teacher-training/sessions/*/react', (route) =>
    route.fulfill({
      status: 502,
      json: { code: 'STUDENT_GENERATION_FAILED', message: '受控验收：模型暂不可用' },
    }),
  );
  await page.goto('/teacher-training');
  await expect(page.getByRole('button', { name: '新建课题', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await page.getByLabel('课题名称').fill('页面改版验收 · 椭圆');
  await page.getByLabel('学段与年级').fill('高中二年级');
  await page.getByLabel('本次教学范围').fill('分母与长轴方向');
  await page.getByRole('button', { name: '创建备课' }).click();
  await page
    .getByRole('textbox', { name: '教学过程', exact: true })
    .fill('先比较分母，再检查理解。');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '我的课题', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '教学过程', exact: true })).toHaveValue(
    '先比较分母，再检查理解。',
  );
  await page.getByRole('button', { name: '确认试讲版本并继续' }).click();
  await expect(page.getByRole('heading', { name: '为这一轮，准备一个班级' })).toBeVisible();
  await expect(page.getByLabel('模型连接检查')).toContainText('尚未检测');
  expect(probes).toBe(0);
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(page.getByLabel('模型连接检查')).toContainText('检测成功');
  connectionOk = false;
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(page.getByLabel('模型连接检查')).toContainText('检测失败');
  expect(probes).toBe(2);
  const student = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: '小周' }) });
  await student.locator('summary').click();
  await student.getByLabel('学生名称').fill('小周同学');
  await student.getByLabel('本课常见误解', { exact: false }).fill('认为长轴总沿横轴');
  await page.getByRole('button', { name: '保存班级配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('班级配置已保存');
  await page.reload();
  const restored = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: '小周同学' }) });
  await restored.locator('summary').click();
  await expect(restored.getByLabel('本课常见误解', { exact: false })).toHaveValue(
    '认为长轴总沿横轴',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '基础薄弱', exact: false }).click();
  await expect(restored.getByLabel('学生名称')).toHaveValue('小周同学');
  await page.getByRole('button', { name: '进入模拟课堂', exact: true }).click();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.getByLabel('教师课堂发言').fill('哪个分母更大？');
  await page.getByRole('button', { name: '全班提问', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '受控验收' })).toBeVisible();
  await page.setViewportSize({ width: 820, height: 900 });
  await page.getByRole('button', { name: /^课堂对话/ }).click();
  const conversation = page.getByRole('dialog', { name: '课堂对话', exact: true });
  await expect(conversation.getByLabel('课堂对话记录')).toContainText('哪个分母更大？');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByTitle('返回备课与历史').click();
  const resume = page.getByRole('region', { name: '继续上一次训练' });
  await expect(resume).toContainText('页面改版验收 · 椭圆');
  await expect(resume).toContainText('已暂停');
  const before = (await (await page.request.get('/api/teacher-training/overview')).json()).data
    .resumeSession;
  await resume.getByRole('button', { name: '继续课堂', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${before.id}/classroom`));
  await expect(page.getByRole('button', { name: '继续课堂', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('read-only evidence scene uses the frozen page and cannot leak later board edits', async ({
  page,
}) => {
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/teacher-training/' + path, { data });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  const key = () => crypto.randomUUID();
  const project = await post('projects', {
    title: '复盘片段验收',
    grade: '高二',
    scope: '历史片段',
    clientRequestId: key(),
  });
  const content = {
    objectives: '',
    priorKnowledge: '',
    keyPoints: '',
    process: '试讲教案',
    exercises: '',
    notes: '',
    segments: [],
    sources: [],
    pages: [
      {
        id: 'page_one',
        title: '原始页',
        canvas: blankSlide('page_one'),
        source: 'edited',
        teacherNotes: '教师私有提示',
      },
    ],
  };
  await page.request.patch('/api/teacher-training/drafts/' + project.id, {
    data: { expectedRevision: 0, content },
  });
  const material = await post('drafts/' + project.id + '/confirm', { expectedRevision: 1 });
  const config = await post('class-configs', {
    projectId: project.id,
    template: 'mixed',
    students: [
      { id: 'lin', name: '小林', priorKnowledge: '', expression: 'responsive', misconceptions: [] },
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
  await post(`sessions/${session.id}/commands`, {
    command: 'start',
    expectedRevision: 0,
    clientEventId: key(),
  });
  const read = async () =>
    (await (await page.request.get(`/api/teacher-training/sessions/${session.id}`)).json()).data;
  const publish = async (data: Record<string, unknown>) => {
    const current = await read();
    return post(`sessions/${session.id}/events`, {
      ...data,
      expectedRevision: current.session.revision,
      clientEventId: key(),
    });
  };
  const boardText = (id: string, text: string) => ({
    id,
    type: 'text',
    left: 40,
    top: 40,
    width: 800,
    height: 100,
    rotate: 0,
    defaultColor: '#233d34',
    defaultFontName: 'Noto Sans SC',
    content: `<p style="font-size:36px">${text}</p>`,
  });
  await publish({ type: 'board_visibility', open: true });
  await publish({
    type: 'board_operation',
    operation: { kind: 'add', element: boardText('old_board', '旧板书，仅在当时展示') },
  });
  await publish({
    type: 'teacher_text',
    text: '这是当时的理解检查。',
    intent: 'check',
  });
  await publish({ type: 'board_operation', operation: { kind: 'clear' } });
  await publish({
    type: 'board_operation',
    operation: { kind: 'add', element: boardText('later_board', '后来的板书不应进入旧片段') },
  });
  const state = await read();
  await post(`sessions/${session.id}/commands`, {
    command: 'end',
    confirmed: true,
    expectedRevision: state.session.revision,
    clientEventId: key(),
  });
  const before = await read();
  await page.goto(`/teacher-training?project=${project.id}&tab=records&session=${session.id}`);
  await expect(page.getByLabel('课堂事件记录')).toContainText('这是当时的理解检查。');
  await page.getByRole('button', { name: '查看课堂片段', exact: false }).first().click();
  const fragment = page.getByRole('dialog', { name: /^课堂片段/ });
  await expect(fragment).toBeVisible();
  await expect(fragment).toContainText('旧板书，仅在当时展示');
  await expect(fragment).not.toContainText('后来的板书不应进入旧片段');
  await page.keyboard.press('Escape');
  await page.getByText('课堂表现', { exact: true }).click();
  const performance = page.locator('details[open]').filter({
    has: page.getByText('课堂表现', { exact: true }),
  });
  await expect(performance.getByText('本轮不适用', { exact: true })).toBeVisible();
  await expect(performance.getByText('证据不足', { exact: true })).toBeVisible();
  await performance
    .getByRole('button', { name: /更新板书$/ })
    .first()
    .click();
  await expect(fragment).toContainText('旧板书，仅在当时展示');
  await expect(fragment).not.toContainText('后来的板书不应进入旧片段');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/teacher-review-redesign.png', fullPage: true });
  expect((await read()).events).toEqual(before.events);
  expect((await read()).session.totalScore).toBeNull();
});

test('outline edits survive preparation tabs and navigation cancellation', async ({ page }) => {
  await page.goto('/teacher-training');
  await expect(page.getByRole('button', { name: '新建课题', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await page.getByLabel('课题名称').fill('大纲保护验收');
  await page.getByLabel('学段与年级').fill('高二');
  await page.getByLabel('本次教学范围').fill('方向判断');
  await page.getByRole('button', { name: '创建备课' }).click();
  await page.getByLabel('教学过程', { exact: true }).fill('从分母判断方向。');
  await page.route('**/api/teacher-training/projects/*/generate', async (route) => {
    const projectId = new URL(route.request().url()).pathname.split('/').at(-2);
    const revision = route.request().postDataJSON().expectedRevision;
    await route.fulfill({
      json: {
        data: {
          id: 'prep_fixture',
          projectId,
          revision,
          sourceRevision: revision,
          requestId: 'outline-fixture',
          status: 'ready',
          createdAt: new Date().toISOString(),
          outlines: [
            {
              id: 'outline_one',
              title: '方向大纲',
              description: '比较分母并说明理由。',
              keyPoints: [],
            },
          ],
          completed: [],
        },
      },
    });
  });
  await page.getByRole('button', { name: '课件与练习', exact: true }).click();
  await page.getByRole('button', { name: '从课题生成课件', exact: true }).click();
  const title = page.getByLabel('大纲标题 方向大纲', { exact: true });
  await title.fill('保留我的大纲修改');
  await page.getByRole('button', { name: '02 班级配置' }).click();
  await page.getByRole('button', { name: '01 材料准备' }).click();
  await expect(title).toHaveValue('保留我的大纲修改');
  await page.getByRole('button', { name: '参考材料', exact: true }).click();
  await page.getByRole('button', { name: '课件与练习', exact: true }).click();
  await expect(title).toHaveValue('保留我的大纲修改');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '返回备课与历史', exact: true }).click();
  await expect(title).toHaveValue('保留我的大纲修改');
});

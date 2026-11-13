import { test, expect } from '@playwright/test';
import PptxGenJS from 'pptxgenjs';
import { mkdir } from 'node:fs/promises';

test('PPTX preparation, editor, independent classroom, board and recovery', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // This test verifies UI and teacher control independently of paid provider availability.
  await page.route('**/api/teacher-training/sessions/*/react', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ message: '验收：模型暂时不可用', code: 'STUDENT_GENERATION_FAILED' }),
    }),
  );
  await page.goto('/teacher-training');
  await expect(page.getByRole('button', { name: '新建课题', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await page.getByLabel('课题名称').fill('课堂验收 · 椭圆');
  await page.getByLabel('学段与年级').fill('高中二年级');
  await page.getByLabel('本次教学范围').fill('长半轴方向判断与变式练习');
  await page.getByRole('button', { name: '创建备课' }).click();
  await page.getByRole('button', { name: '课件与练习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '课件准备' })).toBeVisible();
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  const slide = deck.addSlide();
  slide.addText('椭圆的标准方程', { x: 0.8, y: 0.7, w: 10, h: 1, fontSize: 32, color: '355F4F' });
  slide.addText('比较分母，说明长半轴的方向。', { x: 0.8, y: 2, w: 10, h: 1, fontSize: 24 });
  const next = deck.addSlide();
  next.addText('理解检查：请解释你的判断依据。', { x: 0.8, y: 1, w: 10, h: 1, fontSize: 28 });
  await mkdir('test-results', { recursive: true });
  await deck.writeFile({ fileName: 'test-results/training-fixture.pptx' });
  await page.locator('input[accept=".pptx"]').setInputFiles('test-results/training-fixture.pptx');
  await expect(page.getByRole('status').filter({ hasText: '已导入2/2页' })).toBeVisible({
    timeout: 120000,
  });
  await page.getByLabel('页面标题').fill('椭圆的标准方程');
  await page.getByRole('button', { name: '编辑页面', exact: true }).click();
  await expect(page.getByText('双击文字编辑 · 拖动调整 · 修改保存在草稿')).toBeVisible();
  await page
    .getByTestId('training-slide-editor')
    .getByText('比较分母，说明长半轴的方向。', { exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const textBox = await page
    .getByTestId('training-slide-editor')
    .getByText('比较分母，说明长半轴的方向。', { exact: true })
    .boundingBox();
  expect(textBox).not.toBeNull();
  // The editor intentionally places its selection layer above rendered text.
  await page.mouse.dblclick(textBox!.x + textBox!.width / 2, textBox!.y + textBox!.height / 2);
  const editable = page.locator('[contenteditable="true"]').first();
  await expect(editable).toBeVisible();
  await editable.fill('先比较分母，再说明长半轴的方向。');
  await page.getByLabel('页面标题').click();
  await page.screenshot({ path: 'test-results/teacher-courseware-editor.png', fullPage: true });
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: '确认试讲版本并继续' }).click();
  await expect(page.getByRole('status').filter({ hasText: '材料版本 V1 已确认' })).toBeVisible();
  await page.getByRole('button', { name: '02 班级配置' }).click();
  await page.getByRole('button', { name: '进入模拟课堂' }).click();
  await expect(page).toHaveURL(new RegExp('/sessions/training_.+/classroom'), { timeout: 120_000 });
  const url = page.url();
  const sessionId = url.split('/').at(-2)!;
  await expect(page.getByLabel('虚拟学生')).toBeVisible();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('heading', { name: '椭圆的标准方程' })).toBeVisible();
  await expect(
    page.getByLabel('课堂舞台').getByText('先比较分母，再说明长半轴的方向。'),
  ).toBeVisible();
  await page.getByRole('button', { name: '白板', exact: true }).click();
  await page.getByLabel('板书内容').fill('长半轴由较大分母所在变量决定');
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await expect(page.getByTestId('teaching-whiteboard')).toContainText(
    '长半轴由较大分母所在变量决定',
  );
  await page.getByLabel('板书内容').fill('x^2/9+y^2/16=1');
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.getByTestId('teaching-whiteboard').locator('.katex')).toBeVisible();
  const ink = page.getByLabel('手写画布');
  const box = await ink.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const r = await page.request.get('/api/teacher-training/sessions/' + sessionId);
      return (await r.json()).data.classroom.board.elements.length;
    })
    .toBe(3);
  await page.screenshot({ path: 'test-results/teacher-classroom-whiteboard.png' });
  await page.getByLabel('教师课堂发言').fill('谁能解释这个椭圆的长半轴为什么沿纵轴？');
  await page.getByRole('button', { name: '全班提问', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '模型暂时不可用' })).toBeVisible();
  await expect(page.getByLabel('课堂对话记录')).toContainText('长半轴为什么沿纵轴');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByLabel('教师课堂发言')).toBeDisabled();
  await page.getByRole('button', { name: '继续课堂', exact: true }).click();
  await page.getByRole('button', { name: '点名小林', exact: true }).click();
  await expect(page.getByLabel('课堂对话记录')).toContainText('教师点名');
  await page.getByRole('button', { name: '收回发言', exact: true }).click();
  await page.screenshot({ path: 'test-results/teacher-classroom-desktop.png' });
  await page.reload();
  await expect(page.getByRole('dialog', { name: '恢复课堂' })).toBeVisible();
  await expect(page.getByLabel('教师课堂发言')).toBeDisabled();
  await page.getByRole('button', { name: '恢复至暂停', exact: true }).click();
  await page.getByRole('button', { name: '继续课堂', exact: true }).click();
  await expect(page.getByTestId('teaching-whiteboard')).toContainText('长半轴由较大分母');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/teacher-classroom-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '结束本轮', exact: true }).click();
  await page.getByRole('button', { name: '确认结束', exact: true }).click();
  await page.getByRole('button', { name: '查看本轮记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '课堂记录', exact: true })).toBeVisible();
  await expect(page.getByLabel('教师课堂发言')).toHaveCount(0);
  const other = await browser.newContext();
  try {
    expect(
      (
        await other.request.get('http://localhost:3013/api/teacher-training/sessions/' + sessionId)
      ).status(),
    ).toBe(404);
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});

test('student hands, published reply and interruption UI with controlled model transport', async ({
  page,
}) => {
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/teacher-training/' + path, { data });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  const key = () => crypto.randomUUID();
  const project = await post('projects', {
    title: '学生交互验收',
    grade: '高中',
    scope: '椭圆定义',
    clientRequestId: key(),
  });
  const content = {
    objectives: '',
    priorKnowledge: '',
    keyPoints: '',
    process: '比较椭圆的方向',
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
        priorKnowledge: '椭圆定义',
        expression: 'responsive',
        misconceptions: [],
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
    plannedMinutes: 10,
    clientRequestId: key(),
  });
  let hands: string[] = [];
  let published = '';
  let slow = false;
  const answer = '长半轴沿纵轴，因为y平方对应的分母更大。';
  // Browser-only fixtures: service authority, persistence and epochs are tested separately.
  await page.route('**/sessions/' + session.id + '/runtime', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.classroom.hands = hands;
    if (published)
      json.data.events.push({
        ...json.data.events[0],
        id: 'fixture_student',
        type: 'student_speech',
        actorType: 'student',
        payload: { text: published, studentId: 'lin' },
      });
    await route.fulfill({ response, json });
  });
  await page.route('**/sessions/' + session.id + '/react', async (route) => {
    const current = (
      await (await page.request.get('/api/teacher-training/sessions/' + session.id)).json()
    ).data;
    const selected = current.events.at(-1)?.type === 'call_on';
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));
    hands = selected ? [] : ['lin'];
    await route
      .fulfill({
        json: {
          data: {
            id: 'fixture_turn',
            status: selected ? 'proposed' : 'delivered',
            committedLength: 0,
            studentId: selected ? 'lin' : undefined,
            speakerEpoch: current.session.speakerEpoch,
            speech: selected ? (slow ? '迟到回答不应显示' : answer) : '',
            hands,
          },
        },
      })
      .catch(() => {});
  });
  await page.route('**/sessions/' + session.id + '/deliver', async (route) => {
    published = answer.slice(0, route.request().postDataJSON().length);
    await route.fulfill({ json: { data: {} } });
  });
  await page.goto('/teacher-training/sessions/' + session.id + '/classroom');
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.getByLabel('教师课堂发言').fill('谁能解释方向？');
  await page.getByRole('button', { name: '全班提问', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const student = page.getByRole('button', { name: '点名小林', exact: true });
  await expect(student).toHaveAttribute('data-hand', 'true');
  await expect(page.getByLabel('课堂对话记录')).not.toContainText(answer);
  await student.click();
  await expect(page.getByLabel('课堂对话记录')).toContainText(answer);
  await expect(student).toHaveAttribute('data-hand', 'false');
  await page.screenshot({ path: 'test-results/teacher-classroom-student-fixture.png' });
  slow = true;
  await student.click();
  await expect(page.getByText('学生正在思考…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByLabel('教师课堂发言')).toBeDisabled();
  await expect(page.getByLabel('课堂对话记录')).not.toContainText('迟到回答不应显示');
});

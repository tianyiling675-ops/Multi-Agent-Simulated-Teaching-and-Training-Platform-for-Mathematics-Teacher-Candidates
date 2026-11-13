import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { emptyMaterial } from '../../lib/teacher-training/contracts';
import { faceModelVersion } from '../../lib/teacher-training/face-evidence';
import { blankSlide } from '../../lib/teacher-training/slides';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  },
});

test('loads MediaPipe, releases the camera, and rehearses a saved classroom segment', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['camera']);
  const prefix = '/api/teacher-training/';
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(prefix + path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const get = async (path: string) => {
    const response = await page.request.get(prefix + path);
    await expect(response).toBeOK();
    return (await response.json()).data;
  };
  const project = await post('projects', {
    title: '表情复盘验收',
    grade: '高一',
    scope: '分式',
    clientRequestId: randomUUID(),
  });
  await expect(
    await page.request.patch(prefix + `drafts/${project.id}`, {
      data: {
        expectedRevision: 0,
        content: {
          ...emptyMaterial(),
          process: '讨论约分条件。',
          pages: [
            {
              id: 'face-slide',
              title: '约分条件',
              canvas: blankSlide('face-slide'),
              source: 'edited',
            },
          ],
        },
      },
    }),
  ).toBeOK();
  const material = await post(`drafts/${project.id}/confirm`, { expectedRevision: 1 });
  const config = await post('class-configs', {
    projectId: project.id,
    template: 'mixed',
    students: [
      {
        id: 'lin',
        name: '小林',
        expression: 'responsive',
        priorKnowledge: '',
        misconceptions: ['忽略分母非零'],
      },
    ],
    clientRequestId: randomUUID(),
  });
  const session = await post('sessions', {
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'text',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: randomUUID(),
  });
  const root = `sessions/${session.id}`;
  const classroom = `/teacher-training/sessions/${session.id}/classroom`;
  // The default Windows input can be occupied while an explicit camera works.
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      const video = constraints?.video;
      if (video && typeof video === 'object' && !video.deviceId)
        return Promise.reject(new DOMException('Device in use', 'NotReadableError'));
      return getUserMedia(constraints);
    };
  });
  await page.goto(classroom);
  const stage = page.getByLabel('课堂舞台');
  const panel = stage.getByLabel('试讲表情分析');
  await page.getByRole('button', { name: '开启摄像头并分析表情' }).click();
  await expect(panel).toContainText('课堂进行时才采样');
  await expect(panel.getByLabel('摄像头设备')).not.toHaveValue('');
  expect((await get(`${root}/face-evidence`)).windows).toHaveLength(0);
  await page.getByRole('button', { name: '开始课堂' }).click();
  await expect(page.getByLabel('试讲表情分析')).toContainText('未检测到单张清晰人脸');
  const camera = await page
    .locator('video[aria-label="本机摄像头预览"]')
    .evaluateHandle(
      (video) => ((video as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0],
    );
  const panelX = (await panel.boundingBox())!.x;
  await stage.getByRole('button', { name: '白板', exact: true }).click();
  const board = stage.getByTestId('teaching-whiteboard');
  await expect(board).toBeVisible();
  const boardBox = (await board.boundingBox())!;
  expect(boardBox.x + boardBox.width).toBeLessThan(panelX);
  expect((await panel.boundingBox())!.x).toBe(panelX);
  expect(await camera.evaluate((track) => track.readyState)).toBe('live');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await panel.boundingBox())!.y > (await board.boundingBox())!.y)
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await stage.getByRole('button', { name: '课件', exact: true }).click();
  await expect(board).toHaveCount(0);
  expect((await panel.boundingBox())!.x).toBe(panelX);
  expect(await camera.evaluate((track) => track.readyState)).toBe('live');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByLabel('试讲表情分析')).toContainText('课堂进行时才采样');
  await expect
    .poll(async () => (await get(`${root}/face-evidence`)).windows.length)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '关闭摄像头' }).click();
  expect(await camera.evaluate((track) => track.readyState)).toBe('ended');
  await page.getByRole('button', { name: '继续课堂' }).click();
  const running = await get(`${root}/runtime`);
  const question = await post(`${root}/events`, {
    type: 'teacher_text',
    intent: 'question',
    text: '什么时候可以约分？',
    expectedRevision: running.session.revision,
    clientEventId: randomUUID(),
  });
  const time = Date.parse(question.event.receivedAt);
  // Controlled positive observation verifies the UI independently of the fake webcam image.
  await post(`${root}/face-evidence`, {
    generation: 0,
    modelVersion: faceModelVersion,
    windows: [
      {
        id: randomUUID(),
        startedAt: time,
        endedAt: time + 400,
        samples: 4,
        visible: 4,
        smile: 3,
        browDown: 0,
        browUp: 0,
      },
    ],
  });
  await post(`${root}/commands`, {
    command: 'end',
    confirmed: true,
    expectedRevision: question.session.revision,
    clientEventId: randomUUID(),
  });
  const records = `/teacher-training?project=${project.id}&tab=records&session=${session.id}`;
  await page.goto(records);
  const evidence = page.getByLabel('本轮表情证据');
  await evidence.getByText('表情观测', { exact: false }).click();
  await expect(evidence).toContainText('观测到嘴角上扬');
  await evidence.getByRole('button', { name: '查看教师发言时的课堂现场' }).click();
  await page.getByRole('button', { name: '重练这段' }).click();
  await expect(page).not.toHaveURL(new RegExp(session.id));
  await expect(page.getByText('请围绕原提问重新组织措辞')).toBeVisible();
  await expect(page.getByText('什么时候可以约分？')).toBeVisible();
});
